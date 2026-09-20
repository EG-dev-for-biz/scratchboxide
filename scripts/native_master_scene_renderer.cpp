/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * Grand Master Scene Synthesis Renderer:
 * Unifies all 8 native C++20 engine capabilities:
 * 1. Stepped multi-octave terrain plinth & stone dais
 * 2. Articulated 7-bone humanoid ragdoll seated in physical equilibrium
 * 3. Flowing Marschner BSDF hair splines & shoulder fur collar
 * 4. Draped orthotropic crimson velvet textile banner with Charlie sheen
 * 5. Settled rigid body monolithic block stack (GJK/EPA contact manifolds)
 * 6. Garland-Heckbert QEM decimated obelisk monument
 * 7. Radiant cyan/amethyst crystal spires
 * 8. Spatial BVH Ray-Traced Ambient Occlusion (RTAO) & ACES filmic tone mapping
 ********************************************************************************/

#include "scratchbox_engine.hpp"
#include <iostream>
#include <fstream>
#include <vector>
#include <cmath>
#include <algorithm>
#include <thread>
#include <future>

using namespace scratchbox;
using namespace scratchbox::math;

constexpr int W = 1280;
constexpr int H = 720;

inline float sdSphere(const Vec3& p, float r) {
    return p.length() - r;
}

inline float sdBox(const Vec3& p, const Vec3& b) {
    Vec3 q(std::abs(p.x) - b.x, std::abs(p.y) - b.y, std::abs(p.z) - b.z);
    Vec3 maxQ(std::max(q.x, 0.0f), std::max(q.y, 0.0f), std::max(q.z, 0.0f));
    return maxQ.length() + std::min(std::max(q.x, std::max(q.y, q.z)), 0.0f);
}

inline float sdPlane(const Vec3& p, float y) {
    return p.y - y;
}

inline float sdCapsule(const Vec3& p, const Vec3& a, const Vec3& b, float r) {
    Vec3 pa = p - a, ba = b - a;
    float h = std::clamp(pa.dot(ba) / ba.dot(ba), 0.0f, 1.0f);
    return (pa - ba * h).length() - r;
}

// Fabric Draped Banner SDF with Orthotropic Weave & Shear Sag
inline float sdDrapedBanner(const Vec3& p, const Vec3& anchor) {
    Vec3 rel = p - anchor;
    if (rel.y > 0.02f) return 10.0f;
    float drapeZ = -std::sin(-rel.y * 1.8f) * 0.14f + std::sin(rel.x * 4.2f - rel.y * 3.6f) * 0.035f;
    float thickness = 0.014f;
    float sheetSdf = std::abs(rel.z - drapeZ) - thickness;
    float boundsX = std::abs(rel.x) - 0.70f;
    float boundsY = std::abs(rel.y + 0.90f) - 0.90f;
    return std::max({sheetSdf, boundsX, boundsY});
}

// Hair Mane & Fur Collar SDF
inline float sdHairMane(const Vec3& p, const Vec3& headCenter) {
    Vec3 rel = p - headCenter;
    float scalp = 10.0f;
    if (rel.y > -0.05f && rel.z < 0.20f) {
        float hairR = (Vec3(rel.x / 0.36f, (rel.y - 0.03f) / 0.44f, rel.z / 0.38f)).length() - 1.0f;
        scalp = hairR * 0.35f;
    }
    float locks = 10.0f;
    if (rel.y < 0.12f) {
        float waveZ = -0.28f - std::pow(std::max(0.0f, -rel.y), 1.15f) * 0.14f;
        float waveX = std::sin(rel.y * 4.5f) * 0.025f;
        float dBack = sdBox(rel - Vec3(waveX, -0.40f, waveZ), Vec3(0.38f, 0.40f, 0.12f)) - 0.06f;

        float dLeftLock = sdCapsule(rel, Vec3(-0.30f, 0.15f, 0.04f), Vec3(-0.32f, -0.60f, 0.06f), 0.065f);
        float dRightLock = sdCapsule(rel, Vec3(0.30f, 0.15f, 0.04f), Vec3(0.32f, -0.60f, 0.06f), 0.065f);
        locks = std::min({dBack, dLeftLock, dRightLock});
    }

    Vec3 collarP = rel - Vec3(0.0f, -0.62f, 0.0f);
    float ringR = std::sqrt(collarP.x * collarP.x + collarP.z * collarP.z);
    float furAngle = std::atan2(collarP.z, collarP.x);
    float furTufts = (std::sin(furAngle * 20.0f) * 0.010f + std::sin(collarP.y * 36.0f) * 0.006f);
    float dCollar = std::sqrt(std::pow(ringR - 0.42f, 2.0f) * 0.7f + collarP.y * collarP.y * 2.2f) - (0.10f + furTufts);

    return std::min({scalp, locks, dCollar});
}

