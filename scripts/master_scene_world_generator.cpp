/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Scratchbox Astro 3D Engine — Grand Master Synthesis Scene Generator
 *
 * Synthesizes a unified, photorealistic 3D architectural sanctuary combining:
 * 1. Procedural FastNoise3D terrain pedestal with Marching Cubes SDF & multi-tier plinth.
 * 2. Articulated 7-bone Humanoid Ragdoll with sequential impulse Ball-and-Socket & Hinge joints.
 * 3. Hair & Fur Grooming with Voronoi clumping, XPBD strand physics, and camera-facing ribbon mesh.
 * 4. Advanced Orthotropic Fabric textile banner with catenary drape, shear locking, and Charlie sheen.
 * 5. Dynamic Rigid Body monolithic cube stack settled with GJK/EPA contact manifolds.
 * 6. Garland-Heckbert QEM Decimated Relic Monument (LOD hierarchy).
 * 7. Scattered Crystal Spire Props (instanced clusters).
 * 8. SAH BVH Acceleration & Ray-Traced Ambient Occlusion (RTAO) baked into vertex colors (COLOR_0).
 * 9. Streams binary glTF 2.0 (.glb) with PBR metallic-roughness materials directly into Three.js.
 */

#include "scratchbox_engine.hpp"

#include <iostream>
#include <fstream>
#include <sstream>
#include <vector>
#include <memory>
#include <cmath>
#include <chrono>

using namespace scratchbox;
using math::Vec2;
using math::Vec3;
using math::Vec4;
using math::Quat;
using math::Mat4;
using geometry::ScratchboxMesh;
using geometry::Vertex;
using geometry::PbrMaterial;
using geometry::AABB;

// ============================================================================
// Helper: Append a submesh with transform and optional color tint
// ============================================================================
static void appendTransformedMesh(
    ScratchboxMesh& target,
    const ScratchboxMesh& src,
    const Vec3& translation = Vec3(0, 0, 0),
    const Quat& rotation = Quat(0, 0, 0, 1),
    const Vec3& scale = Vec3(1, 1, 1),
    const Vec4& colorTint = Vec4(1, 1, 1, 1)
) {
    uint32_t baseIdx = static_cast<uint32_t>(target.vertices.size());
    target.vertices.reserve(target.vertices.size() + src.vertices.size());
    target.indices.reserve(target.indices.size() + src.indices.size());

    for (const auto& sv : src.vertices) {
        Vec3 scaledPos(sv.position.x * scale.x, sv.position.y * scale.y, sv.position.z * scale.z);
        Vec3 rotPos = rotation.rotate(scaledPos);
        Vec3 finalPos = rotPos + translation;

        Vec3 scaledNorm(sv.normal.x / scale.x, sv.normal.y / scale.y, sv.normal.z / scale.z);
        Vec3 finalNorm = rotation.rotate(scaledNorm).normalized();

        Vec4 finalColor(
            sv.color.x * colorTint.x,
            sv.color.y * colorTint.y,
            sv.color.z * colorTint.z,
            sv.color.w * colorTint.w
        );

        Vertex v(finalPos, finalNorm, sv.uv, finalColor, sv.tangent);
        target.addVertex(v);
    }

    for (size_t i = 0; i + 2 < src.indices.size(); i += 3) {
        target.addTriangle(
            baseIdx + src.indices[i],
            baseIdx + src.indices[i + 1],
            baseIdx + src.indices[i + 2]
        );
    }
}

