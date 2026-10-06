/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
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
#include <functional>

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

// ============================================================================
// 8. DETERMINISTIC SPATIAL CONSTRAINT & CONTACT SOLVER
// ============================================================================

enum class RelationPredicate {
    SupportedBy,        // Base of subject sits flush on target surface / terrain
    AttachedToSurface,  // Subject snaps flush to target socket (top/bottom/left/right/front/back)
    AdjacentTo,         // Subject placed adjacent to target with clearance
    ContainedIn,        // Subject placed inside target bounding box
    SymmetricTo         // Subject mirrored across target symmetry plane
};

struct SpatialConstraint {
    std::string subjectName;
    RelationPredicate predicate{RelationPredicate::SupportedBy};
    std::string targetName;
    Vec3 offset{0.0f, 0.0f, 0.0f};
    std::string faceAlignment{"top"}; // "top", "crown", "ground", "bottom", "left", "right", "front", "back"
    float clearanceMeters{0.0f};
    char symmetryAxis{'x'};
};

struct ContactAuditViolation {
    std::string subject;
    std::string target;
    std::string type; // "penetration" or "floating_gap"
    float metricDistance{0.0f};
    Vec3 resolutionDelta{0.0f, 0.0f, 0.0f};
};

class SpatialConstraintSolver {
private:
    std::unordered_map<std::string, ScratchboxMesh*> meshRegistry;
    std::vector<SpatialConstraint> constraints;

public:
    void registerMesh(const std::string& name, ScratchboxMesh* mesh) {
        if (mesh) {
            mesh->recomputeBounds();
            meshRegistry[name] = mesh;
        }
    }

    void addConstraint(const SpatialConstraint& c) {
        constraints.push_back(c);
    }

    /**
     * Terrain Raycast Grounding: snaps the mesh's bottom onto the terrain
     * heightfield. Samples the height function at the mesh footprint center and
     * four corners, then drops the mesh so its lowest point rests on the
     * highest sampled ground contact (zero levitation, zero burial).
     */
    bool groundOnTerrain(const std::string& name,
                         const std::function<float(float, float)>& heightFn,
                         float clearance = 0.0f) {
        auto it = meshRegistry.find(name);
        if (it == meshRegistry.end() || !it->second) return false;
        ScratchboxMesh* mesh = it->second;
        mesh->recomputeBounds();

        const Vec3 c = mesh->bounds.center();
        const float hx = (mesh->bounds.max.x - mesh->bounds.min.x) * 0.5f;
        const float hz = (mesh->bounds.max.z - mesh->bounds.min.z) * 0.5f;

        float maxGround = -1e9f;
        const float samplePts[5][2] = {
            {c.x, c.z},
            {c.x - hx, c.z - hz},
            {c.x + hx, c.z - hz},
            {c.x - hx, c.z + hz},
            {c.x + hx, c.z + hz}
        };
        for (const auto& pt : samplePts) {
            maxGround = std::max(maxGround, heightFn(pt[0], pt[1]));
        }

        const float deltaY = (maxGround + clearance) - mesh->bounds.min.y;
        mesh->translate(Vec3(0.0f, deltaY, 0.0f));
        mesh->recomputeBounds();
        return true;
    }

