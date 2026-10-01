/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

#ifndef SCRATCHBOX_KINEMATICS_HPP
#define SCRATCHBOX_KINEMATICS_HPP

#include "scratchbox_math.hpp"
#include <vector>
#include <string>
#include <cmath>
#include <cstdint>
#include <algorithm>

namespace scratchbox {
namespace kinematics {

/**
 * Scratchbox Standard Humanoid Rig Joint Indices (canonical 21-joint hierarchy)
 */
enum class StandardJoint : int32_t {
    Pelvis = 0,
    Spine,
    Chest,
    Neck,
    Head,
    LeftClavicle,
    LeftShoulder,
    LeftElbow,
    LeftWrist,
    RightClavicle,
    RightShoulder,
    RightElbow,
    RightWrist,
    LeftHip,
    LeftKnee,
    LeftAnkle,
    LeftFoot,
    RightHip,
    RightKnee,
    RightAnkle,
    RightFoot,
    Count
};

/**
 * Scratchbox Canonical 55-Joint Humanoid Rig (Body + Face + 5-Digit Hands)
 */
enum class Canonical55Joint : int32_t {
    Pelvis = 0,
    LeftHip,
    RightHip,
    Spine1,
    LeftKnee,
    RightKnee,
    Spine2,
    LeftAnkle,
    RightAnkle,
    Spine3,
    LeftFoot,
    RightFoot,
    Neck,
    LeftCollar,
    RightCollar,
    Head,
    LeftShoulder,
    RightShoulder,
    LeftElbow,
    RightElbow,
    LeftWrist,
    RightWrist,
    Jaw,
    LeftEye,
    RightEye,
    // Left Hand (canonical SB-Human order: Index, Middle, Pinky, Ring, Thumb)
    LeftIndex1,
    LeftIndex2,
    LeftIndex3,
    LeftMiddle1,
    LeftMiddle2,
    LeftMiddle3,
    LeftPinky1,
    LeftPinky2,
    LeftPinky3,
    LeftRing1,
    LeftRing2,
    LeftRing3,
    LeftThumb1,
    LeftThumb2,
    LeftThumb3,
    // Right Hand (canonical SB-Human order: Index, Middle, Pinky, Ring, Thumb)
    RightIndex1,
    RightIndex2,
    RightIndex3,
    RightMiddle1,
    RightMiddle2,
    RightMiddle3,
    RightPinky1,
    RightPinky2,
    RightPinky3,
    RightRing1,
    RightRing2,
    RightRing3,
    RightThumb1,
    RightThumb2,
    RightThumb3,
    Count
};

/**
 * Skeletal joint representation
 */
struct Joint {
    std::string name;
    int32_t index{0};
    int32_t parentIndex{-1};
    math::Vec3 restPosition{0.0f, 0.0f, 0.0f};
    math::Vec3 localRotation{0.0f, 0.0f, 0.0f}; // Axis-angle Rodrigues ω

    math::Mat4 worldTransform{math::Mat4::identity()};  // A_k
    math::Mat4 skinningMatrix{math::Mat4::identity()};  // G_k = A_k * T(-restPosition)

    Joint() = default;
    Joint(std::string jointName, int32_t idx, int32_t parent, const math::Vec3& restPos)
        : name(std::move(jointName)), index(idx), parentIndex(parent), restPosition(restPos) {}
};

/**
 * Rodrigues' Formula: Convert Axis-Angle vector ω to 3x3 / 4x4 SO(3) Rotation Matrix
 */
inline math::Mat4 rodrigues(const math::Vec3& omega) {
    float angleSq = omega.lengthSq();
    if (angleSq < 1e-8f) {
        // Taylor series approximation for small angles
        math::Mat4 R = math::Mat4::identity();
        R.m[1] = -omega.z; R.m[2] =  omega.y;
        R.m[4] =  omega.z; R.m[6] = -omega.x;
        R.m[8] = -omega.y; R.m[9] =  omega.x;
        return R;
    }

    float angle = std::sqrt(angleSq);
    float invAngle = 1.0f / angle;
    math::Vec3 u = omega * invAngle;

    float c = std::cos(angle);
    float s = std::sin(angle);
    float t = 1.0f - c;

    math::Mat4 R = math::Mat4::identity();
    // Column-major layout matching scratchbox::math::Mat4
    R.m[0] = t * u.x * u.x + c;
    R.m[1] = t * u.x * u.y + s * u.z;
    R.m[2] = t * u.x * u.z - s * u.y;

    R.m[4] = t * u.x * u.y - s * u.z;
    R.m[5] = t * u.y * u.y + c;
    R.m[6] = t * u.y * u.z + s * u.x;

    R.m[8] = t * u.x * u.z + s * u.y;
    R.m[9] = t * u.y * u.z - s * u.x;
    R.m[10] = t * u.z * u.z + c;

    return R;
}

/**
 * Low-Dimensional Hand Pose PCA Subspace (compressing 15 finger joints / 45 DOFs into natural gesture coefficients)
 */
struct HandPcaSubspace {
    static constexpr size_t NUM_JOINTS = 15;
    static constexpr size_t NUM_DOFS = 45;
    static constexpr size_t NUM_COMPONENTS = 6;