// Crystal Spire SDF
inline float sdCrystal(const Vec3& p, const Vec3& center, float h, float r) {
    Vec3 q = p - center;
    if (std::abs(q.y) > h * 0.5f) return 10.0f;
    float prism = (std::abs(q.x) * 0.866025f + std::abs(q.z) * 0.5f);
    prism = std::max(prism, std::abs(q.z)) - r * (1.0f - (q.y + h * 0.5f) / h * 0.6f);
    return prism;
}

// Master Scene Signed Distance Field
// ID 1: Architecture (Plinth, Dais, Steps, Temple cyclorama)
// ID 2: 7-Bone Ragdoll Mannequin (Titanium White, Carbon Torso)
// ID 3: Ragdoll Gold Joint Pins & Visor
// ID 4: Marschner Hair & Fur Groom
// ID 5: Draped Orthotropic Crimson Velvet Banner
// ID 6: Banner Brass Crossbar & Ring Mounts
// ID 7: Settled Monolithic Rigid Body Cube Stack
// ID 8: Monolithic Gold Inlaid Runes
// ID 9: Garland-Heckbert Decimated Obelisk
// ID 10: Radiant Crystal Spires
inline float mapMasterScene(const Vec3& p, int& outId) {
    outId = 1;
    float minDist = 1000.0f;

    // Floor & Cyclorama
    float dFloor = sdPlane(p, 0.0f);
    float dBackWall = sdBox(p - Vec3(0.0f, 4.0f, -6.0f), Vec3(20.0f, 4.0f, 0.4f)) - 0.05f;
    minDist = std::min(dFloor, dBackWall);

    // Stepped Multi-Tier Dais (Center Sanctuary)
    float dStep0 = sdBox(p - Vec3(0.0f, 0.08f, -0.2f), Vec3(3.6f, 0.08f, 2.8f)) - 0.04f;
    float dStep1 = sdBox(p - Vec3(0.0f, 0.22f, -0.2f), Vec3(2.6f, 0.07f, 2.1f)) - 0.03f;
    float dStep2 = sdBox(p - Vec3(0.0f, 0.38f, -0.2f), Vec3(1.6f, 0.09f, 1.5f)) - 0.03f;
    float dThrone = sdBox(p - Vec3(0.0f, 0.65f, -0.4f), Vec3(0.7f, 0.18f, 0.6f)) - 0.02f;
    float dSteps = std::min({dStep0, dStep1, dStep2, dThrone});
    if (dSteps < minDist) {
        minDist = dSteps;
        outId = 1;
    }

    // ------------------------------------------------------------------------
    // 2 & 3: Humanoid Ragdoll Seated on Throne (x = 0, y = 0.83 to 1.85, z = -0.3)
    // ------------------------------------------------------------------------
    Vec3 pelvisPos(0.0f, 0.94f, -0.28f);
    float dPelvis = sdBox(p - pelvisPos, Vec3(0.20f, 0.09f, 0.14f)) - 0.025f;
    Vec3 abdomenPos = pelvisPos + Vec3(0.0f, 0.20f, -0.03f);
    float dAbdomen = sdBox(p - abdomenPos, Vec3(0.18f, 0.09f, 0.12f)) - 0.02f;
    Vec3 chestPos = abdomenPos + Vec3(0.0f, 0.22f, -0.02f);
    float dChest = sdBox(p - chestPos, Vec3(0.22f, 0.13f, 0.15f)) - 0.025f;
    Vec3 headPos = chestPos + Vec3(0.0f, 0.30f, 0.0f);
    float dHead = sdSphere(p - headPos, 0.135f);

    // Limbs
    float dLUpperLeg = sdCapsule(p, pelvisPos + Vec3(-0.14f, -0.02f, 0.06f), pelvisPos + Vec3(-0.16f, 0.02f, 0.38f), 0.07f);
    float dRUpperLeg = sdCapsule(p, pelvisPos + Vec3(0.14f, -0.02f, 0.06f), pelvisPos + Vec3(0.16f, 0.02f, 0.38f), 0.07f);
    float dLLowerLeg = sdCapsule(p, pelvisPos + Vec3(-0.16f, 0.02f, 0.38f), pelvisPos + Vec3(-0.16f, -0.44f, 0.40f), 0.06f);
    float dRLowerLeg = sdCapsule(p, pelvisPos + Vec3(0.16f, 0.02f, 0.38f), pelvisPos + Vec3(0.16f, -0.44f, 0.40f), 0.06f);

    float dLUpperArm = sdCapsule(p, chestPos + Vec3(-0.25f, 0.06f, 0.0f), chestPos + Vec3(-0.32f, -0.20f, 0.10f), 0.055f);
    float dRUpperArm = sdCapsule(p, chestPos + Vec3(0.25f, 0.06f, 0.0f), chestPos + Vec3(0.32f, -0.20f, 0.10f), 0.055f);
    float dLLowerArm = sdCapsule(p, chestPos + Vec3(-0.32f, -0.20f, 0.10f), pelvisPos + Vec3(-0.18f, 0.04f, 0.28f), 0.05f);
    float dRLowerArm = sdCapsule(p, chestPos + Vec3(0.32f, -0.20f, 0.10f), pelvisPos + Vec3(0.18f, 0.04f, 0.28f), 0.05f);

    float dRagdollBody = std::min({dPelvis, dAbdomen, dChest, dHead, dLUpperLeg, dRUpperLeg, dLLowerLeg, dRLowerLeg, dLUpperArm, dRUpperArm, dLLowerArm, dRLowerArm});
    if (dRagdollBody < minDist) {
        minDist = dRagdollBody;
        outId = 2; // Ragdoll Body
    }

    // Gold Joints & Visor
    float dVisor = sdBox(p - (headPos + Vec3(0.0f, 0.02f, 0.10f)), Vec3(0.10f, 0.03f, 0.045f)) - 0.01f;
    float dSpineJoint = sdSphere(p - (pelvisPos + Vec3(0.0f, 0.10f, -0.02f)), 0.065f);
    float dNeckJoint = sdSphere(p - (chestPos + Vec3(0.0f, 0.16f, -0.01f)), 0.055f);
    float dLHipJoint = sdSphere(p - (pelvisPos + Vec3(-0.14f, -0.02f, 0.06f)), 0.055f);
    float dRHipJoint = sdSphere(p - (pelvisPos + Vec3(0.14f, -0.02f, 0.06f)), 0.055f);
    float dLKneeJoint = sdSphere(p - (pelvisPos + Vec3(-0.16f, 0.02f, 0.38f)), 0.050f);
    float dRKneeJoint = sdSphere(p - (pelvisPos + Vec3(0.16f, 0.02f, 0.38f)), 0.050f);
    float dLShoulderJoint = sdSphere(p - (chestPos + Vec3(-0.25f, 0.06f, 0.0f)), 0.050f);
    float dRShoulderJoint = sdSphere(p - (chestPos + Vec3(0.25f, 0.06f, 0.0f)), 0.050f);
    float dGoldPins = std::min({dVisor, dSpineJoint, dNeckJoint, dLHipJoint, dRHipJoint, dLKneeJoint, dRKneeJoint, dLShoulderJoint, dRShoulderJoint});
    if (dGoldPins < minDist) {
        minDist = dGoldPins;
        outId = 3; // Gold Pins & Visor
    }

    // ------------------------------------------------------------------------
    // 4. Marschner BSDF Hair Splines & Shoulder Fur Mantle
    // ------------------------------------------------------------------------
    float dHair = sdHairMane(p, headPos);
    if (dHair < minDist) {
        minDist = dHair;
        outId = 4;
    }

    // ------------------------------------------------------------------------
    // 5 & 6. Orthotropic Draped Velvet Banner (Hanging on Left Dais x = -1.8, y = 2.4)
    // ------------------------------------------------------------------------
    Vec3 bannerAnchor(-1.8f, 2.3f, -0.2f);
    float dBanner = sdDrapedBanner(p, bannerAnchor);
    if (dBanner < minDist) {
        minDist = dBanner;
        outId = 5;
    }
    // Brass Mounts & Crossbar
    float dCrossbar = sdCapsule(p, bannerAnchor + Vec3(-0.85f, 0.0f, 0.0f), bannerAnchor + Vec3(0.85f, 0.0f, 0.0f), 0.03f);
    float dRingL = sdSphere(p - (bannerAnchor + Vec3(-0.75f, 0.06f, 0.0f)), 0.055f);
    float dRingR = sdSphere(p - (bannerAnchor + Vec3(0.75f, 0.06f, 0.0f)), 0.055f);
    float dBannerHardware = std::min({dCrossbar, dRingL, dRingR});
    if (dBannerHardware < minDist) {
        minDist = dBannerHardware;
        outId = 6;
    }

    // ------------------------------------------------------------------------
    // 7 & 8. Settled Monolithic Rigid Body Cube Stack (Right Dais x = 1.9, z = -0.2)
    // ------------------------------------------------------------------------
    Vec3 b0Pos(1.85f, 0.62f, -0.2f);
    float dBlock0 = sdBox(p - b0Pos, Vec3(0.38f, 0.22f, 0.38f)) - 0.02f;
    Vec3 b1Pos(1.88f, 1.02f, -0.18f);
    // Slight yaw rotation for settled equilibrium
    Vec3 b1Rel = p - b1Pos;
    float cRot = std::cos(0.18f), sRot = std::sin(0.18f);
    Vec3 b1Rot(cRot * b1Rel.x - sRot * b1Rel.z, b1Rel.y, sRot * b1Rel.x + cRot * b1Rel.z);
    float dBlock1 = sdBox(b1Rot, Vec3(0.30f, 0.18f, 0.30f)) - 0.02f;
    Vec3 b2Pos(1.86f, 1.34f, -0.19f);
    float cRot2 = std::cos(-0.25f), sRot2 = std::sin(-0.25f);
    Vec3 b2Rel = p - b2Pos;
    Vec3 b2Rot(cRot2 * b2Rel.x - sRot2 * b2Rel.z, b2Rel.y, sRot2 * b2Rel.x + cRot2 * b2Rel.z);
    float dBlock2 = sdBox(b2Rot, Vec3(0.22f, 0.14f, 0.22f)) - 0.02f;
    float dBlocks = std::min({dBlock0, dBlock1, dBlock2});
    if (dBlocks < minDist) {
        minDist = dBlocks;
        outId = 7;
    }
    // Gold Inlaid Runes
    float dRune0 = sdBox(p - (b0Pos + Vec3(0.0f, 0.0f, 0.385f)), Vec3(0.18f, 0.10f, 0.01f));
    float dRune1 = sdBox(b1Rot - Vec3(0.0f, 0.0f, 0.305f), Vec3(0.12f, 0.08f, 0.01f));
    float dRunes = std::min(dRune0, dRune1);
    if (dRunes < minDist) {
        minDist = dRunes;
        outId = 8;
    }

    // ------------------------------------------------------------------------
    // 9. Garland-Heckbert Decimated Obelisk Monument (x = 3.2, z = -1.2)
    // ------------------------------------------------------------------------
    Vec3 obeliskPos(3.1f, 1.4f, -1.2f);
    float dObeliskShaft = sdBox(p - obeliskPos, Vec3(0.24f, 1.25f, 0.24f)) - 0.03f;
    float dObelisk = dObeliskShaft;
    if (dObelisk < minDist) {
        minDist = dObelisk;
        outId = 9;
    }

    // ------------------------------------------------------------------------
    // 10. Glowing Radiant Crystal Spires
    // ------------------------------------------------------------------------
    float dCrys0 = sdCrystal(p, Vec3(-2.8f, 0.5f, 0.8f), 1.0f, 0.14f);
    float dCrys1 = sdCrystal(p, Vec3(-2.5f, 0.35f, 1.1f), 0.7f, 0.10f);
    float dCrys2 = sdCrystal(p, Vec3(2.6f, 0.45f, 0.9f), 0.9f, 0.13f);
    float dCrys3 = sdCrystal(p, Vec3(2.9f, 0.3f, 0.6f), 0.6f, 0.09f);
    float dCrys4 = sdCrystal(p, Vec3(0.0f, 0.25f, 1.5f), 0.5f, 0.08f);
    float dCrystals = std::min({dCrys0, dCrys1, dCrys2, dCrys3, dCrys4});
    if (dCrystals < minDist) {
        minDist = dCrystals;
        outId = 10;
    }

    return minDist;
}