    /**
     * Mesh-based Terrain Raycast Grounding: casts vertical rays downward from
     * the mesh footprint (center + 4 corners) against the terrain mesh
     * triangles (Möller–Trumbore), snaps the mesh bottom onto the highest hit.
     */
    bool groundOnTerrainMesh(const std::string& name,
                             const ScratchboxMesh& terrain,
                             float clearance = 0.0f) {
        auto it = meshRegistry.find(name);
        if (it == meshRegistry.end() || !it->second) return false;
        ScratchboxMesh* mesh = it->second;
        mesh->recomputeBounds();

        const Vec3 c = mesh->bounds.center();
        const float hx = (mesh->bounds.max.x - mesh->bounds.min.x) * 0.5f;
        const float hz = (mesh->bounds.max.z - mesh->bounds.min.z) * 0.5f;
        const float samplePts[5][2] = {
            {c.x, c.z},
            {c.x - hx, c.z - hz},
            {c.x + hx, c.z - hz},
            {c.x - hx, c.z + hz},
            {c.x + hx, c.z + hz}
        };

        auto raycastDown = [&](float x, float z) -> float {
            const Vec3 origin(x, 1e6f, z);
            const Vec3 dir(0.0f, -1.0f, 0.0f);
            float bestT = 1e12f;
            const size_t triCount = terrain.indices.size() / 3;
            for (size_t t = 0; t < triCount; ++t) {
                const Vec3& v0 = terrain.vertices[terrain.indices[t * 3 + 0]].position;
                const Vec3& v1 = terrain.vertices[terrain.indices[t * 3 + 1]].position;
                const Vec3& v2 = terrain.vertices[terrain.indices[t * 3 + 2]].position;
                // Möller–Trumbore
                const Vec3 e1 = v1 - v0;
                const Vec3 e2 = v2 - v0;
                const Vec3 p = dir.cross(e2);
                const float det = e1.dot(p);
                if (std::abs(det) < 1e-9f) continue;
                const float invDet = 1.0f / det;
                const Vec3 s = origin - v0;
                const float u = s.dot(p) * invDet;
                if (u < -1e-5f || u > 1.0f + 1e-5f) continue;
                const Vec3 q = s.cross(e1);
                const float v = dir.dot(q) * invDet;
                if (v < -1e-5f || (u + v) > 1.0f + 1e-5f) continue;
                const float tt = e2.dot(q) * invDet;
                if (tt > 0.0f && tt < bestT) bestT = tt;
            }
            if (bestT > 1e11f) return -1e9f; // no hit
            return origin.y - bestT;
        };

        float maxGround = -1e9f;
        bool anyHit = false;
        for (const auto& pt : samplePts) {
            const float h = raycastDown(pt[0], pt[1]);
            if (h > -1e8f) {
                maxGround = std::max(maxGround, h);
                anyHit = true;
            }
        }
        if (!anyHit) return false;

        const float deltaY = (maxGround + clearance) - mesh->bounds.min.y;
        mesh->translate(Vec3(0.0f, deltaY, 0.0f));
        mesh->recomputeBounds();
        return true;
    }

    /**
     * Surface-Normal Contact Snapping: rotates the mesh so its local +Y axis
     * aligns with the terrain surface normal at its footprint center, keeping
     * structures flush on sloped ground instead of floating on one edge.
     */
    bool alignToSurfaceNormal(const std::string& name,
                              const std::function<Vec3(float, float)>& normalFn,
                              float maxTiltDeg = 45.0f) {
        auto it = meshRegistry.find(name);
        if (it == meshRegistry.end() || !it->second) return false;
        ScratchboxMesh* mesh = it->second;
        mesh->recomputeBounds();

        const Vec3 c = mesh->bounds.center();
        Vec3 n = normalFn(c.x, c.z).normalized();
        if (n.lengthSquared() < 1e-8f) return false;

        // Clamp tilt to prevent structures toppling on cliffs
        const float cosTilt = std::clamp(n.y, -1.0f, 1.0f);
        const float tiltDeg = std::acos(cosTilt) * (180.0f / math::PI);
        if (tiltDeg > maxTiltDeg) {
            // Blend normal back toward vertical to respect the tilt cap
            const float t = maxTiltDeg / std::max(tiltDeg, 1e-4f);
            n = math::lerp(Vec3(0, 1, 0), n, t).normalized();
        }

        // Rotate +Y onto n around the horizontal axis
        Vec3 axis = Vec3(0, 1, 0).cross(n);
        const float axisLen = axis.length();
        if (axisLen < 1e-6f) return true; // already aligned
        axis = axis * (1.0f / axisLen);
        const float angle = std::acos(std::clamp(Vec3(0, 1, 0).dot(n), -1.0f, 1.0f));
        const Quat q = Quat::fromAxisAngle(axis, angle);

        for (auto& v : mesh->vertices) {
            const Vec3 rel = v.position - c;
            v.position = c + q.rotate(rel);
            v.normal = q.rotate(v.normal).normalized();
        }
        mesh->recomputeBounds();
        return true;
    }

