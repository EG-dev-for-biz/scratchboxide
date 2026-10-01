/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_SB_VEGGIE_HPP
#define SCRATCHBOX_SB_VEGGIE_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_pbr.hpp"
#include "scratchbox_texture.hpp"
#include "scratchbox_io.hpp"
#include "scratchbox_botanical_texture.hpp"
#include <vector>
#include <string>
#include <cmath>
#include <algorithm>
#include <array>
#include <memory>
#include <iostream>

namespace scratchbox {
namespace sb_veggie {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using math::Mat4;
using math::Quat;
using math::PI;
using math::TWO_PI;
using math::HALF_PI;
using geometry::Vertex;
using geometry::ScratchboxMesh;
using geometry::PbrMaterial;
using botanical::BotanicalPbrTextureSynthesizer;

// ============================================================================
// 1. Botanical Macro-Archetype Enumeration
// ============================================================================

enum class SbVeggieArchetype : uint32_t {
    DecurrentHardwood = 0,    // Spreading dome canopy, bifurcating trunk (Oak, Maple, Elm)
    ExcurrentConifer = 1,     // Conical canopy, central leader trunk (Pine, Fir, Spruce)
    Palmate = 2,              // Bare column stipe, apical frond crown (Palm, Cycad)
    FastigiateColumnar = 3    // Upright hugging branches (Cypress, Lombardy Poplar)
};

// ============================================================================
// 2. Kinematic Branch Skeleton & Skinning Definitions
// ============================================================================

struct SbVeggieJoint {
    int id{0};
    int parentId{-1};
    std::string name{"Root"};
    Vec3 restPosition{0.0f, 0.0f, 0.0f};
    Vec3 posedPosition{0.0f, 0.0f, 0.0f};
    Quat restRotation{Quat::identity()};
    Quat localRotation{Quat::identity()};
    Mat4 bindMatrixInverse{Mat4::identity()};
    Mat4 globalTransform{Mat4::identity()};
};

struct SbVeggieSkinWeight {
    uint32_t jointIndices[4]{0, 0, 0, 0};
    float weights[4]{1.0f, 0.0f, 0.0f, 0.0f};

    void normalize() {
        float sum = weights[0] + weights[1] + weights[2] + weights[3];
        if (sum > 1e-6f) {
            float inv = 1.0f / sum;
            weights[0] *= inv;
            weights[1] *= inv;
            weights[2] *= inv;
            weights[3] *= inv;
        } else {
            weights[0] = 1.0f;
            weights[1] = weights[2] = weights[3] = 0.0f;
        }
    }
};

// ============================================================================
// 3. Foliage Cluster Anchor Definition
// ============================================================================

struct SbVeggieFoliageAnchor {
    int attachedJointIndex{0};
    int parentJointIndex{-1};
    Vec3 localOffset{0.0f, 0.0f, 0.0f};
    Vec3 outwardDirection{0.0f, 1.0f, 0.0f};
    float clusterRadius{0.8f};
    int leafCount{18};
    bool isTerminalTwig{true};
    float shootStation{1.0f};
};

// ============================================================================
// 4. Canonical Botanical Template Topology
// ============================================================================

struct SbVeggieTemplate {
    SbVeggieArchetype archetype{SbVeggieArchetype::DecurrentHardwood};
    std::string name{"Canonical_Decurrent_Oak"};
    
    // Watertight unposed canonical manifold geometry T_bar
    std::vector<Vertex> canonicalVertices;
    std::vector<uint32_t> indices;
    
    // Kinematic joint hierarchy
    std::vector<SbVeggieJoint> skeleton;
    
    // Per-vertex 4-bone partition-of-unity skinning weights
    std::vector<SbVeggieSkinWeight> skinWeights;
    
    // 16-Mode Orthonormal PCA Shape Basis Tensors (S_k in R^{16 x N x 3})
    // shapeBasis[mode][vertexIdx]
    std::vector<std::vector<Vec3>> shapeBasis;
    
    // Joint regression offsets: dJ[mode][jointIdx]
    std::vector<std::vector<Vec3>> jointShapeOffsets;
    
    // Foliage anchors attached to outer branch tips
    std::vector<SbVeggieFoliageAnchor> foliageAnchors;

    // Ancestor primary scaffold index (0..7) for every joint, or -1 for trunk joints
    std::vector<int> jointScaffoldAncestor;
    
    PbrMaterial barkMaterial;
    PbrMaterial foliageMaterial;
};

// ============================================================================
// 4B. Asymmetric Bough Inverse Kinematics (IK)
// ============================================================================

struct SbVeggieScaffoldIK {
    float azimuthOffset{0.0f};   // radians: horizontal yaw around trunk fork [-0.45, 0.45] (~ +/-25 deg)
    float elevationOffset{0.0f}; // radians: vertical pitch up/down [-0.35, 0.35] (~ +/-20 deg)
    float reachScale{1.0f};       // scalar radial extension multiplier [0.65, 1.45] (1.0 = nominal)
};

// ============================================================================
// 5. Morphological, Pose & Phenology Parameters
// ============================================================================

struct SbVeggieParams {
    // 16 Morphological Shape Coefficients (beta)
    // beta[0]: DBH / Girth Caliper [-2.0, 2.0]
    // beta[1]: Total Height Scale  [-2.0, 2.0]
    // beta[2]: Crown Spread Aspect [-2.0, 2.0]
    // beta[3]: Crown Base Height   [-2.0, 2.0]
    // beta[4]: Cantilever Droop    [-2.0, 2.0]
    // beta[5]: Basal Flare Fluting [-2.0, 2.0]
    // beta[6]: Trunk Taper Law     [-2.0, 2.0]
    // beta[7]: Apical Dominance    [-2.0, 2.0]
    // beta[8..15]: High-order volumetric harmonic modes
    float beta[16]{0.0f};
    
    // Kinematic joint rotations in Euler radians (theta)
    std::vector<Vec3> theta;

    // 8 Primary Scaffold Bough IK Degrees of Freedom (Scaffolds 0..7 / Joints 8..15)
    // Allows asymmetric bough elevation, azimuthal swing, and reach extension
    SbVeggieScaffoldIK scaffoldIK[8];
    
    // Phenological state (psi)
    float psi_season{1.0f};       // 1.0 = Summer green, 0.5 = Autumn gold, 0.0 = Winter bare
    float psi_leafDensity{1.0f};  // Multiplier for foliage cluster density
    float psi_leafScale{1.0f};    // Leaf size factor
    
    // Environmental wind force vector
    Vec3 windVector{0.0f, 0.0f, 0.0f};
    float windTimeSeconds{0.0f};
    
    // Global translation vector (root ground anchor)
    Vec3 translation{0.0f, 0.0f, 0.0f};
    
    // Branch & Leaf Shaping controls (Native Code Skills Integration)
    float branchCurvature{1.0f};        // Catenary/phototropic arch and gravitropic droop
    float collarFlare{1.0f};            // Swelling branch collar at bifurcations
    float reactionWood{1.0f};           // Stress-adapted elliptical cross section
    int leafMorphology{0};              // 0 = Lobed Oak (3D anatomical), 1 = Serrated Birch, 2 = Planar Quad
    float leafCupping{1.0f};            // Parabolic 3D lamina cupping amplitude
    bool transferEnvelopeNormals{true}; // Blender-style radial envelope normal transfer with sky bias
    float colorInfluenceWeight{0.0f};   // 0.0 = canonical botanical color, 1.0 = full scan color influence
    int colorInfluenceMode{0};          // 0 = Luminance-preserving chrominance transfer, 1 = Direct RGB lerp
    float saturationScale{0.78f};       // Saturation multiplier for natural botanical shading (0.78 = muted a tad)
    