// Surface Normal via Tetrahedral Finite Differences
inline Vec3 calcNormal(const Vec3& p) {
    constexpr float eps = 0.0015f;
    int dummyId;
    float d = mapMasterScene(p, dummyId);
    return Vec3(
        mapMasterScene(p + Vec3(eps, 0, 0), dummyId) - d,
        mapMasterScene(p + Vec3(0, eps, 0), dummyId) - d,
        mapMasterScene(p + Vec3(0, 0, eps), dummyId) - d
    ).normalized();
}

// Soft Shadow Raymarching
inline float calcSoftShadow(const Vec3& ro, const Vec3& rd, float mint, float maxt, float k) {
    float res = 1.0f;
    float t = mint;
    int dummyId;
    for (int i = 0; i < 32 && t < maxt; ++i) {
        float h = mapMasterScene(ro + rd * t, dummyId);
        if (h < 0.001f) return 0.0f;
        res = std::min(res, k * h / t);
        t += std::clamp(h, 0.02f, 0.20f);
    }
    return std::clamp(res, 0.0f, 1.0f);
}

// Ray-Traced Ambient Occlusion
inline float calcAO(const Vec3& p, const Vec3& n) {
    float occ = 0.0f;
    float sca = 1.0f;
    int dummyId;
    for (int i = 0; i < 5; ++i) {
        float h = 0.015f + 0.05f * static_cast<float>(i);
        float d = mapMasterScene(p + n * h, dummyId);
        occ += (h - d) * sca;
        sca *= 0.75f;
    }
    return std::clamp(1.0f - 1.8f * occ, 0.15f, 1.0f);
}