    /**
     * Mesh-based Surface-Normal Snapping: estimates the terrain normal at the
     * mesh footprint center via central differences on raycast heights.
     */
    bool alignToTerrainNormal(const std::string& name,
                              const ScratchboxMesh& terrain,
                              float maxTiltDeg = 45.0f) {
        auto it = meshRegistry.find(name);
        if (it == meshRegistry.end() || !it->second) return false;
        ScratchboxMesh* mesh = it->second;
        mesh->recomputeBounds();
        const Vec3 c = mesh->bounds.center();

        auto heightAt = [&](float x, float z) -> float {
            const Vec3 origin(x, 1e6f, z);
            const Vec3 dir(0.0f, -1.0f, 0.0f);
            float bestT = 1e12f;
            const size_t triCount = terrain.indices.size() / 3;
            for (size_t t = 0; t < triCount; ++t) {
                const Vec3& v0 = terrain.vertices[terrain.indices[t * 3 + 0]].position;
                const Vec3& v1 = terrain.vertices[terrain.indices[t * 3 + 1]].position;
                const Vec3& v2 = terrain.vertices[terrain.indices[t * 3 + 2]].position;
                const Vec3 e1 = v1 - v0;
                const Vec3 e2 = v2 - v0;
                const Vec3 p = dir.cross(e2);
                const float det = e1.dot(p);
                if (std::abs(det) < 1e-9f) continue;
                const float invDet = 1.0f / det;
                const Vec3 s = origin - v0;
                const float u = s.dot(p) * invDet;
                if (u < -1e-5f || u > 1.0f + 1e-5f) continue;
                const Vec3 q = s.cross(e1);
                const float v = dir.dot(q) * invDet;
                if (v < -1e-5f || (u + v) > 1.0f + 1e-5f) continue;
                const float tt = e2.dot(q) * invDet;
                if (tt > 0.0f && tt < bestT) bestT = tt;
            }
            if (bestT > 1e11f) return 0.0f;
            return origin.y - bestT;
        };

        const float eps = std::max(0.25f, (mesh->bounds.max.x - mesh->bounds.min.x) * 0.05f);
        const float hL = heightAt(c.x - eps, c.z);
        const float hR = heightAt(c.x + eps, c.z);
        const float hD = heightAt(c.x, c.z - eps);
        const float hU = heightAt(c.x, c.z + eps);
        Vec3 n(-(hR - hL) / (2.0f * eps), 1.0f, -(hU - hD) / (2.0f * eps));

        return alignToSurfaceNormal(name, [&](float, float) { return n; }, maxTiltDeg);
    }

    void addConstraint(const std::string& subject,
                       const std::string& predicateStr,
                       const std::string& target,
                       const std::string& face = "top",
                       float clearance = 0.0f,
                       const Vec3& offset = Vec3(0, 0, 0)) {
        SpatialConstraint c;
        c.subjectName = subject;
        c.targetName = target;
        c.faceAlignment = face;
        c.clearanceMeters = clearance;
        c.offset = offset;

        std::string p = predicateStr;
        std::transform(p.begin(), p.end(), p.begin(), ::tolower);
        if (p == "supported_by" || p == "supported" || p == "grounded_on") {
            c.predicate = RelationPredicate::SupportedBy;
        } else if (p == "attached_to_surface" || p == "attached" || p == "attach") {
            c.predicate = RelationPredicate::AttachedToSurface;
        } else if (p == "adjacent_to" || p == "adjacent") {
            c.predicate = RelationPredicate::AdjacentTo;
        } else if (p == "contained_in" || p == "inside") {
            c.predicate = RelationPredicate::ContainedIn;
        } else if (p == "symmetric_to" || p == "mirror") {
            c.predicate = RelationPredicate::SymmetricTo;
        }
        constraints.push_back(c);
    }