    static SbVeggieParams createNeutral() {
        SbVeggieParams p;
        for (int i = 0; i < 16; ++i) p.beta[i] = 0.0f;
        p.theta.resize(16, Vec3(0.0f, 0.0f, 0.0f));
        for (int i = 0; i < 8; ++i) {
            p.scaffoldIK[i] = SbVeggieScaffoldIK{0.0f, 0.0f, 1.0f};
        }
        p.psi_season = 1.0f;
        p.psi_leafDensity = 1.0f;
        p.psi_leafScale = 1.0f;
        p.windVector = Vec3(0.0f, 0.0f, 0.0f);
        p.windTimeSeconds = 0.0f;
        p.translation = Vec3(0.0f, 0.0f, 0.0f);
        p.branchCurvature = 1.0f;
        p.collarFlare = 1.0f;
        p.reactionWood = 1.0f;
        p.leafMorphology = 0;
        p.leafCupping = 1.0f;
        p.transferEnvelopeNormals = true;
        p.colorInfluenceWeight = 0.0f;
        p.colorInfluenceMode = 0;
        p.saturationScale = 0.78f;
        return p;
    }
};

// ============================================================================
// 6. Canonical Template Synthesizer (Model Builder)
// ============================================================================

class SbVeggieModelBuilder {
public:
    static SbVeggieTemplate buildCanonicalTemplate(
        SbVeggieArchetype archetype = SbVeggieArchetype::DecurrentHardwood
    ) {
        SbVeggieTemplate tmpl;
        tmpl.archetype = archetype;

        // Configure default PBR materials
        tmpl.barkMaterial.name = "PBR_Wood_Bark";
        tmpl.barkMaterial.baseColorFactor = Vec4(1.0f, 1.0f, 1.0f, 1.0f);
        tmpl.barkMaterial.roughnessFactor = 0.94f;
        tmpl.barkMaterial.metallicFactor = 0.02f;

        tmpl.foliageMaterial.name = "PBR_Foliage_Leaves";
        tmpl.foliageMaterial.baseColorFactor = Vec4(1.0f, 1.0f, 1.0f, 1.0f);
        tmpl.foliageMaterial.roughnessFactor = 0.90f;
        tmpl.foliageMaterial.metallicFactor = 0.0f;
        tmpl.foliageMaterial.doubleSided = true;
        tmpl.foliageMaterial.alphaMode = "MASK";
        tmpl.foliageMaterial.alphaCutoff = 0.5f;

        // Construct kinematic skeleton (112 joints across 5 botanical ramification tiers):
        // 0..7: Trunk spine from ground root (0,0,0) to apical crown apex (0, 5.65, 0)
        // 8..15: 8 Primary Scaffold Boughs radiating at golden azimuths & staggered heights
        // 16..39: 24 Secondary Limbs (each primary bough trifurcates)
        // 40..87: 48 Tertiary Branchlets (each secondary bough bifurcates)
        // 88..111: 24 Terminal & Apical Twigs (4 crown apex twigs + 20 peripheral terminal twigs)
        auto addJoint = [&](int id, int parentId, const std::string& name, const Vec3& pos) {
            SbVeggieJoint j;
            j.id = id;
            j.parentId = parentId;
            j.name = name;
            j.restPosition = pos;
            j.posedPosition = pos;
            j.restRotation = Quat::identity();
            j.localRotation = Quat::identity();

            Mat4 worldBind = Mat4::translation(pos);
            j.bindMatrixInverse = worldBind.inverseRigid();
            j.globalTransform = worldBind;
            tmpl.skeleton.push_back(j);
        };

        // 0..7 Trunk (8 joints)
        addJoint(0, -1, "Root",            Vec3(0.0f, 0.0f, 0.0f));
        addJoint(1,  0, "Trunk_Low",       Vec3(0.0f, 0.85f, 0.0f));
        addJoint(2,  1, "Trunk_Mid1",      Vec3(0.04f, 1.70f, 0.02f));
        addJoint(3,  2, "Crown_Fork_1",    Vec3(0.08f, 2.45f, -0.04f));
        addJoint(4,  3, "Crown_Fork_2",    Vec3(0.05f, 3.20f, 0.05f));
        addJoint(5,  4, "Crown_Fork_3",    Vec3(-0.04f, 3.95f, 0.03f));
        addJoint(6,  5, "Apical_Mid",      Vec3(0.02f, 4.75f, -0.03f));
        addJoint(7,  6, "Apical_Apex",     Vec3(0.00f, 5.65f, 0.00f));

        // 8..15 Scaffolds (8 joints)
        addJoint(8,  2, "Scaffold_0", Vec3( 1.35f, 2.25f,  0.45f));
        addJoint(9,  2, "Scaffold_1", Vec3(-0.75f, 2.45f,  1.20f));
        addJoint(10, 3, "Scaffold_2", Vec3(-1.25f, 2.95f, -0.65f));
        addJoint(11, 3, "Scaffold_3", Vec3( 0.65f, 3.15f, -1.30f));
        addJoint(12, 4, "Scaffold_4", Vec3( 1.30f, 3.70f, -0.50f));
        addJoint(13, 4, "Scaffold_5", Vec3(-0.95f, 3.85f,  0.90f));
        addJoint(14, 5, "Scaffold_6", Vec3( 0.45f, 4.40f,  1.10f));
        addJoint(15, 5, "Scaffold_7", Vec3(-0.55f, 4.50f, -1.05f));

        // 16..39 Secondary Boughs (24 joints, 3 per scaffold)
        addJoint(16, 8, "Sec_0A", Vec3( 2.35f, 2.70f,  0.85f));
        addJoint(17, 8, "Sec_0B", Vec3( 1.95f, 3.05f, -0.35f));
        addJoint(18, 8, "Sec_0C", Vec3( 1.55f, 2.85f,  1.45f));
        addJoint(19, 9, "Sec_1A", Vec3(-1.45f, 3.00f,  1.95f));
        addJoint(20, 9, "Sec_1B", Vec3(-0.05f, 3.20f,  1.85f));
        addJoint(21, 9, "Sec_1C", Vec3(-1.55f, 3.10f,  0.75f));
        addJoint(22, 10, "Sec_2A", Vec3(-2.25f, 3.40f, -0.45f));
        addJoint(23, 10, "Sec_2B", Vec3(-1.55f, 3.60f, -1.65f));
        addJoint(24, 10, "Sec_2C", Vec3(-1.95f, 3.45f,  0.35f));
        addJoint(25, 11, "Sec_3A", Vec3( 0.45f, 3.80f, -2.15f));
        addJoint(26, 11, "Sec_3B", Vec3( 1.55f, 3.85f, -1.75f));
        addJoint(27, 11, "Sec_3C", Vec3(-0.45f, 3.75f, -1.75f));
        addJoint(28, 12, "Sec_4A", Vec3( 2.25f, 4.30f, -0.35f));
        addJoint(29, 12, "Sec_4B", Vec3( 1.65f, 4.50f,  0.65f));
        addJoint(30, 12, "Sec_4C", Vec3( 1.85f, 4.35f, -1.25f));
        addJoint(31, 13, "Sec_5A", Vec3(-1.65f, 4.45f,  0.65f));
        addJoint(32, 13, "Sec_5B", Vec3(-0.65f, 4.60f,  1.75f));
        addJoint(33, 13, "Sec_5C", Vec3(-1.55f, 4.50f, -0.25f));
        addJoint(34, 14, "Sec_6A", Vec3( 0.65f, 5.10f,  1.75f));
        addJoint(35, 14, "Sec_6B", Vec3( 1.35f, 5.15f,  0.75f));
        addJoint(36, 14, "Sec_6C", Vec3(-0.25f, 5.05f,  1.55f));
        addJoint(37, 15, "Sec_7A", Vec3(-0.75f, 5.10f, -1.65f));
        addJoint(38, 15, "Sec_7B", Vec3( 0.35f, 5.15f, -1.55f));
        addJoint(39, 15, "Sec_7C", Vec3(-1.15f, 5.05f, -0.65f));

        // 40..87 Tertiary Branchlets (48 joints, 2 per secondary bough)
        for (int s = 0; s < 24; ++s) {
            int secJointIdx = 16 + s;
            int parentScaffoldIdx = tmpl.skeleton[secJointIdx].parentId;
            Vec3 p0 = tmpl.skeleton[parentScaffoldIdx].restPosition;
            Vec3 p1 = tmpl.skeleton[secJointIdx].restPosition;
            Vec3 dir = p1 - p0;
            float dLen = dir.length();
            Vec3 normDir = dLen > 1e-4f ? dir / dLen : Vec3(1, 0, 0);

            Vec3 perp = normDir.cross(Vec3(0, 1, 0));
            if (perp.lengthSquared() < 0.01f) perp = normDir.cross(Vec3(1, 0, 0));
            perp = perp.normalized();

            Vec3 tert1 = p1 + normDir * (dLen * 0.55f) + perp * 0.42f + Vec3(0, 0.28f, 0);
            Vec3 tert2 = p1 + normDir * (dLen * 0.55f) - perp * 0.42f + Vec3(0, 0.28f, 0);

            int tIdx1 = 40 + s * 2;
            int tIdx2 = 40 + s * 2 + 1;
            addJoint(tIdx1, secJointIdx, "Tert_" + std::to_string(s) + "A", tert1);
            addJoint(tIdx2, secJointIdx, "Tert_" + std::to_string(s) + "B", tert2);
        }

        // 88..111 Terminal & Apical Twigs (24 joints)
        addJoint(88, 7, "Apical_Twig_0", Vec3( 0.45f, 6.10f,  0.30f));
        addJoint(89, 7, "Apical_Twig_1", Vec3(-0.40f, 6.15f,  0.35f));
        addJoint(90, 7, "Apical_Twig_2", Vec3(-0.35f, 6.05f, -0.40f));
        addJoint(91, 7, "Apical_Twig_3", Vec3( 0.38f, 6.12f, -0.32f));

        for (int k = 0; k < 20; ++k) {
            int parentTertIdx = 40 + static_cast<int>((k * 47) / 19);
            int parentSecIdx = tmpl.skeleton[parentTertIdx].parentId;
            Vec3 p0 = tmpl.skeleton[parentSecIdx].restPosition;
            Vec3 p1 = tmpl.skeleton[parentTertIdx].restPosition;
            Vec3 dir = (p1 - p0).normalized();
            Vec3 twigPos = p1 + dir * 0.55f + Vec3(0, 0.22f, 0);
            addJoint(92 + k, parentTertIdx, "Terminal_Twig_" + std::to_string(k), twigPos);
        }

        // --------------------------------------------------------------------
        // 1. Synthesize Watertight Trunk Mesh with Da Vinci Taper & Bark Furrows
        // --------------------------------------------------------------------
        const int trunkRadial = 16;
        const int trunkRings = 24;
        float totalHeight = 5.8f;

        for (int r = 0; r <= trunkRings; ++r) {
            float t = static_cast<float>(r) / trunkRings;
            float y = t * totalHeight;

            // Da Vinci Caliper Taper: radius drops from 0.38m at base to 0.08m at apex
            float baseRadius = 0.38f;
            float nominalRadius = baseRadius * std::pow(1.0f - t * 0.82f, 0.62f);

            // Basal trunk flare fluting near ground (t < 0.16)
            float flare = 0.0f;
            if (t < 0.16f) {
                float fFactor = 1.0f - t / 0.16f;
                flare = fFactor * fFactor * 0.18f;
            }

            for (int s = 0; s < trunkRadial; ++s) {
                float angle = (static_cast<float>(s) / trunkRadial) * TWO_PI;

                // Organic longitudinal bark furrowing harmonics (smooth macro flare)
                float furrowNoise = std::sin(angle * 4.0f) * 0.012f 
                                  + std::cos(angle * 3.0f + y * 1.5f) * 0.008f;
                float flutedRoot = flare * (1.0f + std::cos(angle * 5.0f) * 0.35f);
                float radius = std::max(0.04f, nominalRadius + furrowNoise + flutedRoot);

                float x = std::cos(angle) * radius;
                float z = std::sin(angle) * radius;

                Vec3 pos(x, y, z);
                // Analytical normal with subtle upward inclination for daylight capture
                Vec3 norm = Vec3(std::cos(angle) * 0.96f, 0.10f, std::sin(angle) * 0.96f).normalized();
                Vec2 uv(static_cast<float>(s) / trunkRadial * 1.0f, t * 4.0f);

                // Desaturated weathered ash-oak cork tone (matching scaffold bough reflectance)
                Vec4 col = Vec4(0.66f, 0.64f, 0.61f, 1.0f);

                tmpl.canonicalVertices.push_back(Vertex{pos, norm, uv, col});

                // Compute 4-bone geodesic skinning weights along trunk spine
                SbVeggieSkinWeight sw;
                if (y < 0.9f) {
                    float factor = y / 0.9f;
                    sw.jointIndices[0] = 0; sw.weights[0] = 1.0f - factor;
                    sw.jointIndices[1] = 1; sw.weights[1] = factor;
                } else if (y < 1.8f) {
                    float factor = (y - 0.9f) / 0.9f;
                    sw.jointIndices[0] = 1; sw.weights[0] = 1.0f - factor;
                    sw.jointIndices[1] = 2; sw.weights[1] = factor;
                } else if (y < 2.5f) {
                    float factor = (y - 1.8f) / 0.7f;
                    sw.jointIndices[0] = 2; sw.weights[0] = 1.0f - factor;
                    sw.jointIndices[1] = 3; sw.weights[1] = factor;
                } else if (y < 3.2f) {
                    float factor = (y - 2.5f) / 0.7f;
                    sw.jointIndices[0] = 3; sw.weights[0] = 1.0f - factor;
                    sw.jointIndices[1] = 4; sw.weights[1] = factor;
                } else if (y < 4.0f) {
                    float factor = (y - 3.2f) / 0.8f;
                    sw.jointIndices[0] = 4; sw.weights[0] = 1.0f - factor;
                    sw.jointIndices[1] = 5; sw.weights[1] = factor;
                } else if (y < 4.8f) {
                    float factor = (y - 4.0f) / 0.8f;
                    sw.jointIndices[0] = 5; sw.weights[0] = 1.0f - factor;
                    sw.jointIndices[1] = 6; sw.weights[1] = factor;
                } else {
                    float factor = std::clamp((y - 4.8f) / 1.0f, 0.0f, 1.0f);
                    sw.jointIndices[0] = 6; sw.weights[0] = 1.0f - factor;
                    sw.jointIndices[1] = 7; sw.weights[1] = factor;
                }
                sw.normalize();
                tmpl.skinWeights.push_back(sw);
            }
        }

        // Trunk Quad Triangulation
        for (int r = 0; r < trunkRings; ++r) {
            for (int s = 0; s < trunkRadial; ++s) {
                int nextS = (s + 1) % trunkRadial;
                uint32_t i00 = r * trunkRadial + s;
                uint32_t i10 = r * trunkRadial + nextS;
                uint32_t i01 = (r + 1) * trunkRadial + s;
                uint32_t i11 = (r + 1) * trunkRadial + nextS;

                tmpl.indices.push_back(i00); tmpl.indices.push_back(i10); tmpl.indices.push_back(i11);
                tmpl.indices.push_back(i00); tmpl.indices.push_back(i11); tmpl.indices.push_back(i01);
            }
        }

        // Helper lambda to add watertight branch cylinders with Bézier curvature,
        // swollen branch collars, reaction-wood ellipticity, Da Vinci taper & hemispherical caps
        auto addBranchCylinder = [&](
            int parentJointIdx, int childJointIdx,
            const Vec3& startPos, const Vec3& endPos,
            float rStart, float rEnd,
            int rings, int radial,
            const Vec4& color, bool addCap,
            float curvatureStrength = 0.12f,
            bool applyCollar = true
        ) {
            Vec3 straightVec = endPos - startPos;
            float branchLen = straightVec.length();
            Vec3 straightDir = branchLen > 1e-4f ? straightVec / branchLen : Vec3(0, 1, 0);

            // Outward horizontal vector for natural branch arching
            Vec3 horizDir(straightDir.x, 0.0f, straightDir.z);
            float horizLen = horizDir.length();
            if (horizLen > 1e-3f) horizDir = horizDir / horizLen;
            else horizDir = Vec3(1, 0, 0);

            // Bézier intermediate control point:
            // Branches emerge with phototropic upward arc (+Y) and droop under cantilever load
            Vec3 midPoint = startPos + straightVec * 0.5f 
                          + Vec3(0.0f, branchLen * curvatureStrength * 0.55f, 0.0f)
                          - horizDir * (branchLen * curvatureStrength * 0.20f);

            uint32_t branchStartVertex = static_cast<uint32_t>(tmpl.canonicalVertices.size());

            for (int r = 0; r <= rings; ++r) {
                float t = static_cast<float>(r) / rings;
                float oneMinusT = 1.0f - t;

                // Quadratic Bézier centerline curve: C(t) = (1-t)^2 P0 + 2(1-t)t Pmid + t^2 P1
                Vec3 center = startPos * (oneMinusT * oneMinusT) 
                            + midPoint * (2.0f * oneMinusT * t) 
                            + endPos * (t * t);

                // Tangent vector along curve
                Vec3 tangent = (midPoint - startPos) * (2.0f * oneMinusT) 
                             + (endPos - midPoint) * (2.0f * t);
                Vec3 dir = tangent.length() > 1e-4f ? tangent.normalized() : straightDir;

                // Frenet/Bishop moving reference frame
                Vec3 perp1 = Vec3(0, 1, 0).cross(dir);
                if (perp1.length() < 1e-4f) perp1 = Vec3(1, 0, 0).cross(dir);
                if (perp1.length() < 1e-4f) perp1 = Vec3(0, 0, 1);
                perp1 = perp1.normalized();
                Vec3 perp2 = dir.cross(perp1).normalized();

                // 1. Tapering Law
                float baseRadius = rStart * (1.0f - t) + rEnd * t;

                // 2. Botanical Branch Collar Flare (exponential swelling at junction t -> 0)
                float collar = applyCollar ? (1.0f + 0.45f * std::exp(-t / 0.16f)) : 1.0f;
                float rRadius = baseRadius * collar;

                // 2b. Basal Trunk Buttress Root Fluting (ground level t < 0.35 on trunk base)
                float buttressFlare = 1.0f;
                if (parentJointIdx == 0 && childJointIdx == 1 && t < 0.35f) {
                    float rootDecay = std::exp(-t / 0.10f);
                    buttressFlare = 1.0f + rootDecay * 0.40f;
                }
                rRadius *= buttressFlare;

                for (int s = 0; s < radial; ++s) {
                    float a = (static_cast<float>(s) / radial) * TWO_PI;

                    // Fluting root ridges on trunk base expanding organically into soil
                    float fluteMod = 1.0f;
                    if (parentJointIdx == 0 && childJointIdx == 1 && t < 0.35f) {
                        float rootDecay = std::exp(-t / 0.10f);
                        fluteMod = 1.0f + 0.16f * rootDecay * std::sin(a * 5.0f);
                    }

                    // 3. Reaction Wood Ellipticity:
                    // Hardwood branches deepen vertically (1.10x) vs laterally (0.92x) under gravity
                    float rx = rRadius * 0.92f * fluteMod;
                    float ry = rRadius * 1.10f * fluteMod;

                    // 4. Longitudinal Bark Furrow Harmonics along bough (dual frequency)
                    float barkFurrow = 1.0f + 0.040f * std::sin(a * 6.0f + t * 4.0f)
                                            + 0.018f * std::cos(a * 12.0f + t * 8.0f);

                    Vec3 offset = perp1 * (std::cos(a) * rx * barkFurrow) 
                                + perp2 * (std::sin(a) * ry * barkFurrow);
                    Vec3 pos = center + offset;
                    Vec3 norm = offset.normalized();
                    Vec2 uv(static_cast<float>(s) / radial * 1.0f, t * 2.5f);

                    Vec4 vColor = color;

                    tmpl.canonicalVertices.push_back(Vertex{pos, norm, uv, vColor});

                    SbVeggieSkinWeight sw;
                    sw.jointIndices[0] = parentJointIdx; sw.weights[0] = 1.0f - t;
                    sw.jointIndices[1] = childJointIdx;  sw.weights[1] = t;
                    sw.normalize();
                    tmpl.skinWeights.push_back(sw);
                }
            }

            for (int r = 0; r < rings; ++r) {
                for (int s = 0; s < radial; ++s) {
                    int nextS = (s + 1) % radial;
                    uint32_t i00 = branchStartVertex + r * radial + s;
                    uint32_t i10 = branchStartVertex + r * radial + nextS;
                    uint32_t i01 = branchStartVertex + (r + 1) * radial + s;
                    uint32_t i11 = branchStartVertex + (r + 1) * radial + nextS;

                    tmpl.indices.push_back(i00); tmpl.indices.push_back(i10); tmpl.indices.push_back(i11);
                    tmpl.indices.push_back(i00); tmpl.indices.push_back(i11); tmpl.indices.push_back(i01);
                }
            }

            // Hemispherical cap at branch tip for 100% watertight manifold integrity
            if (addCap) {
                uint32_t capCenterIdx = static_cast<uint32_t>(tmpl.canonicalVertices.size());
                Vec3 endDir = (endPos - midPoint).normalized();
                Vec3 capCenter = endPos + endDir * (rEnd * 0.5f);
                tmpl.canonicalVertices.push_back(Vertex{capCenter, endDir, Vec2(0.5f, 0.5f), color});

                SbVeggieSkinWeight capSw;
                capSw.jointIndices[0] = childJointIdx; capSw.weights[0] = 1.0f;
                tmpl.skinWeights.push_back(capSw);

                uint32_t lastRingStart = branchStartVertex + rings * radial;
                for (int s = 0; s < radial; ++s) {
                    int nextS = (s + 1) % radial;
                    tmpl.indices.push_back(lastRingStart + s);
                    tmpl.indices.push_back(lastRingStart + nextS);
                    tmpl.indices.push_back(capCenterIdx);
                }
            }
        };

        // --------------------------------------------------------------------
        // 2. Synthesize 8 Primary Scaffold Boughs (Order 1)
        // --------------------------------------------------------------------
        for (int b = 0; b < 8; ++b) {
            int scaffoldJointIdx = 8 + b;
            int parentTrunkJointIdx = tmpl.skeleton[scaffoldJointIdx].parentId;
            Vec3 startPos = tmpl.skeleton[parentTrunkJointIdx].restPosition;
            Vec3 endPos = tmpl.skeleton[scaffoldJointIdx].restPosition;

            addBranchCylinder(
                parentTrunkJointIdx, scaffoldJointIdx,
                startPos, endPos,
                0.15f, 0.088f,
                4, 8,
                Vec4(0.65f, 0.63f, 0.60f, 1.0f), false,
                0.14f, true
            );
        }

        // --------------------------------------------------------------------
        // 3. Synthesize 24 Secondary Limbs (Order 2 Da Vinci Trifurcations)
        // --------------------------------------------------------------------
        for (int b = 0; b < 24; ++b) {
            int secJointIdx = 16 + b;
            int scaffoldJointIdx = tmpl.skeleton[secJointIdx].parentId;
            Vec3 startPos = tmpl.skeleton[scaffoldJointIdx].restPosition;
            Vec3 endPos = tmpl.skeleton[secJointIdx].restPosition;

            addBranchCylinder(
                scaffoldJointIdx, secJointIdx,
                startPos, endPos,
                0.082f, 0.046f,
                3, 6,
                Vec4(0.62f, 0.60f, 0.57f, 1.0f), false,
                0.10f, true
            );
        }

        // --------------------------------------------------------------------
        // 4. Synthesize 48 Tertiary Branchlets (Order 3 Bifurcations)
        // --------------------------------------------------------------------
        for (int b = 0; b < 48; ++b) {
            int tertJointIdx = 40 + b;
            int secJointIdx = tmpl.skeleton[tertJointIdx].parentId;
            Vec3 startPos = tmpl.skeleton[secJointIdx].restPosition;
            Vec3 endPos = tmpl.skeleton[tertJointIdx].restPosition;

            addBranchCylinder(
                secJointIdx, tertJointIdx,
                startPos, endPos,
                0.044f, 0.024f,
                3, 5,
                Vec4(0.58f, 0.56f, 0.53f, 1.0f), false,
                0.08f, true
            );
        }

        // --------------------------------------------------------------------
        // 5. Synthesize 24 Terminal & Apical Twigs (Order 4 with Watertight Caps)
        // --------------------------------------------------------------------
        for (int b = 0; b < 24; ++b) {
            int twigJointIdx = 88 + b;
            int parentIdx = tmpl.skeleton[twigJointIdx].parentId;
            Vec3 startPos = tmpl.skeleton[parentIdx].restPosition;
            Vec3 endPos = tmpl.skeleton[twigJointIdx].restPosition;

            addBranchCylinder(
                parentIdx, twigJointIdx,
                startPos, endPos,
                0.022f, 0.010f,
                2, 4,
                Vec4(0.55f, 0.53f, 0.50f, 1.0f), true,
                0.06f, true
            );
        }

        // --------------------------------------------------------------------
        // 5. Seed 16-Mode Orthonormal PCA Shape Basis Tensors S_k
        // --------------------------------------------------------------------
        size_t N = tmpl.canonicalVertices.size();
        tmpl.shapeBasis.resize(16);
        for (int k = 0; k < 16; ++k) {
            tmpl.shapeBasis[k].resize(N, Vec3(0, 0, 0));
        }

        for (size_t v = 0; v < N; ++v) {
            const auto& pos = tmpl.canonicalVertices[v].position;
            float y = pos.y;
            float rDist = std::sqrt(pos.x * pos.x + pos.z * pos.z);

            // Mode 0: DBH / Trunk Caliper Girth (expands trunk radially)
            if (y < 4.0f) {
                float factor = (1.0f - y / 4.5f);
                if (rDist > 1e-4f) {
                    tmpl.shapeBasis[0][v] = Vec3(pos.x / rDist, 0.0f, pos.z / rDist) * (factor * 0.22f);
                }
            }

            // Mode 1: Total Tree Height Scaling
            tmpl.shapeBasis[1][v] = Vec3(0.0f, y * 0.35f, 0.0f);

            // Mode 2: Crown Spread (expands upper canopy horizontally)
            if (y > 1.6f) {
                float spreadFactor = (y - 1.6f) / 4.2f;
                if (rDist > 1e-4f) {
                    tmpl.shapeBasis[2][v] = Vec3(pos.x, 0.0f, pos.z) * (spreadFactor * 0.40f);
                }
            }

            // Mode 3: Crown Base Height (shifts lower branches up/down for street clearance)
            if (y > 1.2f && y < 4.5f) {
                float lift = std::sin((y - 1.2f) / 3.3f * PI);
                tmpl.shapeBasis[3][v] = Vec3(0.0f, lift * 0.50f, 0.0f);
            }

            // Mode 4: Cantilever Droop (gravitropic sag on outer branches)
            if (rDist > 1.0f) {
                float droop = (rDist - 1.0f) * 0.30f;
                tmpl.shapeBasis[4][v] = Vec3(0.0f, -droop, 0.0f);
            }

            // Mode 5: Basal Flare Fluting (root buttress near ground)
            if (y < 1.0f) {
                float flare = (1.0f - y) / 1.0f;
                float flute = std::sin(std::atan2(pos.z, pos.x) * 5.0f);
                tmpl.shapeBasis[5][v] = Vec3(pos.x, 0.0f, pos.z) * (flare * (0.15f + flute * 0.08f));
            }

            // Mode 6: Taper Exponent (conical vs cylindrical)
            tmpl.shapeBasis[6][v] = Vec3(pos.x * (y / 5.8f) * -0.18f, 0.0f, pos.z * (y / 5.8f) * -0.18f);

            // Mode 7: Apical Dominance (suppresses side branches, elongates leader)
            if (rDist < 0.8f && y > 3.0f) {
                tmpl.shapeBasis[7][v] = Vec3(0.0f, 0.70f, 0.0f);
            } else if (rDist >= 0.8f) {
                tmpl.shapeBasis[7][v] = Vec3(-pos.x * 0.12f, 0.0f, -pos.z * 0.12f);
            }
        }

        // --------------------------------------------------------------------
        // 5B. Seed Joint Morphing Offsets for Skeleton (dJ in R^{16 x J x 3})
        // --------------------------------------------------------------------
        size_t J = tmpl.skeleton.size();
        tmpl.jointShapeOffsets.resize(16);
        for (int k = 0; k < 16; ++k) {
            tmpl.jointShapeOffsets[k].resize(J, Vec3(0, 0, 0));
        }

        for (size_t j = 0; j < J; ++j) {
            const auto& jpos = tmpl.skeleton[j].restPosition;
            float jy = jpos.y;
            float jrDist = std::sqrt(jpos.x * jpos.x + jpos.z * jpos.z);

            // Mode 1: Height Scaling on Joints
            tmpl.jointShapeOffsets[1][j] = Vec3(0.0f, jy * 0.35f, 0.0f);

            // Mode 2: Crown Spread on Joints
            if (jy > 1.6f) {
                float spreadFactor = (jy - 1.6f) / 4.2f;
                tmpl.jointShapeOffsets[2][j] = Vec3(jpos.x, 0.0f, jpos.z) * (spreadFactor * 0.40f);
            }

            // Mode 3: Crown Base Height on Joints
            if (jy > 1.2f && jy < 4.5f) {
                float lift = std::sin((jy - 1.2f) / 3.3f * PI);
                tmpl.jointShapeOffsets[3][j] = Vec3(0.0f, lift * 0.50f, 0.0f);
            }

            // Mode 4: Cantilever Droop on Joints
            if (jrDist > 1.0f) {
                float droop = (jrDist - 1.0f) * 0.30f;
                tmpl.jointShapeOffsets[4][j] = Vec3(0.0f, -droop, 0.0f);
            }

            // Mode 7: Apical Dominance on Joints
            if (jrDist < 0.8f && jy > 3.0f) {
                tmpl.jointShapeOffsets[7][j] = Vec3(0.0f, 0.70f, 0.0f);
            } else if (jrDist >= 0.8f) {
                tmpl.jointShapeOffsets[7][j] = Vec3(-jpos.x * 0.12f, 0.0f, -jpos.z * 0.12f);
            }
        }

        // --------------------------------------------------------------------
        // 6. Pre-seed 288 Distributed High-Density Foliage Anchors across All Shoot Orders
        // --------------------------------------------------------------------
        // A. 24 Terminal Twigs x 2 Stations = 48 Anchors (Outer crown mantle & perimeter)
        for (int b = 0; b < 24; ++b) {
            int twigJointIdx = 88 + b;
            int parentIdx = tmpl.skeleton[twigJointIdx].parentId;
            Vec3 twigDir = tmpl.skeleton[twigJointIdx].restPosition.normalized();

            // Distal terminal apex station (t = 1.0)
            SbVeggieFoliageAnchor a1;
            a1.attachedJointIndex = twigJointIdx;
            a1.parentJointIndex = parentIdx;
            a1.shootStation = 1.0f;
            a1.localOffset = Vec3(0.0f, 0.12f, 0.0f);
            a1.outwardDirection = twigDir;
            a1.clusterRadius = 1.05f;
            a1.leafCount = 52;
            a1.isTerminalTwig = true;
            tmpl.foliageAnchors.push_back(a1);

            // Sub-terminal nodal station (t = 0.55)
            SbVeggieFoliageAnchor a2;
            a2.attachedJointIndex = twigJointIdx;
            a2.parentJointIndex = parentIdx;
            a2.shootStation = 0.55f;
            a2.localOffset = Vec3(0.0f, 0.10f, 0.0f);
            a2.outwardDirection = twigDir;
            a2.clusterRadius = 0.90f;
            a2.leafCount = 42;
            a2.isTerminalTwig = true;
            tmpl.foliageAnchors.push_back(a2);
        }

        // B. 48 Tertiary Branches x 3 Stations = 144 Anchors (Continuous mid-to-outer canopy)
        for (int b = 0; b < 48; ++b) {
            int tertJointIdx = 40 + b;
            int parentSecIdx = tmpl.skeleton[tertJointIdx].parentId;
            Vec3 tertDir = tmpl.skeleton[tertJointIdx].restPosition.normalized();

            // Distal fork station (t = 0.90)
            SbVeggieFoliageAnchor a1;
            a1.attachedJointIndex = tertJointIdx;
            a1.parentJointIndex = parentSecIdx;
            a1.shootStation = 0.90f;
            a1.localOffset = Vec3(0.0f, 0.16f, 0.0f);
            a1.outwardDirection = tertDir;
            a1.clusterRadius = 0.95f;
            a1.leafCount = 46;
            a1.isTerminalTwig = true;
            tmpl.foliageAnchors.push_back(a1);

            // Medial station (t = 0.60)
            SbVeggieFoliageAnchor a2;
            a2.attachedJointIndex = tertJointIdx;
            a2.parentJointIndex = parentSecIdx;
            a2.shootStation = 0.60f;
            a2.localOffset = Vec3(0.0f, 0.14f, 0.0f);
            a2.outwardDirection = tertDir;
            a2.clusterRadius = 0.85f;
            a2.leafCount = 40;
            a2.isTerminalTwig = false;
            tmpl.foliageAnchors.push_back(a2);

            // Proximal lateral shoot station (t = 0.30)
            SbVeggieFoliageAnchor a3;
            a3.attachedJointIndex = tertJointIdx;
            a3.parentJointIndex = parentSecIdx;
            a3.shootStation = 0.30f;
            a3.localOffset = Vec3(0.0f, 0.12f, 0.0f);
            a3.outwardDirection = tertDir;
            a3.clusterRadius = 0.78f;
            a3.leafCount = 34;
            a3.isTerminalTwig = false;
            tmpl.foliageAnchors.push_back(a3);
        }

        // C. 24 Secondary Boughs x 3 Stations = 72 Anchors (Inner-to-mid canopy foliage volume)
        for (int b = 0; b < 24; ++b) {
            int secJointIdx = 16 + b;
            int scaffoldJointIdx = tmpl.skeleton[secJointIdx].parentId;
            Vec3 secDir = tmpl.skeleton[secJointIdx].restPosition.normalized();

            // Distal lateral spur (t = 0.85)
            SbVeggieFoliageAnchor a1;
            a1.attachedJointIndex = secJointIdx;
            a1.parentJointIndex = scaffoldJointIdx;
            a1.shootStation = 0.85f;
            a1.localOffset = Vec3(0.0f, 0.18f, 0.0f);
            a1.outwardDirection = secDir;
            a1.clusterRadius = 0.82f;
            a1.leafCount = 36;
            a1.isTerminalTwig = false;
            tmpl.foliageAnchors.push_back(a1);

            // Medial lateral spur (t = 0.50)
            SbVeggieFoliageAnchor a2;
            a2.attachedJointIndex = secJointIdx;
            a2.parentJointIndex = scaffoldJointIdx;
            a2.shootStation = 0.50f;
            a2.localOffset = Vec3(0.0f, 0.15f, 0.0f);
            a2.outwardDirection = secDir;
            a2.clusterRadius = 0.75f;
            a2.leafCount = 30;
            a2.isTerminalTwig = false;
            tmpl.foliageAnchors.push_back(a2);

            // Proximal epicormic spur (t = 0.20)
            SbVeggieFoliageAnchor a3;
            a3.attachedJointIndex = secJointIdx;
            a3.parentJointIndex = scaffoldJointIdx;
            a3.shootStation = 0.20f;
            a3.localOffset = Vec3(0.0f, 0.12f, 0.0f);
            a3.outwardDirection = secDir;
            a3.clusterRadius = 0.70f;
            a3.leafCount = 26;
            a3.isTerminalTwig = false;
            tmpl.foliageAnchors.push_back(a3);
        }

        // D. 8 Primary Scaffolds x 2 Stations = 16 Anchors (Core interior canopy fill, eliminates hollow center)
        for (int b = 0; b < 8; ++b) {
            int scafJointIdx = 8 + b;
            int trunkParentIdx = tmpl.skeleton[scafJointIdx].parentId;
            Vec3 scafDir = tmpl.skeleton[scafJointIdx].restPosition.normalized();

            SbVeggieFoliageAnchor a1;
            a1.attachedJointIndex = scafJointIdx;
            a1.parentJointIndex = trunkParentIdx;
            a1.shootStation = 0.55f;
            a1.localOffset = Vec3(0.0f, 0.20f, 0.0f);
            a1.outwardDirection = scafDir;
            a1.clusterRadius = 0.75f;
            a1.leafCount = 28;
            a1.isTerminalTwig = false;
            tmpl.foliageAnchors.push_back(a1);

            SbVeggieFoliageAnchor a2;
            a2.attachedJointIndex = scafJointIdx;
            a2.parentJointIndex = trunkParentIdx;
            a2.shootStation = 0.85f;
            a2.localOffset = Vec3(0.0f, 0.22f, 0.0f);
            a2.outwardDirection = scafDir;
            a2.clusterRadius = 0.80f;
            a2.leafCount = 32;
            a2.isTerminalTwig = false;
            tmpl.foliageAnchors.push_back(a2);
        }

        // E. 4 Apical Crown Bole Joints (Joints 4, 5, 6, 7) x 2 Stations = 8 Anchors (Canopy summit dome)
        for (int b = 0; b < 4; ++b) {
            int trunkJointIdx = 4 + b;
            int trunkParentIdx = tmpl.skeleton[trunkJointIdx].parentId;

            for (int k = 0; k < 2; ++k) {
                float angle = (b * 2 + k) * (PI * 0.25f);
                Vec3 outDir(std::cos(angle), 0.65f, std::sin(angle));
                outDir = outDir.normalized();

                SbVeggieFoliageAnchor a;
                a.attachedJointIndex = trunkJointIdx;
                a.parentJointIndex = trunkParentIdx;
                a.shootStation = 0.75f;
                a.localOffset = outDir * 0.40f + Vec3(0.0f, 0.30f, 0.0f);
                a.outwardDirection = outDir;
                a.clusterRadius = 0.90f;
                a.leafCount = 40;
                a.isTerminalTwig = true;
                tmpl.foliageAnchors.push_back(a);
            }
        }

        // Precompute ancestor scaffold index for all joints (0..7 for boughs, -1 for trunk)
        tmpl.jointScaffoldAncestor.assign(tmpl.skeleton.size(), -1);
        for (size_t j = 0; j < tmpl.skeleton.size(); ++j) {
            int curr = static_cast<int>(j);
            while (curr >= 8 && curr < static_cast<int>(tmpl.skeleton.size())) {
                if (curr >= 8 && curr <= 15) {
                    tmpl.jointScaffoldAncestor[j] = curr - 8;
                    break;
                }
                curr = tmpl.skeleton[curr].parentId;
            }
        }

        return tmpl;
    }
};

// ============================================================================
// 6B. Spatial Color Field (Photogrammetric Inversion & Color Transfer)
// ============================================================================

struct SbVeggieSpatialColorField {
    std::vector<Vec3> positions;
    std::vector<Vec4> colors;

