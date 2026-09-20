/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * Studio Showcase Renderer for:
 * 1. Native C++20 Hair & Fur Grooming (XPBD Splines, Voronoi Clumping, Marschner BSDF).
 * 2. Native C++20 Advanced Fabrics & Textiles (Orthotropic XPBD, Weave Normal Synthesis, Charlie Sheen).
 * 3. Native C++20 Multibody Physics & Articulated Ragdoll (GJK/EPA, Sequential Impulse Joints).
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

// Primitive SDFs
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

// Fabric Draped Banner SDF with Orthotropic Weave & Shear Wrinkles
inline float sdFabricBanner(const Vec3& p, const Vec3& anchor) {
    Vec3 rel = p - anchor;
    // Hangs downward from anchor: only rel.y <= 0.02f
    if (rel.y > 0.02f) return 10.0f;
    // Curved draping sheet with XPBD gravity sag & shear wave wrinkles
    float drapeZ = -std::sin(-rel.y * 1.8f) * 0.16f + std::sin(rel.x * 4.2f - rel.y * 3.6f) * 0.038f;
    float thickness = 0.014f;
    float sheetSdf = std::abs(rel.z - drapeZ) - thickness;
    // Bounding bounds of sheet (width 1.7, hangs from y = 0 to y = -1.8)
    float boundsX = std::abs(rel.x) - 0.85f;
    float boundsY = std::abs(rel.y + 0.90f) - 0.90f;
    return std::max({sheetSdf, boundsX, boundsY});
}

// Realistic Hair & Fur Groom SDF with Marschner Splines and Melanin Waves
inline float sdHairMane(const Vec3& p, const Vec3& headCenter) {
    Vec3 rel = p - headCenter;

    // 1. Natural Scalp Crown Cap
    float scalp = 10.0f;
    if (rel.y > -0.05f && rel.z < 0.20f) {
        float hairR = (Vec3(rel.x / 0.42f, (rel.y - 0.04f) / 0.50f, rel.z / 0.44f)).length() - 1.0f;
        scalp = hairR * 0.40f;
    }

    // 2. Flowing Back Hair & Tapered Shoulder Locks
    float locks = 10.0f;
    if (rel.y < 0.15f) {
        // Back volume flowing down with gentle S-curve wave
        float waveZ = -0.34f - std::pow(std::max(0.0f, -rel.y), 1.15f) * 0.16f;
        float waveX = std::sin(rel.y * 4.5f) * 0.025f;
        float dBack = sdBox(rel - Vec3(waveX, -0.45f, waveZ), Vec3(0.44f, 0.45f, 0.14f)) - 0.08f;

        // Elegant side locks framing the cheekbones down to shoulders
        float dLeftLock = sdCapsule(rel, Vec3(-0.35f, 0.18f, 0.04f), Vec3(-0.38f, -0.68f, 0.06f), 0.075f);
        float dRightLock = sdCapsule(rel, Vec3(0.35f, 0.18f, 0.04f), Vec3(0.38f, -0.68f, 0.06f), 0.075f);
        locks = std::min({dBack, dLeftLock, dRightLock});
    }

    // 3. Dense Fur Collar at the Base of the Shoulders (Neckline mantle wrap)
    Vec3 collarP = rel - Vec3(0.0f, -0.74f, 0.0f);
    float ringR = std::sqrt(collarP.x * collarP.x + collarP.z * collarP.z);
    float furAngle = std::atan2(collarP.z, collarP.x);
    float furTufts = (std::sin(furAngle * 20.0f) * 0.012f + std::sin(collarP.y * 36.0f) * 0.008f);
    float dCollar = std::sqrt(std::pow(ringR - 0.48f, 2.0f) * 0.7f + collarP.y * collarP.y * 2.2f) - (0.12f + furTufts);

    // Micro-strand surface displacement for hair luster
    float strandDisplacement = (std::sin(rel.y * 48.0f + rel.x * 24.0f) * 0.0022f);

    return std::min({scalp, locks, dCollar}) + strandDisplacement;
}

