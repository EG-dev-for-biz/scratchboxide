/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

#ifndef SCRATCHBOX_SCENE_COMPOSER_HPP
#define SCRATCHBOX_SCENE_COMPOSER_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_sdf.hpp"
#include "scratchbox_shaper.hpp"
#include "scratchbox_particles.hpp"
#include "scratchbox_pbr.hpp"
#include "scratchbox_io.hpp"

#include <vector>
#include <string>
#include <cmath>
#include <algorithm>
#include <unordered_map>
#include <random>

namespace scratchbox {
namespace composer {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using math::Quat;
using math::Mat4;
using geometry::ScratchboxMesh;
using geometry::Vertex;
using geometry::PbrMaterial;

// ============================================================================
// 1. MACRO-TO-MICRO FORM HIERARCHY (Grant Abbitt / 70-20-10 Rule)
// ============================================================================
enum class FormTier {
    Primary,   // 70%: Silhouette, proportions, bounding masses, gestures
    Secondary, // 20%: Structural transitions, bevels, lofts, extrusions, panels
    Tertiary   // 10%: Micro-surface displacements, edge wear, bolts, seams
};

struct FormDescriptor {
    FormTier tier = FormTier::Primary;
    float bevelRadius = 0.05f;
    int bevelSegments = 3;
    float microDisplacement = 0.02f;
    float noiseFrequency = 8.0f;
    float edgeWearStrength = 0.85f;
    float creviceDirtStrength = 0.75f;
};

// Procedural Torus primitive
inline ScratchboxMesh createTorus(float mainRadius = 1.0f, float tubeRadius = 0.25f, int radialSegments = 24, int tubularSegments = 36, const Vec4& color = {0.8f, 0.8f, 0.8f, 1.0f}) {
    ScratchboxMesh mesh("torus");
    for (int j = 0; j <= tubularSegments; ++j) {
        float u = float(j) * 2.0f * math::PI / float(tubularSegments);
        float cosU = std::cos(u);
        float sinU = std::sin(u);
        for (int i = 0; i <= radialSegments; ++i) {
            float v = float(i) * 2.0f * math::PI / float(radialSegments);
            float cosV = std::cos(v);
            float sinV = std::sin(v);
            Vec3 pos(
                (mainRadius + tubeRadius * cosV) * cosU,
                tubeRadius * sinV,
                (mainRadius + tubeRadius * cosV) * sinU
            );
            Vec3 norm(cosV * cosU, sinV, cosV * sinU);
            mesh.addVertex(Vertex(pos, norm.normalized(), Vec2(float(j)/tubularSegments, float(i)/radialSegments), color));
        }
    }
    for (int j = 0; j < tubularSegments; ++j) {
        for (int i = 0; i < radialSegments; ++i) {
            uint32_t a = j * (radialSegments + 1) + i;
            uint32_t b = (j + 1) * (radialSegments + 1) + i;
            uint32_t c = (j + 1) * (radialSegments + 1) + (i + 1);
            uint32_t d = j * (radialSegments + 1) + (i + 1);
            mesh.addTriangle(a, b, d);
            mesh.addTriangle(b, c, d);
        }
    }
    return mesh;
}

// ============================================================================
// 2. MESH CURVATURE & POINTINESS EXTRACTION (Ducky 3D / Blender Pointiness)
// ============================================================================
struct MeshCurvatureResult {
    std::vector<float> pointiness;  // Convex edge wear mask [0, 1]
    std::vector<float> cavityAO;    // Concave crevice dirt mask [0, 1]
};

inline MeshCurvatureResult computeMeshCurvature(const ScratchboxMesh& mesh) {
    MeshCurvatureResult result;
    size_t vCount = mesh.vertices.size();
    result.pointiness.assign(vCount, 0.0f);
    result.cavityAO.assign(vCount, 0.0f);

    if (vCount == 0 || mesh.indices.empty()) {
        return result;
    }

    // Build vertex-to-vertex adjacency map
    std::vector<std::vector<uint32_t>> adj(vCount);
    for (size_t i = 0; i + 2 < mesh.indices.size(); i += 3) {
        uint32_t i0 = mesh.indices[i];
        uint32_t i1 = mesh.indices[i + 1];
        uint32_t i2 = mesh.indices[i + 2];

        if (i0 < vCount && i1 < vCount && i2 < vCount) {
            adj[i0].push_back(i1); adj[i0].push_back(i2);
            adj[i1].push_back(i0); adj[i1].push_back(i2);
            adj[i2].push_back(i0); adj[i2].push_back(i1);
        }
    }

    // Compute pointiness and cavity AO
    for (size_t i = 0; i < vCount; ++i) {
        if (adj[i].empty()) continue;

        Vec3 vi = mesh.vertices[i].position;
        Vec3 ni = mesh.vertices[i].normal;
        float curvatureSum = 0.0f;
        float cavitySum = 0.0f;
        int neighborCount = 0;

        for (uint32_t j : adj[i]) {
            Vec3 vj = mesh.vertices[j].position;
            Vec3 nj = mesh.vertices[j].normal;
            Vec3 edge = vj - vi;
            float dist = edge.length();
            if (dist < 1e-6f) continue;

            Vec3 edgeDir = edge / dist;
            float normalDot = ni.dot(nj);
            float angleDiff = 1.0f - normalDot;
            float dotPos = ni.dot(edgeDir);

            if (dotPos < -0.05f) {
                // Surface curves outward (convex ridge / corner)
                curvatureSum += angleDiff;
            } else if (dotPos > 0.05f) {
                // Surface curves inward (concave crevice / cavity)
                cavitySum += angleDiff;
            }
            neighborCount++;
        }

        if (neighborCount > 0) {
            float rawPointiness = curvatureSum / float(neighborCount);
            float rawCavity = cavitySum / float(neighborCount);

            // Contrast curves (Blender color ramp emulation)
            result.pointiness[i] = std::clamp(rawPointiness * 3.5f, 0.0f, 1.0f);
            result.cavityAO[i] = std::clamp(rawCavity * 4.0f, 0.0f, 1.0f);
        }
    }

    return result;
}

// Bakes curvature & AO directly into mesh vertex colors (R = Pointiness, G = Cavity AO, B = Ambient Occlusion, A = 1.0)
inline ScratchboxMesh bakeCurvatureToVertexColors(ScratchboxMesh mesh, float pointinessContrast = 3.0f, float cavityContrast = 4.0f) {
    MeshCurvatureResult curvs = computeMeshCurvature(mesh);
    for (size_t i = 0; i < mesh.vertices.size(); ++i) {
        float p = std::clamp(curvs.pointiness[i] * (pointinessContrast / 3.0f), 0.0f, 1.0f);
        float c = std::clamp(curvs.cavityAO[i] * (cavityContrast / 4.0f), 0.0f, 1.0f);
        float ao = std::clamp(1.0f - c * 0.7f, 0.0f, 1.0f);
        mesh.vertices[i].color = Vec4(p, c, ao, 1.0f);
    }
    return mesh;
}

// ============================================================================
// 3. MULTI-LAYER PROCEDURAL WEATHERING (Andrew Price & Ducky 3D PBR Stack)
// ============================================================================
struct LayeredPbrConfig {
    Vec3 baseAlbedo = Vec3(0.12f, 0.14f, 0.18f); // Base coated material
    float baseMetallic = 0.2f;
    float baseRoughness = 0.45f;