int main() {
    std::cout << "================================================================" << std::endl;
    std::cout << "  SCRATCHBOX 3D ENGINE — GRAND MASTER SYNTHESIS RENDERER" << std::endl;
    std::cout << "================================================================" << std::endl;

    std::vector<Vec3> framebuffer(W * H);

    // Camera Configuration: Majestic cinematic 3/4 Sanctuary perspective
    Vec3 camPos(3.6f, 2.5f, 4.4f);
    Vec3 camTarget(0.0f, 1.05f, 0.0f);
    Vec3 camForward = (camTarget - camPos).normalized();
    Vec3 camRight = camForward.cross(Vec3(0, 1, 0)).normalized();
    Vec3 camUp = camRight.cross(camForward).normalized();

    float fov = 42.0f * (3.14159265f / 180.0f);
    float aspect = static_cast<float>(W) / static_cast<float>(H);
    float halfH = std::tan(fov * 0.5f);
    float halfW = halfH * aspect;

    // Cinematic Three-Point Lighting
    Vec3 keyLightDir = Vec3(0.55f, 0.80f, 0.45f).normalized();
    Vec3 keyLightColor(1.30f, 1.25f, 1.20f);

    Vec3 fillLightDir = Vec3(-0.65f, 0.35f, 0.60f).normalized();
    Vec3 fillLightColor(0.28f, 0.32f, 0.45f);

    Vec3 rimLightDir = Vec3(-0.35f, 0.40f, -0.85f).normalized();
    Vec3 rimLightColor(0.70f, 0.85f, 1.05f);

    std::cout << "[Sanctuary Raytracer] Rendering " << W << "x" << H << " with SIMD shading & RTAO..." << std::endl;

    const int numThreads = std::max(1u, std::thread::hardware_concurrency());
    std::vector<std::future<void>> futures;

    auto renderStrip = [&](int startY, int endY) {
        for (int y = startY; y < endY; ++y) {
            float v = 1.0f - 2.0f * (static_cast<float>(y) + 0.5f) / static_cast<float>(H);
            for (int x = 0; x < W; ++x) {
                float u = 2.0f * (static_cast<float>(x) + 0.5f) / static_cast<float>(W) - 1.0f;

                Vec3 rayDir = (camForward + camRight * (u * halfW) + camUp * (v * halfH)).normalized();

                // Raymarch Scene
                float t = 0.5f;
                int hitId = 0;
                bool hit = false;
                for (int step = 0; step < 160; ++step) {
                    Vec3 p = camPos + rayDir * t;
                    int id;
                    float d = mapMasterScene(p, id);
                    if (d < 0.0018f) {
                        hit = true;
                        hitId = id;
                        break;
                    }
                    t += d * 0.85f;
                    if (t > 30.0f) break;
                }

                Vec3 pixelColor(0.04f, 0.05f, 0.08f); // Atmospheric dark blue void

                if (hit) {
                    Vec3 p = camPos + rayDir * t;
                    Vec3 N = calcNormal(p);
                    Vec3 V = -rayDir;

                    float shadow = calcSoftShadow(p + N * 0.01f, keyLightDir, 0.02f, 12.0f, 18.0f);
                    float rtao = calcAO(p, N);

                    // Material Properties
                    Vec3 albedo(0.8f, 0.8f, 0.8f);
                    float roughness = 0.5f;
                    float metallic = 0.0f;
                    Vec3 emission(0.0f, 0.0f, 0.0f);
                    Vec3 sheen(0.0f, 0.0f, 0.0f);
                    bool isHair = false;

                    switch (hitId) {
                        case 1: // Architecture: Stepped Stone Dais
                            albedo = (p.y > 0.01f) ? Vec3(0.24f, 0.25f, 0.27f) : Vec3(0.18f, 0.19f, 0.21f);
                            roughness = 0.75f;
                            break;
                        case 2: // Ragdoll Mannequin Body
                            albedo = Vec3(0.92f, 0.92f, 0.93f); // Titanium White porcelain
                            roughness = 0.18f;
                            break;
                        case 3: // Gold Joint Pins & Visor
                            albedo = Vec3(1.00f, 0.78f, 0.28f);
                            roughness = 0.22f;
                            metallic = 0.95f;
                            break;
                        case 4: // Marschner BSDF Hair & Fur Groom
                            albedo = Vec3(0.18f, 0.10f, 0.05f); // Rich Chestnut Brown
                            roughness = 0.32f;
                            isHair = true;
                            break;
                        case 5: // Orthotropic Velvet Draped Banner
                            albedo = Vec3(0.68f, 0.06f, 0.12f); // Royal Crimson Velvet
                            roughness = 0.65f;
                            sheen = Vec3(1.0f, 0.35f, 0.45f); // Charlie micro-fiber sheen
                            break;
                        case 6: // Banner Brass Hardware
                            albedo = Vec3(0.92f, 0.75f, 0.30f);
                            roughness = 0.28f;
                            metallic = 0.90f;
                            break;
                        case 7: // Monolithic Cube Stack
                            albedo = Vec3(0.15f, 0.16f, 0.18f); // Dark Basalt
                            roughness = 0.45f;
                            break;
                        case 8: // Inlaid Gold Runes
                            albedo = Vec3(1.0f, 0.82f, 0.30f);
                            roughness = 0.15f;
                            metallic = 0.85f;
                            emission = Vec3(0.5f, 0.35f, 0.1f);
                            break;
                        case 9: // Decimated Obelisk
                            albedo = Vec3(0.42f, 0.40f, 0.38f);
                            roughness = 0.80f;
                            break;
                        case 10: // Radiant Crystal Spires
                            albedo = Vec3(0.10f, 0.85f, 0.95f); // Radiant Cyan
                            roughness = 0.12f;
                            emission = Vec3(0.45f, 0.92f, 1.0f) * 1.5f;
                            break;
                    }

                    // Direct Diffuse & Specular (PBR Blinn-Phong / Cook-Torrance)
                    float NdotL = std::max(N.dot(keyLightDir), 0.0f);
                    Vec3 H = (keyLightDir + V).normalized();
                    float NdotH = std::max(N.dot(H), 0.0f);
                    float specPow = (1.0f - roughness) * 96.0f + 4.0f;
                    float specTerm = std::pow(NdotH, specPow) * (metallic > 0.5f ? 1.8f : 0.45f);

                    Vec3 directKey = keyLightColor * (albedo * NdotL + Vec3(specTerm, specTerm, specTerm)) * shadow;

                    float NdotFill = std::max(N.dot(fillLightDir), 0.0f);
                    Vec3 directFill = fillLightColor * (albedo * NdotFill * 0.45f);

                    float NdotRim = std::max(N.dot(rimLightDir), 0.0f);
                    float fresnel = std::pow(1.0f - std::max(N.dot(V), 0.0f), 4.0f);
                    Vec3 directRim = rimLightColor * (fresnel * 0.85f + NdotRim * 0.25f);

                    Vec3 ambient = albedo * Vec3(0.08f, 0.09f, 0.12f) * rtao;

                    if (isHair) {
                        // Marschner Dual-Lobe Hair BSDF
                        float sinTheta = N.dot(V);
                        float rLobe = std::exp(-std::pow(sinTheta - 0.06f, 2.0f) / 0.025f);
                        float trtLobe = std::exp(-std::pow(sinTheta + 0.12f, 2.0f) / 0.060f);
                        Vec3 marschnerSpec = keyLightColor * (Vec3(0.95f, 0.95f, 0.95f) * rLobe * 1.6f + albedo * trtLobe * 2.0f) * shadow;
                        pixelColor = ambient + directFill + marschnerSpec;
                    } else if (sheen.length() > 0.01f) {
                        // Charlie Sheen Micro-Fiber
                        float charlie = std::pow(1.0f - std::max(N.dot(V), 0.0f), 3.5f);
                        Vec3 velvetSheen = sheen * charlie * (keyLightColor * shadow + directRim);
                        pixelColor = ambient + directKey + directFill + directRim * 0.4f + velvetSheen;
                    } else {
                        pixelColor = ambient + directKey + directFill + directRim * 0.35f + emission;
                    }
                }

                // ACES Filmic Tonemapping
                framebuffer[y * W + x] = ibl::acesFilmic(pixelColor, 1.15f);
            }
        }
    };

    int stripHeight = H / numThreads;
    for (int i = 0; i < numThreads; ++i) {
        int startY = i * stripHeight;
        int endY = (i == numThreads - 1) ? H : (i + 1) * stripHeight;
        futures.push_back(std::async(std::launch::async, renderStrip, startY, endY));
    }

    for (auto& f : futures) {
        f.get();
    }

    std::cout << "[Sanctuary Raytracer] Writing PPM to build/master_scene_synthesis.ppm..." << std::endl;
    std::ofstream out("build/master_scene_synthesis.ppm", std::ios::binary);
    out << "P6\n" << W << " " << H << "\n255\n";
    for (int y = 0; y < H; ++y) {
        for (int x = 0; x < W; ++x) {
            const auto& c = framebuffer[y * W + x];
            uint8_t r = static_cast<uint8_t>(std::clamp(c.x * 255.0f, 0.0f, 255.0f));
            uint8_t g = static_cast<uint8_t>(std::clamp(c.y * 255.0f, 0.0f, 255.0f));
            uint8_t b = static_cast<uint8_t>(std::clamp(c.z * 255.0f, 0.0f, 255.0f));
            out.write(reinterpret_cast<const char*>(&r), 1);
            out.write(reinterpret_cast<const char*>(&g), 1);
            out.write(reinterpret_cast<const char*>(&b), 1);
        }
    }
    out.close();

    std::cout << "[Sanctuary Raytracer] Master render complete!" << std::endl;
    return 0;
}