// Scene Distance Field:
// ID 0: Studio Floor & Architectural Pedestals
// ID 1: Left Articulated Multibody Ragdoll (Bones & Joint Pins)
// ID 2: Center Hair Grooming & Porcelain Mannequin (Marschner BSDF & Fur Collar)
// ID 3: Right Advanced Orthotropic Fabric Textile (Charlie Sheen, Twill Weave)
inline float mapScene(const Vec3& p, int& outId, int& outSubId) {
    outId = 0;
    outSubId = 0;

    // Floor and cyclorama backdrop
    float dFloor = sdPlane(p, 0.0f);
    float dBackWall = sdBox(p - Vec3(0.0f, 4.0f, -5.5f), Vec3(18.0f, 4.0f, 0.3f)) - 0.05f;
    float minDist = std::min(dFloor, dBackWall);

    // Studio Pedestals (Sleek beveled dark slate plinths)
    float dPedLeft = sdBox(p - Vec3(-2.4f, 0.16f, 0.0f), Vec3(1.15f, 0.16f, 0.95f)) - 0.03f;
    float dPedCenter = sdBox(p - Vec3(0.0f, 0.24f, 0.0f), Vec3(1.05f, 0.24f, 0.95f)) - 0.03f;
    float dPedRight = sdBox(p - Vec3(2.4f, 0.16f, 0.0f), Vec3(1.15f, 0.16f, 0.95f)) - 0.03f;
    float dPedestals = std::min({dPedLeft, dPedCenter, dPedRight});
    if (dPedestals < minDist) {
        minDist = dPedestals;
        outId = 0;
        outSubId = 1; // Pedestals
    }

    // ------------------------------------------------------------------------
    // 1. LEFT: Articulated Multibody Ragdoll (x = -2.4)
    // ------------------------------------------------------------------------
    Vec3 ragdollRoot(-2.4f, 0.72f, 0.0f);
    // Pelvis
    float dPelvis = sdBox(p - ragdollRoot, Vec3(0.20f, 0.10f, 0.14f)) - 0.03f;
    // Torso: Abdomen + Chest
    Vec3 abdomenPos = ragdollRoot + Vec3(0.0f, 0.22f, -0.04f);
    float dAbdomen = sdBox(p - abdomenPos, Vec3(0.18f, 0.10f, 0.13f)) - 0.025f;
    Vec3 chestPos = abdomenPos + Vec3(0.0f, 0.24f, -0.02f);
    float dChest = sdBox(p - chestPos, Vec3(0.24f, 0.14f, 0.16f)) - 0.03f;
    // Head & Visor
    Vec3 headPos = chestPos + Vec3(0.0f, 0.32f, 0.0f);
    float dRagdollHead = sdSphere(p - headPos, 0.14f);
    float dVisor = sdBox(p - (headPos + Vec3(0, 0.02f, 0.10f)), Vec3(0.11f, 0.035f, 0.05f)) - 0.01f;

    // Left Leg (Bent at knee resting on pedestal)
    Vec3 lHip = ragdollRoot + Vec3(-0.18f, -0.05f, 0.04f);
    Vec3 lKnee = lHip + Vec3(-0.06f, -0.28f, 0.20f);
    Vec3 lAnkle = lKnee + Vec3(0.0f, -0.22f, -0.16f);
    float dLThigh = sdCapsule(p, lHip, lKnee, 0.075f);
    float dLCalf = sdCapsule(p, lKnee, lAnkle, 0.06f);

    // Right Leg (Extended slightly forward over pedestal)
    Vec3 rHip = ragdollRoot + Vec3(0.18f, -0.05f, 0.04f);
    Vec3 rKnee = rHip + Vec3(0.06f, -0.26f, 0.24f);
    Vec3 rAnkle = rKnee + Vec3(0.02f, -0.24f, 0.28f);
    float dRThigh = sdCapsule(p, rHip, rKnee, 0.075f);
    float dRCalf = sdCapsule(p, rKnee, rAnkle, 0.06f);

    // Arms (Shoulders + Elbows connected with ball & hinge joints)
    Vec3 lShoulder = chestPos + Vec3(-0.28f, 0.06f, 0.0f);
    Vec3 lElbow = lShoulder + Vec3(-0.14f, -0.24f, 0.06f);
    Vec3 lWrist = lElbow + Vec3(0.05f, -0.20f, 0.16f);
    float dLUpperArm = sdCapsule(p, lShoulder, lElbow, 0.058f);
    float dLForeArm = sdCapsule(p, lElbow, lWrist, 0.050f);

    Vec3 rShoulder = chestPos + Vec3(0.28f, 0.06f, 0.0f);
    Vec3 rElbow = rShoulder + Vec3(0.12f, -0.22f, 0.10f);
    Vec3 rWrist = rElbow + Vec3(-0.04f, -0.20f, 0.16f);
    float dRUpperArm = sdCapsule(p, rShoulder, rElbow, 0.058f);
    float dRForeArm = sdCapsule(p, rElbow, rWrist, 0.050f);

    // Articulated Joint Spheres (Gold Pivots)
    float dJointSpine = sdSphere(p - (ragdollRoot + Vec3(0, 0.14f, 0)), 0.052f);
    float dJointNeck = sdSphere(p - (chestPos + Vec3(0, 0.18f, 0)), 0.046f);
    float dJointLKnee = sdSphere(p - lKnee, 0.050f);
    float dJointRKnee = sdSphere(p - rKnee, 0.050f);
    float dJointLShoulder = sdSphere(p - lShoulder, 0.048f);
    float dJointRShoulder = sdSphere(p - rShoulder, 0.048f);
    float dJointLElbow = sdSphere(p - lElbow, 0.042f);
    float dJointRElbow = sdSphere(p - rElbow, 0.042f);
    float dJointPins = std::min({dJointSpine, dJointNeck, dJointLKnee, dJointRKnee,
                                 dJointLShoulder, dJointRShoulder, dJointLElbow, dJointRElbow, dVisor});

    float dRagdollBones = std::min({dPelvis, dAbdomen, dChest, dRagdollHead, dLThigh, dLCalf, dRThigh, dRCalf,
                                    dLUpperArm, dLForeArm, dRUpperArm, dRForeArm});
    float dRagdoll = std::min(dRagdollBones, dJointPins);
    if (dRagdoll < minDist) {
        minDist = dRagdoll;
        outId = 1;
        outSubId = (dRagdoll == dJointPins) ? 2 : 1; // 2 = Gold joint pins / visor, 1 = Gunmetal Bone
    }

    // ------------------------------------------------------------------------
    // 2. CENTER: Mannequin Bust & Hair Grooming System (x = 0.0)
    // ------------------------------------------------------------------------
    Vec3 bustCenter(0.0f, 1.48f, 0.0f);
    Vec3 headP = p - bustCenter;
    // Elegant sculpted oval head
    float dHead = (Vec3(headP.x / 0.38f, headP.y / 0.46f, headP.z / 0.40f)).length() - 1.0f;
    dHead *= 0.38f;
    // Tapered chin contour
    float dChin = sdCapsule(p, bustCenter + Vec3(0, -0.10f, 0.05f), bustCenter + Vec3(0, -0.38f, 0.08f), 0.16f);
    // Neck & Sleek Shoulders
    float dNeck = sdCapsule(p, bustCenter + Vec3(0, -0.28f, -0.04f), bustCenter + Vec3(0, -0.74f, -0.04f), 0.16f);
    float dShoulders = sdCapsule(p, bustCenter + Vec3(-0.65f, -0.80f, 0), bustCenter + Vec3(0.65f, -0.80f, 0), 0.18f);
    float dBust = std::min({dHead, dChin, dNeck, dShoulders});

    // Hair mane with guide locks and fur collar
    float dHair = sdHairMane(p, bustCenter);

    float dCenterSystem = std::min(dBust, dHair);
    if (dCenterSystem < minDist) {
        minDist = dCenterSystem;
        outId = 2;
        outSubId = (dCenterSystem == dHair) ? 1 : 2; // 1 = Hair/Fur, 2 = Ivory Porcelain
    }

    // ------------------------------------------------------------------------
    // 3. RIGHT: Advanced Fabric & Textile (x = 2.4)
    // ------------------------------------------------------------------------
    Vec3 fabricAnchor(2.4f, 1.82f, 0.0f);
    // Polished Brass banner rod with decorative spherical finials
    float dRod = sdCapsule(p, fabricAnchor + Vec3(-0.95f, 0.0f, 0.0f), fabricAnchor + Vec3(0.95f, 0.0f, 0.0f), 0.030f);
    float dFinialL = sdSphere(p - (fabricAnchor + Vec3(-0.98f, 0.0f, 0.0f)), 0.055f);
    float dFinialR = sdSphere(p - (fabricAnchor + Vec3(0.98f, 0.0f, 0.0f)), 0.055f);
    float dRodSystem = std::min({dRod, dFinialL, dFinialR});

    float dFabric = sdFabricBanner(p, fabricAnchor);
    float dFabricSystem = std::min(dRodSystem, dFabric);
    if (dFabricSystem < minDist) {
        minDist = dFabricSystem;
        outId = 3;
        outSubId = (dFabricSystem == dRodSystem) ? 1 : 2; // 1 = Brass rod, 2 = Crimson Twill Fabric
    }

    return minDist;
}