    Vec3 wornEdgeAlbedo = Vec3(0.95f, 0.90f, 0.75f); // Exposed bare metal (brass/steel/gold)
    float wornEdgeMetallic = 0.95f;
    float wornEdgeRoughness = 0.18f;

    Vec3 creviceDirtAlbedo = Vec3(0.04f, 0.03f, 0.02f); // Matte crevice grime
    float creviceDirtMetallic = 0.0f;
    float creviceDirtRoughness = 0.92f;

    float edgeWearThreshold = 0.35f;
    float creviceDirtThreshold = 0.25f;
    float noiseTurbulence = 0.35f;
};

// Generates a fully weathered PBR material color and roughness at any surface coordinate
inline void sampleLayeredPbr(const LayeredPbrConfig& cfg, float pointiness, float cavity, float noiseVal,
                             Vec3& outAlbedo, float& outMetallic, float& outRoughness) {
    float modulatedEdge = pointiness + (noiseVal - 0.5f) * cfg.noiseTurbulence;
    float edgeFactor = std::clamp((modulatedEdge - cfg.edgeWearThreshold) / (1.0f - cfg.edgeWearThreshold), 0.0f, 1.0f);

    float modulatedDirt = cavity + (noiseVal - 0.5f) * cfg.noiseTurbulence;
    float dirtFactor = std::clamp((modulatedDirt - cfg.creviceDirtThreshold) / (1.0f - cfg.creviceDirtThreshold), 0.0f, 1.0f);

    Vec3 albedo = cfg.baseAlbedo;
    float metallic = cfg.baseMetallic;
    float roughness = cfg.baseRoughness;

    // Layer 2: Worn edge exposure
    if (edgeFactor > 0.0f) {
        albedo = pbr::lerpVec3(albedo, cfg.wornEdgeAlbedo, edgeFactor);
        metallic = std::lerp(metallic, cfg.wornEdgeMetallic, edgeFactor);
        roughness = std::lerp(roughness, cfg.wornEdgeRoughness, edgeFactor);
    }

    // Layer 3: Crevice dirt & grime
    if (dirtFactor > 0.0f) {
        albedo = pbr::lerpVec3(albedo, cfg.creviceDirtAlbedo, dirtFactor);
        metallic = std::lerp(metallic, cfg.creviceDirtMetallic, dirtFactor);
        roughness = std::lerp(roughness, cfg.creviceDirtRoughness, dirtFactor);
    }

    outAlbedo = albedo;
    outMetallic = metallic;
    outRoughness = roughness;
}

// ============================================================================
// 4. INSTANCE SCATTERING & WORLD CLUTTER (Ian Hubert Scene Building)
// ============================================================================
using io::InstanceTransform;

inline std::vector<InstanceTransform> scatterInstancesOnMesh(const ScratchboxMesh& baseMesh,
                                                             size_t count,
                                                             float minScale = 0.6f,
                                                             float maxScale = 1.4f,
                                                             uint32_t seed = 42) {
    std::vector<InstanceTransform> instances;
    if (baseMesh.vertices.empty() || baseMesh.indices.size() < 3 || count == 0) {
        return instances;
    }

    instances.reserve(count);
    std::mt19937 rng(seed);
    std::uniform_real_distribution<float> dist01(0.0f, 1.0f);
    std::uniform_real_distribution<float> scaleDist(minScale, maxScale);
    std::uniform_real_distribution<float> angleDist(0.0f, 6.2831853f);

    size_t triCount = baseMesh.indices.size() / 3;

    std::vector<float> cumulativeArea(triCount, 0.0f);
    float totalArea = 0.0f;
    for (size_t t = 0; t < triCount; ++t) {
        Vec3 v0 = baseMesh.vertices[baseMesh.indices[t * 3]].position;
        Vec3 v1 = baseMesh.vertices[baseMesh.indices[t * 3 + 1]].position;
        Vec3 v2 = baseMesh.vertices[baseMesh.indices[t * 3 + 2]].position;
        float area = (v1 - v0).cross(v2 - v0).length() * 0.5f;
        totalArea += area;
        cumulativeArea[t] = totalArea;
    }

    for (size_t i = 0; i < count; ++i) {
        float r = dist01(rng) * totalArea;
        auto it = std::lower_bound(cumulativeArea.begin(), cumulativeArea.end(), r);
        size_t triIdx = std::distance(cumulativeArea.begin(), it);
        if (triIdx >= triCount) triIdx = triCount - 1;

        const auto& v0 = baseMesh.vertices[baseMesh.indices[triIdx * 3]];
        const auto& v1 = baseMesh.vertices[baseMesh.indices[triIdx * 3 + 1]];
        const auto& v2 = baseMesh.vertices[baseMesh.indices[triIdx * 3 + 2]];

        float u = 1.0f - std::sqrt(dist01(rng));
        float v = dist01(rng) * (1.0f - u);
        float w = 1.0f - u - v;

        Vec3 pos = v0.position * u + v1.position * v + v2.position * w;
        Vec3 norm = (v0.normal * u + v1.normal * v + v2.normal * w).normalized();

        float yaw = angleDist(rng);
        Quat qYaw = Quat::fromAxisAngle(norm, yaw);

        float s = scaleDist(rng);
        instances.push_back({ pos, Vec3(s, s, s), qYaw });
    }

    return instances;
}

// ============================================================================
// 5. CINEMATIC 3-POINT LIGHTING & PEDESTAL RIG (Blender Guru Photorealism)
// ============================================================================
struct StudioLight {
    std::string name;
    Vec3 position;
    Vec3 color;
    float intensity;
    float radius;
    float colorTemperatureKelvin = 5600.0f;
};

struct StudioLightingRig {
    StudioLight keyLight;
    StudioLight fillLight;
    StudioLight rimLight;
    StudioLight floorBounce;
};

inline StudioLightingRig createCinematicStudioLighting(Vec3 targetCenter = Vec3(0, 1.0f, 0), float rigScale = 5.0f) {
    StudioLightingRig rig;

    rig.keyLight.name = "Key_Daylight_5600K";
    rig.keyLight.position = targetCenter + Vec3(rigScale * 0.707f, rigScale * 0.65f, rigScale * 0.707f);
    rig.keyLight.color = Vec3(1.0f, 0.95f, 0.88f);
    rig.keyLight.intensity = 1.8f;
    rig.keyLight.radius = 1.5f;
    rig.keyLight.colorTemperatureKelvin = 5600.0f;

    rig.fillLight.name = "Fill_CoolSky_7500K";
    rig.fillLight.position = targetCenter + Vec3(-rigScale * 0.85f, rigScale * 0.35f, rigScale * 0.5f);
    rig.fillLight.color = Vec3(0.75f, 0.85f, 1.0f);
    rig.fillLight.intensity = 0.65f;
    rig.fillLight.radius = 2.5f;
    rig.fillLight.colorTemperatureKelvin = 7500.0f;

    rig.rimLight.name = "Rim_Kicker_HighContrast";
    rig.rimLight.position = targetCenter + Vec3(-rigScale * 0.3f, rigScale * 0.8f, -rigScale * 0.9f);
    rig.rimLight.color = Vec3(0.95f, 0.98f, 1.0f);
    rig.rimLight.intensity = 2.4f;
    rig.rimLight.radius = 0.8f;
    rig.rimLight.colorTemperatureKelvin = 6500.0f;

    rig.floorBounce.name = "Ground_Bounce";
    rig.floorBounce.position = targetCenter + Vec3(0, -rigScale * 0.4f, 0);
    rig.floorBounce.color = Vec3(0.35f, 0.32f, 0.28f);
    rig.floorBounce.intensity = 0.25f;
    rig.floorBounce.radius = 4.0f;
    rig.floorBounce.colorTemperatureKelvin = 3200.0f;

    return rig;
}

inline ScratchboxMesh generateStudioPedestal(float radius = 4.0f, float height = 0.25f, float bevelRadius = 0.04f, int segments = 64) {
    ScratchboxMesh mesh("Studio_Pedestal");

    float innerR = radius - bevelRadius;
    float topY = 0.0f;
    float botY = -height;
    float bevelMidY = topY - bevelRadius * 0.5f;

    // Center vertex for top cap
    mesh.vertices.push_back(Vertex(Vec3(0, topY, 0), Vec3(0, 1, 0), Vec2(0.5f, 0.5f), Vec4(0, 0, 1, 1)));

    for (int i = 0; i <= segments; ++i) {
        float angle = float(i) * 2.0f * math::PI / float(segments);
        float cosA = std::cos(angle);
        float sinA = std::sin(angle);

        // Top flat ring
        mesh.vertices.push_back(Vertex(
            Vec3(cosA * innerR, topY, sinA * innerR),
            Vec3(0, 1, 0),
            Vec2(0.5f + cosA * 0.45f, 0.5f + sinA * 0.45f),
            Vec4(0.0f, 0.0f, 0.95f, 1.0f)
        ));

        // Bevel outer ring
        Vec3 bevelNorm = Vec3(cosA * 0.707f, 0.707f, sinA * 0.707f).normalized();
        mesh.vertices.push_back(Vertex(
            Vec3(cosA * radius, bevelMidY, sinA * radius),
            bevelNorm,
            Vec2(float(i) / float(segments), 0.5f),
            Vec4(0.85f, 0.0f, 0.90f, 1.0f)
        ));

        // Bottom base ring
        mesh.vertices.push_back(Vertex(
            Vec3(cosA * radius, botY, sinA * radius),
            Vec3(cosA, 0, sinA),
            Vec2(float(i) / float(segments), 0.0f),
            Vec4(0.0f, 0.75f, 0.35f, 1.0f)
        ));
    }

    // Top cap fan
    for (int i = 1; i <= segments; ++i) {
        mesh.indices.push_back(0);
        mesh.indices.push_back(1 + (i - 1) * 3);
        mesh.indices.push_back(1 + (i % segments) * 3);
    }

    // Bevel quad strip
    for (int i = 0; i < segments; ++i) {
        uint32_t topA = 1 + i * 3;
        uint32_t topB = 1 + ((i + 1) % segments) * 3;
        uint32_t bevA = topA + 1;
        uint32_t bevB = topB + 1;

        mesh.indices.push_back(topA);
        mesh.indices.push_back(bevA);
        mesh.indices.push_back(topB);

        mesh.indices.push_back(topB);
        mesh.indices.push_back(bevA);
        mesh.indices.push_back(bevB);
    }

    // Outer side wall quad strip
    for (int i = 0; i < segments; ++i) {
        uint32_t bevA = 1 + i * 3 + 1;
        uint32_t bevB = 1 + ((i + 1) % segments) * 3 + 1;
        uint32_t botA = bevA + 1;
        uint32_t botB = bevB + 1;

        mesh.indices.push_back(bevA);
        mesh.indices.push_back(botA);
        mesh.indices.push_back(bevB);

        mesh.indices.push_back(bevB);
        mesh.indices.push_back(botA);
        mesh.indices.push_back(botB);
    }

    mesh.material = pbr::presets::blackOnyx();
    mesh.material.roughnessFactor = 0.25f;
    return mesh;
}

// ============================================================================
// 6. COMPOUND SCENE GRAPH & MULTI-MESH COMBINER
// ============================================================================
struct SceneNode {
    std::string name;
    ScratchboxMesh mesh;
    Vec3 position = Vec3(0, 0, 0);
    Quat rotation = Quat::identity();
    Vec3 scale = Vec3(1, 1, 1);
};

class UniversalSceneComposer {
public:
    std::string sceneName;
    std::vector<SceneNode> nodes;
    StudioLightingRig lighting;