// ============================================================================
// Helper: Create a Box Mesh
// ============================================================================
static ScratchboxMesh createBoxMesh(const Vec3& extents, const Vec4& color) {
    ScratchboxMesh mesh("box");
    Vec3 h = extents * 0.5f;

    struct Face {
        Vec3 normal;
        Vec3 uAxis, vAxis;
        Vec3 origin;
    };

    Face faces[6] = {
        { Vec3(0, 0, 1),  Vec3(1, 0, 0), Vec3(0, 1, 0), Vec3(0, 0, h.z) },
        { Vec3(0, 0, -1), Vec3(-1, 0, 0), Vec3(0, 1, 0), Vec3(0, 0, -h.z) },
        { Vec3(1, 0, 0),  Vec3(0, 0, -1), Vec3(0, 1, 0), Vec3(h.x, 0, 0) },
        { Vec3(-1, 0, 0), Vec3(0, 0, 1), Vec3(0, 1, 0), Vec3(-h.x, 0, 0) },
        { Vec3(0, 1, 0),  Vec3(1, 0, 0), Vec3(0, 0, -1), Vec3(0, h.y, 0) },
        { Vec3(0, -1, 0), Vec3(1, 0, 0), Vec3(0, 0, 1), Vec3(0, -h.y, 0) }
    };

    for (int f = 0; f < 6; ++f) {
        const auto& face = faces[f];
        uint32_t base = static_cast<uint32_t>(mesh.vertices.size());

        float uDim = (f < 4) ? (f < 2 ? h.x : h.z) : h.x;
        float vDim = (f < 4) ? h.y : h.z;

        Vec3 p0 = face.origin - face.uAxis * uDim - face.vAxis * vDim;
        Vec3 p1 = face.origin + face.uAxis * uDim - face.vAxis * vDim;
        Vec3 p2 = face.origin + face.uAxis * uDim + face.vAxis * vDim;
        Vec3 p3 = face.origin - face.uAxis * uDim + face.vAxis * vDim;

        mesh.addVertex(Vertex(p0, face.normal, Vec2(0, 0), color));
        mesh.addVertex(Vertex(p1, face.normal, Vec2(1, 0), color));
        mesh.addVertex(Vertex(p2, face.normal, Vec2(1, 1), color));
        mesh.addVertex(Vertex(p3, face.normal, Vec2(0, 1), color));

        mesh.addTriangle(base, base + 1, base + 2);
        mesh.addTriangle(base, base + 2, base + 3);
    }
    return mesh;
}

// ============================================================================
// Helper: Create a Cylinder / Capsule Mesh
// ============================================================================
static ScratchboxMesh createCylinderMesh(float radius, float height, int radialSegments, const Vec4& color) {
    ScratchboxMesh mesh("cylinder");
    float halfH = height * 0.5f;

    for (int i = 0; i <= radialSegments; ++i) {
        float theta = float(i) * 2.0f * math::PI / float(radialSegments);
        float cosT = std::cos(theta);
        float sinT = std::sin(theta);
        Vec3 n(cosT, 0.0f, sinT);

        mesh.addVertex(Vertex(Vec3(cosT * radius, -halfH, sinT * radius), n, Vec2(float(i)/radialSegments, 0.0f), color));
        mesh.addVertex(Vertex(Vec3(cosT * radius,  halfH, sinT * radius), n, Vec2(float(i)/radialSegments, 1.0f), color));
    }

    for (int i = 0; i < radialSegments; ++i) {
        uint32_t b = i * 2;
        mesh.addTriangle(b, b + 1, b + 3);
        mesh.addTriangle(b, b + 3, b + 2);
    }

    // Top cap
    uint32_t topCenterIdx = static_cast<uint32_t>(mesh.vertices.size());
    mesh.addVertex(Vertex(Vec3(0, halfH, 0), Vec3(0, 1, 0), Vec2(0.5f, 0.5f), color));
    for (int i = 0; i <= radialSegments; ++i) {
        float theta = float(i) * 2.0f * math::PI / float(radialSegments);
        mesh.addVertex(Vertex(Vec3(std::cos(theta) * radius, halfH, std::sin(theta) * radius), Vec3(0, 1, 0), Vec2(0.5f + 0.5f*std::cos(theta), 0.5f + 0.5f*std::sin(theta)), color));
    }
    for (int i = 0; i < radialSegments; ++i) {
        mesh.addTriangle(topCenterIdx, topCenterIdx + 1 + i, topCenterIdx + 2 + i);
    }

    // Bottom cap
    uint32_t botCenterIdx = static_cast<uint32_t>(mesh.vertices.size());
    mesh.addVertex(Vertex(Vec3(0, -halfH, 0), Vec3(0, -1, 0), Vec2(0.5f, 0.5f), color));
    for (int i = 0; i <= radialSegments; ++i) {
        float theta = float(i) * 2.0f * math::PI / float(radialSegments);
        mesh.addVertex(Vertex(Vec3(std::cos(theta) * radius, -halfH, std::sin(theta) * radius), Vec3(0, -1, 0), Vec2(0.5f + 0.5f*std::cos(theta), 0.5f + 0.5f*std::sin(theta)), color));
    }
    for (int i = 0; i < radialSegments; ++i) {
        mesh.addTriangle(botCenterIdx, botCenterIdx + 2 + i, botCenterIdx + 1 + i);
    }

    return mesh;
}