    std::array<float, NUM_DOFS> meanPose{};
    std::array<std::array<float, NUM_DOFS>, NUM_COMPONENTS> components{};

    HandPcaSubspace() {
        initDefault();
    }

    void initDefault() {
        // Authentic Empirical Left Hand Mean Pose from SB-Human (15 joints x 3 DOFs)
        static constexpr std::array<float, NUM_DOFS> SBHUMAN_HANDS_MEAN_L = {
            +0.1117f, +0.0429f, -0.4164f, // 0: Index1
            +0.1088f, -0.0660f, -0.7562f, // 1: Index2
            -0.0964f, -0.0909f, -0.1885f, // 2: Index3
            -0.1181f, +0.0509f, -0.5296f, // 3: Middle1
            -0.1437f, +0.0552f, -0.7049f, // 4: Middle2
            -0.0192f, -0.0923f, -0.3379f, // 5: Middle3
            -0.4570f, -0.1963f, -0.6255f, // 6: Pinky1
            -0.2147f, -0.0660f, -0.5069f, // 7: Pinky2
            -0.3697f, -0.0603f, -0.0795f, // 8: Pinky3
            -0.1419f, -0.0859f, -0.6355f, // 9: Ring1
            -0.3033f, -0.0579f, -0.6314f, // 10: Ring2
            -0.1761f, -0.1321f, -0.3734f, // 11: Ring3
            +0.8510f, +0.2769f, -0.0915f, // 12: Thumb1
            -0.4998f, +0.0266f, +0.0529f, // 13: Thumb2
            +0.5356f, +0.0460f, -0.2774f  // 14: Thumb3
        };
        static constexpr auto& SMPLX_HANDS_MEAN_L = SBHUMAN_HANDS_MEAN_L;
        meanPose = SBHUMAN_HANDS_MEAN_L;

        for (size_t c = 0; c < NUM_COMPONENTS; ++c) {
            components[c].fill(0.0f);
        }

        // Component 0: Anatomical Clenched Fist (full curl with thumb wrap)
        components[0][ 0 * 3 + 0] = -0.0617f; components[0][ 0 * 3 + 1] = +0.0071f; components[0][ 0 * 3 + 2] = -0.8336f;
        components[0][ 1 * 3 + 0] = -0.1088f; components[0][ 1 * 3 + 1] = +0.0660f; components[0][ 1 * 3 + 2] = -0.7938f;
        components[0][ 2 * 3 + 0] = +0.0964f; components[0][ 2 * 3 + 1] = +0.0909f; components[0][ 2 * 3 + 2] = -0.9615f;
        components[0][ 3 * 3 + 0] = +0.0981f; components[0][ 3 * 3 + 1] = -0.0509f; components[0][ 3 * 3 + 2] = -0.7704f;
        components[0][ 4 * 3 + 0] = +0.1437f; components[0][ 4 * 3 + 1] = -0.0552f; components[0][ 4 * 3 + 2] = -0.8951f;
        components[0][ 5 * 3 + 0] = +0.0192f; components[0][ 5 * 3 + 1] = +0.0923f; components[0][ 5 * 3 + 2] = -0.8621f;
        components[0][ 6 * 3 + 0] = +0.3570f; components[0][ 6 * 3 + 1] = +0.0463f; components[0][ 6 * 3 + 2] = -0.6245f;
        components[0][ 7 * 3 + 0] = +0.2147f; components[0][ 7 * 3 + 1] = +0.0660f; components[0][ 7 * 3 + 2] = -0.9931f;
        components[0][ 8 * 3 + 0] = +0.3697f; components[0][ 8 * 3 + 1] = +0.0603f; components[0][ 8 * 3 + 2] = -1.0205f;
        components[0][ 9 * 3 + 0] = +0.0919f; components[0][ 9 * 3 + 1] = +0.0059f; components[0][ 9 * 3 + 2] = -0.6445f;
        components[0][10 * 3 + 0] = +0.3033f; components[0][10 * 3 + 1] = +0.0579f; components[0][10 * 3 + 2] = -0.9186f;
        components[0][11 * 3 + 0] = +0.1761f; components[0][11 * 3 + 1] = +0.1321f; components[0][11 * 3 + 2] = -0.7766f;
        components[0][12 * 3 + 0] = -0.7310f; components[0][12 * 3 + 1] = +0.8231f; components[0][12 * 3 + 2] = +0.5715f;
        components[0][13 * 3 + 0] = +0.2498f; components[0][13 * 3 + 1] = -0.0266f; components[0][13 * 3 + 2] = -0.7029f;
        components[0][14 * 3 + 0] = -0.3856f; components[0][14 * 3 + 1] = -0.0460f; components[0][14 * 3 + 2] = -0.4726f;

        // Component 1: Finger Spread / Splay (abduction / adduction)
        components[1][ 0 * 3 + 1] = +0.25f; // Index splay +
        components[1][ 3 * 3 + 1] = +0.05f; // Middle slight +
        components[1][ 6 * 3 + 1] = -0.30f; // Pinky splay -
        components[1][ 9 * 3 + 1] = -0.15f; // Ring splay -
        components[1][12 * 3 + 1] = +0.35f; // Thumb splay out

        // Component 2: Point (Index extends forward, others curl into fist)
        components[2][ 0 * 3 + 0] = -0.0617f; components[2][ 0 * 3 + 1] = +0.0071f; components[2][ 0 * 3 + 2] = +0.3664f;
        components[2][ 1 * 3 + 0] = -0.1088f; components[2][ 1 * 3 + 1] = +0.0660f; components[2][ 1 * 3 + 2] = +0.7562f;
        components[2][ 2 * 3 + 0] = +0.0964f; components[2][ 2 * 3 + 1] = +0.0909f; components[2][ 2 * 3 + 2] = +0.1885f;
        components[2][ 3 * 3 + 0] = +0.0981f; components[2][ 3 * 3 + 1] = -0.0509f; components[2][ 3 * 3 + 2] = -0.7704f;
        components[2][ 4 * 3 + 0] = +0.1437f; components[2][ 4 * 3 + 1] = -0.0552f; components[2][ 4 * 3 + 2] = -0.8951f;
        components[2][ 5 * 3 + 0] = +0.0192f; components[2][ 5 * 3 + 1] = +0.0923f; components[2][ 5 * 3 + 2] = -0.8621f;
        components[2][ 6 * 3 + 0] = +0.3570f; components[2][ 6 * 3 + 1] = +0.0463f; components[2][ 6 * 3 + 2] = -0.6245f;
        components[2][ 7 * 3 + 0] = +0.2147f; components[2][ 7 * 3 + 1] = +0.0660f; components[2][ 7 * 3 + 2] = -0.9931f;
        components[2][ 8 * 3 + 0] = +0.3697f; components[2][ 8 * 3 + 1] = +0.0603f; components[2][ 8 * 3 + 2] = -1.0205f;
        components[2][ 9 * 3 + 0] = +0.0919f; components[2][ 9 * 3 + 1] = +0.0059f; components[2][ 9 * 3 + 2] = -0.6445f;
        components[2][10 * 3 + 0] = +0.3033f; components[2][10 * 3 + 1] = +0.0579f; components[2][10 * 3 + 2] = -0.9186f;
        components[2][11 * 3 + 0] = +0.1761f; components[2][11 * 3 + 1] = +0.1321f; components[2][11 * 3 + 2] = -0.7766f;
        components[2][12 * 3 + 0] = -0.7310f; components[2][12 * 3 + 1] = +0.8231f; components[2][12 * 3 + 2] = +0.5715f;
        components[2][13 * 3 + 0] = +0.2498f; components[2][13 * 3 + 1] = -0.0266f; components[2][13 * 3 + 2] = -0.7029f;
        components[2][14 * 3 + 0] = -0.3856f; components[2][14 * 3 + 1] = -0.0460f; components[2][14 * 3 + 2] = -0.4726f;

        // Component 3: Pinch (Thumb + Index tips meet)
        components[3][ 0 * 3 + 0] = -0.0617f; components[3][ 0 * 3 + 1] = +0.0071f; components[3][ 0 * 3 + 2] = -0.4336f;
        components[3][ 1 * 3 + 0] = -0.1088f; components[3][ 1 * 3 + 1] = +0.0660f; components[3][ 1 * 3 + 2] = -0.1938f;
        components[3][ 2 * 3 + 0] = +0.0964f; components[3][ 2 * 3 + 1] = +0.0909f; components[3][ 2 * 3 + 2] = -0.4615f;
        components[3][12 * 3 + 0] = -0.5510f; components[3][12 * 3 + 1] = +0.5731f; components[3][12 * 3 + 2] = +0.3415f;
        components[3][13 * 3 + 0] = +0.2998f; components[3][13 * 3 + 1] = -0.0266f; components[3][13 * 3 + 2] = -0.5029f;
        components[3][14 * 3 + 0] = -0.4356f; components[3][14 * 3 + 1] = -0.0460f; components[3][14 * 3 + 2] = -0.2726f;

        // Component 4: Thumbs Up (4 fingers curled into fist, thumb extended)
        components[4][ 0 * 3 + 0] = -0.0617f; components[4][ 0 * 3 + 1] = +0.0071f; components[4][ 0 * 3 + 2] = -0.8336f;
        components[4][ 1 * 3 + 0] = -0.1088f; components[4][ 1 * 3 + 1] = +0.0660f; components[4][ 1 * 3 + 2] = -0.7938f;
        components[4][ 2 * 3 + 0] = +0.0964f; components[4][ 2 * 3 + 1] = +0.0909f; components[4][ 2 * 3 + 2] = -0.9615f;
        components[4][ 3 * 3 + 0] = +0.0981f; components[4][ 3 * 3 + 1] = -0.0509f; components[4][ 3 * 3 + 2] = -0.7704f;
        components[4][ 4 * 3 + 0] = +0.1437f; components[4][ 4 * 3 + 1] = -0.0552f; components[4][ 4 * 3 + 2] = -0.8951f;
        components[4][ 5 * 3 + 0] = +0.0192f; components[4][ 5 * 3 + 1] = +0.0923f; components[4][ 5 * 3 + 2] = -0.8621f;
        components[4][ 6 * 3 + 0] = +0.3570f; components[4][ 6 * 3 + 1] = +0.0463f; components[4][ 6 * 3 + 2] = -0.6245f;
        components[4][ 7 * 3 + 0] = +0.2147f; components[4][ 7 * 3 + 1] = +0.0660f; components[4][ 7 * 3 + 2] = -0.9931f;
        components[4][ 8 * 3 + 0] = +0.3697f; components[4][ 8 * 3 + 1] = +0.0603f; components[4][ 8 * 3 + 2] = -1.0205f;
        components[4][ 9 * 3 + 0] = +0.0919f; components[4][ 9 * 3 + 1] = +0.0059f; components[4][ 9 * 3 + 2] = -0.6445f;
        components[4][10 * 3 + 0] = +0.3033f; components[4][10 * 3 + 1] = +0.0579f; components[4][10 * 3 + 2] = -0.9186f;
        components[4][11 * 3 + 0] = +0.1761f; components[4][11 * 3 + 1] = +0.1321f; components[4][11 * 3 + 2] = -0.7766f;
        components[4][12 * 3 + 0] = +0.0990f; components[4][12 * 3 + 1] = -0.1769f; components[4][12 * 3 + 2] = -0.0085f;
        components[4][13 * 3 + 0] = +0.3998f; components[4][13 * 3 + 1] = -0.0266f; components[4][13 * 3 + 2] = -0.0529f;
        components[4][14 * 3 + 0] = -0.4356f; components[4][14 * 3 + 1] = -0.0460f; components[4][14 * 3 + 2] = +0.2774f;

        // Component 5: Flat Open Hand (flatten fingers out)
        components[5][ 0 * 3 + 0] = -0.1117f; components[5][ 0 * 3 + 1] = -0.0429f; components[5][ 0 * 3 + 2] = +0.4164f;
        components[5][ 1 * 3 + 0] = -0.1088f; components[5][ 1 * 3 + 1] = +0.0660f; components[5][ 1 * 3 + 2] = +0.7562f;
        components[5][ 2 * 3 + 0] = +0.0964f; components[5][ 2 * 3 + 1] = +0.0909f; components[5][ 2 * 3 + 2] = +0.1885f;
        components[5][ 3 * 3 + 0] = +0.1181f; components[5][ 3 * 3 + 1] = -0.0509f; components[5][ 3 * 3 + 2] = +0.5296f;
        components[5][ 4 * 3 + 0] = +0.1437f; components[5][ 4 * 3 + 1] = -0.0552f; components[5][ 4 * 3 + 2] = +0.7049f;
        components[5][ 5 * 3 + 0] = +0.0192f; components[5][ 5 * 3 + 1] = +0.0923f; components[5][ 5 * 3 + 2] = +0.3379f;
        components[5][ 6 * 3 + 0] = +0.4570f; components[5][ 6 * 3 + 1] = +0.1963f; components[5][ 6 * 3 + 2] = +0.6255f;
        components[5][ 7 * 3 + 0] = +0.2147f; components[5][ 7 * 3 + 1] = +0.0660f; components[5][ 7 * 3 + 2] = +0.5069f;
        components[5][ 8 * 3 + 0] = +0.3697f; components[5][ 8 * 3 + 1] = +0.0603f; components[5][ 8 * 3 + 2] = +0.0795f;
        components[5][ 9 * 3 + 0] = +0.1419f; components[5][ 9 * 3 + 1] = +0.0859f; components[5][ 9 * 3 + 2] = +0.6355f;
        components[5][10 * 3 + 0] = +0.3033f; components[5][10 * 3 + 1] = +0.0579f; components[5][10 * 3 + 2] = +0.6314f;
        components[5][11 * 3 + 0] = +0.1761f; components[5][11 * 3 + 1] = +0.1321f; components[5][11 * 3 + 2] = +0.3734f;
        components[5][12 * 3 + 0] = -0.5010f; components[5][12 * 3 + 1] = -0.1269f; components[5][12 * 3 + 2] = +0.0415f;
        components[5][13 * 3 + 0] = +0.4998f; components[5][13 * 3 + 1] = -0.0266f; components[5][13 * 3 + 2] = -0.0529f;
        components[5][14 * 3 + 0] = -0.5356f; components[5][14 * 3 + 1] = -0.0460f; components[5][14 * 3 + 2] = +0.2774f;
    }