    UniversalSceneComposer(const std::string& name = "MasterScene") : sceneName(name) {
        lighting = createCinematicStudioLighting();
    }

    void addNode(const std::string& name, const ScratchboxMesh& mesh,
                 Vec3 pos = Vec3(0, 0, 0), Quat rot = Quat::identity(), Vec3 scl = Vec3(1, 1, 1)) {
        nodes.push_back({ name, mesh, pos, rot, scl });
    }

    void addNode(const std::string& name, const ScratchboxMesh& mesh, FormTier /*tier*/,
                 Vec3 pos = Vec3(0, 0, 0), Quat rot = Quat::identity(), Vec3 scl = Vec3(1, 1, 1)) {
        nodes.push_back({ name, mesh, pos, rot, scl });
    }

    void addNode(const std::string& name, const ScratchboxMesh& mesh, FormTier /*tier*/,
                 Vec3 pos, Vec3 rotEuler, Vec3 scl = Vec3(1, 1, 1)) {
        nodes.push_back({ name, mesh, pos, Quat::fromEuler(rotEuler), scl });
    }

    void addNode(const std::string& name, const geometry::Mesh& mesh,
                 Vec3 pos = Vec3(0, 0, 0), Quat rot = Quat::identity(), Vec3 scl = Vec3(1, 1, 1)) {
        nodes.push_back({ name, mesh.toScratchboxMesh(), pos, rot, scl });
    }