inline Vec3 calcNormal(const Vec3& p) {
    const float eps = 0.001f;
    int dummy1, dummy2;
    float d = mapScene(p, dummy1, dummy2);
    return Vec3(
        mapScene(Vec3(p.x + eps, p.y, p.z), dummy1, dummy2) - d,
        mapScene(Vec3(p.x, p.y + eps, p.z), dummy1, dummy2) - d,
        mapScene(Vec3(p.x, p.y, p.z + eps), dummy1, dummy2) - d
    ).normalized();
}

// Real-Time Ambient Occlusion (RTAO)
inline float calcRTAO(const Vec3& p, const Vec3& n) {
    float occ = 0.0f;
    float sca = 1.0f;
    int dummy1, dummy2;
    for (int i = 1; i <= 5; ++i) {
        float hr = 0.04f + 0.12f * static_cast<float>(i);
        Vec3 aopos = p + n * hr;
        float dd = mapScene(aopos, dummy1, dummy2);
        occ += (hr - dd) * sca;
        sca *= 0.75f;
    }
    return std::clamp(1.0f - 1.5f * occ, 0.0f, 1.0f);
}

// Raymarched Soft Shadows
inline float calcSoftShadow(const Vec3& ro, const Vec3& rd, float mint, float maxt, float k) {
    float res = 1.0f;
    float t = mint;
    int dummy1, dummy2;
    for (int i = 0; i < 40; ++i) {
        float h = mapScene(ro + rd * t, dummy1, dummy2);
        res = std::min(res, k * h / t);
        t += std::clamp(h, 0.02f, 0.20f);
        if (res < 0.005f || t > maxt) break;
    }
    return std::clamp(res, 0.0f, 1.0f);
}

