/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

#ifndef SCRATCHBOX_SKINNING_HPP
#define SCRATCHBOX_SKINNING_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_kinematics.hpp"
#include "scratchbox_shaper.hpp"
#include <vector>
#include <array>
#include <cmath>
#include <algorithm>

namespace scratchbox {
namespace skinning {

/**
 * 4-Bone Influence Skin Weight (Directly compatible with glTF 2.0 JOINTS_0 / WEIGHTS_0)
 */
struct VertexSkinWeight {
    std::array<uint16_t, 4> joints{0, 0, 0, 0};
    std::array<float, 4> weights{1.0f, 0.0f, 0.0f, 0.0f};

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

/**
 * SIMD Linear Blend Skinning Engine
 */
class LinearBlendSkinning {
public:
    static geometry::ScratchboxMesh deform(
        const geometry::ScratchboxMesh& restMesh,
        const std::vector<VertexSkinWeight>& skinWeights,
        const std::vector<math::Mat4>& skinTransforms
    ) {
        geometry::ScratchboxMesh posedMesh(restMesh.name + "_posed");
        posedMesh.indices = restMesh.indices;
        posedMesh.material = restMesh.material;
        posedMesh.vertices.resize(restMesh.vertices.size());

        const size_t vertexCount = restMesh.vertices.size();
        const bool hasWeights = skinWeights.size() >= vertexCount;

        for (size_t i = 0; i < vertexCount; ++i) {
            const auto& rv = restMesh.vertices[i];
            if (!hasWeights || skinTransforms.empty()) {
                posedMesh.vertices[i] = rv;
                posedMesh.bounds.expand(rv.position);
                continue;
            }

            const auto& sw = skinWeights[i];
            math::Vec3 posedPos(0.0f, 0.0f, 0.0f);
            math::Vec3 posedNorm(0.0f, 0.0f, 0.0f);

            for (int k = 0; k < 4; ++k) {
                float w = sw.weights[k];
                if (w <= 1e-5f) continue;

                uint16_t jIdx = sw.joints[k];
                if (jIdx < skinTransforms.size()) {
                    const auto& G = skinTransforms[jIdx];
                    posedPos += G.transformPoint(rv.position) * w;
                    posedNorm += G.transformDirection(rv.normal) * w;
                }
            }

            geometry::Vertex pv = rv;
            pv.position = posedPos;
            pv.normal = posedNorm.normalized();
            posedMesh.vertices[i] = pv;
            posedMesh.bounds.expand(posedPos);
        }

        return posedMesh;
    }
};

/**
 * Parametric Morph Target & Blend Shape Evaluator (Shape β and Expression ψ)
 */
class ParametricDeformer {
public:
    /**
     * Displace base mesh along PCA shape modes: V_shaped = V + sum(beta_l * S_l)
     */
    static void applyShapeBlendShapes(
        geometry::ScratchboxMesh& mesh,
        const std::vector<float>& betas,
        const std::vector<float>& shapeDirs,
        size_t numBetas
    ) {
        if (betas.empty() || shapeDirs.empty()) return;
        const size_t activeBetas = std::min(betas.size(), numBetas);
        const size_t vertexCount = mesh.vertices.size();

        mesh.bounds = math::AABB();
        for (size_t i = 0; i < vertexCount; ++i) {
            math::Vec3 disp(0.0f, 0.0f, 0.0f);
            for (size_t b = 0; b < activeBetas; ++b) {
                float betaVal = betas[b];
                if (std::abs(betaVal) < 1e-5f) continue;

                size_t offset = (b * vertexCount + i) * 3;
                if (offset + 2 < shapeDirs.size()) {
                    disp.x += betaVal * shapeDirs[offset];
                    disp.y += betaVal * shapeDirs[offset + 1];
                    disp.z += betaVal * shapeDirs[offset + 2];
                }
            }
            mesh.vertices[i].position += disp;
            mesh.bounds.expand(mesh.vertices[i].position);
        }
    }
};

/**
 * Sparse Compressed Row (CSR) Linear Regressor
 * Dynamically computes 3D joint pivot centers from surface vertices: J = J_regressor * V
 */
struct SparseCsrRegressor {
    uint32_t numJoints{0};
    uint32_t numVertices{0};
    std::vector<uint32_t> rowOffsets; // size: numJoints + 1
    std::vector<uint32_t> colIndices; // size: total non-zeros NNZ
    std::vector<float> values;        // size: total non-zeros NNZ

    bool empty() const { return rowOffsets.empty() || values.empty(); }

    void evaluate(const std::vector<math::Vec3>& surfaceVertices, std::vector<math::Vec3>& outJoints) const {
        outJoints.resize(numJoints);
        for (uint32_t j = 0; j < numJoints; ++j) {
            math::Vec3 center(0.0f, 0.0f, 0.0f);
            uint32_t start = rowOffsets[j];
            uint32_t end = rowOffsets[j + 1];
            for (uint32_t k = start; k < end; ++k) {
                uint32_t vIdx = colIndices[k];
                if (vIdx < surfaceVertices.size()) {
                    center += surfaceVertices[vIdx] * values[k];
                }
            }
            outJoints[j] = center;
        }
    }

    /**
     * Automatically constructs a sparse regressor matrix from rest mesh and skeleton
     * by finding nearest k-neighborhood surface rings around each joint rest position
     */
    static SparseCsrRegressor buildFromRestPose(
        const geometry::ScratchboxMesh& restMesh,
        const kinematics::Skeleton& skeleton,
        size_t kNearest = 32
    ) {
        SparseCsrRegressor reg;
        reg.numJoints = static_cast<uint32_t>(skeleton.joints.size());
        reg.numVertices = static_cast<uint32_t>(restMesh.vertices.size());
        reg.rowOffsets.resize(reg.numJoints + 1, 0);

        struct VDist {
            uint32_t idx;
            float dist;
        };

        for (uint32_t j = 0; j < reg.numJoints; ++j) {
            math::Vec3 jPos = skeleton.joints[j].restPosition;
            std::vector<VDist> candidates;
            candidates.reserve(restMesh.vertices.size());

            for (uint32_t v = 0; v < restMesh.vertices.size(); ++v) {
                float d = (restMesh.vertices[v].position - jPos).length();
                candidates.push_back({v, d});
            }

            std::sort(candidates.begin(), candidates.end(), [](const VDist& a, const VDist& b) {
                return a.dist < b.dist;
            });

            size_t count = std::min(kNearest, candidates.size());
            float weightSum = 0.0f;
            std::vector<float> rowWeights(count);
            for (size_t c = 0; c < count; ++c) {
                float d = std::max(candidates[c].dist, 0.01f);
                float w = 1.0f / (d * d);
                rowWeights[c] = w;
                weightSum += w;
            }

            float invSum = (weightSum > 1e-6f) ? (1.0f / weightSum) : 1.0f;
            for (size_t c = 0; c < count; ++c) {
                reg.colIndices.push_back(candidates[c].idx);
                reg.values.push_back(rowWeights[c] * invSum);
            }
            reg.rowOffsets[j + 1] = static_cast<uint32_t>(reg.colIndices.size());
        }

        return reg;
    }
};

/**
 * Pose-Space Corrective Blendshapes Deformer (PSD)
 * Eliminates Linear Blend Skinning candy-wrapper volume loss and models dynamic muscle flex
 * V_posed = V_shaped + sum_{k=1}^{J-1} sum_{m=1}^9 (R_{k, m} - delta_m) * P_{i, m, k}
 */
class PoseCorrectiveDeformer {
public:
    static void apply(
        geometry::ScratchboxMesh& mesh,
        const kinematics::Skeleton& skeleton,
        const std::vector<float>& poseDirs,
        size_t numPoseJoints
    ) {
        if (poseDirs.empty() || skeleton.joints.size() <= 1) return;
        const size_t numVertices = mesh.vertices.size();
        const size_t maxJoints = std::min(numPoseJoints, skeleton.joints.size() - 1);

        // 1. Compute 9-element rotation deviations (R - I) for each non-root joint
        std::vector<std::array<float, 9>> rotDevs(maxJoints);
        bool anyRotation = false;

        for (size_t j = 0; j < maxJoints; ++j) {
            const auto& joint = skeleton.joints[j + 1]; // non-root joint
            math::Mat4 R = kinematics::rodrigues(joint.localRotation);
            rotDevs[j] = {
                R.m[0] - 1.0f, R.m[4],        R.m[8],
                R.m[1],        R.m[5] - 1.0f, R.m[9],
                R.m[2],        R.m[6],        R.m[10] - 1.0f
            };

            for (int m = 0; m < 9; ++m) {
                if (std::abs(rotDevs[j][m]) > 1e-5f) {
                    anyRotation = true;
                }
            }
        }

        if (!anyRotation) return;

        // 2. Displace mesh vertices
        for (size_t i = 0; i < numVertices; ++i) {
            math::Vec3 disp(0.0f, 0.0f, 0.0f);

            for (size_t j = 0; j < maxJoints; ++j) {
                for (int m = 0; m < 9; ++m) {
                    float dev = rotDevs[j][m];
                    if (std::abs(dev) < 1e-5f) continue;

                    size_t basisIdx = ((j * 9 + m) * numVertices + i) * 3;
                    if (basisIdx + 2 < poseDirs.size()) {
                        disp.x += dev * poseDirs[basisIdx + 0];
                        disp.y += dev * poseDirs[basisIdx + 1];
                        disp.z += dev * poseDirs[basisIdx + 2];
                    }
                }
            }

            mesh.vertices[i].position += disp;
        }
    }
};

/**
 * Gender and Somatotype Morphological Archetypes
 * Derived from SB-Human empirical sexual dimorphism metrics (height, biacromial breadth, pelvic width)
 */
enum class GenderMorph {
    Neutral, // Standard balanced reference morphology
    Male,    // Android athletic V-taper (broad clavicles, narrow pelvis, chiseled pectorals)
    Female   // Gynoid hourglass silhouette (cinched waist, wide gynecoid pelvic flare, inframammary mammary contour)
};

/**
 * Procedural Humanoid Geometry & Skinning Builder
 * Generates an anatomical base mesh and automatically calculates smooth geodesic skinning weights.
 */
class ProceduralHumanoidBuilder {
public:
    static geometry::PbrMaterial defaultSkinMaterial() {
        geometry::PbrMaterial m;
        m.name = "humanoid_skin";
        m.baseColorFactor = math::Vec4(0.82f, 0.64f, 0.52f, 1.0f);
        m.metallicFactor = 0.02f;
        m.roughnessFactor = 0.45f;
        m.clearcoatFactor = 0.12f;
        return m;
    }

    /**
     * Builds a single continuous, watertight, anatomical humanoid 2-manifold surface
     * featuring 5-digit articulated hands, sculpted facial features, and anatomical musculature.
     */
    static geometry::ScratchboxMesh buildAnatomicalWatertightHumanoid(float height, float shoulderWidth) {
        return buildAnatomicalWatertightHumanoid(height, GenderMorph::Neutral);
    }