    std::array<math::Vec3, NUM_JOINTS> evaluate(const std::vector<float>& coeffs) const {
        std::array<math::Vec3, NUM_JOINTS> rotations;
        for (size_t j = 0; j < NUM_JOINTS; ++j) {
            float rx = meanPose[j * 3 + 0];
            float ry = meanPose[j * 3 + 1];
            float rz = meanPose[j * 3 + 2];

            for (size_t c = 0; c < NUM_COMPONENTS && c < coeffs.size(); ++c) {
                float coeff = coeffs[c];
                rx += coeff * components[c][j * 3 + 0];
                ry += coeff * components[c][j * 3 + 1];
                rz += coeff * components[c][j * 3 + 2];
            }

            rotations[j] = math::Vec3(rx, ry, rz);
        }
        return rotations;
    }

    static const HandPcaSubspace& defaultSubspace() {
        static const HandPcaSubspace instance;
        return instance;
    }
};

/**
 * Kinematic Skeleton and Forward Kinematics Tree
 */
class Skeleton {
public:
    std::vector<Joint> joints;

    int32_t addJoint(const std::string& name, int32_t parentIndex, const math::Vec3& restPosition) {
        int32_t idx = static_cast<int32_t>(joints.size());
        joints.emplace_back(name, idx, parentIndex, restPosition);
        return idx;
    }