    bool empty() const { return positions.empty(); }

    void buildFromScan(const ScratchboxMesh& scanMesh, const Vec3& anchorOffset = Vec3(0, 0, 0)) {
        positions.clear();
        colors.clear();
        for (const auto& v : scanMesh.vertices) {
            positions.push_back(v.position - anchorOffset);
            colors.push_back(v.color);
        }
    }

    Vec4 sampleIDW(const Vec3& pt, int k = 4, float epsilon2 = 0.15f) const {
        if (positions.empty()) return Vec4(1.0f, 1.0f, 1.0f, 1.0f);
        if (positions.size() == 1) return colors[0];

        int actualK = std::min(k, static_cast<int>(positions.size()));
        struct Neighbor {
            float d2;
            int idx;
        };
        std::vector<Neighbor> top(actualK, {1e18f, -1});

        for (int i = 0; i < static_cast<int>(positions.size()); ++i) {
            Vec3 diff = positions[i] - pt;
            float d2 = diff.lengthSquared();
            if (d2 < top[actualK - 1].d2) {
                top[actualK - 1] = {d2, i};
                for (int j = actualK - 1; j > 0 && top[j].d2 < top[j - 1].d2; --j) {
                    std::swap(top[j], top[j - 1]);
                }
            }
        }

        float weightSum = 0.0f;
        Vec4 accum(0.0f, 0.0f, 0.0f, 0.0f);
        for (int i = 0; i < actualK; ++i) {
            if (top[i].idx < 0) continue;
            float w = 1.0f / (top[i].d2 + epsilon2);
            weightSum += w;
            accum = accum + colors[top[i].idx] * w;
        }

        if (weightSum > 1e-6f) {
            return accum * (1.0f / weightSum);
        }
        return colors[0];
    }
};

// ============================================================================
// 7. SB-Veggie Model Evaluator
// ============================================================================

class SbVeggieEvaluator {
public:
    struct SbVeggieDecomposedMesh {
        ScratchboxMesh woodMesh;
        ScratchboxMesh foliageMesh;
        std::vector<Vec3> posedJoints;