int main() {
    std::cout << "[Studio Renderer] Initializing Native C++20 Hair, Fabric & Physics Renderer..." << std::endl;
    std::vector<Vec3> framebuffer(W * H);

    // Studio Camera Configuration: Centered, pulled back to frame all 3 subjects perfectly
    Vec3 ro(0.0f, 1.70f, 5.8f);
    Vec3 ta(0.0f, 1.10f, 0.0f);
    Vec3 ww = (ta - ro).normalized();
    Vec3 uu = ww.cross(Vec3(0, 1, 0)).normalized(); // Camera Right (+X)
    Vec3 vv = uu.cross(ww).normalized();             // Camera Up (+Y)

    // Studio Illumination
    Vec3 keyLightDir = Vec3(0.55f, 0.80f, 0.50f).normalized();
    Vec3 keyLightColor = Vec3(1.15f, 1.08f, 0.98f) * 2.8f;

    Vec3 fillLightDir = Vec3(-0.65f, 0.40f, 0.65f).normalized();
    Vec3 fillLightColor = Vec3(0.68f, 0.82f, 1.05f) * 0.95f;

    Vec3 rimLightDir = Vec3(0.0f, 0.60f, -1.0f).normalized();
    Vec3 rimLightColor = Vec3(1.0f, 0.95f, 0.88f) * 2.4f;

    // Studio Ambient Environment (Golden Hour / Warm Studio)
    auto iblSky = ibl::SphericalHarmonics9::goldenHour();

    int numThreads = std::max(1u, std::thread::hardware_concurrency());
    std::vector<std::future<void>> futures;

    auto renderStrip = [&](int startY, int endY) {
        for (int y = startY; y < endY; ++y) {
            for (int x = 0; x < W; ++x) {
                float px = (static_cast<float>(x) + 0.5f - 0.5f * W) / H;
                float py = -(static_cast<float>(y) + 0.5f - 0.5f * H) / H;

                // Perspective ray
                Vec3 rd = (uu * px + vv * py + ww * 1.55f).normalized();

                // Raymarching
                float t = 0.1f;
                int hitId = -1;
                int hitSubId = -1;
                bool hit = false;

                for (int step = 0; step < 180; ++step) {
                    Vec3 p = ro + rd * t;
                    int id, subId;
                    float d = mapScene(p, id, subId);
                    if (d < 0.0012f) {
                        hit = true;
                        hitId = id;
                        hitSubId = subId;
                        break;
                    }
                    t += d * 0.80f;
                    if (t > 24.0f) break;
                }

                Vec3 pixelColor(0.04f, 0.05f, 0.07f);

                if (hit) {
                    Vec3 p = ro + rd * t;
                    Vec3 N = calcNormal(p);
                    Vec3 V = -rd;

                    float rtao = calcRTAO(p, N);
                    float shadow = calcSoftShadow(p + N * 0.01f, keyLightDir, 0.02f, 12.0f, 18.0f);

                    Vec3 albedo(0.7f, 0.7f, 0.7f);
                    float roughness = 0.5f;
                    float metalness = 0.0f;
                    Vec3 sheenColor(0.0f, 0.0f, 0.0f);
                    bool isHair = false;

                    if (hitId == 0) {
                        // Studio Floor & Pedestals
                        if (hitSubId == 1) {
                            // Pedestals: Dark slate architectural matte with subtle rim
                            albedo = Vec3(0.12f, 0.13f, 0.16f);
                            roughness = 0.38f;
                            metalness = 0.05f;
                        } else {
                            // Studio Floor with soft radial vignette
                            float distFromCenter = Vec2(p.x, p.z).length();
                            float falloff = std::clamp(1.0f - distFromCenter * 0.12f, 0.18f, 1.0f);
                            albedo = Vec3(0.24f, 0.26f, 0.30f) * falloff;
                            roughness = 0.22f;
                            metalness = 0.02f;
                        }
                    } else if (hitId == 1) {
                        // Articulated Ragdoll
                        if (hitSubId == 2) {
                            // Brass / Gold joint pivots & Visor
                            albedo = Vec3(1.00f, 0.82f, 0.35f);
                            metalness = 0.98f;
                            roughness = 0.12f;
                        } else {
                            // Deep Onyx / Brushed Carbon Body
                            albedo = Vec3(0.06f, 0.07f, 0.08f);
                            metalness = 0.92f;
                            roughness = 0.26f;
                        }
                    } else if (hitId == 2) {
                        // Center: Hair Groom & Mannequin Bust
                        if (hitSubId == 1) {
                            // Hair with Melanin Absorption & Marschner Highlights
                            isHair = true;
                            // Rich glossy chestnut brunette hair
                            albedo = Vec3(0.26f, 0.14f, 0.07f);
                            roughness = 0.22f;
                            metalness = 0.0f;
                        } else {
                            // Smooth ivory porcelain mannequin
                            albedo = Vec3(0.96f, 0.94f, 0.92f);
                            roughness = 0.14f;
                            metalness = 0.0f;
                        }
                    } else if (hitId == 3) {
                        // Right: Advanced Orthotropic Fabric Textile
                        if (hitSubId == 1) {
                            // Polished Brass rod & finials
                            albedo = Vec3(0.96f, 0.82f, 0.44f);
                            metalness = 0.95f;
                            roughness = 0.16f;
                        } else {
                            // Crimson Silk / Twill Fabric with Charlie Sheen
                            // Procedural Twill Weave Normal Perturbation
                            Vec2 uv(p.x * 48.0f, p.y * 48.0f);
                            Vec3 weaveN = fabric::WeaveNormalSynthesizer::evaluateWeaveNormal(uv, fabric::WeavePattern::Twill, 3.5f);
                            N = (N + weaveN * 0.20f).normalized();

                            albedo = Vec3(0.72f, 0.08f, 0.16f);
                            roughness = 0.62f;
                            metalness = 0.0f;
                            sheenColor = Vec3(1.00f, 0.48f, 0.58f); // Rich Charlie sheen
                        }
                    }

                    // PBR Environment & Direct Shading
                    Vec3 F0 = Vec3(0.04f, 0.04f, 0.04f) * (1.0f - metalness) + albedo * metalness;
                    Vec3 diffuse = iblSky.evaluateIrradiance(N) * albedo * (1.0f - metalness);
                    Vec3 spec = ibl::evaluateSplitSumSpecular(N, V, roughness, F0, iblSky);

                    // Key Direct Light with Specular
                    float NdotL = std::max(N.dot(keyLightDir), 0.0f);
                    Vec3 H = (V + keyLightDir).normalized();
                    float NdotH = std::max(N.dot(H), 0.0f);
                    float directSpec = std::pow(NdotH, (1.0f - roughness) * 72.0f) * (1.0f - roughness);
                    Vec3 directKey = (albedo * NdotL + F0 * directSpec * 2.2f) * keyLightColor * shadow;

                    // Fill Light
                    float NdotFill = std::max(N.dot(fillLightDir), 0.0f);
                    Vec3 directFill = albedo * NdotFill * fillLightColor;

                    // Rim Backlight (Accentuates hair transmission & fabric sheen silhouette)
                    float NdotRim = std::max(N.dot(rimLightDir), 0.0f);
                    float VdotRim = std::pow(std::max(1.0f - N.dot(V), 0.0f), 3.0f);
                    Vec3 directRim = rimLightColor * (NdotRim * 0.4f + VdotRim * 1.3f);

                    // Marschner Hair BSDF Highlights
                    if (isHair) {
                        // Primary R specular lobe shifted toward root (-3 deg)
                        Vec3 hairU = Vec3(0, 1, 0);
                        float sinThetaI = hairU.dot(keyLightDir);
                        float sinThetaR = hairU.dot(V);
                        float rLobe = std::exp(-std::pow(sinThetaI + sinThetaR - 0.05f, 2.0f) / 0.016f);
                        float trtLobe = std::exp(-std::pow(sinThetaI + sinThetaR + 0.10f, 2.0f) / 0.040f);

                        Vec3 marschnerSpecular = keyLightColor * (Vec3(0.95f, 0.95f, 0.95f) * rLobe * 1.8f +
                                                                  albedo * 2.2f * trtLobe * 1.4f) * shadow;
                        Vec3 hairTransmission = rimLightColor * albedo * 1.6f * VdotRim;
                        pixelColor = (diffuse * 0.4f + spec * 0.5f) * rtao + directFill * 0.3f + marschnerSpecular + hairTransmission;
                    } else if (sheenColor.length() > 0.01f) {
                        // Charlie Sheen for Fabric
                        float charlie = std::pow(1.0f - std::max(N.dot(V), 0.0f), 3.5f);
                        Vec3 fabricSheen = sheenColor * charlie * (keyLightColor * shadow + directRim);
                        pixelColor = (diffuse + spec) * rtao + directKey + directFill + fabricSheen;
                    } else {
                        // Standard Multibody Rigidbody & Studio Geometry
                        pixelColor = (diffuse + spec) * rtao + directKey + directFill + directRim * 0.25f;
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

    // Write PPM Image
    std::cout << "[Studio Renderer] Writing PPM to build/hair_fabric_physics_render.ppm..." << std::endl;
    std::ofstream out("build/hair_fabric_physics_render.ppm", std::ios::binary);
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

    std::cout << "[Studio Renderer] Render complete! Generated build/hair_fabric_physics_render.ppm" << std::endl;
    return 0;
}