    int32_t findJoint(const std::string& name) const {
        for (size_t i = 0; i < joints.size(); ++i) {
            if (joints[i].name == name) return static_cast<int32_t>(i);
        }
        return -1;
    }

    void setJointRotation(int32_t jointIndex, const math::Vec3& axisAngle) {
        if (jointIndex >= 0 && jointIndex < static_cast<int32_t>(joints.size())) {
            joints[jointIndex].localRotation = axisAngle;
        }
    }

    void setJointRotation(StandardJoint joint, const math::Vec3& axisAngle) {
        setJointRotation(static_cast<int32_t>(joint), axisAngle);
    }

    void setJointRotation(Canonical55Joint joint, const math::Vec3& axisAngle) {
        setJointRotation(static_cast<int32_t>(joint), axisAngle);
    }

    void setJointRotation(const std::string& name, const math::Vec3& axisAngle) {
        int32_t idx = findJoint(name);
        if (idx >= 0) setJointRotation(idx, axisAngle);
    }

    /**
     * Recursively computes forward kinematics:
     * A_k = A_parent * T_local
     * G_k = A_k * T(-restPosition)
     */
    void updateTransforms() {
        for (auto& j : joints) {
            math::Mat4 localRot = rodrigues(j.localRotation);

            if (j.parentIndex < 0) {
                // Root joint in world space
                localRot.m[12] = j.restPosition.x;
                localRot.m[13] = j.restPosition.y;
                localRot.m[14] = j.restPosition.z;
                j.worldTransform = localRot;
            } else {
                const auto& parent = joints[j.parentIndex];
                math::Vec3 delta = j.restPosition - parent.restPosition;
                localRot.m[12] = delta.x;
                localRot.m[13] = delta.y;
                localRot.m[14] = delta.z;
                j.worldTransform = parent.worldTransform * localRot;
            }

            // G_k = A_k * T(-restPosition)
            math::Mat4 invBind = math::Mat4::translation(-j.restPosition);
            j.skinningMatrix = j.worldTransform * invBind;
        }
    }