        ScratchboxMesh getCombined() const {
            ScratchboxMesh combined = woodMesh;
            if (!foliageMesh.vertices.empty()) {
                uint32_t baseIdx = static_cast<uint32_t>(combined.vertices.size());
                combined.vertices.insert(combined.vertices.end(), foliageMesh.vertices.begin(), foliageMesh.vertices.end());
                for (uint32_t idx : foliageMesh.indices) {
                    combined.indices.push_back(baseIdx + idx);
                }
            }
            combined.recomputeBounds();
            return combined;
        }
    };

    // Helper to mute chroma/saturation using standard Rec. 709 perceptual luminance weights
    static inline Vec4 muteSaturation(const Vec4& c, float satScale) {
        float lum = 0.2126f * c.x + 0.7152f * c.y + 0.0722f * c.z;
        return Vec4(
            std::clamp(lum + (c.x - lum) * satScale, 0.0f, 1.0f),
            std::clamp(lum + (c.y - lum) * satScale, 0.0f, 1.0f),
            std::clamp(lum + (c.z - lum) * satScale, 0.0f, 1.0f),
            c.w
        );
    }

    static SbVeggieDecomposedMesh evaluateDecomposed(
        const SbVeggieTemplate& tmpl,
        const SbVeggieParams& params,
        bool generateLeaves = true,
        const SbVeggieSpatialColorField* colorField = nullptr
    ) {
        SbVeggieDecomposedMesh result;
        result.woodMesh = ScratchboxMesh("SbVeggie_Botanical_Wood");
        result.woodMesh.material = tmpl.barkMaterial;
        result.woodMesh.material.name = "material_oak_bark";

        result.foliageMesh = ScratchboxMesh("SbVeggie_Botanical_Foliage");
        result.foliageMesh.material = tmpl.foliageMaterial;
        result.foliageMesh.material.name = "material_oak_foliage";
        result.foliageMesh.material.doubleSided = true;
        result.foliageMesh.material.alphaMode = "MASK";
        result.foliageMesh.material.alphaCutoff = 0.5f;

        size_t N = tmpl.canonicalVertices.size();
        size_t J = tmpl.skeleton.size();

        // 1. Forward Kinematics for Joints with Asymmetric Bough IK
        std::vector<Mat4> globalTransforms(J, Mat4::identity());
        std::vector<Vec3> posedJointPositions(J, Vec3(0, 0, 0));

        Quat scaffoldBoughQ[8];
        float scaffoldReach[8];
        for (int i = 0; i < 8; ++i) {
            int jIdx = 8 + i;
            float dAzim = params.scaffoldIK[i].azimuthOffset;
            float dElev = params.scaffoldIK[i].elevationOffset;
            scaffoldReach[i] = std::clamp(params.scaffoldIK[i].reachScale, 0.40f, 2.0f);

            // Determine base direction of scaffold from its parent in rest skeleton
            Vec3 vBase(1.0f, 0.5f, 0.0f);
            if (jIdx < static_cast<int>(tmpl.skeleton.size())) {
                int pId = tmpl.skeleton[jIdx].parentId;
                if (pId >= 0 && pId < static_cast<int>(tmpl.skeleton.size())) {
                    vBase = tmpl.skeleton[jIdx].restPosition - tmpl.skeleton[pId].restPosition;
                }
            }
            float baseAzim = std::atan2(vBase.z, vBase.x);
            Vec3 lateralAxis(-std::sin(baseAzim), 0.0f, std::cos(baseAzim));

            // Yaw around world Up (Y)
            Quat qYaw = Quat::fromAxisAngle(Vec3(0.0f, 1.0f, 0.0f), dAzim);
            // Pitch around rotated lateral axis
            Vec3 rotLateral = qYaw.rotate(lateralAxis);
            Quat qPitch = Quat::fromAxisAngle(rotLateral, dElev);
            scaffoldBoughQ[i] = qPitch * qYaw;
        }

        std::vector<Mat4> skinMatrices(J);

        // Evaluate joint local rotations theta + wind perturbation + Asymmetric Bough IK
        for (size_t j = 0; j < J; ++j) {
            const auto& joint = tmpl.skeleton[j];

            // Local pose rotation from theta Euler angles
            Vec3 rotEuler(0, 0, 0);
            if (j < params.theta.size()) {
                rotEuler = params.theta[j];
            }

            // Hierarchical Wind Deflection: higher branches oscillate more
            float heightRatio = std::clamp(joint.restPosition.y / 8.0f, 0.0f, 1.0f);
            if (params.windVector.lengthSquared() > 1e-4f) {
                float windPhase = params.windTimeSeconds * 2.8f + joint.restPosition.y * 0.45f;
                float gust = std::sin(windPhase) * 0.08f * heightRatio;
                rotEuler.x += params.windVector.z * gust;
                rotEuler.z += -params.windVector.x * gust;
            }

            Quat localQ = Quat::fromEuler(rotEuler);

            // Shape-induced joint offset
            Vec3 jointRest = joint.restPosition;
            for (int k = 0; k < 16; ++k) {
                if (k < static_cast<int>(tmpl.jointShapeOffsets.size()) &&
                    j < tmpl.jointShapeOffsets[k].size()) {
                    jointRest += tmpl.jointShapeOffsets[k][j] * params.beta[k];
                }
            }

            if (joint.parentId < 0) {
                // Root joint (0)
                Mat4 localTransform = Mat4::translation(jointRest) * QuatToMat4(localQ);
                globalTransforms[j] = Mat4::translation(params.translation) * localTransform;
            } else if (j >= 8 && j <= 15) {
                // Primary Scaffold Joint (8..15): Poses elbow and orients bough
                int scafIdx = static_cast<int>(j) - 8;
                Mat4 parentGlobal = globalTransforms[joint.parentId];
                Vec3 parentRest = tmpl.skeleton[joint.parentId].restPosition;
                for (int k = 0; k < 16; ++k) {
                    if (k < static_cast<int>(tmpl.jointShapeOffsets.size()) &&
                        joint.parentId < static_cast<int>(tmpl.jointShapeOffsets[k].size())) {
                        parentRest += tmpl.jointShapeOffsets[k][joint.parentId] * params.beta[k];
                    }
                }

                Vec3 deltaRest = jointRest - parentRest;
                Quat boughQ = scaffoldBoughQ[scafIdx];
                float reach = scaffoldReach[scafIdx];
                Vec3 posedDelta = boughQ.rotate(deltaRest * reach);

                Mat4 toParentLocal = Mat4::translation(posedDelta) * QuatToMat4(boughQ * localQ);
                globalTransforms[j] = parentGlobal * toParentLocal;
            } else {
                // Trunk spine (1..7) or descendant branches (16..111)
                Mat4 parentGlobal = globalTransforms[joint.parentId];
                Vec3 parentRest = tmpl.skeleton[joint.parentId].restPosition;
                for (int k = 0; k < 16; ++k) {
                    if (k < static_cast<int>(tmpl.jointShapeOffsets.size()) &&
                        joint.parentId < static_cast<int>(tmpl.jointShapeOffsets[k].size())) {
                        parentRest += tmpl.jointShapeOffsets[k][joint.parentId] * params.beta[k];
                    }
                }

                Vec3 deltaRest = jointRest - parentRest;

                // Descendant of a scaffold: scale branch segment by scaffold reach
                int scafIdx = -1;
                if (j < tmpl.jointScaffoldAncestor.size()) {
                    scafIdx = tmpl.jointScaffoldAncestor[j];
                }
                if (scafIdx >= 0 && scafIdx < 8) {
                    deltaRest = deltaRest * scaffoldReach[scafIdx];
                }

                Mat4 toParentLocal = Mat4::translation(deltaRest) * QuatToMat4(localQ);
                globalTransforms[j] = parentGlobal * toParentLocal;
            }

            posedJointPositions[j] = globalTransforms[j].transformPoint(Vec3(0, 0, 0));

            // Shape-aware Bind Matrix Inversion:
            // B_j^{-1}(beta) = translation(-J_j(beta)), transforming morphed rest vertices
            // directly into the shaped joint's local frame with zero double-scale drift.
            Mat4 shapedBindInv = Mat4::translation(jointRest).inverseRigid();
            skinMatrices[j] = globalTransforms[j] * shapedBindInv;
        }

        result.posedJoints = posedJointPositions;

        // 2. Vertex Morphing (Shape Space S_k) and Skinning (Linear Blend Skinning)
        result.woodMesh.vertices.resize(N);

        for (size_t v = 0; v < N; ++v) {
            const auto& canon = tmpl.canonicalVertices[v];

            // Apply 16 Morphological Shape Modes: v_morph = T_bar + sum(beta_k * S_k)
            Vec3 morphPos = canon.position;
            for (int k = 0; k < 16; ++k) {
                morphPos += tmpl.shapeBasis[k][v] * params.beta[k];
            }

            // Apply 4-Bone Linear Blend Skinning (LBS)
            const auto& sw = tmpl.skinWeights[v];
            Vec3 skinnedPos(0.0f, 0.0f, 0.0f);
            Vec3 skinnedNorm(0.0f, 0.0f, 0.0f);

            for (int w = 0; w < 4; ++w) {
                float weight = sw.weights[w];
                if (weight < 1e-4f) continue;

                uint32_t jIdx = sw.jointIndices[w];
                if (jIdx >= J) jIdx = 0;

                skinnedPos += skinMatrices[jIdx].transformPoint(morphPos) * weight;
                skinnedNorm += skinMatrices[jIdx].transformDirection(canon.normal) * weight;
            }

            result.woodMesh.vertices[v].position = skinnedPos;
            result.woodMesh.vertices[v].normal = skinnedNorm.normalized();
            result.woodMesh.vertices[v].uv = canon.uv;
            // Trunk and branches use authentic anatomical oak bark colors (canon.color)
            // and are NOT influenced by the green foliage of the tree canopy or scan.
            Vec4 woodColor = canon.color;
            if (params.saturationScale < 0.999f || params.saturationScale > 1.001f) {
                woodColor = muteSaturation(woodColor, params.saturationScale);
            }
            result.woodMesh.vertices[v].color = woodColor;
        }

        result.woodMesh.indices = tmpl.indices;
        result.woodMesh.recomputeBounds();

        // 3. Optional Foliage Generation (Anatomical Leaf Cards)
        if (generateLeaves && params.psi_season > 0.05f) {
            appendFoliageCards(result.foliageMesh, tmpl, posedJointPositions, params, colorField);
            result.foliageMesh.recomputeBounds();
        }

        return result;
    }