    /**
     * Solves all spatial relational constraints in dependency order and relaxes collisions.
     */
    bool solve(int collisionPasses = 8, float minMargin = 0.01f) {
        for (const auto& c : constraints) {
            auto sIt = meshRegistry.find(c.subjectName);
            auto tIt = meshRegistry.find(c.targetName);
            if (sIt == meshRegistry.end() || tIt == meshRegistry.end()) continue;

            ScratchboxMesh* subject = sIt->second;
            ScratchboxMesh* target = tIt->second;
            if (!subject || !target) continue;

            subject->recomputeBounds();
            target->recomputeBounds();

            switch (c.predicate) {
                case RelationPredicate::SupportedBy: {
                    // Snap subject bottom to target top + vertical clearance
                    float targetTopY = target->bounds.max.y;
                    float subjectBottomY = subject->bounds.min.y;
                    float deltaY = (targetTopY + c.clearanceMeters + c.offset.y) - subjectBottomY;
                    subject->translate(Vec3(c.offset.x, deltaY, c.offset.z));
                    break;
                }
                case RelationPredicate::AttachedToSurface: {
                    std::string f = c.faceAlignment;
                    std::transform(f.begin(), f.end(), f.begin(), ::tolower);

                    Vec3 delta(0, 0, 0);
                    if (f == "top" || f == "crown" || f == "roof") {
                        delta.y = (target->bounds.max.y + c.clearanceMeters) - subject->bounds.min.y;
                        delta.x = target->bounds.center().x - subject->bounds.center().x;
                        delta.z = target->bounds.center().z - subject->bounds.center().z;
                    } else if (f == "ground" || f == "bottom" || f == "base") {
                        delta.y = (target->bounds.min.y - c.clearanceMeters) - subject->bounds.max.y;
                        delta.x = target->bounds.center().x - subject->bounds.center().x;
                        delta.z = target->bounds.center().z - subject->bounds.center().z;
                    } else if (f == "left" || f == "west" || f == "port") {
                        delta.x = (target->bounds.min.x - c.clearanceMeters) - subject->bounds.max.x;
                        delta.y = target->bounds.center().y - subject->bounds.center().y;
                        delta.z = target->bounds.center().z - subject->bounds.center().z;
                    } else if (f == "right" || f == "east" || f == "starboard") {
                        delta.x = (target->bounds.max.x + c.clearanceMeters) - subject->bounds.min.x;
                        delta.y = target->bounds.center().y - subject->bounds.center().y;
                        delta.z = target->bounds.center().z - subject->bounds.center().z;
                    } else if (f == "front" || f == "bow" || f == "north") {
                        delta.z = (target->bounds.max.z + c.clearanceMeters) - subject->bounds.min.z;
                        delta.x = target->bounds.center().x - subject->bounds.center().x;
                        delta.y = target->bounds.center().y - subject->bounds.center().y;
                    } else if (f == "back" || f == "rear" || f == "stern" || f == "south") {
                        delta.z = (target->bounds.min.z - c.clearanceMeters) - subject->bounds.max.z;
                        delta.x = target->bounds.center().x - subject->bounds.center().x;
                        delta.y = target->bounds.center().y - subject->bounds.center().y;
                    }
                    subject->translate(delta + c.offset);
                    break;
                }
                case RelationPredicate::AdjacentTo: {
                    // Position horizontally adjacent along X with clearance
                    float deltaX = (target->bounds.max.x + c.clearanceMeters + c.offset.x) - subject->bounds.min.x;
                    subject->translate(Vec3(deltaX, c.offset.y, c.offset.z));
                    break;
                }
                case RelationPredicate::ContainedIn: {
                    Vec3 targetCenter = target->bounds.center();
                    Vec3 subjectCenter = subject->bounds.center();
                    subject->translate(targetCenter - subjectCenter + c.offset);
                    break;
                }
                case RelationPredicate::SymmetricTo: {
                    Vec3 targetCenter = target->bounds.center();
                    Vec3 subjectCenter = subject->bounds.center();
                    Vec3 mirrored = subjectCenter;
                    if (c.symmetryAxis == 'x' || c.symmetryAxis == 'X') {
                        mirrored.x = targetCenter.x - (subjectCenter.x - targetCenter.x);
                    } else if (c.symmetryAxis == 'z' || c.symmetryAxis == 'Z') {
                        mirrored.z = targetCenter.z - (subjectCenter.z - targetCenter.z);
                    }
                    subject->translate(mirrored - subjectCenter + c.offset);
                    break;
                }
            }
            subject->recomputeBounds();
        }

        // Iterative OBB/AABB collision relaxation
        relaxCollisions(collisionPasses, minMargin);
        return true;
    }