    std::vector<math::Mat4> getSkinningMatrices() const {
        std::vector<math::Mat4> mats;
        mats.reserve(joints.size());
        for (const auto& j : joints) {
            mats.push_back(j.skinningMatrix);
        }
        return mats;
    }

    std::vector<math::Vec3> getPosedJointPositions() const {
        std::vector<math::Vec3> positions;
        positions.reserve(joints.size());
        for (const auto& j : joints) {
            positions.push_back({
                j.worldTransform.m[12],
                j.worldTransform.m[13],
                j.worldTransform.m[14]
            });
        }
        return positions;
    }

    /**
     * Factory: Canonical Proportional Standard Humanoid Rig (1.8m height)
     */
    static Skeleton createStandardHumanoid(float scale = 1.0f) {
        Skeleton rig;
        // Pelvis (root)
        int32_t pelvis = rig.addJoint("Pelvis", -1, math::Vec3(0.0f, 0.95f, 0.0f) * scale);
        // Spine & Head
        int32_t spine = rig.addJoint("Spine", pelvis, math::Vec3(0.0f, 1.15f, 0.0f) * scale);
        int32_t chest = rig.addJoint("Chest", spine, math::Vec3(0.0f, 1.40f, 0.0f) * scale);
        int32_t neck = rig.addJoint("Neck", chest, math::Vec3(0.0f, 1.55f, 0.0f) * scale);
        rig.addJoint("Head", neck, math::Vec3(0.0f, 1.70f, 0.0f) * scale);

        // Left Arm
        int32_t lClav = rig.addJoint("LeftClavicle", chest, math::Vec3(0.08f, 1.42f, 0.0f) * scale);
        int32_t lShoulder = rig.addJoint("LeftShoulder", lClav, math::Vec3(0.22f, 1.40f, 0.0f) * scale);
        int32_t lElbow = rig.addJoint("LeftElbow", lShoulder, math::Vec3(0.50f, 1.40f, 0.0f) * scale);
        rig.addJoint("LeftWrist", lElbow, math::Vec3(0.75f, 1.40f, 0.0f) * scale);

        // Right Arm
        int32_t rClav = rig.addJoint("RightClavicle", chest, math::Vec3(-0.08f, 1.42f, 0.0f) * scale);
        int32_t rShoulder = rig.addJoint("RightShoulder", rClav, math::Vec3(-0.22f, 1.40f, 0.0f) * scale);
        int32_t rElbow = rig.addJoint("RightElbow", rShoulder, math::Vec3(-0.50f, 1.40f, 0.0f) * scale);
        rig.addJoint("RightWrist", rElbow, math::Vec3(-0.75f, 1.40f, 0.0f) * scale);

        // Left Leg
        int32_t lHip = rig.addJoint("LeftHip", pelvis, math::Vec3(0.12f, 0.90f, 0.0f) * scale);
        int32_t lKnee = rig.addJoint("LeftKnee", lHip, math::Vec3(0.12f, 0.50f, 0.0f) * scale);
        int32_t lAnkle = rig.addJoint("LeftAnkle", lKnee, math::Vec3(0.12f, 0.10f, 0.0f) * scale);
        rig.addJoint("LeftFoot", lAnkle, math::Vec3(0.12f, 0.02f, 0.15f) * scale);

        // Right Leg
        int32_t rHip = rig.addJoint("RightHip", pelvis, math::Vec3(-0.12f, 0.90f, 0.0f) * scale);
        int32_t rKnee = rig.addJoint("RightKnee", rHip, math::Vec3(-0.12f, 0.50f, 0.0f) * scale);
        int32_t rAnkle = rig.addJoint("RightAnkle", rKnee, math::Vec3(-0.12f, 0.10f, 0.0f) * scale);
        rig.addJoint("RightFoot", rAnkle, math::Vec3(-0.12f, 0.02f, 0.15f) * scale);

        rig.updateTransforms();
        return rig;
    }

