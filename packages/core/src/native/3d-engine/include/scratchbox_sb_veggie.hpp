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
// 1. Continuous Morphology (no archetype classes)
// ============================================================================
//
// Tree form is a point in a continuous space; no field below names a kind of tree, and nothing branches on a name. A
// columnar crown, a spreading one and a conical one differ in these numbers (and the measured crown they grow into),
// and any value between them is as valid as the ends.

/** A leaf blade's outline, in continuous quantities. */
struct SbVeggieBlade {
    float widthRatio{0.70f};           // blade width / blade length
    float outlineA{0.55f};             // half-width profile t^a (1 - t)^b along the blade: a sets how far the widest point lies from the base ...
    float outlineB{0.75f};             // ... and b how it tapers to the tip
    float lobeCount{0.0f};             // lobes along the margin (cosine terms); no effect at depth 0
    float lobeDepth{0.0f};             // lobe amplitude as a share of the half-width (0 = entire margin)
    float serrationCount{0.0f};        // teeth along the margin
    float serrationDepth{0.0f};        // tooth amplitude as a share of the half-width (0 = entire margin)
    int rows{3};                       // interior rows of the outline (resolution: lobes and teeth need more rows than a plain blade)
    float undersideNormalBlend{0.7f};  // underside normals: 0 the flipped upper normals ... 1 the upper side's
    float petioleRatio{0.38f};         // petiole length / blade length (0: none drawn)
};