    static geometry::ScratchboxMesh buildAnatomicalWatertightHumanoid(
        float height = 1.80f,
        GenderMorph gender = GenderMorph::Neutral
    ) {
        geometry::ScratchboxMesh mesh("anatomical_humanoid_watertight");
        mesh.material = defaultSkinMaterial();
        float scale = height / 1.80f;

        struct RingSpec {
            math::Vec3 center;
            float rx;
            float rz;
            float frontBulge{0.0f};    // e.g. chest, chin, nose, patella (+Z)
            float backBulge{0.0f};     // e.g. calf, gluteus (-Z)
            float topBulge{0.0f};      // e.g. bicep, shoulder (+Y)
            float zOffset{0.0f};
            float pectoralSplit{0.0f}; // harmonic modulation for left/right pectoral muscle bellies & sternal notch
            float spinalGroove{0.0f};  // harmonic modulation for erector spinae & vertebral furrow
            float lineaAlba{0.0f};     // harmonic modulation for abdominal rectus definition
            float temporalFlats{0.0f}; // Loomis planar temporal facet cuts
            float chinShelf{0.0f};     // planar mental protuberance pad
            float teardropBust{0.0f};  // isolated paired teardrop breast volumes (female)
            float pectoralPlates{0.0f};// planar rectangular pectoral major plates (male)
            float bustCenterWidth{0.076f}; // lateral distance to each breast apex (meters)
            float yContour{0.0f};          // angular height modulation (e.g. pelvic rim inguinal drop/lateral lift)
            float patellaPlate{0.0f};      // planar hexagonal kneecap plate
            float tibialCrest{0.0f};       // subcutaneous anterior tibial ridge (shin crest)
            float clavicleRidge{0.0f};     // bicycle-handlebar collarbone ridge
            float zygomaticFlats{0.0f};    // cheekbone prominence and temporal taper
            float scapulaPlates{0.0f};     // triangular posterior shoulder blade plates
            float eyeOrbitIndent{0.0f};    // bilateral concavity for eye sockets
            float nasalPyramid{0.0f};      // triangular nasal bridge and pyramid projection
            float oralPlanes{0.0f};        // upper and lower lip planar steps & commissures
            float earPads{0.0f};           // lateral planar ear blocks
            float quadTeardrop{0.0f};      // vastus medialis teardrop low on inner knee
            float vastusLateralis{0.0f};   // sweeping outer thigh muscle curve
            float calfAsymmetry{0.0f};     // medial gastrocnemius belly fullness (lower than lateral)
            float malleolusOffset{0.0f};   // medial higher, lateral lower ankle protrusion
            float jawTaper{0.0f};          // anatomical jaw taper: narrows anterior chin/mouth relative to posterior jaw angle
            float glutealCleft{0.0f};      // posterior intergluteal sulcus (buttock cleft separation)
        };

        // Helper to loft a vertical chain of cross-section rings along Y
        auto addLoftedVerticalChain = [&](
            const std::vector<RingSpec>& rings,
            int sectors = 24,
            bool capStart = true,
            bool capEnd = true,
            int legSide = 0 // 0 = torso/center, 1 = left leg, -1 = right leg
        ) -> std::vector<std::vector<uint32_t>> {
            if (rings.empty()) return {};
            std::vector<std::vector<uint32_t>> ringIndices(rings.size());

            uint32_t startCapIdx = 0;
            if (capStart) {
                startCapIdx = static_cast<uint32_t>(mesh.vertices.size());
                math::Vec3 startPole = rings.front().center;
                mesh.addVertex(geometry::Vertex(startPole, math::Vec3(0, -1, 0), math::Vec2(0.5f, 0.0f), mesh.material.baseColorFactor));
            }

            for (size_t r = 0; r < rings.size(); ++r) {
                const auto& spec = rings[r];
                ringIndices[r].reserve(sectors);
                float vCoord = static_cast<float>(r) / std::max(1UL, rings.size() - 1);

                for (int s = 0; s < sectors; ++s) {
                    float uCoord = static_cast<float>(s) / sectors;
                    float theta = uCoord * math::TWO_PI;
                    float cosT = std::cos(theta);
                    float sinT = std::sin(theta);

                    float radX = spec.rx;
                    float radZ = spec.rz;

                    if (sinT > 0.0f) {
                        radZ *= (1.0f + spec.frontBulge * sinT);
                    } else {
                        radZ *= (1.0f - spec.backBulge * sinT);
                    }

                    float deltaZ = 0.0f;
                    if (sinT > 0.0f && spec.pectoralSplit > 0.0f) {
                        float sinFactor = sinT * sinT;
                        float cosSq = cosT * cosT;
                        // peaks at mid-clavicular line |cosT| ~ 0.52 and dips at sternum cosT = 0
                        deltaZ += spec.pectoralSplit * sinFactor * (3.8f * cosSq - 0.25f);
                    }
                    if (sinT > 0.0f && spec.lineaAlba > 0.0f) {
                        float sinFactor = sinT * sinT;
                        float cosSq = cosT * cosT;
                        // subtle midline notch at cosT = 0 flanked by rectus abdominis muscle columns
                        deltaZ += spec.lineaAlba * sinFactor * (3.2f * cosSq - 0.20f);
                    }
                    if (sinT < 0.0f && spec.spinalGroove > 0.0f) {
                        float sinFactor = sinT * sinT;
                        float cosSq = cosT * cosT;
                        // posterior vertebral furrow at cosT = 0 flanked by erector spinae
                        deltaZ -= spec.spinalGroove * sinFactor * (3.0f * cosSq - 0.25f);
                    }

                    float deltaY = 0.0f;
                    if (spec.yContour != 0.0f) {
                        if (legSide == 1) {
                            // Left leg: lateral is cosT = +1, medial is cosT = -1
                            deltaY = spec.yContour * cosT;
                        } else if (legSide == -1) {
                            // Right leg: lateral is cosT = -1, medial is cosT = +1
                            deltaY = -spec.yContour * cosT;
                        } else {
                            // Pelvic rim / Torso: lateral hips lift (|cosT| = 1), anterior/posterior drop
                            float cosSq = cosT * cosT;
                            float sinSq = sinT * sinT;
                            deltaY = spec.yContour * (cosSq - 0.80f * sinSq);
                        }
                    }

                    math::Vec3 pos = spec.center + math::Vec3(
                        cosT * radX,
                        spec.topBulge * std::abs(cosT) + deltaY,
                        sinT * radZ + spec.zOffset + deltaZ
                    );

                    // 1. Loomis Head Planar Temporal Cuts (flattens cranial lateral walls at temples)
                    if (spec.temporalFlats > 0.0f && sinT > -0.20f) {
                        float maxTemporalX = radX * (1.0f - spec.temporalFlats * 0.22f);
                        float deltaX = pos.x - spec.center.x;
                        if (std::abs(deltaX) > maxTemporalX) {
                            float excess = std::abs(deltaX) - maxTemporalX;
                            pos.x = spec.center.x + std::copysign(maxTemporalX + excess * 0.35f, deltaX);
                        }
                    }

                    // 2. Anatomical Jaw & Chin Taper (narrows anterior facial width relative to posterior jaw angle)
                    if (spec.jawTaper > 0.0f && sinT > 0.0f) {
                        float taper = 1.0f - spec.jawTaper * sinT;
                        pos.x = spec.center.x + (pos.x - spec.center.x) * taper;
                    }

                    // 2. Planar Mandible & Chin Pad (tapered drawing figure jaw shelf)
                    if (spec.chinShelf > 0.0f && sinT > 0.0f) {
                        float chinPadWidth = spec.rx * 0.44f;
                        float absX = std::abs(pos.x - spec.center.x);
                        if (absX < chinPadWidth) {
                            float u = absX / chinPadWidth;
                            float padFactor = 1.0f - u * u * 0.35f;
                            pos.z += spec.chinShelf * padFactor;
                        }
                    }

                    // 3. Isolated Paired Teardrop Bust Volumes (female drawing figure)
                    if (spec.teardropBust > 0.0f && sinT > 0.0f) {
                        float bustApexX = spec.bustCenterWidth * scale;
                        float bustRadius = 0.064f * scale;
                        float distL = std::abs(pos.x - bustApexX);
                        float distR = std::abs(pos.x + bustApexX);
                        float minDist = std::min(distL, distR);
                        if (minDist < bustRadius) {
                            float u = minDist / bustRadius;
                            float cosU = std::cos(u * math::HALF_PI);
                            pos.z += spec.teardropBust * (cosU * cosU);
                        }
                    }

                    // 4. Chiseled Planar Pectoral Major Plates (male drawing figure)
                    if (spec.pectoralPlates > 0.0f && sinT > 0.0f) {
                        float pecInnerX = 0.018f * scale;
                        float pecOuterX = 0.142f * scale;
                        float absX = std::abs(pos.x - spec.center.x);
                        if (absX > pecInnerX && absX < pecOuterX) {
                            float tIn = std::clamp((absX - pecInnerX) / (0.024f * scale), 0.0f, 1.0f);
                            float tOut = std::clamp((pecOuterX - absX) / (0.024f * scale), 0.0f, 1.0f);
                            float sIn = tIn * tIn * (3.0f - 2.0f * tIn);
                            float sOut = tOut * tOut * (3.0f - 2.0f * tOut);
                            pos.z += spec.pectoralPlates * (sIn * sOut);
                        }
                    }

                    // 5. Planar Hexagonal Kneecap Shield (patella plate)
                    if (spec.patellaPlate > 0.0f && sinT > 0.35f) {
                        float kneeHalfW = spec.rx * 0.40f;
                        float absX = std::abs(pos.x - spec.center.x);
                        if (absX < kneeHalfW) {
                            float u = absX / kneeHalfW;
                            float plate = (u < 0.60f) ? 1.0f : (1.0f - (u - 0.60f) / 0.40f);
                            pos.z += spec.patellaPlate * plate * sinT;
                        }
                    }

                    // 6. Subcutaneous Anterior Shin Crest (tibia)
                    if (spec.tibialCrest > 0.0f && sinT > 0.60f) {
                        float shinHalfW = spec.rx * 0.28f;
                        float absX = std::abs(pos.x - spec.center.x);
                        if (absX < shinHalfW) {
                            float u = absX / shinHalfW;
                            float crest = (1.0f - u * u);
                            pos.z += spec.tibialCrest * crest * sinT;
                        }
                    }

                    // 7. Bicycle-Handlebar Clavicle Ridge (collarbone)
                    if (spec.clavicleRidge > 0.0f && sinT > 0.20f) {
                        float absX = std::abs(pos.x - spec.center.x);
                        float clavicleMinX = spec.rx * 0.12f;
                        float clavicleMaxX = spec.rx * 0.88f;
                        if (absX > clavicleMinX && absX < clavicleMaxX) {
                            float u = (absX - clavicleMinX) / (clavicleMaxX - clavicleMinX);
                            float sCurve = std::sin(u * math::PI);
                            pos.z += spec.clavicleRidge * sCurve * sinT;
                            pos.y += spec.clavicleRidge * 0.35f * sCurve;
                        }
                    }

                    // 8. Zygomatic Cheekbone Prominence
                    if (spec.zygomaticFlats > 0.0f) {
                        float angle = std::abs(theta);
                        if (angle > math::PI) angle = math::TWO_PI - angle;
                        float cheekAngle = 0.75f; // ~43 degrees anterolateral
                        float diff = std::abs(angle - cheekAngle);
                        if (diff < 0.60f) {
                            float factor = 1.0f - diff / 0.60f;
                            pos.x += std::copysign(spec.zygomaticFlats * factor * factor * 0.55f, pos.x - spec.center.x);
                            pos.z += spec.zygomaticFlats * factor * factor * 0.75f;
                        }
                    }

                    // 9. Triangular Scapular Plates (Shoulder Blades) on Posterior Ribcage
                    if (spec.scapulaPlates > 0.0f && sinT < -0.30f) {
                        float absX = std::abs(pos.x - spec.center.x);
                        float scapMinX = spec.rx * 0.26f;
                        float scapMaxX = spec.rx * 0.82f;
                        if (absX > scapMinX && absX < scapMaxX) {
                            float u = (absX - scapMinX) / (scapMaxX - scapMinX);
                            float plate = std::sin(u * math::PI);
                            pos.z -= spec.scapulaPlates * plate * (-sinT);
                        }
                    }

                    // 10. Eye Orbit Recessions (Loomis eye sockets)
                    if (spec.eyeOrbitIndent > 0.0f && sinT > 0.25f) {
                        float eyeX = 0.034f * scale;
                        float absX = std::abs(pos.x - spec.center.x);
                        float distL = std::abs(absX - eyeX);
                        float orbitRadius = 0.022f * scale;
                        if (distL < orbitRadius) {
                            float u = distL / orbitRadius;
                            float indent = (1.0f - u * u);
                            pos.z -= spec.eyeOrbitIndent * indent * sinT;
                        }
                    }

                    // 11. Triangular Nasal Pyramid & Dorsal Bridge
                    if (spec.nasalPyramid > 0.0f && sinT > 0.45f) {
                        float absX = std::abs(pos.x - spec.center.x);
                        float noseHalfW = 0.015f * scale;
                        if (absX < noseHalfW) {
                            float u = absX / noseHalfW;
                            float pyramid = (1.0f - u);
                            pos.z += spec.nasalPyramid * pyramid * sinT;
                        }
                    }

                    // 12. Planar Oral Barrel & Lip Planes
                    if (spec.oralPlanes > 0.0f && sinT > 0.35f) {
                        float absX = std::abs(pos.x - spec.center.x);
                        float mouthHalfW = 0.024f * scale;
                        if (absX < mouthHalfW) {
                            float u = absX / mouthHalfW;
                            float barrel = (1.0f - u * u);
                            pos.z += spec.oralPlanes * barrel * sinT;
                        } else if (absX < mouthHalfW * 1.35f) {
                            float u = (absX - mouthHalfW) / (mouthHalfW * 0.35f);
                            pos.z -= spec.oralPlanes * 0.30f * (1.0f - u) * sinT;
                        }
                    }

                    // 13. Stylized Lateral Ear Wedges
                    if (spec.earPads > 0.0f && std::abs(cosT) > 0.85f && std::abs(sinT) < 0.38f) {
                        float earFac = (std::abs(cosT) - 0.85f) / 0.15f;
                        pos.x += std::copysign(spec.earPads * earFac, pos.x - spec.center.x);
                        pos.z -= spec.earPads * earFac * 0.20f;
                    }

                    // 14. Vastus Medialis Teardrop (lower inner thigh directly above knee)
                    if (spec.quadTeardrop > 0.0f && legSide != 0) {
                        float medialVal = (legSide == 1) ? -cosT : cosT;
                        if (medialVal > 0.10f && sinT > 0.10f) {
                            float qm = medialVal * sinT;
                            pos.x += (legSide == 1 ? -1.0f : 1.0f) * spec.quadTeardrop * qm * 0.65f;
                            pos.z += spec.quadTeardrop * qm * 0.75f;
                        }
                    }

                    // 15. Vastus Lateralis Outer Flare (high sweeping outer thigh)
                    if (spec.vastusLateralis > 0.0f && legSide != 0) {
                        float lateralVal = (legSide == 1) ? cosT : -cosT;
                        if (lateralVal > 0.10f) {
                            pos.x += (legSide == 1 ? 1.0f : -1.0f) * spec.vastusLateralis * lateralVal * 0.85f;
                            if (sinT > 0.0f) pos.z += spec.vastusLateralis * lateralVal * sinT * 0.45f;
                        }
                    }

                    // 16. Asymmetric Gastrocnemius Belly (medial head lower & fuller)
                    if (spec.calfAsymmetry > 0.0f && legSide != 0) {
                        float medialVal = (legSide == 1) ? -cosT : cosT;
                        if (medialVal > 0.10f && sinT < -0.10f) {
                            float caf = medialVal * (-sinT);
                            pos.z -= spec.calfAsymmetry * caf * 0.85f;
                            pos.x += (legSide == 1 ? -1.0f : 1.0f) * spec.calfAsymmetry * caf * 0.45f;
                        }
                    }

                    // 17. Asymmetric Ankle Malleoli (medial higher, lateral lower)
                    if (spec.malleolusOffset > 0.0f && legSide != 0) {
                        float medialVal = (legSide == 1) ? -cosT : cosT;
                        float lateralVal = -medialVal;
                        if (medialVal > 0.35f) {
                            float u = (medialVal - 0.35f) / 0.65f;
                            pos.y += spec.malleolusOffset * u * 0.70f;
                            pos.z += spec.malleolusOffset * u * 0.35f;
                            pos.x += (legSide == 1 ? -1.0f : 1.0f) * spec.malleolusOffset * u * 0.50f;
                        } else if (lateralVal > 0.35f) {
                            float u = (lateralVal - 0.35f) / 0.65f;
                            pos.y -= spec.malleolusOffset * u * 0.60f;
                            pos.z -= spec.malleolusOffset * u * 0.35f;
                            pos.x += (legSide == 1 ? 1.0f : -1.0f) * spec.malleolusOffset * u * 0.50f;
                        }
                    }

                    // 18. Intergluteal Sulcus (posterior buttock cleft separation)
                    if (spec.glutealCleft > 0.0f && sinT < -0.30f) {
                        float absX = std::abs(pos.x - spec.center.x);
                        float cleftW = spec.rx * 0.35f;
                        if (absX < cleftW) {
                            float u = absX / cleftW;
                            float cleft = (1.0f - u * u);
                            pos.z += spec.glutealCleft * cleft * (-sinT); // inward indentation towards anterior
                        }
                    }

                    uint32_t vIdx = static_cast<uint32_t>(mesh.vertices.size());
                    mesh.addVertex(geometry::Vertex(pos, math::Vec3(cosT, 0, sinT), math::Vec2(uCoord, vCoord), mesh.material.baseColorFactor));
                    ringIndices[r].push_back(vIdx);
                }
            }

            if (capStart) {
                for (int s = 0; s < sectors; ++s) {
                    int sNext = (s + 1) % sectors;
                    mesh.addTriangle(startCapIdx, ringIndices[0][sNext], ringIndices[0][s]);
                }
            }

            for (size_t r = 0; r + 1 < rings.size(); ++r) {
                for (int s = 0; s < sectors; ++s) {
                    int sNext = (s + 1) % sectors;
                    uint32_t i0 = ringIndices[r][s];
                    uint32_t i1 = ringIndices[r + 1][s];
                    uint32_t i2 = ringIndices[r + 1][sNext];
                    uint32_t i3 = ringIndices[r][sNext];

                    float len02Sq = (mesh.vertices[i0].position - mesh.vertices[i2].position).lengthSquared();
                    float len13Sq = (mesh.vertices[i1].position - mesh.vertices[i3].position).lengthSquared();

                    if (len02Sq <= len13Sq) {
                        mesh.addTriangle(i0, i1, i2);
                        mesh.addTriangle(i0, i2, i3);
                    } else {
                        mesh.addTriangle(i0, i1, i3);
                        mesh.addTriangle(i1, i2, i3);
                    }
                }
            }

            if (capEnd) {
                uint32_t endCapIdx = static_cast<uint32_t>(mesh.vertices.size());
                math::Vec3 endPole = rings.back().center + math::Vec3(0, 0.006f * scale, 0);
                mesh.addVertex(geometry::Vertex(endPole, math::Vec3(0, 1, 0), math::Vec2(0.5f, 1.0f), mesh.material.baseColorFactor));
                size_t lastR = rings.size() - 1;
                for (int s = 0; s < sectors; ++s) {
                    int sNext = (s + 1) % sectors;
                    mesh.addTriangle(endCapIdx, ringIndices[lastR][s], ringIndices[lastR][sNext]);
                }
            }
            return ringIndices;
        };

        // Helper to loft a lateral chain of rings along X (for arms)
        auto addLoftedArmChain = [&](const std::vector<RingSpec>& rings, bool isLeft, int sectors = 20, bool capStart = false, bool capEnd = false) -> std::vector<std::vector<uint32_t>> {
            if (rings.empty()) return {};
            std::vector<std::vector<uint32_t>> ringIndices(rings.size());

            for (size_t r = 0; r < rings.size(); ++r) {
                const auto& spec = rings[r];
                ringIndices[r].reserve(sectors);
                float vCoord = static_cast<float>(r) / std::max(1UL, rings.size() - 1);

                for (int s = 0; s < sectors; ++s) {
                    float uCoord = static_cast<float>(s) / sectors;
                    float theta = uCoord * math::TWO_PI;
                    float cosT = std::cos(theta); // Y vertical
                    float sinT = std::sin(theta); // Z anterior/posterior

                    float radY = spec.rx;
                    float radZ = spec.rz;

                    if (cosT > 0.0f) {
                        radY *= (1.0f + spec.topBulge * cosT); // bicep/deltoid expansion
                    }

                    if (sinT < 0.0f && spec.backBulge > 0.0f) {
                        radZ *= (1.0f - spec.backBulge * sinT); // olecranon process elbow prominence
                    } else if (sinT > 0.0f && spec.frontBulge > 0.0f) {
                        radZ *= (1.0f + spec.frontBulge * sinT); // cubital fossa / antecubital definition
                    }

                    math::Vec3 pos = spec.center + math::Vec3(
                        0.0f,
                        cosT * radY,
                        sinT * radZ + spec.zOffset
                    );
                    uint32_t vIdx = static_cast<uint32_t>(mesh.vertices.size());
                    mesh.addVertex(geometry::Vertex(pos, math::Vec3(0, cosT, sinT), math::Vec2(uCoord, vCoord), mesh.material.baseColorFactor));
                    ringIndices[r].push_back(vIdx);
                }
            }

            if (capStart) {
                // Spherical deltoid dome extending medially inside the torso's shoulder socket
                const int domeSteps = 4;
                float sign = isLeft ? 1.0f : -1.0f;
                const auto& spec0 = rings.front();
                float R = spec0.rx;
                std::vector<std::vector<uint32_t>> domeRings(domeSteps);

                for (int d = 1; d <= domeSteps; ++d) {
                    float u = static_cast<float>(d) / (domeSteps + 1);
                    float dx = -sign * (u * R * 1.10f);
                    float rScale = std::sqrt(std::max(0.01f, 1.0f - u * u));
                    domeRings[d - 1].reserve(sectors);

                    for (int s = 0; s < sectors; ++s) {
                        float theta = (static_cast<float>(s) / sectors) * math::TWO_PI;
                        float cosT = std::cos(theta);
                        float sinT = std::sin(theta);
                        math::Vec3 pos = spec0.center + math::Vec3(dx, cosT * spec0.rx * rScale, sinT * spec0.rz * rScale);
                        uint32_t vIdx = static_cast<uint32_t>(mesh.vertices.size());
                        mesh.addVertex(geometry::Vertex(pos, math::Vec3(-sign * u, cosT * rScale, sinT * rScale).normalized(), math::Vec2(0, 0), mesh.material.baseColorFactor));
                        domeRings[d - 1].push_back(vIdx);
                    }
                }

                // Stitch ringIndices[0] to domeRings[0]
                for (int s = 0; s < sectors; ++s) {
                    int sNext = (s + 1) % sectors;
                    uint32_t i0 = ringIndices[0][s];
                    uint32_t i1 = domeRings[0][s];
                    uint32_t i2 = domeRings[0][sNext];
                    uint32_t i3 = ringIndices[0][sNext];
                    if (isLeft) {
                        mesh.addTriangle(i0, i1, i2);
                        mesh.addTriangle(i0, i2, i3);
                    } else {
                        mesh.addTriangle(i0, i2, i1);
                        mesh.addTriangle(i0, i3, i2);
                    }
                }

                // Stitch intermediate dome rings
                for (int d = 0; d + 1 < domeSteps; ++d) {
                    for (int s = 0; s < sectors; ++s) {
                        int sNext = (s + 1) % sectors;
                        uint32_t i0 = domeRings[d][s];
                        uint32_t i1 = domeRings[d + 1][s];
                        uint32_t i2 = domeRings[d + 1][sNext];
                        uint32_t i3 = domeRings[d][sNext];
                        if (isLeft) {
                            mesh.addTriangle(i0, i1, i2);
                            mesh.addTriangle(i0, i2, i3);
                        } else {
                            mesh.addTriangle(i0, i2, i1);
                            mesh.addTriangle(i0, i3, i2);
                        }
                    }
                }

                // Pole vertex closing medial deltoid dome
                uint32_t poleIdx = static_cast<uint32_t>(mesh.vertices.size());
                math::Vec3 polePos = spec0.center + math::Vec3(-sign * R * 0.95f, 0, 0);
                mesh.addVertex(geometry::Vertex(polePos, math::Vec3(-sign, 0, 0), math::Vec2(0.5f, 0.0f), mesh.material.baseColorFactor));
                for (int s = 0; s < sectors; ++s) {
                    int sNext = (s + 1) % sectors;
                    if (isLeft) {
                        mesh.addTriangle(poleIdx, domeRings[domeSteps - 1][sNext], domeRings[domeSteps - 1][s]);
                    } else {
                        mesh.addTriangle(poleIdx, domeRings[domeSteps - 1][s], domeRings[domeSteps - 1][sNext]);
                    }
                }
            }

            for (size_t r = 0; r + 1 < rings.size(); ++r) {
                for (int s = 0; s < sectors; ++s) {
                    int sNext = (s + 1) % sectors;
                    uint32_t i0 = ringIndices[r][s];
                    uint32_t i1 = ringIndices[r + 1][s];
                    uint32_t i2 = ringIndices[r + 1][sNext];
                    uint32_t i3 = ringIndices[r][sNext];

                    if (isLeft) {
                        mesh.addTriangle(i0, i2, i1);
                        mesh.addTriangle(i0, i3, i2);
                    } else {
                        mesh.addTriangle(i0, i1, i2);
                        mesh.addTriangle(i0, i2, i3);
                    }
                }
            }

            if (capEnd) {
                uint32_t endCapIdx = static_cast<uint32_t>(mesh.vertices.size());
                math::Vec3 endPole = rings.back().center;
                mesh.addVertex(geometry::Vertex(endPole, math::Vec3(isLeft ? 1.0f : -1.0f, 0, 0), math::Vec2(0.5f, 1.0f), mesh.material.baseColorFactor));
                size_t lastR = rings.size() - 1;
                for (int s = 0; s < sectors; ++s) {
                    int sNext = (s + 1) % sectors;
                    if (isLeft) {
                        mesh.addTriangle(endCapIdx, ringIndices[lastR][s], ringIndices[lastR][sNext]);
                    } else {
                        mesh.addTriangle(endCapIdx, ringIndices[lastR][sNext], ringIndices[lastR][s]);
                    }
                }
            }
            return ringIndices;
        };

        // Helper to loft a longitudinal foot chain along Z (Heel to Toes)
        auto addLoftedFootChain = [&](const std::vector<RingSpec>& rings, bool isLeft, int sectors = 16, bool capStart = true, bool capEnd = true) -> std::vector<std::vector<uint32_t>> {
            if (rings.empty()) return {};

            std::vector<std::vector<uint32_t>> ringIndices(rings.size());
            uint32_t startCapIdx = 0;

            if (capStart) {
                startCapIdx = static_cast<uint32_t>(mesh.vertices.size());
                math::Vec3 startPole = rings.front().center + math::Vec3(0, 0, -0.012f * scale);
                mesh.addVertex(geometry::Vertex(startPole, math::Vec3(0, 0, -1.0f), math::Vec2(0.5f, 0.0f), mesh.material.baseColorFactor));
            }

            for (size_t r = 0; r < rings.size(); ++r) {
                const auto& spec = rings[r];
                ringIndices[r].reserve(sectors);
                float vCoord = static_cast<float>(r) / std::max(1UL, rings.size() - 1);

                for (int s = 0; s < sectors; ++s) {
                    float uCoord = static_cast<float>(s) / sectors;
                    float theta = uCoord * math::TWO_PI;
                    float cosT = std::cos(theta); // X lateral
                    float sinT = std::sin(theta); // Y vertical

                    float radX = spec.rx;
                    float radY = spec.rz;

                    math::Vec3 pos = spec.center + math::Vec3(
                        cosT * radX,
                        sinT * radY,
                        0.0f
                    );

                    // Ground contact: sole does not penetrate Y = 0
                    if (pos.y < 0.0f) pos.y = 0.0f;

                    uint32_t vIdx = static_cast<uint32_t>(mesh.vertices.size());
                    mesh.addVertex(geometry::Vertex(pos, math::Vec3(cosT, sinT, 0), math::Vec2(uCoord, vCoord), mesh.material.baseColorFactor));
                    ringIndices[r].push_back(vIdx);
                }
            }

            if (capStart) {
                for (int s = 0; s < sectors; ++s) {
                    int sNext = (s + 1) % sectors;
                    mesh.addTriangle(startCapIdx, ringIndices[0][sNext], ringIndices[0][s]);
                }
            }

            for (size_t r = 0; r + 1 < rings.size(); ++r) {
                for (int s = 0; s < sectors; ++s) {
                    int sNext = (s + 1) % sectors;
                    uint32_t i0 = ringIndices[r][s];
                    uint32_t i1 = ringIndices[r + 1][s];
                    uint32_t i2 = ringIndices[r + 1][sNext];
                    uint32_t i3 = ringIndices[r][sNext];

                    mesh.addTriangle(i0, i2, i1);
                    mesh.addTriangle(i0, i3, i2);
                }
            }

            if (capEnd) {
                uint32_t endCapIdx = static_cast<uint32_t>(mesh.vertices.size());
                math::Vec3 endPole = rings.back().center + math::Vec3(0, 0, 0.015f * scale);
                mesh.addVertex(geometry::Vertex(endPole, math::Vec3(0, 0, 1.0f), math::Vec2(0.5f, 1.0f), mesh.material.baseColorFactor));
                size_t lastR = rings.size() - 1;
                for (int s = 0; s < sectors; ++s) {
                    int sNext = (s + 1) % sectors;
                    mesh.addTriangle(endCapIdx, ringIndices[lastR][s], ringIndices[lastR][sNext]);
                }
            }
            return ringIndices;
        };

        // Helper to add an articulated finger digit (3 phalanges + tip cap) aligned to segment direction
        auto addArticulatedFinger = [&](const std::vector<math::Vec3>& joints, float baseRadius, bool isLeft, bool capStart = false) -> std::vector<std::vector<uint32_t>> {
            if (joints.size() < 2) return {};
            const int fSectors = 8;
            std::vector<std::vector<uint32_t>> fRings(joints.size());

            for (size_t j = 0; j < joints.size(); ++j) {
                fRings[j].reserve(fSectors);
                float taper = 1.0f - 0.30f * (static_cast<float>(j) / (joints.size() - 1));
                float r = baseRadius * taper;
                math::Vec3 p = joints[j];

                // Compute orthogonal frame along local finger segment ray
                math::Vec3 dir = (j + 1 < joints.size()) ? (joints[j + 1] - joints[j]).normalized() : (joints[j] - joints[j - 1]).normalized();
                math::Vec3 up = std::abs(dir.y) < 0.9f ? math::Vec3(0, 1, 0) : math::Vec3(0, 0, 1);
                math::Vec3 right = dir.cross(up).normalized();
                up = right.cross(dir).normalized();

                for (int s = 0; s < fSectors; ++s) {
                    float theta = static_cast<float>(s) / fSectors * math::TWO_PI;
                    float cT = std::cos(theta);
                    float sT = std::sin(theta);
                    math::Vec3 pos = p + right * (cT * r) + up * (sT * r);
                    uint32_t vIdx = static_cast<uint32_t>(mesh.vertices.size());
                    mesh.addVertex(geometry::Vertex(pos, (right * cT + up * sT).normalized(), math::Vec2(0, 0), mesh.material.baseColorFactor));
                    fRings[j].push_back(vIdx);
                }
            }

            if (capStart) {
                uint32_t startIdx = static_cast<uint32_t>(mesh.vertices.size());
                math::Vec3 firstDir = (joints[1] - joints[0]).normalized();
                math::Vec3 basePole = joints.front() - firstDir * (baseRadius * 0.5f);
                mesh.addVertex(geometry::Vertex(basePole, -firstDir, math::Vec2(0.5f, 0.0f), mesh.material.baseColorFactor));
                for (int s = 0; s < fSectors; ++s) {
                    int sNext = (s + 1) % fSectors;
                    if (isLeft) {
                        mesh.addTriangle(startIdx, fRings[0][s], fRings[0][sNext]);
                    } else {
                        mesh.addTriangle(startIdx, fRings[0][sNext], fRings[0][s]);
                    }
                }
            }

            for (size_t j = 0; j + 1 < joints.size(); ++j) {
                for (int s = 0; s < fSectors; ++s) {
                    int sNext = (s + 1) % fSectors;
                    uint32_t i0 = fRings[j][s];
                    uint32_t i1 = fRings[j + 1][s];
                    uint32_t i2 = fRings[j + 1][sNext];
                    uint32_t i3 = fRings[j][sNext];

                    if (isLeft) {
                        mesh.addTriangle(i0, i1, i2);
                        mesh.addTriangle(i0, i2, i3);
                    } else {
                        mesh.addTriangle(i0, i2, i1);
                        mesh.addTriangle(i0, i3, i2);
                    }
                }
            }

            // Dome cap on distal fingertip
            uint32_t tipIdx = static_cast<uint32_t>(mesh.vertices.size());
            math::Vec3 lastDir = (joints.back() - joints[joints.size() - 2]).normalized();
            math::Vec3 tipPole = joints.back() + lastDir * (baseRadius * 0.6f);
            mesh.addVertex(geometry::Vertex(tipPole, lastDir, math::Vec2(0.5f, 1.0f), mesh.material.baseColorFactor));
            size_t lastJ = joints.size() - 1;
            for (int s = 0; s < fSectors; ++s) {
                int sNext = (s + 1) % fSectors;
                if (isLeft) {
                    mesh.addTriangle(tipIdx, fRings[lastJ][sNext], fRings[lastJ][s]);
                } else {
                    mesh.addTriangle(tipIdx, fRings[lastJ][s], fRings[lastJ][sNext]);
                }
            }
            return fRings;
        };

        // 1. Torso, Shoulder Girdle, Neck, and Sculpted Cranium (Drawing Figure Reference Aesthetic)
        float shoulderAcromionX = 0.208f * scale;
        float waistRx = 0.122f * scale;
        float waistRz = 0.098f * scale;
        float pelvisRx = 0.166f * scale;
        float pelvisRz = 0.134f * scale;
        float gluteBack = 0.36f;
        float pecSplitVal = 0.018f * scale;
        float pecFront = 0.42f;
        float bustZOffset = 0.005f * scale;
        float spinalVal = 0.010f * scale;
        float lineaVal = 0.009f * scale;

        // Facial, cervical, and cranial proportions
        float neckRx1 = 0.048f * scale; // neck base
        float neckRx2 = 0.042f * scale; // mid neck
        float neckRz = 0.046f * scale;
        float jawRx = 0.062f * scale;   // wider than neck: crisp jawline shelf
        float chinFront = 0.40f;
        float noseTipZOffset = 0.022f * scale;
        float cranialRx = 0.082f * scale;
        float cranialRz = 0.096f * scale;

        if (gender == GenderMorph::Male) {
            shoulderAcromionX = 0.222f * scale; // broad heroic biacromial span
            waistRx = 0.122f * scale;           // athletic V-taper
            waistRz = 0.100f * scale;
            pelvisRx = 0.156f * scale;          // sleek athletic pelvic basin
            pelvisRz = 0.120f * scale;
            gluteBack = 0.22f;                  // compact athletic gluteus
            pecSplitVal = 0.0f;                 // superseded by pecPlateVal planar pectoral plates
            pecFront = 0.40f;                   // planar pectoral plates
            bustZOffset = 0.0f;
            spinalVal = 0.014f * scale;         // deep vertebral furrow
            lineaVal = 0.014f * scale;          // athletic six-pack column & linea alba
            neckRx1 = 0.066f * scale;           // trapezius neck root flare
            neckRx2 = 0.044f * scale;           // mid cervical neck column
            neckRz = 0.048f * scale;
            jawRx = 0.062f * scale;             // athletic angular jaw flaring wider than neck
            chinFront = 0.22f;
            noseTipZOffset = 0.012f * scale;
            cranialRx = 0.086f * scale;         // rounded cranial vault
            cranialRz = 0.104f * scale;
        } else if (gender == GenderMorph::Female) {
            shoulderAcromionX = 0.176f * scale; // delicate feminine shoulders
            waistRx = 0.104f * scale;           // high, pronounced hourglass cinched waist
            waistRz = 0.082f * scale;
            pelvisRx = 0.176f * scale;          // wide curvaceous gynecoid pelvic flare (greater trochanters)
            pelvisRz = 0.124f * scale;
            gluteBack = 0.30f;                  // rounded feminine gluteal curve
            pecSplitVal = 0.0f;                 // superseded by bustTeardropVal C2 teardrop bust
            pecFront = 0.48f;                   // natural teardrop bust projection
            bustZOffset = 0.014f * scale;       // soft anterior apex projection
            spinalVal = 0.010f * scale;
            lineaVal = 0.005f * scale;          // subtle smooth abdominal curve
            neckRx1 = 0.050f * scale;           // slender graceful cervical neck root
            neckRx2 = 0.035f * scale;           // slender mid neck column
            neckRz = 0.038f * scale;
            jawRx = 0.050f * scale;             // delicate tapered jaw wider than slender neck
            chinFront = 0.16f;
            noseTipZOffset = 0.010f * scale;
            cranialRx = 0.082f * scale;         // drawing mannequin cranium
            cranialRz = 0.098f * scale;
        }

        float legXNominal = (gender == GenderMorph::Female ? 0.098f : (gender == GenderMorph::Male ? 0.088f : 0.092f)) * scale;
        float thighThick = (gender == GenderMorph::Male) ? 1.02f : ((gender == GenderMorph::Female) ? 0.94f : 1.00f);
        float thighRx = 0.086f * scale * thighThick;
        float thighRz = 0.090f * scale * thighThick;
        float pelvisRimRx = legXNominal + thighRx;
        float pelvisRimRz = thighRz * 1.08f;

        float chinShelfVal = (gender == GenderMorph::Male) ? (0.014f * scale) : ((gender == GenderMorph::Female) ? (0.008f * scale) : (0.010f * scale));
        float bustTeardropVal = (gender == GenderMorph::Female) ? (0.046f * scale) : 0.0f;
        float pecPlateVal = (gender == GenderMorph::Male) ? (0.028f * scale) : ((gender == GenderMorph::Neutral) ? (0.014f * scale) : 0.0f);
        float bustWidth = (gender == GenderMorph::Female) ? 0.074f : 0.078f;
        float pelvicYContour = 0.024f * scale;
        float clavicleVal = (gender == GenderMorph::Male ? 0.012f : 0.010f) * scale;
        float cheekVal = (gender == GenderMorph::Male ? 0.012f : 0.009f) * scale;
        float scapulaVal = (gender == GenderMorph::Male ? 0.012f : 0.008f) * scale;
        float orbitIndentVal = (gender == GenderMorph::Male ? 0.012f : 0.010f) * scale;
        float nasalPyramidVal = (gender == GenderMorph::Male ? 0.016f : 0.014f) * scale;
        float oralPlanesVal = (gender == GenderMorph::Male ? 0.012f : 0.010f) * scale;
        float earPadsVal = (gender == GenderMorph::Male ? 0.010f : 0.008f) * scale;

        float pelvisMidRx = (gender == GenderMorph::Female) ? (waistRx * 1.54f) : (waistRx * 1.18f);
        float pelvisTopRx = (gender == GenderMorph::Female) ? (waistRx * 1.30f) : (waistRx * 1.10f);
        float flankRx     = (gender == GenderMorph::Female) ? (waistRx * 1.12f) : (waistRx * 1.05f);

        std::vector<RingSpec> trunkRings = {
            // Lower pubic basin & Inguinal folds (bifurcation boundary with 3D anatomical contour)
            RingSpec{ .center = math::Vec3(0, 0.865f, -0.004f) * scale, .rx = pelvisRimRx, .rz = pelvisRimRz, .frontBulge = 0.08f, .backBulge = gluteBack * 0.48f, .bustCenterWidth = bustWidth, .yContour = pelvicYContour, .glutealCleft = (gender == GenderMorph::Female ? 0.012f : 0.010f) * scale },
            // Greater trochanter & Gluteal shelf (smooth rounded pelvic flare)
            RingSpec{ .center = math::Vec3(0, 0.915f, -0.008f) * scale, .rx = pelvisRx, .rz = (gender == GenderMorph::Female ? 0.116f : 0.110f) * scale, .frontBulge = 0.08f, .backBulge = gluteBack * 0.65f, .bustCenterWidth = bustWidth, .glutealCleft = (gender == GenderMorph::Female ? 0.016f : 0.014f) * scale },
            // Mid-gluteus & Lower abdomen (smooth continuous blend)
            RingSpec{ .center = math::Vec3(0, 0.965f, -0.006f) * scale, .rx = pelvisMidRx, .rz = (gender == GenderMorph::Female ? 0.108f : 0.104f) * scale, .frontBulge = 0.10f, .backBulge = gluteBack * 0.45f, .bustCenterWidth = bustWidth, .glutealCleft = (gender == GenderMorph::Female ? 0.010f : 0.008f) * scale },
            // Iliac crest & Navel
            RingSpec{ .center = math::Vec3(0, 1.015f, -0.002f) * scale, .rx = pelvisTopRx, .rz = (gender == GenderMorph::Female ? 0.100f : 0.098f) * scale, .frontBulge = 0.10f, .backBulge = gluteBack * 0.30f, .spinalGroove = spinalVal, .lineaAlba = lineaVal * 0.8f, .bustCenterWidth = bustWidth },
            // Flank & Waist taper
            RingSpec{ .center = math::Vec3(0, 1.070f,  0.004f) * scale, .rx = flankRx, .rz = waistRz * 1.04f, .frontBulge = 0.08f, .backBulge = 0.08f, .spinalGroove = spinalVal, .lineaAlba = lineaVal, .bustCenterWidth = bustWidth },
            // Narrowest athletic waist (lumbar lordosis forward arch)
            RingSpec{ .center = math::Vec3(0, 1.130f,  0.008f) * scale, .rx = waistRx, .rz = waistRz, .frontBulge = 0.06f, .backBulge = 0.06f, .spinalGroove = spinalVal, .lineaAlba = lineaVal, .bustCenterWidth = bustWidth },
            // Lower ribcage (10th rib margin)
            RingSpec{ .center = math::Vec3(0, 1.190f,  0.006f) * scale, .rx = waistRx * (gender == GenderMorph::Female ? 1.12f : 1.10f), .rz = waistRz * 1.08f, .frontBulge = 0.08f, .backBulge = 0.08f, .spinalGroove = spinalVal, .lineaAlba = lineaVal, .bustCenterWidth = bustWidth },
            // Mid thorax / Thoracic arch (thoracic kyphosis begins)
            RingSpec{ .center = math::Vec3(0, 1.250f,  0.000f) * scale, .rx = waistRx * (gender == GenderMorph::Female ? 1.22f : 1.24f), .rz = waistRz * 1.14f, .frontBulge = 0.10f, .backBulge = 0.08f, .spinalGroove = spinalVal, .lineaAlba = lineaVal * 0.5f, .bustCenterWidth = bustWidth },
            // Lower pectoral / Inframammary fold undercut
            RingSpec{ .center = math::Vec3(0, 1.295f, -0.006f) * scale, .rx = shoulderAcromionX * (gender == GenderMorph::Female ? 0.80f : 0.78f), .rz = 0.116f * scale, .frontBulge = 0.06f, .backBulge = 0.06f, .pectoralSplit = pecSplitVal * 0.5f, .spinalGroove = spinalVal, .teardropBust = bustTeardropVal * 0.60f, .pectoralPlates = pecPlateVal * 0.85f, .bustCenterWidth = bustWidth, .scapulaPlates = scapulaVal * 0.5f },
            // Mid pectorals & Bust apex (separated teardrop mounds or chiseled plates)
            RingSpec{ .center = math::Vec3(0, 1.345f, -0.008f) * scale, .rx = shoulderAcromionX * (gender == GenderMorph::Female ? 0.86f : 0.84f), .rz = 0.120f * scale, .frontBulge = 0.08f, .backBulge = 0.05f, .pectoralSplit = pecSplitVal, .spinalGroove = spinalVal, .teardropBust = bustTeardropVal, .pectoralPlates = pecPlateVal, .bustCenterWidth = bustWidth, .scapulaPlates = scapulaVal },
            // Upper chest slope
            RingSpec{ .center = math::Vec3(0, 1.395f, -0.010f) * scale, .rx = shoulderAcromionX * (gender == GenderMorph::Female ? 0.91f : 0.90f), .rz = 0.122f * scale, .frontBulge = 0.06f, .backBulge = 0.05f, .pectoralSplit = pecSplitVal * 0.6f, .spinalGroove = spinalVal * 0.8f, .teardropBust = bustTeardropVal * 0.45f, .pectoralPlates = pecPlateVal * 0.65f, .bustCenterWidth = bustWidth, .scapulaPlates = scapulaVal * 0.75f },
            // Sternal notch & Acromion deltoid shelf (flaring out to cup shoulder deltoid head)
            RingSpec{ .center = math::Vec3(0, 1.435f, -0.012f) * scale, .rx = shoulderAcromionX * (gender == GenderMorph::Female ? 0.96f : 0.95f), .rz = 0.118f * scale, .frontBulge = 0.10f, .backBulge = 0.05f, .topBulge = 0.008f * scale, .bustCenterWidth = bustWidth, .clavicleRidge = clavicleVal },
            // Clavicle line & Trapezius slope
            RingSpec{ .center = math::Vec3(0, 1.465f, -0.006f) * scale, .rx = shoulderAcromionX * 0.68f, .rz = 0.094f * scale, .frontBulge = 0.08f, .backBulge = 0.05f, .topBulge = 0.006f * scale, .bustCenterWidth = bustWidth, .clavicleRidge = clavicleVal * 0.75f },
            // Upper trapezius & Neck root
            RingSpec{ .center = math::Vec3(0, 1.492f, -0.008f) * scale, .rx = neckRx1, .rz = neckRz * 1.12f, .frontBulge = 0.06f, .backBulge = 0.04f, .bustCenterWidth = bustWidth },
            // Mid cervical neck & Laryngeal prominence
            RingSpec{ .center = math::Vec3(0, 1.520f, -0.002f) * scale, .rx = neckRx2, .rz = neckRz, .frontBulge = 0.06f, .backBulge = 0.04f, .bustCenterWidth = bustWidth },
            // Submandibular throat & Jawline shelf base
            RingSpec{ .center = math::Vec3(0, 1.545f,  0.004f) * scale, .rx = neckRx2 * 1.08f, .rz = neckRz * 1.02f, .frontBulge = 0.04f, .backBulge = 0.05f, .zOffset = 0.002f * scale, .temporalFlats = 0.0f, .bustCenterWidth = bustWidth },
            // Mandible & Mental protuberance (Chin pogonion - Loomis drawing pad)
            RingSpec{ .center = math::Vec3(0, 1.568f,  0.010f) * scale, .rx = jawRx, .rz = cranialRz * 0.76f, .frontBulge = chinFront, .backBulge = 0.06f, .zOffset = 0.008f * scale, .temporalFlats = 0.10f, .chinShelf = chinShelfVal, .jawTaper = (gender == GenderMorph::Female ? 0.58f : 0.50f), .bustCenterWidth = bustWidth },
            // Lower lip & Labiomental groove
            RingSpec{ .center = math::Vec3(0, 1.590f,  0.010f) * scale, .rx = jawRx * 1.02f, .rz = cranialRz * 0.80f, .frontBulge = 0.12f, .backBulge = 0.05f, .zOffset = 0.008f * scale, .temporalFlats = 0.12f, .chinShelf = chinShelfVal * 0.5f, .bustCenterWidth = bustWidth, .oralPlanes = oralPlanesVal * 0.85f, .jawTaper = (gender == GenderMorph::Female ? 0.46f : 0.38f) },
            // Oral fissure & Upper lip / Philtrum
            RingSpec{ .center = math::Vec3(0, 1.612f,  0.008f) * scale, .rx = jawRx * 1.04f, .rz = cranialRz * 0.82f, .frontBulge = 0.14f, .backBulge = 0.05f, .zOffset = 0.010f * scale, .temporalFlats = 0.15f, .bustCenterWidth = bustWidth, .oralPlanes = oralPlanesVal, .jawTaper = (gender == GenderMorph::Female ? 0.35f : 0.28f) },
            // Subnasale & Maxillary base
            RingSpec{ .center = math::Vec3(0, 1.634f,  0.005f) * scale, .rx = cranialRx * 0.86f, .rz = cranialRz * 0.86f, .frontBulge = 0.16f, .backBulge = 0.05f, .zOffset = 0.010f * scale, .temporalFlats = 0.20f, .bustCenterWidth = bustWidth, .nasalPyramid = nasalPyramidVal * 0.70f, .earPads = earPadsVal * 0.75f, .jawTaper = (gender == GenderMorph::Female ? 0.20f : 0.15f) },
            // Pronasale (Nose tip) & Zygomatic arches (Cheekbones)
            RingSpec{ .center = math::Vec3(0, 1.656f,  0.000f) * scale, .rx = cranialRx * 0.92f, .rz = cranialRz * 0.90f, .frontBulge = 0.18f, .backBulge = 0.06f, .zOffset = noseTipZOffset, .temporalFlats = 0.22f, .bustCenterWidth = bustWidth, .zygomaticFlats = cheekVal, .nasalPyramid = nasalPyramidVal, .earPads = earPadsVal },
            // Eye orbits & Superciliary brow ridge (Loomis brow shelf)
            RingSpec{ .center = math::Vec3(0, 1.680f, -0.004f) * scale, .rx = cranialRx * 0.95f, .rz = cranialRz * 0.94f, .frontBulge = 0.12f, .backBulge = 0.08f, .zOffset = 0.006f * scale, .temporalFlats = 0.20f, .bustCenterWidth = bustWidth, .eyeOrbitIndent = orbitIndentVal, .nasalPyramid = nasalPyramidVal * 0.50f, .earPads = earPadsVal },
            // Glabella & Lower forehead
            RingSpec{ .center = math::Vec3(0, 1.705f, -0.006f) * scale, .rx = cranialRx * 0.98f, .rz = cranialRz * 0.96f, .frontBulge = 0.08f, .backBulge = 0.08f, .zOffset = 0.002f * scale, .temporalFlats = 0.12f, .bustCenterWidth = bustWidth },
            // Mid forehead & Cranial equator (parietal eminence peak - widest biparietal cranium)
            RingSpec{ .center = math::Vec3(0, 1.730f, -0.006f) * scale, .rx = cranialRx * 1.00f, .rz = cranialRz * 0.94f, .frontBulge = 0.04f, .backBulge = 0.06f, .temporalFlats = 0.0f, .bustCenterWidth = bustWidth },
            // Parietal cranial vault (rounding inward smoothly)
            RingSpec{ .center = math::Vec3(0, 1.755f, -0.006f) * scale, .rx = cranialRx * 0.92f, .rz = cranialRz * 0.86f, .frontBulge = 0.02f, .backBulge = 0.04f, .temporalFlats = 0.0f, .bustCenterWidth = bustWidth },
            // Superior calvaria vault (spherical inward curving)
            RingSpec{ .center = math::Vec3(0, 1.776f, -0.006f) * scale, .rx = cranialRx * 0.76f, .rz = cranialRz * 0.72f, .frontBulge = 0.00f, .backBulge = 0.02f, .temporalFlats = 0.0f, .bustCenterWidth = bustWidth },
            // Pre-vertex curvature
            RingSpec{ .center = math::Vec3(0, 1.785f, -0.006f) * scale, .rx = cranialRx * 0.52f, .rz = cranialRz * 0.50f, .frontBulge = 0.00f, .backBulge = 0.00f, .bustCenterWidth = bustWidth },
            // Cranial vertex crown (top dome)
            RingSpec{ .center = math::Vec3(0, 1.794f, -0.006f) * scale, .rx = cranialRx * 0.26f, .rz = cranialRz * 0.25f, .frontBulge = 0.00f, .backBulge = 0.00f, .bustCenterWidth = bustWidth }
        };
        auto trunkRingIndices = addLoftedVerticalChain(trunkRings, 24, false, true);
        const auto& pelvisRim = trunkRingIndices[0]; // 24 boundary sectors at Y = 0.850m

        // 2. Arms, Wrists, and 5-Digit Articulated Hands (Left and Right)
        float shoulderWidthScale = (gender == GenderMorph::Female) ? 0.88f : ((gender == GenderMorph::Male) ? 1.00f : 0.94f);
        float shoulderJointX = 0.208f * shoulderWidthScale * scale;
        float armXOffset = (shoulderWidthScale - 1.0f) * 0.20f * scale;
        float elbowX = 0.48f * scale + armXOffset;
        float wristX = 0.74f * scale + armXOffset;
        float knuckleX = 0.795f * scale + armXOffset;
        float armThick = (gender == GenderMorph::Male) ? 1.05f : ((gender == GenderMorph::Female) ? 0.88f : 1.00f);
        float fingerScale = (gender == GenderMorph::Male) ? 1.04f : ((gender == GenderMorph::Female) ? 0.86f : 1.00f);

        for (int side : { 1, -1 }) {
            float sign = static_cast<float>(side);
            bool isLeft = (side == 1);

            std::vector<RingSpec> armRings = {
                // Glenoid lip / Subacromial space (proximal arm boundary - concentric with shoulder pivot)
                { math::Vec3(sign * shoulderJointX, 1.426f * scale, -0.008f * scale), 0.066f * scale * armThick, 0.066f * scale * armThick, 0.0f, 0.0f, 0.04f, 0.0f },
                // Deltoid belly origin
                { math::Vec3(sign * (shoulderJointX * 0.75f + elbowX * 0.25f), 1.424f * scale, -0.008f * scale), 0.070f * scale * armThick, 0.068f * scale * armThick, 0.0f, 0.0f, 0.06f, 0.0f },
                // Deltoid lateral peak / insertion
                { math::Vec3(sign * (shoulderJointX * 0.50f + elbowX * 0.50f), 1.420f * scale, -0.008f * scale), 0.064f * scale * armThick, 0.062f * scale * armThick, 0.0f, 0.0f, 0.04f, 0.0f },
                // Mid humerus (Bicep/Tricep)
                { math::Vec3(sign * (shoulderJointX * 0.25f + elbowX * 0.75f), 1.414f * scale, -0.009f * scale), 0.056f * scale * armThick, 0.054f * scale * armThick, 0.0f, 0.0f, 0.04f, 0.0f },
                // Elbow hinge & Olecranon process
                { math::Vec3(sign * elbowX, 1.410f * scale, -0.010f * scale), 0.048f * scale * armThick, 0.048f * scale * armThick, 0.0f, 0.14f, 0.04f, 0.0f },
                // Upper forearm & Brachioradialis flare
                { math::Vec3(sign * (elbowX * 0.75f + wristX * 0.25f), 1.406f * scale, -0.008f * scale), 0.054f * scale * armThick, 0.048f * scale * armThick, 0.0f, 0.0f, 0.16f, 0.0f },
                // Mid forearm muscle belly
                { math::Vec3(sign * (elbowX * 0.50f + wristX * 0.50f), 1.404f * scale, -0.006f * scale), 0.048f * scale * armThick, 0.042f * scale * armThick, 0.0f, 0.0f, 0.10f, 0.0f },
                // Lower forearm / Flexor tendons
                { math::Vec3(sign * (elbowX * 0.25f + wristX * 0.75f), 1.402f * scale, -0.004f * scale), 0.036f * scale * armThick, 0.032f * scale * armThick, 0.0f, 0.0f, 0.04f, 0.0f },
                // Distal radius & Ulnar head
                { math::Vec3(sign * (wristX - 0.025f * scale), 1.400f * scale, -0.002f * scale), 0.030f * scale * armThick, 0.024f * scale * armThick, 0.0f, 0.0f, 0.01f, 0.0f },
                // Carpal wrist joint
                { math::Vec3(sign * wristX, 1.400f * scale,  0.000f), 0.028f * scale * armThick, 0.020f * scale * armThick, 0.0f, 0.0f, 0.0f,  0.0f },
                // Metacarpal palm base
                { math::Vec3(sign * (wristX * 0.50f + knuckleX * 0.50f), 1.400f * scale,  0.000f), 0.032f * scale * armThick, 0.020f * scale * armThick, 0.15f, 0.0f, 0.0f, 0.0f },
                // Metacarpal knuckles
                { math::Vec3(sign * knuckleX, 1.400f * scale,  0.000f), 0.032f * scale * armThick, 0.018f * scale * armThick, 0.0f, 0.0f, 0.0f,  0.0f }
            };
            auto armRingIndices = addLoftedArmChain(armRings, isLeft, 24, true, true);

            // Five articulated 3D digits per hand (watertight anatomical phalanges)
            float hx = sign * knuckleX;
            float hy = 1.400f * scale;

            // Thumb (abducted anterolaterally with opposable rotation)
            std::vector<math::Vec3> thumb = {
                math::Vec3(hx - sign * 0.015f * scale, hy - 0.010f * scale,  0.020f * scale),
                math::Vec3(hx + sign * 0.012f * scale, hy - 0.018f * scale,  0.032f * scale),
                math::Vec3(hx + sign * 0.032f * scale, hy - 0.024f * scale,  0.040f * scale),
                math::Vec3(hx + sign * 0.050f * scale, hy - 0.030f * scale,  0.046f * scale)
            };
            auto thumbRings = addArticulatedFinger(thumb, 0.0082f * fingerScale, isLeft, true);

            // Index
            std::vector<math::Vec3> index = {
                math::Vec3(hx, hy + 0.024f * scale,  0.004f * scale),
                math::Vec3(hx + sign * 0.030f * scale, hy + 0.023f * scale,  0.007f * scale),
                math::Vec3(hx + sign * 0.052f * scale, hy + 0.020f * scale,  0.012f * scale),
                math::Vec3(hx + sign * 0.069f * scale, hy + 0.016f * scale,  0.018f * scale)
            };
            auto indexRings = addArticulatedFinger(index, 0.0078f * fingerScale, isLeft, true);

            // Middle
            std::vector<math::Vec3> middle = {
                math::Vec3(hx + sign * 0.002f * scale, hy + 0.007f * scale,  0.000f),
                math::Vec3(hx + sign * 0.034f * scale, hy + 0.006f * scale,  0.004f * scale),
                math::Vec3(hx + sign * 0.058f * scale, hy + 0.003f * scale,  0.010f * scale),
                math::Vec3(hx + sign * 0.077f * scale, hy - 0.001f * scale,  0.016f * scale)
            };
            auto middleRings = addArticulatedFinger(middle, 0.0082f * fingerScale, isLeft, true);

            // Ring
            std::vector<math::Vec3> ring = {
                math::Vec3(hx, hy - 0.010f * scale, -0.003f * scale),
                math::Vec3(hx + sign * 0.030f * scale, hy - 0.012f * scale,  0.001f * scale),
                math::Vec3(hx + sign * 0.052f * scale, hy - 0.015f * scale,  0.007f * scale),
                math::Vec3(hx + sign * 0.069f * scale, hy - 0.019f * scale,  0.013f * scale)
            };
            auto ringRings = addArticulatedFinger(ring, 0.0076f * fingerScale, isLeft, true);

            // Pinky
            std::vector<math::Vec3> pinky = {
                math::Vec3(hx - sign * 0.002f * scale, hy - 0.026f * scale, -0.005f * scale),
                math::Vec3(hx + sign * 0.024f * scale, hy - 0.029f * scale, -0.001f * scale),
                math::Vec3(hx + sign * 0.042f * scale, hy - 0.033f * scale,  0.005f * scale),
                math::Vec3(hx + sign * 0.057f * scale, hy - 0.037f * scale,  0.010f * scale)
            };
            auto pinkyRings = addArticulatedFinger(pinky, 0.0070f * fingerScale, isLeft, true);
        }

        // 3. Unified Seamless Legs and Articulated Grounded Feet (Left and Right)
        float legThick = (gender == GenderMorph::Male) ? 1.04f : ((gender == GenderMorph::Female) ? 0.94f : 1.00f);
        float footScale = (gender == GenderMorph::Male) ? 1.04f : ((gender == GenderMorph::Female) ? 0.88f : 1.00f);

        std::vector<uint32_t> leftThighTop;
        std::vector<uint32_t> rightThighTop;

        for (int leg = 0; leg < 2; ++leg) {
            bool isLeft = (leg == 0);
            float sign = isLeft ? 1.0f : -1.0f;
            float legX = sign * legXNominal;

            float shinCrestVal = (gender == GenderMorph::Male ? 0.007f : 0.005f) * scale;
            float kneePlateVal = (gender == GenderMorph::Male ? 0.016f : 0.012f) * scale;
            float quadTeardropVal = (gender == GenderMorph::Male ? 0.016f : 0.012f) * scale;
            float vastusLatVal = (gender == GenderMorph::Male ? 0.014f : 0.010f) * scale;
            float calfAsymVal = (gender == GenderMorph::Male ? 0.015f : 0.011f) * scale;
            float malleolusVal = (gender == GenderMorph::Male ? 0.010f : 0.008f) * scale;

            auto getLegCenterX = [&](int ringIdx) -> float {
                // Taper factor: Ring 16 (hip top) = 1.0, descending to 0.78 at knee and 0.68 at ankle/foot
                static const float qFactors[17] = {
                    0.68f, 0.68f, 0.68f, 0.68f, 0.68f, // 0-4: foot, ankle, distal tibia
                    0.70f, 0.72f, 0.74f, 0.76f,        // 5-8: shin, calf
                    0.77f, 0.78f, 0.80f,               // 9-11: knee
                    0.84f, 0.89f, 0.94f, 0.98f,        // 12-15: thigh
                    1.00f                              // 16: thigh top / pelvis rim
                };
                return sign * legXNominal * qFactors[ringIdx];
            };

            // Single continuous 24-sector vertical chain from Ground Sole -> Calcaneus Heel -> Ankle -> Shin -> Calf -> Knee -> Thigh Top
            std::vector<RingSpec> unifiedLegRings = {
                // Ring 0: Ground sole footprint (planar floor contact at Y = 0.0m, calcaneus to toes)
                RingSpec{ .center = math::Vec3(getLegCenterX(0), 0.000f,           0.045f * scale), .rx = 0.042f * scale * footScale, .rz = 0.102f * scale * footScale },
                // Ring 1: Sole margin & toe box slope
                RingSpec{ .center = math::Vec3(getLegCenterX(1), 0.024f * scale,  0.040f * scale), .rx = 0.041f * scale * footScale, .rz = 0.096f * scale * footScale, .backBulge = 0.04f },
                // Ring 2: Calcaneus heel bulb & high instep dorsum
                RingSpec{ .center = math::Vec3(getLegCenterX(2), 0.050f * scale,  0.016f * scale), .rx = (gender == GenderMorph::Female ? 0.034f : 0.038f) * scale * footScale, .rz = (gender == GenderMorph::Female ? 0.064f : 0.070f) * scale * footScale, .backBulge = 0.10f },
                // Ring 3: Ankle mortise & Malleoli
                RingSpec{ .center = math::Vec3(getLegCenterX(3), 0.082f * scale, -0.001f * scale), .rx = (gender == GenderMorph::Female ? 0.028f : 0.034f) * scale * legThick, .rz = (gender == GenderMorph::Female ? 0.030f : 0.036f) * scale * legThick, .frontBulge = 0.04f, .backBulge = 0.05f, .malleolusOffset = malleolusVal },
                // Ring 4: Distal tibia & Supramalleolar notch (slender human ankle taper)
                RingSpec{ .center = math::Vec3(getLegCenterX(4), 0.138f * scale, -0.002f * scale), .rx = (gender == GenderMorph::Female ? 0.026f : 0.032f) * scale * legThick, .rz = (gender == GenderMorph::Female ? 0.028f : 0.034f) * scale * legThick, .frontBulge = 0.04f, .backBulge = 0.08f },
                // Ring 5: Lower shin & Soleus muscle
                RingSpec{ .center = math::Vec3(getLegCenterX(5), 0.198f * scale, -0.003f * scale), .rx = (gender == GenderMorph::Female ? 0.038f : 0.044f) * scale * legThick, .rz = (gender == GenderMorph::Female ? 0.040f : 0.046f) * scale * legThick, .frontBulge = 0.06f, .backBulge = 0.14f, .tibialCrest = shinCrestVal * 0.8f },
                // Ring 6: Mid calf taper
                RingSpec{ .center = math::Vec3(getLegCenterX(6), 0.258f * scale, -0.004f * scale), .rx = (gender == GenderMorph::Female ? 0.050f : 0.056f) * scale * legThick, .rz = (gender == GenderMorph::Female ? 0.054f : 0.060f) * scale * legThick, .frontBulge = 0.08f, .backBulge = 0.18f, .tibialCrest = shinCrestVal, .calfAsymmetry = calfAsymVal * 0.70f },
                // Ring 7: Gastrocnemius lower belly
                RingSpec{ .center = math::Vec3(getLegCenterX(7), 0.318f * scale, -0.004f * scale), .rx = (gender == GenderMorph::Female ? 0.060f : 0.066f) * scale * legThick, .rz = (gender == GenderMorph::Female ? 0.064f : 0.070f) * scale * legThick, .frontBulge = 0.10f, .backBulge = 0.22f, .zOffset = -0.002f * scale, .tibialCrest = shinCrestVal, .calfAsymmetry = calfAsymVal },
                // Ring 8: Gastrocnemius upper calf peak (smooth S-curve drawing mannequin contour)
                RingSpec{ .center = math::Vec3(getLegCenterX(8), 0.368f * scale, -0.003f * scale), .rx = (gender == GenderMorph::Female ? 0.065f : 0.070f) * scale * legThick, .rz = (gender == GenderMorph::Female ? 0.068f : 0.076f) * scale * legThick, .frontBulge = 0.12f, .backBulge = (gender == GenderMorph::Male ? 0.24f : 0.20f), .zOffset = -0.002f * scale, .tibialCrest = shinCrestVal * 0.9f, .calfAsymmetry = calfAsymVal * 0.50f },
                // Ring 9: Tibial tuberosity & Infrapatellar fat pad
                RingSpec{ .center = math::Vec3(getLegCenterX(9), 0.418f * scale,  0.000f),          .rx = 0.066f * scale * legThick, .rz = 0.066f * scale * legThick, .frontBulge = 0.18f, .backBulge = 0.06f, .zOffset = 0.001f * scale, .tibialCrest = shinCrestVal * 1.1f },
                // Ring 10: Patella center & Popliteal fossa (chiseled planar kneecap shield)
                RingSpec{ .center = math::Vec3(getLegCenterX(10), 0.458f * scale, 0.002f * scale), .rx = (gender == GenderMorph::Female ? 0.062f : 0.070f) * scale * legThick, .rz = (gender == GenderMorph::Female ? 0.064f : 0.070f) * scale * legThick, .frontBulge = (gender == GenderMorph::Male ? 0.36f : 0.28f), .backBulge = 0.06f, .zOffset = 0.003f * scale, .patellaPlate = kneePlateVal },
                // Ring 11: Knee upper margin & Quadriceps tendon notch
                RingSpec{ .center = math::Vec3(getLegCenterX(11), 0.508f * scale, 0.001f * scale), .rx = 0.070f * scale * legThick, .rz = 0.072f * scale * legThick, .frontBulge = 0.26f, .backBulge = 0.06f, .patellaPlate = kneePlateVal * 0.5f, .quadTeardrop = quadTeardropVal },
                // Ring 12: Lower thigh supracondylar
                RingSpec{ .center = math::Vec3(getLegCenterX(12), 0.568f * scale, 0.000f),          .rx = 0.076f * scale * legThick, .rz = 0.076f * scale * legThick, .frontBulge = 0.16f, .backBulge = 0.08f, .quadTeardrop = quadTeardropVal * 0.75f, .vastusLateralis = vastusLatVal * 0.50f },
                // Ring 13: Mid thigh
                RingSpec{ .center = math::Vec3(getLegCenterX(13), 0.648f * scale, -0.002f * scale), .rx = 0.082f * scale * legThick, .rz = 0.084f * scale * legThick, .frontBulge = 0.18f, .backBulge = 0.12f, .vastusLateralis = vastusLatVal },
                // Ring 14: Mid-upper thigh
                RingSpec{ .center = math::Vec3(getLegCenterX(14), 0.728f * scale, -0.004f * scale), .rx = 0.086f * scale * legThick, .rz = 0.088f * scale * legThick, .frontBulge = 0.20f, .backBulge = 0.14f, .vastusLateralis = vastusLatVal * 0.85f },
                // Ring 15: Upper thigh / Quadriceps rectus femoris
                RingSpec{ .center = math::Vec3(getLegCenterX(15), 0.785f * scale, -0.006f * scale), .rx = 0.088f * scale * legThick, .rz = 0.092f * scale * legThick, .frontBulge = 0.22f, .backBulge = 0.16f, .vastusLateralis = vastusLatVal * 0.50f },
                // Ring 16: Inguinal thigh / Adductor insertion (bifurcation boundary with 3D anatomical contour matching pelvis)
                RingSpec{ .center = math::Vec3(getLegCenterX(16), 0.835f * scale, -0.008f * scale), .rx = 0.088f * scale * legThick, .rz = 0.092f * scale * legThick, .frontBulge = 0.12f, .backBulge = 0.18f, .yContour = pelvicYContour }
            };
            auto legRingIndices = addLoftedVerticalChain(unifiedLegRings, 24, true, false, isLeft ? 1 : -1);
            if (isLeft) {
                leftThighTop = legRingIndices.back();
            } else {
                rightThighTop = legRingIndices.back();
            }
        }

        // 4. Pelvic Y-Bifurcation and Perineum Crotch Bridge (Seamless 2-Manifold Torso-to-Legs Connection)
        // 1. Lateral Left Pelvis to Left Thigh: 12 segments (s: 18 -> 23, 0 -> 6)
        for (int step = 0; step < 12; ++step) {
            int s0 = (18 + step) % 24;
            int s1 = (18 + step + 1) % 24;
            uint32_t p0 = pelvisRim[s0];
            uint32_t p1 = pelvisRim[s1];
            uint32_t t0 = leftThighTop[s0];
            uint32_t t1 = leftThighTop[s1];
            mesh.addTriangle(t0, p0, p1);
            mesh.addTriangle(t0, p1, t1);
        }

        // 2. Lateral Right Pelvis to Right Thigh: 12 segments (s: 6 -> 18)
        for (int step = 0; step < 12; ++step) {
            int s0 = 6 + step;
            int s1 = 6 + step + 1;
            uint32_t p0 = pelvisRim[s0];
            uint32_t p1 = pelvisRim[s1];
            uint32_t t0 = rightThighTop[s0];
            uint32_t t1 = rightThighTop[s1];
            mesh.addTriangle(t0, p0, p1);
            mesh.addTriangle(t0, p1, t1);
        }

        // 3. Central Perineum Crotch Saddle Seam:
        // Left medial thigh: s runs from 6 to 18 (12 steps)
        // Right medial thigh: s runs from 6 backwards to 18 (12 steps): 6, 5, 4..0, 23..18
        for (int k = 0; k < 12; ++k) {
            int l0 = 6 + k;
            int l1 = 6 + k + 1;
            int r0 = (6 - k + 24) % 24;
            int r1 = (5 - k + 24) % 24;
            uint32_t lt0 = leftThighTop[l0];
            uint32_t lt1 = leftThighTop[l1];
            uint32_t rt0 = rightThighTop[r0];
            uint32_t rt1 = rightThighTop[r1];
            mesh.addTriangle(lt0, rt0, rt1);
            mesh.addTriangle(lt0, rt1, lt1);
        }

        // 4. Front & Back Midline Apex Triangles
        mesh.addTriangle(pelvisRim[6], rightThighTop[6], leftThighTop[6]);
        mesh.addTriangle(pelvisRim[18], leftThighTop[18], rightThighTop[18]);

        // Grounded foot contact with anatomical medial longitudinal arch
        for (auto& v : mesh.vertices) {
            if (v.position.y < 0.025f * scale && v.position.y > -0.05f * scale) {
                float absX = std::abs(v.position.x);
                bool isMedial = (absX < legXNominal * 0.72f);
                bool isInstepZ = (v.position.z > 0.020f * scale && v.position.z < 0.070f * scale);
                if (isMedial && isInstepZ) {
                    float uZ = (v.position.z - 0.020f * scale) / (0.050f * scale);
                    float archFactor = std::sin(uZ * math::PI);
                    float archHeight = (gender == GenderMorph::Male ? 0.012f : 0.010f) * scale * archFactor;
                    if (v.position.y < archHeight) v.position.y = archHeight;
                } else {
                    if (v.position.y < 0.008f * scale) v.position.y = 0.0f;
                }
            }
        }

        // Seamless mesh topology: smooth normals across all stitched organic contours
        mesh.recomputeSmoothNormals();
        shaper::WeightedNormalOptions normOpt;
        normOpt.keepSharpEdges = false;
        shaper::BevelEngine::applyWeightedNormals(mesh, normOpt);

        return mesh;
    }