    /**
     * Non-penetration impulse relaxation between registered meshes.
     */
    void relaxCollisions(int iterations = 8, float minMargin = 0.01f) {
        std::vector<ScratchboxMesh*> meshes;
        for (auto& kv : meshRegistry) {
            if (kv.second) {
                kv.second->recomputeBounds();
                meshes.push_back(kv.second);
            }
        }

        size_t n = meshes.size();
        for (int iter = 0; iter < iterations; ++iter) {
            bool anyOverlap = false;
            for (size_t i = 0; i < n; ++i) {
                for (size_t j = i + 1; j < n; ++j) {
                    ScratchboxMesh* a = meshes[i];
                    ScratchboxMesh* b = meshes[j];

                    Vec3 aMin = a->bounds.min, aMax = a->bounds.max;
                    Vec3 bMin = b->bounds.min, bMax = b->bounds.max;

                    float overlapX = std::min(aMax.x, bMax.x) - std::max(aMin.x, bMin.x);
                    float overlapY = std::min(aMax.y, bMax.y) - std::max(aMin.y, bMin.y);
                    float overlapZ = std::min(aMax.z, bMax.z) - std::max(aMin.z, bMin.z);

                    if (overlapX > 0 && overlapY > 0 && overlapZ > 0) {
                        anyOverlap = true;
                        // Minimum translation vector separation
                        if (overlapX <= overlapY && overlapX <= overlapZ) {
                            float push = (overlapX + minMargin) * 0.5f;
                            float sign = (a->bounds.center().x < b->bounds.center().x) ? -1.0f : 1.0f;
                            a->translate(Vec3(sign * push, 0, 0));
                            b->translate(Vec3(-sign * push, 0, 0));
                        } else if (overlapZ <= overlapX && overlapZ <= overlapY) {
                            float push = (overlapZ + minMargin) * 0.5f;
                            float sign = (a->bounds.center().z < b->bounds.center().z) ? -1.0f : 1.0f;
                            a->translate(Vec3(0, 0, sign * push));
                            b->translate(Vec3(0, 0, -sign * push));
                        } else {
                            float push = (overlapY + minMargin) * 0.5f;
                            float sign = (a->bounds.center().y < b->bounds.center().y) ? -1.0f : 1.0f;
                            a->translate(Vec3(0, sign * push, 0));
                            b->translate(Vec3(0, -sign * push, 0));
                        }
                        a->recomputeBounds();
                        b->recomputeBounds();
                    }
                }
            }
            if (!anyOverlap) break;
        }
    }