    static ScratchboxMesh evaluate(
        const SbVeggieTemplate& tmpl,
        const SbVeggieParams& params,
        bool generateLeaves = true,
        const SbVeggieSpatialColorField* colorField = nullptr
    ) {
        return evaluateDecomposed(tmpl, params, generateLeaves, colorField).getCombined();
    }

private:
    static Mat4 QuatToMat4(const Quat& q) {
        Mat4 m = Mat4::identity();
        float x = q.x, y = q.y, z = q.z, w = q.w;
        m.m[0] = 1.0f - 2.0f * (y * y + z * z);
        m.m[1] = 2.0f * (x * y + z * w);
        m.m[2] = 2.0f * (x * z - y * w);

        m.m[4] = 2.0f * (x * y - z * w);
        m.m[5] = 1.0f - 2.0f * (x * x + z * z);
        m.m[6] = 2.0f * (y * z + x * w);

        m.m[8] = 2.0f * (x * z + y * w);
        m.m[9] = 2.0f * (y * z - x * w);
        m.m[10] = 1.0f - 2.0f * (x * x + y * y);
        return m;
    }

    static void appendFoliageCards(
        ScratchboxMesh& mesh,
        const SbVeggieTemplate& tmpl,
        const std::vector<Vec3>& posedJoints,
        const SbVeggieParams& params,
        const SbVeggieSpatialColorField* colorField = nullptr
    ) {
        float heightScale = std::max(0.2f, 1.0f + 0.35f * params.beta[1]);
        float spreadScale = std::max(0.2f, 1.0f + 0.40f * params.beta[2]);
        float baseLeafSize = 0.28f * params.psi_leafScale * (0.85f + 0.15f * std::clamp(spreadScale, 0.5f, 2.5f));
        float crownAreaMult = std::clamp(spreadScale * (0.5f * heightScale + 0.5f * spreadScale), 0.5f, 3.5f);

        // Canopy bounding center for envelope normal calculation
        Vec3 crownCenter(params.translation.x, (3.8f + params.beta[3] * 0.5f) * heightScale + params.translation.y, params.translation.z);

        // NOAA Solar Ephemeris Direction (Authentic NYC afternoon sunlight vector)
        // Azimuth: 215 deg (SW), Elevation: 52 deg
        const Vec3 sunDir = Vec3(0.368f, 0.788f, -0.493f).normalized();

        for (size_t a = 0; a < tmpl.foliageAnchors.size(); ++a) {
            const auto& anchor = tmpl.foliageAnchors[a];
            if (anchor.attachedJointIndex >= static_cast<int>(posedJoints.size())) continue;

            // Twig / shoot segment start and end points in posed space
            Vec3 pChild = posedJoints[anchor.attachedJointIndex];
            Vec3 pParent = pChild;
            if (anchor.parentJointIndex >= 0 && anchor.parentJointIndex < static_cast<int>(posedJoints.size())) {
                pParent = posedJoints[anchor.parentJointIndex];
            } else {
                pParent = pChild - anchor.outwardDirection * 0.8f;
            }

            Vec3 shootVec = pChild - pParent;
            float shootLen = shootVec.length();
            Vec3 shootDir = shootLen > 1e-4f ? shootVec / shootLen : anchor.outwardDirection;

            // Continuous station origin along branch shoot
            Vec3 anchorPos = pParent + shootDir * (shootLen * anchor.shootStation) + anchor.localOffset * spreadScale;

            // Reference frames for radial phyllotaxis around shoot axis
            Vec3 perp1 = shootDir.cross(Vec3(0, 1, 0));
            if (perp1.lengthSquared() < 0.01f) perp1 = shootDir.cross(Vec3(1, 0, 0));
            perp1 = perp1.normalized();
            Vec3 perp2 = shootDir.cross(perp1).normalized();

            int count = static_cast<int>(anchor.leafCount * params.psi_leafDensity * crownAreaMult);
            if (params.psi_season < 0.70f) {
                // Autumn partial defoliation
                count = static_cast<int>(count * std::clamp(params.psi_season / 0.70f, 0.15f, 1.0f));
            }
            count = std::max(1, count);

            float clusterRadius = anchor.clusterRadius * spreadScale * (anchor.isTerminalTwig ? 1.15f : 0.92f);

            for (int i = 0; i < count; ++i) {
                // 1. Volumetric botanical shootlet spray branching:
                // From the branch node / anchor station, 4 fine shootlet axes fan outward in 3D
                int subShoot = i % 4;
                float subShootPhase = subShoot * (PI * 0.5f) + anchor.attachedJointIndex * 1.3f;
                Vec3 subShootDir = (shootDir * 0.48f + (perp1 * std::cos(subShootPhase) + perp2 * std::sin(subShootPhase)) * 0.72f + Vec3(0, 0.28f, 0)).normalized();

                // Continuous radial reach along sub-shoot spray with cluster cloud envelope
                float reachFraction = std::pow(static_cast<float>(i + 0.5f) / count, 0.58f);
                float reachDist = reachFraction * clusterRadius;

                // Micro-jitter to prevent artificial linear alignment
                float microJitter = std::sin(i * 3.7f + a * 1.9f) * (0.14f * clusterRadius);
                Vec3 twigNode = anchorPos + subShootDir * reachDist + (perp1 * std::sin(i * 1.7f) + perp2 * std::cos(i * 2.3f)) * microJitter;

                // 2. Petiole emergence vector: combines outward cluster dispersion + phyllotactic roll + phototropism
                Vec3 outCluster = (twigNode - anchorPos);
                float outLen = outCluster.length();
                Vec3 outDir = (outLen > 1e-4f) ? outCluster / outLen : subShootDir;

                float roll = i * 2.39996f + anchor.attachedJointIndex * 1.618f + a * 0.73f;
                Vec3 lateral = (perp1 * std::cos(roll) + perp2 * std::sin(roll)).normalized();

                Vec3 petioleDir = (outDir * 0.50f + lateral * 0.38f + Vec3(0.0f, 0.38f, 0.0f)).normalized();
                float petioleLen = baseLeafSize * 0.38f * (0.85f + 0.30f * std::sin(i * 2.1f + a * 1.7f));

                Vec3 petioleStemBase = twigNode;
                Vec3 petioleTip = twigNode + petioleDir * petioleLen;

                // 3. Leaf blade orientation at petiole tip
                Vec3 leafRachis = (petioleDir * 0.68f + outDir * 0.28f + Vec3(0.0f, 0.22f, 0.0f)).normalized();

                // Transferred envelope normal for soft hemispherical illumination
                Vec3 toEnv = (petioleTip - crownCenter);
                float envDist = toEnv.length();
                Vec3 normal = (envDist > 1e-4f ? toEnv / envDist : Vec3(0, 1, 0)) + Vec3(0.0f, 0.40f, 0.0f);
                normal = normal.normalized();

                Vec3 bitangent = normal.cross(leafRachis).normalized();
                Vec3 tangent = leafRachis;

                // Leaf card scale jitter (+/- 20% organic variance)
                float scaleJitter = 0.85f + 0.30f * std::sin(i * 1.7f + a * 3.1f);
                float leafWidth = baseLeafSize * scaleJitter;
                float leafHeight = baseLeafSize * scaleJitter * 1.15f;

                // ================================================================
                // 4. Native C++20 Optical Physics: Canopy Ambient Occlusion & Subsurface Scattering (SSS)
                // ================================================================
                float distFromCenter = std::sqrt(petioleTip.x * petioleTip.x + petioleTip.z * petioleTip.z);
                float crownRadius = 4.2f * spreadScale;
                float radialRatio = std::clamp(distFromCenter / crownRadius, 0.25f, 1.0f);
                float crownBaseY = 2.0f * heightScale;
                float crownTopY = (tmpl.skeleton[7].restPosition.y + 2.5f) * heightScale;
                float heightRatio = std::clamp((petioleTip.y - crownBaseY) / std::max(1.0f, crownTopY - crownBaseY), 0.20f, 1.0f);
                float ambientOcclusion = std::clamp(radialRatio * 0.55f + heightRatio * 0.45f, 0.28f, 1.0f);

                // Direct sunlight diffuse cosine
                float nDotL = normal.dot(sunDir);
                float directSun = std::max(0.0f, nDotL);

                // Subsurface Scattering (SSS) Backlight Transmission:
                // When looking at the leaf towards the sun (backlit), light penetrates the mesophyll layer
                float backLight = std::max(0.0f, -nDotL);
                float sssTransmittance = std::pow(backLight, 1.5f);

                Vec4 leafColor;
                Vec4 undersideColor;
                float leafJitter = 0.94f + 0.12f * std::sin(a * 1.3f + i * 0.7f);

                if (params.psi_season >= 0.70f) {
                    // Summer Lush Foliage:
                    // Base chlorophyll albedo: natural muted oak green
                    Vec4 albedo(0.18f, 0.32f, 0.16f, 1.0f);
                    // SSS transmitted backlit glow: soft natural foliage glow
                    Vec4 sssGlow(0.30f, 0.50f, 0.22f, 1.0f);

                    albedo.x *= leafJitter;
                    albedo.y *= leafJitter;
                    albedo.z *= leafJitter;

                    float litIntensity = ambientOcclusion * 0.48f + directSun * 0.52f;
                    float transIntensity = sssTransmittance * 0.32f * ambientOcclusion;

                    leafColor = Vec4(
                        std::clamp(albedo.x * litIntensity + sssGlow.x * transIntensity, 0.05f, 0.65f),
                        std::clamp(albedo.y * litIntensity + sssGlow.y * transIntensity, 0.10f, 0.70f),
                        std::clamp(albedo.z * litIntensity + sssGlow.z * transIntensity, 0.03f, 0.55f),
                        1.0f
                    );

                    // Glaucous Underside with SSS forward transmission through the blade
                    Vec4 underAlbedo(0.22f, 0.36f, 0.20f, 1.0f);
                    float throughSun = std::pow(std::max(0.0f, nDotL), 1.3f);
                    float underLit = ambientOcclusion * 0.40f;
                    float underTrans = throughSun * 0.40f * ambientOcclusion;

                    undersideColor = Vec4(
                        std::clamp(underAlbedo.x * underLit + sssGlow.x * underTrans, 0.05f, 0.60f),
                        std::clamp(underAlbedo.y * underLit + sssGlow.y * underTrans, 0.12f, 0.68f),
                        std::clamp(underAlbedo.z * underLit + sssGlow.z * underTrans, 0.04f, 0.50f),
                        1.0f
                    );
                } else if (params.psi_season >= 0.25f) {
                    // Autumn Phenology (Carotenoids / Anthocyanins)
                    float hueVariation = std::sin(i * 0.85f + a * 2.1f);
                    Vec4 fallAlbedo;
                    Vec4 fallSssGlow;
                    if (hueVariation > 0.25f) {
                        // Golden Sugar Maple Yellow
                        fallAlbedo = Vec4(0.85f, 0.65f, 0.12f, 1.0f);
                        fallSssGlow = Vec4(0.98f, 0.85f, 0.22f, 1.0f);
                    } else if (hueVariation > -0.35f) {
                        // Amber Russet Orange
                        fallAlbedo = Vec4(0.82f, 0.38f, 0.08f, 1.0f);
                        fallSssGlow = Vec4(0.95f, 0.55f, 0.14f, 1.0f);
                    } else {
                        // Deep Scarlet / Crimson
                        fallAlbedo = Vec4(0.70f, 0.16f, 0.09f, 1.0f);
                        fallSssGlow = Vec4(0.92f, 0.30f, 0.15f, 1.0f);
                    }
                    float litIntensity = ambientOcclusion * 0.50f + directSun * 0.50f;
                    float transIntensity = sssTransmittance * 0.40f * ambientOcclusion;
                    leafColor = Vec4(
                        std::clamp(fallAlbedo.x * litIntensity + fallSssGlow.x * transIntensity, 0.05f, 0.90f),
                        std::clamp(fallAlbedo.y * litIntensity + fallSssGlow.y * transIntensity, 0.05f, 0.85f),
                        std::clamp(fallAlbedo.z * litIntensity + fallSssGlow.z * transIntensity, 0.03f, 0.50f),
                        1.0f
                    );
                    undersideColor = Vec4(leafColor.x * 0.92f, leafColor.y * 0.88f, leafColor.z * 0.75f, 1.0f);
                } else {
                    // Winter residue
                    leafColor = Vec4(0.42f * ambientOcclusion, 0.26f * ambientOcclusion, 0.14f * ambientOcclusion, 1.0f);
                    undersideColor = leafColor * 0.85f;
                }

                // Query photogrammetric scan color influence if enabled
                if (colorField && !colorField->empty() && params.colorInfluenceWeight > 0.0f) {
                    Vec4 scanCol = colorField->sampleIDW(petioleTip, 4, 0.20f);
                    float w = std::clamp(params.colorInfluenceWeight, 0.0f, 1.0f);
                    
                    // The aerial scan color already embodies real-world chlorophyll and natural light
                    // Modulate by subtle leaf jitter and soft canopy cavity shading
                    float canopyCavity = 0.70f + 0.30f * ambientOcclusion;
                    Vec4 scanAlbedo(
                        scanCol.x * leafJitter * canopyCavity,
                        scanCol.y * leafJitter * canopyCavity,
                        scanCol.z * leafJitter * canopyCavity,
                        1.0f
                    );

                    // Blend base leaf color toward authentic map tile scan albedo
                    leafColor = leafColor * (1.0f - w) + scanAlbedo * w;
                    leafColor.w = 1.0f;

                    // Underside is slightly lighter with glaucous wax
                    Vec4 scanUnder(
                        scanCol.x * canopyCavity * 0.95f,
                        scanCol.y * canopyCavity * 1.00f,
                        scanCol.z * canopyCavity * 0.92f,
                        1.0f
                    );
                    undersideColor = undersideColor * (1.0f - w) + scanUnder * w;
                    undersideColor.w = 1.0f;
                }

                // Mute saturation a tad according to params.saturationScale
                if (params.saturationScale < 0.999f || params.saturationScale > 1.001f) {
                    leafColor = muteSaturation(leafColor, params.saturationScale);
                    undersideColor = muteSaturation(undersideColor, params.saturationScale);
                }

                auto calcNormal = [&](const Vec3& pt, const Vec3& geomN) {
                    if (!params.transferEnvelopeNormals) return geomN.normalized();
                    Vec3 toPt = pt - crownCenter;
                    float d = toPt.length();
                    Vec3 envRad = d > 1e-4f ? toPt / d : Vec3(0, 1, 0);
                    Vec3 envSky = (envRad + Vec3(0.0f, 0.22f, 0.0f)).normalized();
                    return (geomN * 0.35f + envSky * 0.65f).normalized();
                };

                uint32_t baseIdx = static_cast<uint32_t>(mesh.vertices.size());

                if (params.leafMorphology == 0) {
                    // 3D Anatomical Lobed Leaf Blade with Parabolic Cupping and Sunken Midrib
                    float cup = leafWidth * 0.22f * params.leafCupping;
                    float midribSink = leafWidth * 0.10f * params.leafCupping;
                    float droop = leafHeight * 0.18f * params.leafCupping;

                    Vec3 v0_pos = petioleTip;
                    Vec3 v1_pos = petioleTip + tangent * (leafHeight * 0.45f) - bitangent * (leafWidth * 0.55f) + normal * cup;
                    Vec3 v2_pos = petioleTip + tangent * (leafHeight * 0.45f) - normal * midribSink;
                    Vec3 v3_pos = petioleTip + tangent * (leafHeight * 0.45f) + bitangent * (leafWidth * 0.55f) + normal * cup;
                    Vec3 v4_pos = petioleTip + tangent * leafHeight - normal * droop;
                    Vec3 v5_pos = petioleTip + tangent * (leafHeight * 0.75f) - normal * (midribSink * 0.75f);

                    Vec3 n0 = calcNormal(v0_pos, normal);
                    Vec3 n1 = calcNormal(v1_pos, normal - bitangent * 0.35f);
                    Vec3 n2 = calcNormal(v2_pos, normal);
                    Vec3 n3 = calcNormal(v3_pos, normal + bitangent * 0.35f);
                    Vec3 n4 = calcNormal(v4_pos, normal + tangent * 0.35f);
                    Vec3 n5 = calcNormal(v5_pos, normal);

                    // Upper Waxy Cuticle (Front Faces)
                    mesh.vertices.push_back(Vertex{v0_pos, n0, Vec2(0.5f, 0.0f), leafColor});
                    mesh.vertices.push_back(Vertex{v1_pos, n1, Vec2(0.0f, 0.35f), leafColor});
                    mesh.vertices.push_back(Vertex{v2_pos, n2, Vec2(0.5f, 0.35f), leafColor});
                    mesh.vertices.push_back(Vertex{v3_pos, n3, Vec2(1.0f, 0.35f), leafColor});
                    mesh.vertices.push_back(Vertex{v4_pos, n4, Vec2(0.5f, 1.0f), leafColor});
                    mesh.vertices.push_back(Vertex{v5_pos, n5, Vec2(0.5f, 0.70f), leafColor});

                    mesh.indices.push_back(baseIdx + 0); mesh.indices.push_back(baseIdx + 1); mesh.indices.push_back(baseIdx + 2);
                    mesh.indices.push_back(baseIdx + 0); mesh.indices.push_back(baseIdx + 2); mesh.indices.push_back(baseIdx + 3);
                    mesh.indices.push_back(baseIdx + 2); mesh.indices.push_back(baseIdx + 1); mesh.indices.push_back(baseIdx + 5);
                    mesh.indices.push_back(baseIdx + 2); mesh.indices.push_back(baseIdx + 5); mesh.indices.push_back(baseIdx + 3);
                    mesh.indices.push_back(baseIdx + 5); mesh.indices.push_back(baseIdx + 1); mesh.indices.push_back(baseIdx + 4);
                    mesh.indices.push_back(baseIdx + 5); mesh.indices.push_back(baseIdx + 4); mesh.indices.push_back(baseIdx + 3);

                    // Glaucous Underside (Back Faces with Inverted Normals & Translucent Shading)
                    uint32_t underBase = baseIdx + 6;
                    mesh.vertices.push_back(Vertex{v0_pos, -n0, Vec2(0.5f, 0.0f), undersideColor});
                    mesh.vertices.push_back(Vertex{v1_pos, -n1, Vec2(0.0f, 0.35f), undersideColor});
                    mesh.vertices.push_back(Vertex{v2_pos, -n2, Vec2(0.5f, 0.35f), undersideColor});
                    mesh.vertices.push_back(Vertex{v3_pos, -n3, Vec2(1.0f, 0.35f), undersideColor});
                    mesh.vertices.push_back(Vertex{v4_pos, -n4, Vec2(0.5f, 1.0f), undersideColor});
                    mesh.vertices.push_back(Vertex{v5_pos, -n5, Vec2(0.5f, 0.70f), undersideColor});

                    mesh.indices.push_back(underBase + 0); mesh.indices.push_back(underBase + 2); mesh.indices.push_back(underBase + 1);
                    mesh.indices.push_back(underBase + 0); mesh.indices.push_back(underBase + 3); mesh.indices.push_back(underBase + 2);
                    mesh.indices.push_back(underBase + 2); mesh.indices.push_back(underBase + 5); mesh.indices.push_back(underBase + 1);
                    mesh.indices.push_back(underBase + 2); mesh.indices.push_back(underBase + 3); mesh.indices.push_back(underBase + 5);
                    mesh.indices.push_back(underBase + 5); mesh.indices.push_back(underBase + 4); mesh.indices.push_back(underBase + 1);
                    mesh.indices.push_back(underBase + 5); mesh.indices.push_back(underBase + 3); mesh.indices.push_back(underBase + 4);

                    // Slender Woody Petiole connecting twig node directly to leaf base
                    Vec3 petioleWidth = bitangent * (leafWidth * 0.045f);
                    Vec4 petioleColor(0.32f, 0.22f, 0.15f, 1.0f);
                    uint32_t petBaseIdx = static_cast<uint32_t>(mesh.vertices.size());

                    mesh.vertices.push_back(Vertex{petioleStemBase - petioleWidth, normal, Vec2(0.5f, 0.01f), petioleColor});
                    mesh.vertices.push_back(Vertex{petioleStemBase + petioleWidth, normal, Vec2(0.5f, 0.01f), petioleColor});
                    mesh.vertices.push_back(Vertex{petioleTip + petioleWidth, normal, Vec2(0.5f, 0.05f), petioleColor});
                    mesh.vertices.push_back(Vertex{petioleTip - petioleWidth, normal, Vec2(0.5f, 0.05f), petioleColor});

                    mesh.indices.push_back(petBaseIdx + 0); mesh.indices.push_back(petBaseIdx + 1); mesh.indices.push_back(petBaseIdx + 2);
                    mesh.indices.push_back(petBaseIdx + 0); mesh.indices.push_back(petBaseIdx + 2); mesh.indices.push_back(petBaseIdx + 3);
                } else {
                    // Planar Quad Fallback with Envelope Normals
                    Vec3 p0 = petioleTip - bitangent * (leafWidth * 0.5f);
                    Vec3 p1 = petioleTip + bitangent * (leafWidth * 0.5f);
                    Vec3 p2 = petioleTip + tangent * leafHeight + bitangent * (leafWidth * 0.5f);
                    Vec3 p3 = petioleTip + tangent * leafHeight - bitangent * (leafWidth * 0.5f);

                    Vec3 n0 = calcNormal(p0, normal - bitangent * 0.25f);
                    Vec3 n1 = calcNormal(p1, normal + bitangent * 0.25f);
                    Vec3 n2 = calcNormal(p2, normal + tangent * 0.25f + bitangent * 0.25f);
                    Vec3 n3 = calcNormal(p3, normal + tangent * 0.25f - bitangent * 0.25f);

                    mesh.vertices.push_back(Vertex{p0, n0, Vec2(0, 0), leafColor});
                    mesh.vertices.push_back(Vertex{p1, n1, Vec2(1, 0), leafColor});
                    mesh.vertices.push_back(Vertex{p2, n2, Vec2(1, 1), leafColor});
                    mesh.vertices.push_back(Vertex{p3, n3, Vec2(0, 1), leafColor});

                    mesh.indices.push_back(baseIdx + 0);
                    mesh.indices.push_back(baseIdx + 1);
                    mesh.indices.push_back(baseIdx + 2);

                    mesh.indices.push_back(baseIdx + 0);
                    mesh.indices.push_back(baseIdx + 2);
                    mesh.indices.push_back(baseIdx + 3);
                }
            }
        }
    }
};


} // namespace sb_veggie

// Backward-compatible type aliases for legacy code
namespace smpl_tree {
    using namespace sb_veggie;
    using SmplTreeArchetype = sb_veggie::SbVeggieArchetype;
    using SmplTreeJoint = sb_veggie::SbVeggieJoint;
    using SmplSkinWeight = sb_veggie::SbVeggieSkinWeight;
    using SmplFoliageAnchor = sb_veggie::SbVeggieFoliageAnchor;
    using SmplTreeTemplate = sb_veggie::SbVeggieTemplate;
    using SmplScaffoldIK = sb_veggie::SbVeggieScaffoldIK;
    using SmplTreeParams = sb_veggie::SbVeggieParams;
    using SmplTreeModelBuilder = sb_veggie::SbVeggieModelBuilder;
    using SmplSpatialColorField = sb_veggie::SbVeggieSpatialColorField;
    using SmplTreeEvaluator = sb_veggie::SbVeggieEvaluator;
    using SmplTreeDecomposedMesh = sb_veggie::SbVeggieEvaluator::SbVeggieDecomposedMesh;
} // namespace smpl_tree

namespace sb_veggie {
    using SbVeggieDecomposedMesh = SbVeggieEvaluator::SbVeggieDecomposedMesh;
}

namespace veggie = sb_veggie;

} // namespace scratchbox

#endif // SCRATCHBOX_SB_VEGGIE_HPP