    /**
     * Builds a proportional humanoid mesh with anatomical segments
     */
    static geometry::ScratchboxMesh buildProportionalHumanoid(float height = 1.8f, float shoulderWidth = 0.44f) {
        return buildAnatomicalWatertightHumanoid(height, shoulderWidth);
    }

    /**
     * Automatically binds mesh vertices to skeletal joints via bone-segment distance weighting
     */
    static std::vector<VertexSkinWeight> generateStandardWeights(
        const geometry::ScratchboxMesh& mesh,
        const kinematics::Skeleton& skeleton
    ) {
        std::vector<VertexSkinWeight> weights(mesh.vertices.size());
        const size_t numJoints = skeleton.joints.size();

        struct JointDist {
            uint16_t jointIndex;
            float distance;
        };

        // Distance from point P to segment A-B
        auto distToSegment = [](const math::Vec3& p, const math::Vec3& a, const math::Vec3& b) -> float {
            math::Vec3 ab = b - a;
            float lenSq = ab.dot(ab);
            if (lenSq < 1e-6f) return (p - a).length();
            float t = std::clamp((p - a).dot(ab) / lenSq, 0.0f, 1.0f);
            math::Vec3 proj = a + ab * t;
            return (p - proj).length();
        };

        // Identify primary child for each joint to establish anatomical bone segments
        std::vector<int> primaryChild(numJoints, -1);
        for (size_t j = 0; j < numJoints; ++j) {
            int p = skeleton.joints[j].parentIndex;
            if (p >= 0 && primaryChild[p] < 0) {
                primaryChild[p] = static_cast<int>(j);
            }
        }

        // Estimate height scale from mesh bounds
        float scale = (mesh.bounds.max.y > 0.5f) ? (mesh.bounds.max.y / 1.80f) : 1.0f;

        for (size_t i = 0; i < mesh.vertices.size(); ++i) {
            const auto& pos = mesh.vertices[i].position;
            std::vector<JointDist> dists;
            dists.reserve(numJoints);

            for (size_t j = 0; j < numJoints; ++j) {
                const auto& joint = skeleton.joints[j];
                const auto& pj = joint.restPosition;
                const std::string& name = joint.name;

                // 1. Bilateral isolation: Prevent Left/Right cross-midline bleeding
                bool isLeft = (name.find("Left") != std::string::npos || name.find("left") != std::string::npos);
                bool isRight = (name.find("Right") != std::string::npos || name.find("right") != std::string::npos);
                if (isLeft && pos.x < -0.012f * scale) continue;
                if (isRight && pos.x > 0.012f * scale) continue;

                // 2. Cranial/Facial isolation: Head, Jaw, Eyes must not skin below the neck
                bool isFacialOrHead = (name.find("Head") != std::string::npos || 
                                       name.find("Jaw") != std::string::npos || 
                                       name.find("Eye") != std::string::npos);
                if (isFacialOrHead && pos.y < 1.48f * scale) continue;

                // 3. Cervical isolation: Neck must not skin down into the breasts/chest
                bool isNeck = (name.find("Neck") != std::string::npos || name.find("neck") != std::string::npos);
                if (isNeck && pos.y < 1.455f * scale) continue;

                // 4. Thoracic & Arm Isolation:
                // Arm bones (Shoulder, Elbow, Wrist, Hand, Fingers) must not pull on the torso trunk (ribcage, pectorals, latissimus dorsi)
                bool isArmBone = (name.find("Shoulder") != std::string::npos || 
                                  name.find("Elbow") != std::string::npos ||
                                  name.find("Wrist") != std::string::npos ||
                                  name.find("Hand") != std::string::npos ||
                                  name.find("Thumb") != std::string::npos ||
                                  name.find("Index") != std::string::npos ||
                                  name.find("Middle") != std::string::npos ||
                                  name.find("Ring") != std::string::npos ||
                                  name.find("Pinky") != std::string::npos ||
                                  name.find("Arm") != std::string::npos);
                if (isArmBone) {
                    if (pos.y < 1.36f * scale && std::abs(pos.x) < 0.26f * scale) continue;
                    if (std::abs(pos.x) < 0.165f * scale) continue;
                    if (name.find("Shoulder") == std::string::npos && std::abs(pos.x) < 0.24f * scale) continue;
                    if (name.find("Shoulder") != std::string::npos && std::abs(pos.z) > 0.065f * scale && std::abs(pos.x) < 0.23f * scale) continue;
                }
                if (name.find("Collar") != std::string::npos && (pos.y < 1.40f * scale || (pos.z > 0.020f * scale && pos.y < 1.44f * scale && std::abs(pos.x) < 0.16f * scale))) {
                    continue;
                }

                // 5. Lower extremity isolation: Legs/feet must not skin the upper torso
                bool isLegOrFoot = (name.find("Hip") != std::string::npos || 
                                    name.find("Knee") != std::string::npos || 
                                    name.find("Ankle") != std::string::npos || 
                                    name.find("Foot") != std::string::npos || 
                                    name.find("Toe") != std::string::npos);
                if (isLegOrFoot && pos.y > 0.88f * scale) continue;

                // 6. Upper torso isolation: Spine2/Spine3/Neck must not skin the thighs or legs
                bool isUpperTorso = (name.find("Spine2") != std::string::npos || 
                                     name.find("Spine3") != std::string::npos || 
                                     name.find("Neck") != std::string::npos);
                if (isUpperTorso && pos.y < 0.80f * scale) continue;

                float d = (pos - pj).length();

                // Bone segment from this joint to its primary child
                int c = primaryChild[j];
                if (c >= 0) {
                    const auto& pc = skeleton.joints[c].restPosition;
                    math::Vec3 ab = pc - pj;
                    float lenSq = ab.dot(ab);
                    if (lenSq > 1e-6f) {
                        float t = std::clamp((pos - pj).dot(ab) / lenSq, 0.0f, 1.0f);
                        math::Vec3 proj = pj + ab * t;
                        float perpDist = (pos - proj).length();
                        float alongDist = t * std::sqrt(lenSq);
                        d = perpDist + alongDist * 0.25f;
                    }
                }

                dists.push_back({static_cast<uint16_t>(j), d});
            }

            std::sort(dists.begin(), dists.end(), [](const JointDist& a, const JointDist& b) {
                return a.distance < b.distance;
            });

            VertexSkinWeight sw;
            for (int k = 0; k < 4 && k < static_cast<int>(numJoints); ++k) {
                sw.joints[k] = dists[k].jointIndex;
                float d = std::max(dists[k].distance, 0.005f);
                // Organic exponential decay: 8.5cm skinning radius
                sw.weights[k] = std::exp(-d / 0.085f);
            }

            sw.normalize();
            weights[i] = sw;
        }

        return weights;
    }
};

} // namespace skinning
} // namespace scratchbox

#endif // SCRATCHBOX_SKINNING_HPP