    /**
     * Factory: Canonical 55-Joint Humanoid Rig (Body, Face, and 5-Digit Articulated Hands)
     */
    static Skeleton create55JointHumanoid(float scale = 1.0f, float shoulderWidthScale = 1.0f, float hipWidthScale = 1.0f) {
        Skeleton rig;
        rig.joints.reserve(55);

        // 1. Pelvis root (0)
        int32_t pelvis = rig.addJoint("Pelvis", -1, math::Vec3(0.0f, 0.95f, -0.012f) * scale);

        // 2. Lower Body (Hips, Knees, Ankles, Feet)
        int32_t lHip = rig.addJoint("LeftHip", pelvis, math::Vec3(0.092f * hipWidthScale, 0.90f, -0.014f) * scale);
        int32_t rHip = rig.addJoint("RightHip", pelvis, math::Vec3(-0.092f * hipWidthScale, 0.90f, -0.014f) * scale);
        int32_t spine1 = rig.addJoint("Spine1", pelvis, math::Vec3(0.0f, 1.10f, 0.010f) * scale);

        int32_t lKnee = rig.addJoint("LeftKnee", lHip, math::Vec3(0.072f * hipWidthScale, 0.48f, 0.002f) * scale);
        int32_t rKnee = rig.addJoint("RightKnee", rHip, math::Vec3(-0.072f * hipWidthScale, 0.48f, 0.002f) * scale);
        int32_t spine2 = rig.addJoint("Spine2", spine1, math::Vec3(0.0f, 1.25f, -0.004f) * scale);

        int32_t lAnkle = rig.addJoint("LeftAnkle", lKnee, math::Vec3(0.063f * hipWidthScale, 0.082f, -0.006f) * scale);
        int32_t rAnkle = rig.addJoint("RightAnkle", rKnee, math::Vec3(-0.063f * hipWidthScale, 0.082f, -0.006f) * scale);
        int32_t spine3 = rig.addJoint("Spine3", spine2, math::Vec3(0.0f, 1.40f, -0.012f) * scale);

        rig.addJoint("LeftFoot", lAnkle, math::Vec3(0.063f * hipWidthScale, 0.02f, 0.06f) * scale);
        rig.addJoint("RightFoot", rAnkle, math::Vec3(-0.063f * hipWidthScale, 0.02f, 0.06f) * scale);

        // 3. Neck & Head
        int32_t neck = rig.addJoint("Neck", spine3, math::Vec3(0.0f, 1.492f, -0.002f) * scale);
        int32_t lCollar = rig.addJoint("LeftCollar", spine3, math::Vec3(0.08f * shoulderWidthScale, 1.435f, -0.012f) * scale);
        int32_t rCollar = rig.addJoint("RightCollar", spine3, math::Vec3(-0.08f * shoulderWidthScale, 1.435f, -0.012f) * scale);

        int32_t head = rig.addJoint("Head", neck, math::Vec3(0.0f, 1.640f, 0.000f) * scale);

        // 4. Arms
        float armXOffset = (shoulderWidthScale - 1.0f) * 0.20f * scale;
        int32_t lShoulder = rig.addJoint("LeftShoulder", lCollar, math::Vec3(0.208f * shoulderWidthScale, 1.426f, -0.008f) * scale);
        int32_t rShoulder = rig.addJoint("RightShoulder", rCollar, math::Vec3(-0.208f * shoulderWidthScale, 1.426f, -0.008f) * scale);

        int32_t lElbow = rig.addJoint("LeftElbow", lShoulder, math::Vec3(0.48f * scale + armXOffset, 1.410f * scale, -0.010f * scale));
        int32_t rElbow = rig.addJoint("RightElbow", rShoulder, math::Vec3(-0.48f * scale - armXOffset, 1.410f * scale, -0.010f * scale));

        int32_t lWrist = rig.addJoint("LeftWrist", lElbow, math::Vec3(0.74f * scale + armXOffset, 1.400f * scale, 0.000f));
        int32_t rWrist = rig.addJoint("RightWrist", rElbow, math::Vec3(-0.74f * scale - armXOffset, 1.400f * scale, 0.000f));

        // 5. Facial features (childed to Head)
        rig.addJoint("Jaw", head, math::Vec3(0.0f, 1.568f, 0.050f) * scale);
        rig.addJoint("LeftEye", head, math::Vec3(0.034f, 1.680f, 0.055f) * scale);
        rig.addJoint("RightEye", head, math::Vec3(-0.034f, 1.680f, 0.055f) * scale);

        // 6. Left Hand 5-Digit Finger Chains (childed to LeftWrist, canonical SB-Human order)
        // Index (3 joints)
        int32_t li1 = rig.addJoint("LeftIndex1", lWrist, math::Vec3(0.80f * scale + armXOffset, 1.43f * scale, 0.02f * scale));
        int32_t li2 = rig.addJoint("LeftIndex2", li1,    math::Vec3(0.83f * scale + armXOffset, 1.43f * scale, 0.02f * scale));
        rig.addJoint("LeftIndex3", li2,                   math::Vec3(0.86f * scale + armXOffset, 1.43f * scale, 0.02f * scale));

        // Middle (3 joints)
        int32_t lm1 = rig.addJoint("LeftMiddle1", lWrist, math::Vec3(0.80f * scale + armXOffset, 1.41f * scale, 0.00f * scale));
        int32_t lm2 = rig.addJoint("LeftMiddle2", lm1,    math::Vec3(0.84f * scale + armXOffset, 1.41f * scale, 0.00f * scale));
        rig.addJoint("LeftMiddle3", lm2,                   math::Vec3(0.87f * scale + armXOffset, 1.41f * scale, 0.00f * scale));

        // Pinky (3 joints)
        int32_t lp1 = rig.addJoint("LeftPinky1", lWrist, math::Vec3(0.79f * scale + armXOffset, 1.37f * scale, -0.03f * scale));
        int32_t lp2 = rig.addJoint("LeftPinky2", lp1,    math::Vec3(0.82f * scale + armXOffset, 1.37f * scale, -0.03f * scale));
        rig.addJoint("LeftPinky3", lp2,                   math::Vec3(0.84f * scale + armXOffset, 1.37f * scale, -0.03f * scale));

        // Ring (3 joints)
        int32_t lr1 = rig.addJoint("LeftRing1", lWrist, math::Vec3(0.80f * scale + armXOffset, 1.39f * scale, -0.02f * scale));
        int32_t lr2 = rig.addJoint("LeftRing2", lr1,    math::Vec3(0.83f * scale + armXOffset, 1.39f * scale, -0.02f * scale));
        rig.addJoint("LeftRing3", lr2,                   math::Vec3(0.86f * scale + armXOffset, 1.39f * scale, -0.02f * scale));

        // Thumb (3 joints)
        int32_t lt1 = rig.addJoint("LeftThumb1", lWrist, math::Vec3(0.77f * scale + armXOffset, 1.39f * scale, 0.03f * scale));
        int32_t lt2 = rig.addJoint("LeftThumb2", lt1,    math::Vec3(0.80f * scale + armXOffset, 1.38f * scale, 0.04f * scale));
        rig.addJoint("LeftThumb3", lt2,                   math::Vec3(0.82f * scale + armXOffset, 1.37f * scale, 0.05f * scale));

        // 7. Right Hand 5-Digit Finger Chains (childed to RightWrist, canonical SB-Human order)
        // Index (3 joints)
        int32_t ri1 = rig.addJoint("RightIndex1", rWrist, math::Vec3(-0.80f * scale - armXOffset, 1.43f * scale, 0.02f * scale));
        int32_t ri2 = rig.addJoint("RightIndex2", ri1,    math::Vec3(-0.83f * scale - armXOffset, 1.43f * scale, 0.02f * scale));
        rig.addJoint("RightIndex3", ri2,                   math::Vec3(-0.86f * scale - armXOffset, 1.43f * scale, 0.02f * scale));

        // Middle (3 joints)
        int32_t rm1 = rig.addJoint("RightMiddle1", rWrist, math::Vec3(-0.80f * scale - armXOffset, 1.41f * scale, 0.00f * scale));
        int32_t rm2 = rig.addJoint("RightMiddle2", rm1,    math::Vec3(-0.84f * scale - armXOffset, 1.41f * scale, 0.00f * scale));
        rig.addJoint("RightMiddle3", rm2,                   math::Vec3(-0.87f * scale - armXOffset, 1.41f * scale, 0.00f * scale));

        // Pinky (3 joints)
        int32_t rp1 = rig.addJoint("RightPinky1", rWrist, math::Vec3(-0.79f * scale - armXOffset, 1.37f * scale, -0.03f * scale));
        int32_t rp2 = rig.addJoint("RightPinky2", rp1,    math::Vec3(-0.82f * scale - armXOffset, 1.37f * scale, -0.03f * scale));
        rig.addJoint("RightPinky3", rp2,                   math::Vec3(-0.84f * scale - armXOffset, 1.37f * scale, -0.03f * scale));

        // Ring (3 joints)
        int32_t rr1 = rig.addJoint("RightRing1", rWrist, math::Vec3(-0.80f * scale - armXOffset, 1.39f * scale, -0.02f * scale));
        int32_t rr2 = rig.addJoint("RightRing2", rr1,    math::Vec3(-0.83f * scale - armXOffset, 1.39f * scale, -0.02f * scale));
        rig.addJoint("RightRing3", rr2,                   math::Vec3(-0.86f * scale - armXOffset, 1.39f * scale, -0.02f * scale));

        // Thumb (3 joints)
        int32_t rt1 = rig.addJoint("RightThumb1", rWrist, math::Vec3(-0.77f * scale - armXOffset, 1.39f * scale, 0.03f * scale));
        int32_t rt2 = rig.addJoint("RightThumb2", rt1,    math::Vec3(-0.80f * scale - armXOffset, 1.38f * scale, 0.04f * scale));
        rig.addJoint("RightThumb3", rt2,                   math::Vec3(-0.82f * scale - armXOffset, 1.37f * scale, 0.05f * scale));

        rig.updateTransforms();
        return rig;
    }

    void applyHandPose(bool isLeft, const std::vector<float>& coeffs, const HandPcaSubspace& subspace = HandPcaSubspace::defaultSubspace()) {
        auto rotations = subspace.evaluate(coeffs);
        int32_t baseIdx = isLeft ? static_cast<int32_t>(Canonical55Joint::LeftIndex1) : static_cast<int32_t>(Canonical55Joint::RightIndex1);
        for (size_t j = 0; j < HandPcaSubspace::NUM_JOINTS; ++j) {
            int32_t targetIdx = baseIdx + static_cast<int32_t>(j);
            if (targetIdx < static_cast<int32_t>(joints.size())) {
                math::Vec3 rot = rotations[j];
                if (!isLeft) {
                    rot.y = -rot.y;
                    rot.z = -rot.z;
                }
                setJointRotation(targetIdx, rot);
            }
        }
    }
};

} // namespace kinematics
} // namespace scratchbox

#endif // SCRATCHBOX_KINEMATICS_HPP