    /**
     * Audits registered mesh pairs for penetrations or floating air gaps.
     * Floating detection: for each mesh, finds the highest support surface
     * below it among meshes whose XZ footprints horizontally overlap; if the
     * vertical gap exceeds maxAllowedGap, the mesh is reported as floating.
     */
    std::vector<ContactAuditViolation> auditContacts(float maxAllowedGap = 0.05f) const {
        std::vector<ContactAuditViolation> violations;
        std::vector<std::pair<std::string, ScratchboxMesh*>> meshList(meshRegistry.begin(), meshRegistry.end());
        size_t n = meshList.size();

        // 1. Pairwise penetration detection
        for (size_t i = 0; i < n; ++i) {
            for (size_t j = i + 1; j < n; ++j) {
                const auto& a = meshList[i];
                const auto& b = meshList[j];
                if (!a.second || !b.second) continue;

                Vec3 aMin = a.second->bounds.min, aMax = a.second->bounds.max;
                Vec3 bMin = b.second->bounds.min, bMax = b.second->bounds.max;

                float overlapX = std::min(aMax.x, bMax.x) - std::max(aMin.x, bMin.x);
                float overlapY = std::min(aMax.y, bMax.y) - std::max(aMin.y, bMin.y);
                float overlapZ = std::min(aMax.z, bMax.z) - std::max(aMin.z, bMin.z);

                if (overlapX > 0.02f && overlapY > 0.02f && overlapZ > 0.02f) {
                    ContactAuditViolation v;
                    v.subject = a.first;
                    v.target = b.first;
                    v.type = "penetration";
                    v.metricDistance = std::min({overlapX, overlapY, overlapZ});
                    v.resolutionDelta = Vec3(overlapX, overlapY, overlapZ);
                    violations.push_back(v);
                }
            }
        }

        // 2. Floating air-gap detection (unsupported meshes hovering above support)
        for (size_t i = 0; i < n; ++i) {
            const auto& subj = meshList[i];
            if (!subj.second) continue;
            // Skip meshes explicitly named as terrain/ground — they are the support
            const std::string& sName = subj.first;
            if (sName.find("terrain") != std::string::npos ||
                sName.find("ground") != std::string::npos ||
                sName.find("topography") != std::string::npos) {
                continue;
            }

            const Vec3 sMin = subj.second->bounds.min;
            const Vec3 sMax = subj.second->bounds.max;

            // Find the highest top surface among meshes horizontally overlapping & below
            float bestSupportTop = -1e9f;
            std::string bestSupportName;
            for (size_t j = 0; j < n; ++j) {
                if (j == i) continue;
                const auto& cand = meshList[j];
                if (!cand.second) continue;
                const Vec3 cMin = cand.second->bounds.min;
                const Vec3 cMax = cand.second->bounds.max;

                const float overlapX = std::min(sMax.x, cMax.x) - std::max(sMin.x, cMin.x);
                const float overlapZ = std::min(sMax.z, cMax.z) - std::max(sMin.z, cMin.z);
                if (overlapX <= 0.0f || overlapZ <= 0.0f) continue; // no horizontal overlap
                if (cMax.y > sMin.y) continue;                       // not below subject

                if (cMax.y > bestSupportTop) {
                    bestSupportTop = cMax.y;
                    bestSupportName = cand.first;
                }
            }

            if (bestSupportTop > -1e8f) {
                const float gap = sMin.y - bestSupportTop;
                if (gap > maxAllowedGap) {
                    ContactAuditViolation v;
                    v.subject = sName;
                    v.target = bestSupportName;
                    v.type = "floating_gap";
                    v.metricDistance = gap;
                    v.resolutionDelta = Vec3(0.0f, -gap, 0.0f);
                    violations.push_back(v);
                }
            }
        }
        return violations;
    }
};

} // namespace composer
} // namespace scratchbox

#endif // SCRATCHBOX_SCENE_COMPOSER_HPP