/** How a tree grows and carries its leaves. All continuous; defaults are the neutral values the canonical template was drawn with. */
struct SbVeggieMorphology {
    float apicalDominance{0.5f};       // 0..1: how far the leader outgrows the laterals (a grown tree: the momentum of a branch along its heading, 0.76 x this, and how firmly its leader holds its course to the apex, tile_vegetation GrowthParams::excurrentApical)
    float branchAngleMeanRad{0.80795f};// mean angle of laterals from the leader (atan2(0.68, 0.65): the direction scaffold limbs have always sprouted in)
    float branchAngleSpreadRad{0.2f};  // spread of that angle: between crowns and (half of it) between the limbs of one
    float crownAspect{1.0f};           // crown height / crown width (1 = the canonical template; a grown tree has the aspect of its measured crown)
    float internodeLengthM{0.0f};      // distance between successive nodes along a shoot (0: the grower derives it from the tree's height)
    float leafDistributionExponent{0.58f}; // along a shoot, a leaf sits at ((i + 0.5) / n)^exponent of the reach: below 1 it crowds towards the tip
    float divergenceAngleRad{2.39996f};    // angle between successive leaves around the shoot (the golden angle, 137.5 degrees, by default)
    SbVeggieBlade blade;
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
    std::string name{"Canonical_Template"};
    
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
    SbVeggieMorphology morphology;      // leaf outline, leaf distribution and divergence along a shoot (continuous)
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
    static SbVeggieTemplate buildCanonicalTemplate(const SbVeggieMorphology& morphology = SbVeggieMorphology{}) {
        SbVeggieTemplate tmpl;

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
        // crown width follows crownAspect (height / width): every joint past the trunk spine is drawn closer to or further
        // from the trunk axis (the canonical template is 1)
        const float crownWidthScale = 1.0f / std::max(0.2f, morphology.crownAspect);
        auto addJoint = [&](int id, int parentId, const std::string& name, const Vec3& drawn) {
            const Vec3 pos = id >= 8 ? Vec3(drawn.x * crownWidthScale, drawn.y, drawn.z * crownWidthScale) : drawn;
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

            // trunkRadial + 1 columns: the last is the seam, at the first's angle (same position and normal) but u = 1,
            // so the bark's last strip runs from (n-1)/n to 1 instead of wrapping back to 0
            for (int s = 0; s <= trunkRadial; ++s) {
                float angle = (static_cast<float>(s % trunkRadial) / trunkRadial) * TWO_PI;

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

        // Trunk Quad Triangulation: the ring turns from +x towards +z, clockwise seen from above, so each quad is wound
        // i00, i11, i10 to turn counter-clockwise about its outward normals
        const int trunkColumns = trunkRadial + 1;
        for (int r = 0; r < trunkRings; ++r) {
            for (int s = 0; s < trunkRadial; ++s) {
                uint32_t i00 = r * trunkColumns + s;
                uint32_t i10 = r * trunkColumns + s + 1;
                uint32_t i01 = (r + 1) * trunkColumns + s;
                uint32_t i11 = (r + 1) * trunkColumns + s + 1;

                tmpl.indices.push_back(i00); tmpl.indices.push_back(i11); tmpl.indices.push_back(i10);
                tmpl.indices.push_back(i00); tmpl.indices.push_back(i01); tmpl.indices.push_back(i11);
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

                // radial + 1 columns: the last is the seam, at the first's angle (same position and normal) but u = 1
                for (int s = 0; s <= radial; ++s) {
                    float a = (static_cast<float>(s % radial) / radial) * TWO_PI;

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

            const int columns = radial + 1;
            for (int r = 0; r < rings; ++r) {
                for (int s = 0; s < radial; ++s) {
                    uint32_t i00 = branchStartVertex + r * columns + s;
                    uint32_t i10 = branchStartVertex + r * columns + s + 1;
                    uint32_t i01 = branchStartVertex + (r + 1) * columns + s;
                    uint32_t i11 = branchStartVertex + (r + 1) * columns + s + 1;

                    tmpl.indices.push_back(i00); tmpl.indices.push_back(i10); tmpl.indices.push_back(i11);
                    tmpl.indices.push_back(i00); tmpl.indices.push_back(i11); tmpl.indices.push_back(i01);
                }
            }

            // Hemispherical cap at branch tip for 100% watertight manifold integrity
            if (addCap) {
                uint32_t capCenterIdx = static_cast<uint32_t>(tmpl.canonicalVertices.size());
                uint32_t lastRingStart = branchStartVertex + rings * columns;
                Vec3 endDir = (endPos - midPoint).normalized();
                Vec3 capCenter = endPos + endDir * (rEnd * 0.5f);
                // the centre continues the tube's v (2.5 over the branch) past the last ring, so the fan's UVs turn the
                // same way as the tube's
                float capSlant = (capCenter - tmpl.canonicalVertices[lastRingStart].position).length();
                float capV = 2.5f * (1.0f + capSlant / std::max(branchLen, 1e-4f));
                tmpl.canonicalVertices.push_back(Vertex{capCenter, endDir, Vec2(0.5f, capV), color});

                SbVeggieSkinWeight capSw;
                capSw.jointIndices[0] = childJointIdx; capSw.weights[0] = 1.0f;
                tmpl.skinWeights.push_back(capSw);

                for (int s = 0; s < radial; ++s) {
                    tmpl.indices.push_back(lastRingStart + s);
                    tmpl.indices.push_back(lastRingStart + s + 1);
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
// 6A. Leaf Blades & Leaf Clusters (template-free foliage library)
// ============================================================================
//
// One blade outline generator serves the template's foliage cards and the standalone leaf clusters below. A blade is
// described by continuous quantities only (width ratio, where the widest point lies and how it rounds, lobes,
// serration, cupping); there is no leaf class to pick, and nothing here branches on a name.

/** A blade placed in space: its petiole, and the frame its blade lies in. */
struct SbVeggieBladePlacement {
    Vec3 petioleBase;      // where the petiole leaves the twig
    Vec3 petioleTip;       // where the blade starts
    Vec3 tangent;          // rachis direction (unit), base to tip
    Vec3 bitangent;        // across the blade (unit)
    Vec3 normal;           // upper side (unit)
    float lengthM{0.1f};   // blade length base to tip
};

/** One vertex of a generated blade. `underside` marks the back faces, `petiole` the stalk. */
struct SbVeggieBladeVertex {
    Vec3 position, normal;
    Vec2 uv;
    bool underside{false};
    bool petiole{false};
};

class SbVeggieBladeBuilder {
public:
    /**
     * Appends one blade (upper side, underside, optional petiole quad) to `verts` / `indices`. The outline is an ovate
     * half-width profile t^a (1 - t)^b over `rows` interior rows of the card's frame, modulated by lobes and serration
     * (cosine terms of continuous depth; depth 0 leaves the margin entire), cupped by `cupping` with a sunken midrib and
     * a drooping tip. The first indices appended are the blade (both sides), the petiole's two triangles last.
     * Returns the number of blade triangles (both sides, without the petiole).
     */
    static size_t append(const SbVeggieBlade& b, const SbVeggieBladePlacement& pl, float cupping,
                         std::vector<SbVeggieBladeVertex>& verts, std::vector<uint32_t>& indices, bool withPetiole = true) {
        const int R = std::max(0, b.rows);
        const float L = pl.lengthM;
        const float W = std::max(1e-4f, b.widthRatio) * L;
        auto ovate = [&](float t) { return std::pow(std::max(1e-4f, t), b.outlineA) * std::pow(std::max(1e-4f, 1.0f - t), b.outlineB); };
        float ovMax = 1e-6f;
        for (int k = 1; k < 100; ++k) ovMax = std::max(ovMax, ovate(k / 100.0f));
        const float cup = 0.20f * W * cupping, sink = 0.09f * W * cupping, droop = 0.17f * L * cupping;
        auto halfWidth = [&](float t) {
            float h = 0.5f * W * ovate(t) / ovMax;
            if (b.lobeDepth > 0.0f && b.lobeCount > 0.0f) h *= 1.0f + b.lobeDepth * std::cos(TWO_PI * b.lobeCount * t);
            if (b.serrationDepth > 0.0f && b.serrationCount > 0.0f) h *= 1.0f + b.serrationDepth * (2.0f * (b.serrationCount * t - std::floor(b.serrationCount * t)) - 1.0f);
            return std::max(0.0f, h);
        };
        const Vec3 origin = pl.petioleTip;
        std::vector<Vec3> P;
        std::vector<uint32_t> tri;
        P.push_back(origin);
        if (R == 0) {
            // no interior rows: a kite, the widest point at the outline's own widest t, folded along the midrib by the cupping
            float tMax = 0.45f, best = 0.0f;
            for (int k = 1; k < 100; ++k) { const float v = ovate(k / 100.0f); if (v > best) { best = v; tMax = k / 100.0f; } }
            const float h = halfWidth(tMax);
            const Vec3 along = origin + pl.tangent * (L * tMax) - pl.normal * (droop * tMax * tMax);
            P.push_back(along - pl.bitangent * h + pl.normal * cup);
            P.push_back(along + pl.bitangent * h + pl.normal * cup);
            P.push_back(origin + pl.tangent * L - pl.normal * droop);
            tri = {0u, 1u, 2u, 1u, 3u, 2u};
        } else {
            for (int k = 1; k <= R; ++k) {
                const float t = static_cast<float>(k) / (R + 1);
                const float h = halfWidth(t);
                const float edge = cup * (h / (0.5f * W)) * (h / (0.5f * W));
                const Vec3 along = origin + pl.tangent * (L * t) - pl.normal * (droop * t * t);
                P.push_back(along - pl.bitangent * h + pl.normal * edge);
                P.push_back(along - pl.normal * (sink * (1.0f - 0.5f * t)));
                P.push_back(along + pl.bitangent * h + pl.normal * edge);
            }
            P.push_back(origin + pl.tangent * L - pl.normal * droop);
            const uint32_t T = static_cast<uint32_t>(P.size() - 1);
            auto Lk = [&](int k) { return static_cast<uint32_t>(1 + 3 * (k - 1)); };
            tri = {0u, Lk(1), Lk(1) + 1, 0u, Lk(1) + 1, Lk(1) + 2};
            for (int k = 1; k < R; ++k) {
                const uint32_t l0 = Lk(k), m0 = l0 + 1, r0 = l0 + 2, l1 = Lk(k + 1), m1 = l1 + 1, r1 = l1 + 2;
                tri.insert(tri.end(), {l0, l1, m1, l0, m1, m0, m0, m1, r1, m0, r1, r0});
            }
            const uint32_t lr = Lk(R), mr = lr + 1, rr = lr + 2;
            tri.insert(tri.end(), {mr, lr, T, mr, T, rr});
        }
        // smooth normals of the upper side (area weighted), oriented to the blade's upper side
        std::vector<Vec3> N(P.size(), Vec3(0, 0, 0));
        for (size_t i = 0; i + 2 < tri.size(); i += 3) {
            const Vec3 f = (P[tri[i + 1]] - P[tri[i]]).cross(P[tri[i + 2]] - P[tri[i]]);
            for (int j = 0; j < 3; ++j) N[tri[i + static_cast<size_t>(j)]] += f;
        }
        for (auto& n : N) {
            n = n.lengthSquared() > 1e-18f ? n.normalized() : pl.normal;
            if (n.dot(pl.normal) < 0.0f) n = n * -1.0f;
        }
        const float tv = static_cast<float>(R + 1);
        auto uvOf = [&](size_t q) {
            if (q == 0) return Vec2(0.5f, 0.0f);
            if (q == P.size() - 1) return Vec2(0.5f, 1.0f);
            if (R == 0) return Vec2(q == 1 ? 0.0f : 1.0f, 0.45f);
            const int row = static_cast<int>((q - 1) / 3) + 1, col = static_cast<int>((q - 1) % 3);
            return Vec2(0.5f * col, row / tv);
        };
        // appends a triangle wound counter-clockwise about its vertices' own normals
        auto pushFacingNormals = [&](uint32_t i0, uint32_t i1, uint32_t i2) {
            const Vec3 f = (verts[i1].position - verts[i0].position).cross(verts[i2].position - verts[i0].position);
            const Vec3 n = verts[i0].normal + verts[i1].normal + verts[i2].normal;
            if (f.dot(n) >= 0.0f) indices.insert(indices.end(), {i0, i1, i2});
            else indices.insert(indices.end(), {i0, i2, i1});
        };
        uint32_t base = static_cast<uint32_t>(verts.size());
        for (size_t q = 0; q < P.size(); ++q) verts.push_back(SbVeggieBladeVertex{P[q], N[q], uvOf(q), false, false});
        indices.insert(indices.end(), tri.begin(), tri.end());
        // the upper side's indices are relative to its own vertices
        for (size_t i = indices.size() - tri.size(); i < indices.size(); ++i) indices[i] += base;
        const uint32_t underBase = static_cast<uint32_t>(verts.size());
        for (size_t q = 0; q < P.size(); ++q) {
            // the underside keeps the upper side's normal where a leaf is lit through (undersideNormalBlend 1) and
            // the flipped one where it is seen from below (0)
            Vec3 nb = N[q] * -(1.0f - b.undersideNormalBlend) + N[q] * b.undersideNormalBlend;
            nb = nb.lengthSquared() < 1e-6f ? N[q] : nb.normalized();
            verts.push_back(SbVeggieBladeVertex{P[q], nb, uvOf(q), true, false});
        }
        // the underside's triangles face the way its normals do: down with the flipped normals, up with the upper side's
        for (size_t i = 0; i + 2 < tri.size(); i += 3) pushFacingNormals(underBase + tri[i], underBase + tri[i + 1], underBase + tri[i + 2]);
        const size_t bladeTriangles = tri.size() / 3 * 2;
        if (withPetiole && b.petioleRatio > 0.0f) {
            // the petiole: one triangle, as wide as a stalk at the twig and a point at the blade
            const Vec3 w = pl.bitangent * (0.5f * W * 0.045f * 2.0f);
            const uint32_t pb = static_cast<uint32_t>(verts.size());
            verts.push_back(SbVeggieBladeVertex{pl.petioleBase - w, pl.normal, Vec2(0.5f, 0.01f), false, true});
            verts.push_back(SbVeggieBladeVertex{pl.petioleBase + w, pl.normal, Vec2(0.5f, 0.01f), false, true});
            verts.push_back(SbVeggieBladeVertex{pl.petioleTip, pl.normal, Vec2(0.5f, 0.05f), false, true});
            pushFacingNormals(pb, pb + 1, pb + 2);
        }
        return bladeTriangles;
    }
};

/** A standalone cluster of leaves on a spray of sub-shoots, built in its own frame: it attaches at the origin and points along +Z. */
struct SbVeggieClusterParams {
    int leafCount{26};
    float radiusM{0.85f};              // reach of the sub-shoot spray
    float reachScale{1.0f};            // multiplies the reach (a tip spray reaches further than a lateral one: 1.15 / 0.92)
    float leafLengthM{0.10f};          // blade length
    float orientationRadiusM{2.2f};    // distance of the cluster from the virtual crown centre behind it: how parallel its blades face outward
    float shootletRadiusM{0.010f};     // radius of the sub-shoots at their base (0: none drawn)
    uint64_t seed{0};
    SbVeggieMorphology morphology;
    float cupping{1.0f};
    bool petioles{true};
};

struct SbVeggieClusterMesh {
    std::vector<Vec3> positions, normals;
    // per vertex: a blade's own coordinates, scaled by its length (u = 0.5 + across / length, v = along / length, the
    // blade's base at v = 0), and `leaf` = (a hash of the blade in [0, 1): which leaf of a texture atlas it shows, 1 on a
    // blade / 0 on a petiole or sub-shoot)
    std::vector<Vec2> uvs;
    std::vector<std::array<float, 2>> leaf;
    std::vector<uint32_t> indices;     // the leaf cards first (blades and petioles), the sub-shoot tubes after
    size_t leafIndexCount{0};
    std::vector<uint32_t> bladeFrontIndices; // the blades' upper-side triangles alone (no underside, no petioles): the surface a leaf measurement needs
    int leaves{0};
    float reach{0.0f};                 // farthest vertex from the attachment point
    std::vector<Vec3> support;         // extreme points in a Fibonacci sphere of directions: the cluster's hull, for fitting it into a crown
    size_t triangles() const { return indices.size() / 3; }
    size_t leafTriangles() const { return leafIndexCount / 3; }
};

class SbVeggieFoliage {
public:
    static float unitHash(uint64_t seed, uint64_t a) {
        uint64_t h = seed + 0x9E3779B97F4A7C15ull * (a + 1);
        h ^= h >> 30; h *= 0xBF58476D1CE4E5B9ull; h ^= h >> 27; h *= 0x94D049BB133111EBull; h ^= h >> 31;
        return static_cast<float>(static_cast<double>(h >> 11) / 9007199254740992.0);
    }

    /**
     * Builds one leaf cluster without a template: `leafCount` blades spread along four sub-shoots that fan out from the
     * attachment point (phyllotactic roll by the morphology's divergence angle, reach fraction ((i + 0.5) / n)^distribution),
     * each on a petiole, oriented outward from a virtual crown centre `orientationRadiusM` behind the cluster with the
     * sky bias SB-Veggie's foliage cards use, plus the sub-shoots as thin tapered tubes.
     */
    static SbVeggieClusterMesh buildCluster(const SbVeggieClusterParams& cp, int supportDirections = 98) {
        SbVeggieClusterMesh out;
        const SbVeggieMorphology& mo = cp.morphology;
        const int n = std::max(1, cp.leafCount);
        const float seedPhase = unitHash(cp.seed, 7) * TWO_PI;
        const Vec3 shootDir(0, 0, 1);
        const Vec3 perp1 = shootDir.cross(Vec3(0, 1, 0)).normalized();
        const Vec3 perp2 = shootDir.cross(perp1).normalized();
        const Vec3 crownCenter(0, 0, -cp.orientationRadiusM);
        const float effR = cp.radiusM * cp.reachScale;
        std::vector<SbVeggieBladeVertex> verts;
        std::vector<uint32_t> idx;
        std::vector<Vec2> bladeUv;
        std::vector<std::array<float, 2>> bladeLeaf;
        for (int i = 0; i < n; ++i) {
            const float subPhase = (i % 4) * (PI * 0.5f) + seedPhase;
            const Vec3 subDir = (shootDir * 0.48f + (perp1 * std::cos(subPhase) + perp2 * std::sin(subPhase)) * 0.72f + Vec3(0, 0.28f, 0)).normalized();
            const float frac = std::pow((i + 0.5f) / n, mo.leafDistributionExponent);
            const float jit = (unitHash(cp.seed, 100 + i) * 2.0f - 1.0f) * 0.14f * effR;
            const Vec3 twigNode = subDir * (frac * effR) + (perp1 * std::sin(i * 1.7f + seedPhase) + perp2 * std::cos(i * 2.3f + seedPhase)) * jit;
            const float outLen = twigNode.length();
            const Vec3 outDir = outLen > 1e-4f ? twigNode / outLen : subDir;
            const float roll = i * mo.divergenceAngleRad + seedPhase;
            const Vec3 lateral = (perp1 * std::cos(roll) + perp2 * std::sin(roll)).normalized();
            const Vec3 petioleDir = (outDir * 0.50f + lateral * 0.38f + Vec3(0.0f, 0.38f, 0.0f)).normalized();
            const float lenJit = 0.85f + 0.30f * unitHash(cp.seed, 200 + i);
            const float L = cp.leafLengthM * lenJit;
            const float petLen = cp.leafLengthM * mo.blade.petioleRatio * (0.85f + 0.30f * unitHash(cp.seed, 300 + i));
            SbVeggieBladePlacement pl;
            pl.petioleBase = twigNode;
            pl.petioleTip = twigNode + petioleDir * petLen;
            const Vec3 rachis = (petioleDir * 0.68f + outDir * 0.28f + Vec3(0.0f, 0.22f, 0.0f)).normalized();
            Vec3 normal = (pl.petioleTip - crownCenter);
            const float envDist = normal.length();
            normal = (envDist > 1e-4f ? normal / envDist : Vec3(0, 1, 0)) + Vec3(0.0f, 0.40f, 0.0f);
            normal = normal.normalized();
            pl.bitangent = normal.cross(rachis).normalized();
            pl.tangent = rachis;
            pl.normal = normal;
            pl.lengthM = L;
            const size_t before = idx.size();
            const size_t vertsBefore = verts.size();
            const size_t bladeTris = appendLeaf(cp, mo, pl, verts, idx);
            // the blade's own coordinates, by length (its outline's bounding box is [0.5 -+ widthRatio / 2] x [0, 1])
            const float pick = unitHash(cp.seed, 400 + i);
            for (size_t q = vertsBefore; q < verts.size(); ++q) {
                const Vec3 d = verts[q].position - pl.petioleTip;
                bladeUv.push_back(Vec2(0.5f + d.dot(pl.bitangent) / L, d.dot(pl.tangent) / L));
                bladeLeaf.push_back({pick, verts[q].petiole ? 0.0f : 1.0f});
            }
            out.bladeFrontIndices.insert(out.bladeFrontIndices.end(), idx.begin() + static_cast<std::ptrdiff_t>(before), idx.begin() + static_cast<std::ptrdiff_t>(before + bladeTris / 2 * 3));
        }
        out.leaves = n;
        for (const auto& v : verts) { out.positions.push_back(v.position); out.normals.push_back(v.normal); }
        out.uvs = std::move(bladeUv);
        out.leaf = std::move(bladeLeaf);
        out.indices = idx;
        out.leafIndexCount = idx.size();
        // sub-shoots
        if (cp.shootletRadiusM > 0.0f) {
            for (int sub = 0; sub < 4; ++sub) {
                const float phase = sub * (PI * 0.5f) + seedPhase;
                const Vec3 d = (shootDir * 0.48f + (perp1 * std::cos(phase) + perp2 * std::sin(phase)) * 0.72f + Vec3(0, 0.28f, 0)).normalized();
                appendTube(out, Vec3(0, 0, 0), d * (effR * 0.97f), cp.shootletRadiusM, cp.shootletRadiusM * 0.4f, 4);
            }
        }
        // the sub-shoots: wood, no leaf coordinates
        out.uvs.resize(out.positions.size(), Vec2(0.0f, 0.0f));
        out.leaf.resize(out.positions.size(), {0.0f, 0.0f});
        for (const auto& q : out.positions) out.reach = std::max(out.reach, q.length());
        // hull: the extreme point in each of a Fibonacci sphere of directions
        std::vector<uint8_t> used(out.positions.size(), 0);
        const int D = std::max(6, supportDirections);
        for (int d = 0; d < D; ++d) {
            const double zz = 1.0 - 2.0 * (d + 0.5) / D, rr = std::sqrt(std::max(0.0, 1.0 - zz * zz)), ph = d * 2.399963229728653;
            const Vec3 dir(static_cast<float>(rr * std::cos(ph)), static_cast<float>(zz), static_cast<float>(rr * std::sin(ph)));
            size_t best = 0; float bd = -1e9f;
            for (size_t i = 0; i < out.positions.size(); ++i) { const float dd = out.positions[i].dot(dir); if (dd > bd) { bd = dd; best = i; } }
            if (!used[best]) { used[best] = 1; out.support.push_back(out.positions[best]); }
        }
        return out;
    }

    /** A tapered tube from `a` to `b` (radius ra to rb, `sides` around, flat ends closed at the tip), appended to a cluster mesh. */
    static void appendTube(SbVeggieClusterMesh& m, const Vec3& a, const Vec3& b, float ra, float rb, int sides) {
        const Vec3 ax = b - a;
        const float len = ax.length();
        if (len < 1e-6f) return;
        const Vec3 f = ax / len;
        Vec3 u = f.cross(Vec3(0, 1, 0));
        if (u.lengthSquared() < 1e-4f) u = f.cross(Vec3(1, 0, 0));
        u = u.normalized();
        const Vec3 v = f.cross(u).normalized();
        const uint32_t base = static_cast<uint32_t>(m.positions.size());
        for (int ring = 0; ring < 2; ++ring) {
            for (int s = 0; s < sides; ++s) {
                const float ang = TWO_PI * s / sides;
                const Vec3 radial = u * std::cos(ang) + v * std::sin(ang);
                m.positions.push_back((ring ? b : a) + radial * (ring ? rb : ra));
                m.normals.push_back(radial);
            }
        }
        for (int s = 0; s < sides; ++s) {
            const uint32_t a0 = base + s, a1 = base + (s + 1) % sides, b0 = base + sides + s, b1 = base + sides + (s + 1) % sides;
            m.indices.insert(m.indices.end(), {a0, a1, b1, a0, b1, b0});
        }
    }

private:
    static size_t appendLeaf(const SbVeggieClusterParams& cp, const SbVeggieMorphology& mo, const SbVeggieBladePlacement& pl,
                           std::vector<SbVeggieBladeVertex>& verts, std::vector<uint32_t>& idx) {
        SbVeggieBlade b = mo.blade;
        if (!cp.petioles) b.petioleRatio = 0.0f;
        return SbVeggieBladeBuilder::append(b, pl, cp.cupping, verts, idx, cp.petioles);
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

public:
    // Where a foliage anchor's leaf cluster sits in posed space: its station on the shoot, the shoot axis and two
    // perpendiculars for the phyllotaxis, and the cluster's reach.
    struct FoliageFrame {
        Vec3 origin;
        Vec3 shootDir;
        Vec3 perp1;
        Vec3 perp2;
        float clusterRadius{0.0f};
        int attachedJointIndex{0};
    };

    static bool foliageFrame(const SbVeggieFoliageAnchor& anchor, const std::vector<Vec3>& posedJoints, float spreadScale, FoliageFrame& out) {
        if (anchor.attachedJointIndex >= static_cast<int>(posedJoints.size())) return false;
        Vec3 pChild = posedJoints[anchor.attachedJointIndex];
        Vec3 pParent = (anchor.parentJointIndex >= 0 && anchor.parentJointIndex < static_cast<int>(posedJoints.size()))
            ? posedJoints[anchor.parentJointIndex]
            : pChild - anchor.outwardDirection * 0.8f;
        Vec3 shootVec = pChild - pParent;
        float shootLen = shootVec.length();
        out.shootDir = shootLen > 1e-4f ? shootVec / shootLen : anchor.outwardDirection;
        out.origin = pParent + out.shootDir * (shootLen * anchor.shootStation) + anchor.localOffset * spreadScale;
        Vec3 perp1 = out.shootDir.cross(Vec3(0, 1, 0));
        if (perp1.lengthSquared() < 0.01f) perp1 = out.shootDir.cross(Vec3(1, 0, 0));
        out.perp1 = perp1.normalized();
        out.perp2 = out.shootDir.cross(out.perp1).normalized();
        out.clusterRadius = anchor.clusterRadius * spreadScale * (anchor.isTerminalTwig ? 1.15f : 0.92f);
        out.attachedJointIndex = anchor.attachedJointIndex;
        return true;
    }

    // One of the four shootlet axes that fan out of a cluster station.
    static Vec3 subShootDirection(const FoliageFrame& f, int subShoot) {
        float phase = subShoot * (PI * 0.5f) + f.attachedJointIndex * 1.3f;
        return (f.shootDir * 0.48f + (f.perp1 * std::cos(phase) + f.perp2 * std::sin(phase)) * 0.72f + Vec3(0, 0.28f, 0)).normalized();
    }

    /**
     * Fixed stations along every cluster's shootlets, where the leaf cards are placed. Unlike the leaf cards, whose
     * number changes with the crown parameters, these move continuously with the parameters, so a fit can difference
     * them.
     */
    static std::vector<Vec3> foliageStations(const SbVeggieTemplate& tmpl, const std::vector<Vec3>& posedJoints, const SbVeggieParams& params, int stationsPerShootlet) {
        float spreadScale = std::max(0.2f, 1.0f + 0.40f * params.beta[2]);
        std::vector<Vec3> out;
        out.reserve(tmpl.foliageAnchors.size() * 4 * stationsPerShootlet);
        for (const auto& anchor : tmpl.foliageAnchors) {
            FoliageFrame frame;
            if (!foliageFrame(anchor, posedJoints, spreadScale, frame)) continue;
            for (int s = 0; s < 4; ++s) {
                Vec3 dir = subShootDirection(frame, s);
                for (int k = 0; k < stationsPerShootlet; ++k) {
                    // same reach law as the cards: reach = ((k + 0.5) / n)^0.58 of the cluster radius
                    float reach = std::pow((k + 0.5f) / stationsPerShootlet, 0.58f) * frame.clusterRadius;
                    out.push_back(frame.origin + dir * reach);
                }
            }
        }
        return out;
    }

private:
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
        // the template's own top, read from its joints (no joint is singled out by index)
        float templateTopY = 0.0f;
        for (const auto& j : tmpl.skeleton) templateTopY = std::max(templateTopY, j.restPosition.y);

        for (size_t a = 0; a < tmpl.foliageAnchors.size(); ++a) {
            const auto& anchor = tmpl.foliageAnchors[a];
            FoliageFrame frame;
            if (!foliageFrame(anchor, posedJoints, spreadScale, frame)) continue;
            const Vec3& anchorPos = frame.origin;
            const Vec3& shootDir = frame.shootDir;
            const Vec3& perp1 = frame.perp1;
            const Vec3& perp2 = frame.perp2;

            int count = static_cast<int>(anchor.leafCount * params.psi_leafDensity * crownAreaMult);
            if (params.psi_season < 0.70f) {
                // Autumn partial defoliation
                count = static_cast<int>(count * std::clamp(params.psi_season / 0.70f, 0.15f, 1.0f));
            }
            count = std::max(1, count);

            float clusterRadius = frame.clusterRadius;

            for (int i = 0; i < count; ++i) {
                // 1. Volumetric botanical shootlet spray branching:
                // From the branch node / anchor station, 4 fine shootlet axes fan outward in 3D
                Vec3 subShootDir = subShootDirection(frame, i % 4);

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
                float leafHeight = baseLeafSize * scaleJitter * 1.15f;

                // ================================================================
                // 4. Native C++20 Optical Physics: Canopy Ambient Occlusion & Subsurface Scattering (SSS)
                // ================================================================
                float distFromCenter = std::sqrt(petioleTip.x * petioleTip.x + petioleTip.z * petioleTip.z);
                float crownRadius = 4.2f * spreadScale;
                float radialRatio = std::clamp(distFromCenter / crownRadius, 0.25f, 1.0f);
                float crownBaseY = 2.0f * heightScale;
                float crownTopY = (templateTopY + 2.5f) * heightScale;
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

                // The blade: SB-Veggie's one blade generator (continuous outline, cupping, sunken midrib), upper side, underside, petiole
                SbVeggieBladePlacement pl;
                pl.petioleBase = petioleStemBase;
                pl.petioleTip = petioleTip;
                pl.tangent = tangent;
                pl.bitangent = bitangent;
                pl.normal = normal;
                pl.lengthM = leafHeight;
                const SbVeggieBlade& blade = params.morphology.blade;
                std::vector<SbVeggieBladeVertex> bv;
                std::vector<uint32_t> bi;
                SbVeggieBladeBuilder::append(blade, pl, params.leafCupping, bv, bi);
                const uint32_t baseIdx = static_cast<uint32_t>(mesh.vertices.size());
                for (const auto& v : bv) {
                    Vec4 col = v.petiole ? Vec4(0.32f, 0.22f, 0.15f, 1.0f) : (v.underside ? undersideColor : leafColor);
                    // an underside with the flipped normals takes the upper side's transfer reversed, so it stays facing
                    // the way its triangles are wound
                    const Vec3 nrm = v.petiole ? v.normal
                        : v.normal.dot(normal) < 0.0f ? calcNormal(v.position, v.normal * -1.0f) * -1.0f
                        : calcNormal(v.position, v.normal);
                    mesh.vertices.push_back(Vertex{v.position, v.underside ? nrm : nrm, v.uv, col});
                }
                for (uint32_t id : bi) mesh.indices.push_back(baseIdx + id);
            }
        }
    }
};


} // namespace sb_veggie

// Backward-compatible type aliases for legacy code
namespace smpl_tree {
    using namespace sb_veggie;
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