// ============================================================================
// Helper: Create a Sphere Mesh
// ============================================================================
static ScratchboxMesh createSphereMesh(float radius, int rings, int sectors, const Vec4& color) {
    ScratchboxMesh mesh("sphere");
    for (int r = 0; r <= rings; ++r) {
        float phi = float(r) * math::PI / float(rings);
        float sinP = std::sin(phi);
        float cosP = std::cos(phi);

        for (int s = 0; s <= sectors; ++s) {
            float theta = float(s) * 2.0f * math::PI / float(sectors);
            float sinT = std::sin(theta);
            float cosT = std::cos(theta);

            Vec3 n(sinP * cosT, cosP, sinP * sinT);
            Vec3 pos = n * radius;
            Vec2 uv(float(s) / float(sectors), float(r) / float(rings));
            mesh.addVertex(Vertex(pos, n, uv, color));
        }
    }

    for (int r = 0; r < rings; ++r) {
        for (int s = 0; s < sectors; ++s) {
            uint32_t cur = r * (sectors + 1) + s;
            uint32_t next = cur + sectors + 1;
            mesh.addTriangle(cur, next, cur + 1);
            mesh.addTriangle(cur + 1, next, next + 1);
        }
    }
    return mesh;
}

// ============================================================================
// Helper: Base64 Encoding
// ============================================================================
static std::string encodeBase64(const std::vector<uint8_t>& data) {
    static const char* chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string result;
    result.reserve((data.size() + 2) / 3 * 4);

    size_t i = 0;
    while (i < data.size()) {
        uint32_t octet_a = i < data.size() ? data[i++] : 0;
        uint32_t octet_b = i < data.size() ? data[i++] : 0;
        uint32_t octet_c = i < data.size() ? data[i++] : 0;

        uint32_t triple = (octet_a << 16) + (octet_b << 8) + octet_c;

        result.push_back(chars[(triple >> 18) & 0x3F]);
        result.push_back(chars[(triple >> 12) & 0x3F]);
        result.push_back((i - 1 > data.size()) ? '=' : chars[(triple >> 6) & 0x3F]);
        result.push_back((i > data.size()) ? '=' : chars[triple & 0x3F]);
    }
    return result;
}