    void addNode(const std::string& name, const geometry::Mesh& mesh, FormTier /*tier*/,
                 Vec3 pos = Vec3(0, 0, 0), Quat rot = Quat::identity(), Vec3 scl = Vec3(1, 1, 1)) {
        nodes.push_back({ name, mesh.toScratchboxMesh(), pos, rot, scl });
    }

    void addNode(const std::string& name, const geometry::Mesh& mesh, FormTier /*tier*/,
                 Vec3 pos, Vec3 rotEuler, Vec3 scl = Vec3(1, 1, 1)) {
        nodes.push_back({ name, mesh.toScratchboxMesh(), pos, Quat::fromEuler(rotEuler), scl });
    }

    const std::vector<SceneNode>& getNodes() const { return nodes; }
    std::vector<SceneNode>& getNodes() { return nodes; }
    size_t getNodeCount() const { return nodes.size(); }

    ScratchboxMesh buildUnifiedSceneMesh(const std::string& customSceneName = "") const {
        std::string finalName = customSceneName.empty() ? sceneName : customSceneName;
        ScratchboxMesh masterMesh(finalName);

        for (const auto& node : nodes) {
            uint32_t indexOffset = static_cast<uint32_t>(masterMesh.vertices.size());

            for (const auto& v : node.mesh.vertices) {
                Vec3 p = v.position * node.scale;
                p = node.rotation.rotate(p) + node.position;
                Vec3 n = node.rotation.rotate(v.normal).normalized();

                masterMesh.vertices.push_back(Vertex(p, n, v.uv, v.color));
            }

            for (uint32_t idx : node.mesh.indices) {
                masterMesh.indices.push_back(idx + indexOffset);
            }
        }

        if (!nodes.empty()) {
            masterMesh.material = nodes[0].mesh.material;
        }

        return masterMesh;
    }