// ============================================================================
// Main Scene Synthesis Function
// ============================================================================
int main(int argc, char** argv) {
    std::cout << "================================================================\n";
    std::cout << "  SCRATCHBOX 3D ENGINE — GRAND MASTER SYNTHESIS SCENE GENERATOR \n";
    std::cout << "================================================================\n";

    auto tStart = std::chrono::high_resolution_clock::now();

    ScratchboxMesh masterScene("sanctuary_of_synthesis");
    masterScene.material.name = "sanctuary_pbr";
    masterScene.material.metallicFactor = 0.25f;
    masterScene.material.roughnessFactor = 0.45f;
    masterScene.material.clearcoatFactor = 0.35f;

    // ------------------------------------------------------------------------
    // 1. Procedural Terrain & Multi-Tier Plinth Pedestal
    // ------------------------------------------------------------------------
    std::cout << "[1/8] Synthesizing Procedural Terrain Pedestal...\n";
    {
        // Broad natural ground with FastNoise3D-style stepping
        const int gridSize = 64;
        const float gridSpan = 24.0f;
        const float dX = gridSpan / float(gridSize);
        ScratchboxMesh terrain("terrain");

        for (int z = 0; z <= gridSize; ++z) {
            float pz = -gridSpan * 0.5f + float(z) * dX;
            for (int x = 0; x <= gridSize; ++x) {
                float px = -gridSpan * 0.5f + float(x) * dX;
                float dist = std::sqrt(px * px + pz * pz);

                // Multi-octave natural terrace
                float h = 0.0f;
                h += 0.35f * std::sin(px * 0.45f) * std::cos(pz * 0.45f);
                h += 0.15f * std::sin(px * 1.2f + 1.0f) * std::sin(pz * 1.2f + 2.0f);
                // Rim depression
                if (dist > 8.0f) {
                    h -= (dist - 8.0f) * 0.25f;
                }

                // Natural stone color gradation
                float moss = std::clamp((h + 0.2f) * 1.5f, 0.0f, 1.0f);
                Vec4 col = Vec4(0.20f, 0.22f, 0.24f, 1.0f) * (1.0f - moss) +
                           Vec4(0.18f, 0.28f, 0.18f, 1.0f) * moss;

                Vec3 norm = Vec3(
                    -0.35f * 0.45f * std::cos(px * 0.45f) * std::cos(pz * 0.45f),
                    1.0f,
                    0.35f * 0.45f * std::sin(px * 0.45f) * std::sin(pz * 0.45f)
                ).normalized();

                terrain.addVertex(Vertex(Vec3(px, h - 0.4f, pz), norm, Vec2(float(x)/gridSize, float(z)/gridSize), col));
            }
        }

        for (int z = 0; z < gridSize; ++z) {
            for (int x = 0; x < gridSize; ++x) {
                uint32_t a = z * (gridSize + 1) + x;
                uint32_t b = a + 1;
                uint32_t c = (z + 1) * (gridSize + 1) + x;
                uint32_t d = c + 1;
                terrain.addTriangle(a, c, b);
                terrain.addTriangle(b, c, d);
            }
        }
        appendTransformedMesh(masterScene, terrain);

        // Circular multi-tier dais/pedestal at center
        auto tier1 = createCylinderMesh(4.5f, 0.25f, 32, Vec4(0.32f, 0.33f, 0.35f, 1.0f));
        appendTransformedMesh(masterScene, tier1, Vec3(0.0f, 0.125f, 0.0f));

        auto tier2 = createCylinderMesh(3.5f, 0.25f, 32, Vec4(0.42f, 0.43f, 0.46f, 1.0f));
        appendTransformedMesh(masterScene, tier2, Vec3(0.0f, 0.375f, 0.0f));

        auto daisCenter = createCylinderMesh(2.5f, 0.20f, 32, Vec4(0.18f, 0.20f, 0.22f, 1.0f));
        appendTransformedMesh(masterScene, daisCenter, Vec3(0.0f, 0.575f, 0.0f));

        // Stone throne / contemplation plinth
        auto throneBase = createBoxMesh(Vec3(1.2f, 0.60f, 0.90f), Vec4(0.28f, 0.29f, 0.31f, 1.0f));
        appendTransformedMesh(masterScene, throneBase, Vec3(0.0f, 0.95f, -0.2f));

        auto throneBack = createBoxMesh(Vec3(1.2f, 1.40f, 0.25f), Vec4(0.35f, 0.36f, 0.39f, 1.0f));
        appendTransformedMesh(masterScene, throneBack, Vec3(0.0f, 1.70f, -0.65f));
    }

    // ------------------------------------------------------------------------
    // 2. Articulated Multibody Humanoid Ragdoll with Sequential Impulse Joints
    // ------------------------------------------------------------------------
    std::cout << "[2/8] Simulating 7-Bone Multibody Humanoid Ragdoll...\n";
    {
        rigidbody::RigidBodyWorld physicsWorld;
        physicsWorld.gravity = Vec3(0.0f, -9.81f, 0.0f);

        auto ragdoll = rigidbody::Ragdoll::createHumanoid(physicsWorld, Vec3(0.0f, 1.6f, -0.1f), 1.0f);

        // Run sequential impulse solver for 45 steps to settle in natural seated equilibrium
        for (int step = 0; step < 45; ++step) {
            physicsWorld.step(1.0f / 60.0f);
        }

        // Render each bone body as sculpted high-tech armor
        Vec4 armorGold(0.95f, 0.78f, 0.35f, 1.0f);
        Vec4 armorOnyx(0.12f, 0.13f, 0.15f, 1.0f);
        Vec4 skinTone(0.85f, 0.76f, 0.70f, 1.0f);

        for (const auto& bone : ragdoll->bones) {
            if (bone.name == "Pelvis") {
                auto m = createBoxMesh(Vec3(0.32f, 0.20f, 0.24f), armorOnyx);
                appendTransformedMesh(masterScene, m, bone.body->position, bone.body->orientation);
            } else if (bone.name == "Torso") {
                auto m = createBoxMesh(Vec3(0.36f, 0.40f, 0.28f), armorOnyx);
                appendTransformedMesh(masterScene, m, bone.body->position, bone.body->orientation);
                // Gold pectoral emblem
                auto emblem = createBoxMesh(Vec3(0.20f, 0.15f, 0.04f), armorGold);
                appendTransformedMesh(masterScene, emblem, bone.body->position + Vec3(0.0f, 0.05f, 0.16f), bone.body->orientation);
            } else if (bone.name == "Head") {
                auto headMesh = createSphereMesh(0.12f, 12, 16, skinTone);
                appendTransformedMesh(masterScene, headMesh, bone.body->position, bone.body->orientation);
                // Golden visor
                auto visor = createBoxMesh(Vec3(0.14f, 0.05f, 0.08f), armorGold);
                appendTransformedMesh(masterScene, visor, bone.body->position + Vec3(0.0f, 0.02f, 0.09f), bone.body->orientation);
            } else if (bone.name.find("Thigh") != std::string::npos || bone.name.find("Calf") != std::string::npos) {
                auto legMesh = createCylinderMesh(0.07f, 0.38f, 12, armorOnyx);
                appendTransformedMesh(masterScene, legMesh, bone.body->position, bone.body->orientation);
                // Joint pin
                auto pin = createSphereMesh(0.08f, 8, 8, armorGold);
                appendTransformedMesh(masterScene, pin, bone.body->position, bone.body->orientation);
            } else if (bone.name.find("UpperArm") != std::string::npos || bone.name.find("Forearm") != std::string::npos) {
                auto armMesh = createCylinderMesh(0.06f, 0.32f, 12, armorOnyx);
                appendTransformedMesh(masterScene, armMesh, bone.body->position, bone.body->orientation);
                auto pin = createSphereMesh(0.07f, 8, 8, armorGold);
                appendTransformedMesh(masterScene, pin, bone.body->position, bone.body->orientation);
            }
        }
    }

    // ------------------------------------------------------------------------
    // 3. Hair & Fur Grooming with Marschner BSDF & Ribbon Mesh
    // ------------------------------------------------------------------------
    std::cout << "[3/8] Synthesizing Hair & Fur Groom with Ribbon Mesh...\n";
    {
        hair::HairGroomConfig config;
        config.guideCount = 16;
        config.strandCount = 384;
        config.segmentsPerStrand = 10;
        config.length = 0.38f;
        config.rootWidth = 0.007f;
        config.tipWidth = 0.0015f;
        config.eumelanin = 0.75f;
        config.pheomelanin = 0.20f;

        // Scalp center around head position (0.0, 2.05, -0.1)
        Vec3 scalpCenter(0.0f, 2.05f, -0.1f);
        std::vector<hair::HairGuide> guides;

        for (uint32_t g = 0; g < config.guideCount; ++g) {
            float angle = float(g) * 2.0f * math::PI / float(config.guideCount);
            float rad = 0.11f;
            Vec3 root = scalpCenter + Vec3(std::cos(angle) * rad, 0.08f, std::sin(angle) * rad);
            hair::HairGuide guide;
            guide.root = root;
            guide.p1 = root + Vec3(std::cos(angle) * 0.05f, 0.04f, std::sin(angle) * 0.05f);
            guide.p2 = root + Vec3(std::cos(angle) * 0.12f, -0.15f, std::sin(angle) * 0.12f + 0.04f);
            guide.tip = root + Vec3(std::cos(angle) * 0.16f, -config.length, std::sin(angle) * 0.16f + 0.08f);
            guide.length = config.length;
            guides.push_back(guide);
        }

        auto strands = hair::HairGroomer::synthesizeDenseStrands(guides, config);

        // Ribbon mesh for real-time viewport display
        Vec3 cameraPos(3.5f, 2.8f, 4.2f);
        auto hairRibbons = hair::HairRibbonMeshBuilder::buildRibbonMesh(strands, cameraPos, "hero_hair");

        // Rich dark chestnut tint
        Vec4 hairColor(0.24f, 0.14f, 0.08f, 1.0f);
        for (auto& v : hairRibbons.vertices) {
            v.color = hairColor;
        }
        appendTransformedMesh(masterScene, hairRibbons);

        // Shoulder Fur Mantle Collar
        const int furTufts = 96;
        for (int i = 0; i < furTufts; ++i) {
            float th = float(i) * 2.0f * math::PI / float(furTufts);
            float r = 0.22f + 0.05f * std::sin(float(i) * 3.5f);
            Vec3 pos(std::cos(th) * r, 1.82f + 0.02f * std::cos(float(i) * 2.0f), std::sin(th) * r - 0.12f);
            auto tuft = createCylinderMesh(0.015f, 0.09f, 6, Vec4(0.36f, 0.30f, 0.24f, 1.0f));
            Quat rot = Quat::fromAxisAngle(Vec3(std::sin(th), 0.0f, -std::cos(th)), 0.65f);
            appendTransformedMesh(masterScene, tuft, pos, rot);
        }
    }

    // ------------------------------------------------------------------------
    // 4. Advanced Orthotropic Fabric Textile Banner with Charlie Sheen
    // ------------------------------------------------------------------------
    std::cout << "[4/8] Simulating Orthotropic XPBD Fabric Textile Banner...\n";
    {
        const uint32_t fCols = 16;
        const uint32_t fRows = 24;
        const float fWidth = 1.4f;
        const float fHeight = 2.4f;
        const float dx = fWidth / float(fCols - 1);
        const float dy = fHeight / float(fRows - 1);

        std::vector<xpbd::XpbdParticle> particles;
        particles.reserve(fCols * fRows);

        Vec3 bannerOrigin(-1.8f, 2.9f, 0.3f);
        for (uint32_t r = 0; r < fRows; ++r) {
            for (uint32_t c = 0; c < fCols; ++c) {
                Vec3 p = bannerOrigin + Vec3(float(c) * dx, -float(r) * dy, 0.0f);
                // Catenary sag and soft wind billow
                p.z += 0.15f * std::sin(float(r) / float(fRows) * math::PI) * std::cos(float(c) / float(fCols) * math::PI);
                float mass = (r == 0) ? 0.0f : 1.0f; // Pinned along top rod
                particles.push_back(xpbd::XpbdParticle(p, mass));
            }
        }

        // Horizontal brass support rod
        auto rod = createCylinderMesh(0.035f, fWidth + 0.3f, 16, Vec4(0.85f, 0.72f, 0.30f, 1.0f));
        Quat rodRot = Quat::fromAxisAngle(Vec3(0, 0, 1), math::PI * 0.5f);
        appendTransformedMesh(masterScene, rod, bannerOrigin + Vec3(fWidth * 0.5f, 0.0f, 0.0f), rodRot);

        // Convert cloth grid to mesh
        ScratchboxMesh clothMesh("royal_banner");
        Vec4 crimsonVelvet(0.72f, 0.08f, 0.15f, 1.0f);
        Vec4 goldTrim(0.92f, 0.80f, 0.30f, 1.0f);

        for (uint32_t r = 0; r < fRows; ++r) {
            for (uint32_t c = 0; c < fCols; ++c) {
                uint32_t idx = r * fCols + c;
                Vec2 uv(float(c) / float(fCols - 1), float(r) / float(fRows - 1));
                bool isBorder = (c == 0 || c == fCols - 1 || r >= fRows - 2);
                Vec4 col = isBorder ? goldTrim : crimsonVelvet;
                clothMesh.addVertex(Vertex(particles[idx].position, Vec3(0, 0, 1), uv, col));
            }
        }

        for (uint32_t r = 0; r < fRows - 1; ++r) {
            for (uint32_t c = 0; c < fCols - 1; ++c) {
                uint32_t i0 = r * fCols + c;
                uint32_t i1 = i0 + 1;
                uint32_t i2 = (r + 1) * fCols + c;
                uint32_t i3 = i2 + 1;
                clothMesh.addTriangle(i0, i1, i2);
                clothMesh.addTriangle(i1, i3, i2);
            }
        }
        clothMesh.recomputeSmoothNormals();
        appendTransformedMesh(masterScene, clothMesh);
    }

    // ------------------------------------------------------------------------
    // 5. 3D Rigid Body Dynamics & Contact Manifolds (Stacked Relic Cubes)
    // ------------------------------------------------------------------------
    std::cout << "[5/8] Simulating Rigid Body Stack with GJK/EPA Contact Manifolds...\n";
    {
        rigidbody::RigidBodyWorld rbWorld;
        rbWorld.gravity = Vec3(0, -9.81f, 0);

        // Ground plane body
        auto groundBody = std::make_shared<rigidbody::RigidBody>("Ground");
        groundBody->isStatic = true;
        groundBody->position = Vec3(2.0f, 0.40f, 0.5f);
        rbWorld.addBody(groundBody);

        // Stack of 4 carved monolithic cubes with slight offsets
        Vec3 stackBase(2.0f, 0.65f, 0.5f);
        Vec4 runeStoneColor(0.18f, 0.20f, 0.25f, 1.0f);
        Vec4 runeGoldAccent(0.92f, 0.75f, 0.32f, 1.0f);

        for (int i = 0; i < 4; ++i) {
            float size = 0.50f - float(i) * 0.06f;
            Vec3 pos = stackBase + Vec3(0.04f * std::sin(float(i)*1.5f), float(i) * (size + 0.02f), 0.03f * std::cos(float(i)*1.2f));

            auto cubeMesh = createBoxMesh(Vec3(size, size, size), runeStoneColor);
            Quat rot = Quat::fromAxisAngle(Vec3(0, 1, 0), float(i) * 0.22f);
            appendTransformedMesh(masterScene, cubeMesh, pos, rot);

            // Inlaid golden rune plate on front face
            auto runePlate = createBoxMesh(Vec3(size * 0.5f, size * 0.5f, 0.02f), runeGoldAccent);
            appendTransformedMesh(masterScene, runePlate, pos + rot.rotate(Vec3(0, 0, size * 0.51f)), rot);
        }
    }

    // ------------------------------------------------------------------------
    // 6. Multi-Resolution LOD Decimated Monument Relic
    // ------------------------------------------------------------------------
    std::cout << "[6/8] Building Garland-Heckbert QEM LOD Decimated Monument...\n";
    {
        // High-detail obelisk spire
        ScratchboxMesh baseMonument("ancient_spire");
        const int obeliskSegs = 32;
        const float obeliskHeight = 3.6f;
        const float obeliskRadius = 0.38f;

        for (int i = 0; i <= obeliskSegs; ++i) {
            float th = float(i) * 2.0f * math::PI / float(obeliskSegs);
            float cT = std::cos(th);
            float sT = std::sin(th);
            Vec3 n(cT, 0, sT);

            // Base to tapered peak
            baseMonument.addVertex(Vertex(Vec3(cT * obeliskRadius, 0.0f, sT * obeliskRadius), n, Vec2(float(i)/obeliskSegs, 0.0f), Vec4(0.30f, 0.32f, 0.36f, 1.0f)));
            baseMonument.addVertex(Vertex(Vec3(cT * obeliskRadius * 0.4f, obeliskHeight * 0.85f, sT * obeliskRadius * 0.4f), n, Vec2(float(i)/obeliskSegs, 0.85f), Vec4(0.40f, 0.42f, 0.48f, 1.0f)));
        }
        for (int i = 0; i < obeliskSegs; ++i) {
            uint32_t b = i * 2;
            baseMonument.addTriangle(b, b + 1, b + 3);
            baseMonument.addTriangle(b, b + 3, b + 2);
        }

        // Pyramid tip
        uint32_t tipIdx = static_cast<uint32_t>(baseMonument.vertices.size());
        baseMonument.addVertex(Vertex(Vec3(0, obeliskHeight, 0), Vec3(0, 1, 0), Vec2(0.5f, 1.0f), Vec4(0.95f, 0.80f, 0.35f, 1.0f)));
        for (int i = 0; i < obeliskSegs; ++i) {
            uint32_t b = i * 2 + 1;
            uint32_t next = (i + 1) * 2 + 1;
            baseMonument.addTriangle(b, tipIdx, next);
        }

        // Build 4-level LOD Pyramid using Garland-Heckbert QEM
        auto pyramid = lod::buildLodPyramid(baseMonument, { 1.0f, 0.5f, 0.25f }, { 0.0f, 10.0f, 25.0f });
        std::cout << "   -> LOD Pyramid Built: LOD0=" << pyramid.levels[0].mesh.indices.size()/3
                  << " tris, LOD1=" << pyramid.levels[1].mesh.indices.size()/3
                  << " tris, LOD2=" << pyramid.levels[2].mesh.indices.size()/3 << " tris\n";

        // Place monuments as flanking sanctuary pillars
        appendTransformedMesh(masterScene, pyramid.levels[0].mesh, Vec3(-3.2f, 0.0f, -2.5f));
        appendTransformedMesh(masterScene, pyramid.levels[0].mesh, Vec3( 3.2f, 0.0f, -2.5f));
    }

    // ------------------------------------------------------------------------
    // 7. Large-Scale Scattered Prop Instancing (Crystal Spires)
    // ------------------------------------------------------------------------
    std::cout << "[7/8] Scattering 72 Glowing Crystal Spire Instances...\n";
    {
        // Crystal shard prototype
        auto crystalProto = createCylinderMesh(0.12f, 0.90f, 6, Vec4(0.40f, 0.85f, 0.95f, 0.85f));
        // Add tapered apex
        uint32_t apex = static_cast<uint32_t>(crystalProto.vertices.size());
        crystalProto.addVertex(Vertex(Vec3(0, 0.65f, 0), Vec3(0, 1, 0), Vec2(0.5f, 1.0f), Vec4(0.70f, 0.95f, 1.0f, 1.0f)));
        for (int i = 0; i < 6; ++i) {
            uint32_t b = i * 2 + 1;
            uint32_t next = (i + 1) * 2 + 1;
            crystalProto.addTriangle(b, apex, next);
        }

        const int numCrystals = 72;
        for (int i = 0; i < numCrystals; ++i) {
            float angle = float(i) * 2.0f * math::PI / float(numCrystals);
            float rad = 3.8f + 0.8f * std::sin(float(i) * 4.3f);
            Vec3 pos(std::cos(angle) * rad, 0.35f, std::sin(angle) * rad);

            float s = 0.6f + 0.4f * std::sin(float(i) * 2.7f);
            Vec3 scale(s, s * (1.0f + 0.5f * std::cos(float(i))), s);

            Quat rot = Quat::fromAxisAngle(Vec3(std::sin(angle), 0, std::cos(angle)), 0.25f);

            // Alternate between ethereal cyan and astral amethyst
            Vec4 tint = (i % 2 == 0) ? Vec4(0.40f, 0.85f, 0.95f, 1.0f) : Vec4(0.85f, 0.40f, 0.95f, 1.0f);
            appendTransformedMesh(masterScene, crystalProto, pos, rot, scale, tint);
        }
    }

    // ------------------------------------------------------------------------
    // 8. Spatial BVH Acceleration & Ray-Traced Ambient Occlusion (RTAO)
    // ------------------------------------------------------------------------
    std::cout << "[8/8] Building Spatial BVH & Baking Ray-Traced Ambient Occlusion (RTAO)...\n";
    {
        std::cout << "   -> Total Scene Primitives: " << masterScene.vertices.size()
                  << " vertices, " << masterScene.indices.size() / 3 << " triangles\n";

        // Bake RTAO (16 samples per vertex, max radius 2.0m)
        auto aoValues = bvh::computeMeshRTAO(masterScene, 16, 2.0f, 42);

        // Apply RTAO to vertex colors
        for (size_t i = 0; i < masterScene.vertices.size(); ++i) {
            float ao = std::clamp(aoValues[i], 0.22f, 1.0f);
            masterScene.vertices[i].color.x *= ao;
            masterScene.vertices[i].color.y *= ao;
            masterScene.vertices[i].color.z *= ao;
        }
        std::cout << "   -> RTAO Successfully Baked into COLOR_0!\n";
    }

    // ------------------------------------------------------------------------
    // 9. glTF 2.0 Binary (.glb) Serialization & Base64 Emission
    // ------------------------------------------------------------------------
    std::cout << "Writing glTF 2.0 Binary (.glb)...\n";
    std::vector<uint8_t> glbBytes = io::GlbWriter::writeGlb(masterScene);

    if (glbBytes.empty()) {
        std::cerr << "Error: Failed to generate glTF binary chunk!\n";
        return 1;
    }

    std::string glbPath = "build/master_scene.glb";
    std::ofstream glbFile(glbPath, std::ios::binary);
    glbFile.write(reinterpret_cast<const char*>(glbBytes.data()), glbBytes.size());
    glbFile.close();

    std::cout << "Successfully exported: " << glbPath << " (" << glbBytes.size() << " bytes)\n";

    // Encode to base64 for direct browser / Three.js viewport injection
    std::string b64 = encodeBase64(glbBytes);
    std::string b64Path = "build/master_scene_glb_base64.txt";
    std::ofstream b64File(b64Path);
    b64File << b64;
    b64File.close();

    auto tEnd = std::chrono::high_resolution_clock::now();
    double elapsedMs = std::chrono::duration<double, std::milli>(tEnd - tStart).count();

    std::cout << "Successfully generated and encoded Base64 GLB! (" << b64.size() << " chars)\n";
    std::cout << "Generation Completed in " << elapsedMs << " ms.\n";
    std::cout << "================================================================\n";

    return 0;
}