    void streamSceneGlb(const std::string& chunkId = "master-scene") const {
        ScratchboxMesh unified = buildUnifiedSceneMesh(chunkId);
        io::GlbWriter::streamChunk(unified, chunkId);
    }
};

// ============================================================================
// 7. PROCEDURAL HERO OBJECT ARCHETYPES
// ============================================================================

// Archetype A: Quantum Fusion Reactor / Cybernetic Core (Multi-layer Hard Surface)
inline ScratchboxMesh createQuantumReactorCore(const std::string& meshName = "Quantum_Reactor_Core") {
    UniversalSceneComposer comp(meshName);

    // 1. Primary Shape: Cylindrical core chamber
    ScratchboxMesh coreChamber = ScratchboxMesh::createCylinder(0.8f, 2.2f, 48);
    coreChamber.material = pbr::presets::titaniumGrade5();
    coreChamber.material.anisotropyStrength = 0.85f;
    comp.addNode("Core_Chamber", coreChamber, Vec3(0, 1.2f, 0));

    // Toroidal magnetic containment rings
    ScratchboxMesh torusRing = createTorus(1.4f, 0.22f, 24, 48);
    torusRing.material = pbr::presets::polishedGold24k();
    comp.addNode("Magnetic_Ring_Upper", torusRing, Vec3(0, 1.6f, 0));
    comp.addNode("Magnetic_Ring_Lower", torusRing, Vec3(0, 0.8f, 0));

    // 2. Secondary Shape: 4 Radial Magnetic Stabilizer Pylons
    for (int i = 0; i < 4; ++i) {
        float angle = float(i) * math::PI * 0.5f;
        float cosA = std::cos(angle);
        float sinA = std::sin(angle);

        ScratchboxMesh pylon = ScratchboxMesh::createBox(Vec3(0.25f, 2.0f, 0.6f));
        pylon.material = pbr::presets::roughBasaltRock();
        pylon.material.roughnessFactor = 0.55f;
        Quat rot = Quat::fromAxisAngle(Vec3(0, 1, 0), -angle);
        comp.addNode("Pylon_" + std::to_string(i), pylon, Vec3(cosA * 1.6f, 1.2f, sinA * 1.6f), rot);
    }

    // 3. Central Glowing Plasma Sphere (Emissive Core with High Intensity)
    ScratchboxMesh plasmaSphere = ScratchboxMesh::createSphere(0.45f, 32, 32);
    plasmaSphere.material.baseColorFactor = Vec4(0.1f, 0.9f, 1.0f, 1.0f);
    plasmaSphere.material.emissiveFactor = Vec3(0.2f, 1.8f, 3.5f);
    plasmaSphere.material.emissiveStrength = 4.5f;
    plasmaSphere.material.roughnessFactor = 0.05f;
    comp.addNode("Plasma_Sphere", plasmaSphere, Vec3(0, 1.2f, 0));

    // 4. Ground Pedestal with Contact AO
    ScratchboxMesh pedestal = generateStudioPedestal(2.8f, 0.25f, 0.05f, 48);
    comp.addNode("Pedestal", pedestal, Vec3(0, 0, 0));

    ScratchboxMesh master = comp.buildUnifiedSceneMesh(meshName);
    return bakeCurvatureToVertexColors(master);
}

// Archetype B: Ancient Mystical Reliquary / Alchemist Artifact (Ornamental Stone & Gold)
inline ScratchboxMesh createAncientReliquary(const std::string& meshName = "Ancient_Reliquary") {
    UniversalSceneComposer comp(meshName);

    // 1. Primary: Octagonal Plinth Base
    ScratchboxMesh base = ScratchboxMesh::createCylinder(1.6f, 0.4f, 8);
    base.material = pbr::presets::carraraMarble();
    comp.addNode("Base_Plinth", base, Vec3(0, 0.2f, 0));

    // 2. Secondary: Golden Chalice / Relic Font
    ScratchboxMesh cup = ScratchboxMesh::createCylinder(1.0f, 0.2f, 1.2f, 24);
    cup.material = pbr::presets::polishedGold24k();
    comp.addNode("Relic_Cup", cup, Vec3(0, 1.0f, 0));

    // 3. Floating Emerald Gemstone (Transmission + Beer-Lambert Volume)
    ScratchboxMesh gem = ScratchboxMesh::createSphere(0.48f, 32, 32);
    gem.material = pbr::presets::emeraldCrystal();
    gem.material.transmissionFactor = 1.0f;
    gem.material.ior = 1.58f;
    comp.addNode("Emerald_Core", gem, Vec3(0, 1.85f, 0));

    // 4. Studio Ground Pedestal
    ScratchboxMesh pedestal = generateStudioPedestal(3.2f, 0.25f, 0.05f, 48);
    comp.addNode("Pedestal", pedestal, Vec3(0, 0, 0));

    ScratchboxMesh master = comp.buildUnifiedSceneMesh(meshName);
    return bakeCurvatureToVertexColors(master);
}

} // namespace composer
} // namespace scratchbox

#endif // SCRATCHBOX_SCENE_COMPOSER_HPP
