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
using namespace scratchbox::triplanar;
using namespace scratchbox::sss;
using namespace scratchbox::volumetrics;
using namespace scratchbox::nature;

constexpr int W = 1280;
constexpr int H = 720;

// Material IDs
enum MaterialID {
    MAT_SKY = 0,
    MAT_TERRAIN = 1,
    MAT_MONOLITH = 2,
    MAT_TREE_TRUNK = 3,
    MAT_FOLIAGE = 4
};

struct HitResult {
    float dist;
    int mat;
};

// Fast SDF Primitives
inline float sdBox(const Vec3& p, const Vec3& b) {
    Vec3 q = Vec3(std::abs(p.x) - b.x, std::abs(p.y) - b.y, std::abs(p.z) - b.z);
    Vec3 outDist(std::max(q.x, 0.0f), std::max(q.y, 0.0f), std::max(q.z, 0.0f));
    return outDist.length() + std::min(std::max(q.x, std::max(q.y, q.z)), 0.0f);
}

inline float sdCylinder(const Vec3& p, float h, float r) {
    float dX = std::sqrt(p.x * p.x + p.z * p.z) - r;
    float dY = std::abs(p.y) - h;
    Vec3 outDist(std::max(dX, 0.0f), std::max(dY, 0.0f), 0.0f);
    return std::min(std::max(dX, dY), 0.0f) + outDist.length();
}

inline float sdSphere(const Vec3& p, float r) {
    return p.length() - r;
}

inline float getTerrainElevation(float x, float z) {
    float macro = std::sin(x * 0.14f) * std::cos(z * 0.14f) * 1.6f;
    float ridge = (FastNoise3D::perlin(x * 0.22f, 0.0f, z * 0.22f, 101) - 0.5f) * 1.8f;
    float micro = (FastNoise3D::perlin(x * 0.6f, 0.0f, z * 0.6f, 202) - 0.5f) * 0.35f;
    return macro + ridge + micro - 0.5f;
}

// Hierarchical Foliage Clump Helpers (RileyB3D / Blender Data Transfer technique)
const std::vector<scratchbox::nature::FoliageClumpHelper> g_FoliageHelpers = {
    // Left Foreground Oak Canopy Clumps (6 distinct branch lobes)
    { Vec3(-2.2f + 0.15f, 0.1f + 2.30f, 0.2f + 0.15f), 0.95f, Vec3(1.1f, 0.9f, 1.1f), 1 },
    { Vec3(-2.2f - 0.60f, 0.1f + 2.05f, 0.2f - 0.25f), 0.82f, Vec3(1.0f, 0.85f, 1.0f), 2 },
    { Vec3(-2.2f + 0.70f, 0.1f + 1.95f, 0.2f + 0.35f), 0.80f, Vec3(1.0f, 0.85f, 1.0f), 3 },
    { Vec3(-2.2f + 0.18f, 0.1f + 2.85f, 0.2f - 0.25f), 0.75f, Vec3(0.95f, 0.95f, 0.95f), 4 },
    { Vec3(-2.2f - 0.30f, 0.1f + 2.50f, 0.2f + 0.45f), 0.72f, Vec3(0.95f, 0.90f, 0.95f), 5 },
    { Vec3(-2.2f + 0.30f, 0.1f + 1.60f, 0.2f + 0.60f), 0.68f, Vec3(0.90f, 0.80f, 0.90f), 6 },
    // Right Midground Pine Tiered Cones
    { Vec3(3.2f, 0.4f + 1.3f, -1.8f), 1.15f, Vec3(1.1f, 0.8f, 1.1f), 7 },
    { Vec3(3.2f, 0.4f + 2.0f, -1.8f), 0.95f, Vec3(0.95f, 0.75f, 0.95f), 8 },
    { Vec3(3.2f, 0.4f + 2.6f, -1.8f), 0.75f, Vec3(0.85f, 0.70f, 0.85f), 9 },
    { Vec3(3.2f, 0.4f + 3.1f, -1.8f), 0.50f, Vec3(0.70f, 0.65f, 0.70f), 10 }
};

inline const scratchbox::nature::FoliageClumpHelper& getNearestFoliageHelper(const Vec3& p) {
    float minDistSq = 1e9f;
    size_t bestIdx = 0;
    for (size_t i = 0; i < g_FoliageHelpers.size(); ++i) {
        float d2 = (p - g_FoliageHelpers[i].center).lengthSquared();
        if (d2 < minDistSq) {
            minDistSq = d2;
            bestIdx = i;
        }
    }
    return g_FoliageHelpers[bestIdx];
}

inline HitResult mapScene(const Vec3& p) {
    // 1. Stratified Biome Terrain Heightfield
    float th = getTerrainElevation(p.x, p.z);
    float dTerrain = p.y - th;
    float minDist = dTerrain;
    int mat = MAT_TERRAIN;

    // 2. Ancient Hero Monolith on Central Ridge (Deeply rooted in bedrock)
    Vec3 pMono = p - Vec3(0.5f, 0.8f, -1.2f);
    float cosRot = std::cos(0.18f), sinRot = std::sin(0.18f);
    Vec3 rotMono(pMono.x * cosRot - pMono.z * sinRot, pMono.y, pMono.x * sinRot + pMono.z * cosRot);

    // Tapering monolith with chamfered edges and runic carved grooves
    float taper = 1.0f + (rotMono.y - 0.5f) * 0.06f;
    float dMonoBox = sdBox(rotMono, Vec3(0.48f / taper, 3.2f, 0.48f / taper)) - 0.06f;

    // Runic groove channel down front face
    if (std::abs(rotMono.z - 0.44f) < 0.14f && std::abs(rotMono.x) < 0.22f) {
        float runePattern = std::sin(rotMono.y * 14.0f) * std::cos(rotMono.x * 20.0f);
        if (runePattern > 0.30f) dMonoBox += 0.035f;
    }

    // Weathered broken peak
    float brokenTop = rotMono.y - 2.4f - FastNoise3D::perlin(rotMono.x * 4.0f, 0, rotMono.z * 4.0f, 88) * 0.25f;
    float dMonoBody = std::max(dMonoBox, brokenTop);

    // Weathered rock base skirt anchoring the monolith into the terrain
    float dSkirt = sdBox(rotMono + Vec3(0, 0.9f, 0), Vec3(0.70f, 0.5f, 0.70f)) - 0.15f;
    float dMono = std::min(dMonoBody, dSkirt);

    if (dMono < minDist) {
        minDist = dMono;
        mat = MAT_MONOLITH;
    }

    // 3. Foreground Left Oak Tree (Gnarled Trunk + Da Vinci Branching)
    Vec3 pTree1 = p - Vec3(-2.2f, 0.1f, 0.2f);
    // Trunk with deep root flare extending into soil
    float rootFlare = std::max(0.0f, 0.7f - pTree1.y) * 0.16f;
    float dTrunk1 = sdCylinder(pTree1 + Vec3(0, 0.4f, 0), 2.2f, 0.18f + rootFlare);

    // Organic Branching reaching into canopy lobes
    Vec3 pB1 = pTree1 - Vec3(0.35f, 1.35f, 0.15f);
    float dB1 = sdCylinder(Vec3(pB1.x * 0.85f - pB1.y * 0.5f, pB1.x * 0.5f + pB1.y * 0.85f, pB1.z), 0.70f, 0.11f);

    Vec3 pB2 = pTree1 - Vec3(-0.35f, 1.55f, -0.15f);
    float dB2 = sdCylinder(Vec3(pB2.x * 0.88f + pB2.y * 0.45f, -pB2.x * 0.45f + pB2.y * 0.88f, pB2.z), 0.65f, 0.10f);

    Vec3 pB3 = pTree1 - Vec3(0.08f, 1.85f, -0.22f);
    float dB3 = sdCylinder(pB3, 0.60f, 0.09f);

    Vec3 pB4 = pTree1 - Vec3(-0.20f, 2.10f, 0.22f);
    float dB4 = sdCylinder(Vec3(pB4.x * 0.70f + pB4.y * 0.71f, -pB4.x * 0.71f + pB4.y * 0.70f, pB4.z), 0.50f, 0.08f);

    Vec3 pB5 = pTree1 - Vec3(0.20f, 1.45f, 0.35f);
    float dB5 = sdCylinder(Vec3(pB5.x, pB5.y * 0.85f - pB5.z * 0.52f, pB5.y * 0.52f + pB5.z * 0.85f), 0.45f, 0.08f);

    float dAllTrunk1 = std::min(dTrunk1, std::min(dB1, std::min(dB2, std::min(dB3, std::min(dB4, dB5)))));
    if (dAllTrunk1 < minDist) {
        minDist = dAllTrunk1;
        mat = MAT_TREE_TRUNK;
    }

    // Multi-Clump Oak Foliage with Detailed Leaf Silhouettes & Negative Space
    float dOakFoliage = 1e9f;
    float leafDetail = (FastNoise3D::perlin(p.x * 6.5f, p.y * 6.5f, p.z * 6.5f, 55) - 0.5f) * 0.14f
                     + (std::sin(p.x * 15.0f) * std::cos(p.y * 15.0f) * std::sin(p.z * 15.0f)) * 0.04f;

    for (int k = 0; k < 6; ++k) {
        const auto& h = g_FoliageHelpers[k];
        Vec3 diff = p - h.center;
        diff.x /= h.eccentricity.x;
        diff.y /= h.eccentricity.y;
        diff.z /= h.eccentricity.z;
        float dClumpSphere = diff.length() - h.radius;
        // Negative space carve-out so light penetrates and branches peek through
        float carve = std::max(0.0f, FastNoise3D::perlin(diff.x * 2.2f, diff.y * 2.2f, diff.z * 2.2f, 33 + k) - 0.26f) * 0.30f;
        float clumpDist = dClumpSphere + leafDetail + carve;
        dOakFoliage = std::min(dOakFoliage, clumpDist);
    }

    if (dOakFoliage < minDist) {
        minDist = dOakFoliage;
        mat = MAT_FOLIAGE;
    }

    // 4. Background Right Pine Tree (Ground-rooted)
    Vec3 pTree2 = p - Vec3(3.2f, 0.4f, -1.8f);
    float dTrunk2 = sdCylinder(pTree2 + Vec3(0, 0.6f, 0), 3.0f, 0.22f);
    if (dTrunk2 < minDist) {
        minDist = dTrunk2;
        mat = MAT_TREE_TRUNK;
    }

    // Multi-Clump Pine Foliage with Needle Clumping
    float dPineFoliage = 1e9f;
    float pineDetail = (FastNoise3D::perlin(p.x * 9.0f, p.y * 9.0f, p.z * 9.0f, 99) - 0.5f) * 0.10f;
    for (int k = 6; k < 10; ++k) {
        const auto& h = g_FoliageHelpers[k];
        Vec3 diff = p - h.center;
        diff.x /= h.eccentricity.x;
        diff.y /= h.eccentricity.y;
        diff.z /= h.eccentricity.z;
        float dCone = diff.length() - h.radius;
        dPineFoliage = std::min(dPineFoliage, dCone + pineDetail);
    }

    if (dPineFoliage < minDist) {
        minDist = dPineFoliage;
        mat = MAT_FOLIAGE;
    }

    return { minDist, mat };
}

inline Vec3 calcNormal(const Vec3& p) {
    constexpr float eps = 0.003f;
    float d = mapScene(p).dist;
    float nx = mapScene(p + Vec3(eps, 0, 0)).dist - d;
    float ny = mapScene(p + Vec3(0, eps, 0)).dist - d;
    float nz = mapScene(p + Vec3(0, 0, eps)).dist - d;
    return Vec3(nx, ny, nz).normalized();
}

inline float calcShadow(const Vec3& ro, const Vec3& rd, float mint, float maxt, float k = 16.0f, int maxSteps = 16) {
    float res = 1.0f;
    float t = mint;
    for (int i = 0; i < maxSteps && t < maxt; ++i) {
        float h = mapScene(ro + rd * t).dist;
        if (h < 0.001f) return 0.0f;
        res = std::min(res, k * h / t);
        t += std::clamp(h, 0.06f, 0.6f);
    }
    return std::clamp(res, 0.0f, 1.0f);
}

inline float calcAO(const Vec3& p, const Vec3& n) {
    float occ = 0.0f;
    float sca = 1.0f;
    for (int i = 1; i <= 5; ++i) {
        float hr = 0.06f * static_cast<float>(i);
        float dd = mapScene(p + n * hr).dist;
        occ += (hr - dd) * sca;
        sca *= 0.65f;
    }
    return std::clamp(1.0f - 2.5f * occ, 0.0f, 1.0f);
}

// ACES Filmic Tone Mapping Curve
inline Vec3 acesFilmic(const Vec3& v) {
    constexpr float a = 2.51f, b = 0.03f, c = 2.43f, d = 0.59f, e = 0.14f;
    auto mapChannel = [a, b, c, d, e](float x) {
        return std::clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0f, 1.0f);
    };
    return Vec3(mapChannel(v.x), mapChannel(v.y), mapChannel(v.z));
}

int main() {
    std::cout << "[Native C++20 Nature & Atmosphere Renderer] Initializing " << W << "x" << H << "..." << std::endl;

    const Vec3 camPos(-0.6f, 3.2f, 8.2f);
    const Vec3 camTarget(0.4f, 1.6f, -1.0f);
    const Vec3 camFwd = (camTarget - camPos).normalized();
    const Vec3 camRight = camFwd.cross(Vec3(0, 1, 0)).normalized();
    const Vec3 camUp = camRight.cross(camFwd);

    constexpr float fov = 44.0f * (3.14159265f / 180.0f);
    const float tanFov = std::tan(fov * 0.5f);
    const float aspect = static_cast<float>(W) / static_cast<float>(H);

    // Low Golden-Hour Sun
    const Vec3 sunDir = Vec3(0.72f, 0.38f, -0.65f).normalized();
    const Vec3 sunColor(3.8f, 2.6f, 1.3f);
    const Vec3 skyZenith(0.22f, 0.42f, 0.78f);
    const Vec3 skyHorizon(0.85f, 0.65f, 0.42f);

    // Spherical Harmonics Golden Hour Irradiance
    auto skySH = getSkyGoldenHourSH();

    // SSS Profile for Chlorophyll Leaves
    const SSSProfile& leafProfile = PROFILE_GREEN_LEAF;

    // Atmospheric Participating Media
    constexpr float fogDensity = 0.038f;
    constexpr float fogAnisotropy = 0.74f; // Forward Mie scattering
    constexpr float fogHeightScale = 3.2f;
    const Vec3 fogScatteringColor(0.95f, 0.78f, 0.52f);

    std::vector<Vec3> hdrBuffer(W * H);

    // Parallel multi-core rendering across scanlines
    const int numThreads = std::max(1u, std::thread::hardware_concurrency());
    std::vector<std::future<void>> futures;

    auto renderStrip = [&](int yStart, int yEnd) {
        for (int y = yStart; y < yEnd; ++y) {
            float v = (1.0f - 2.0f * ((static_cast<float>(y) + 0.5f) / static_cast<float>(H))) * tanFov;

            for (int x = 0; x < W; ++x) {
                float u = (2.0f * ((static_cast<float>(x) + 0.5f) / static_cast<float>(W)) - 1.0f) * aspect * tanFov;
                Vec3 rayDir = (camRight * u + camUp * v + camFwd).normalized();

                // Surface raymarch
                float t = 0.2f;
                bool hit = false;
                int hitMat = 0;
                Vec3 p = camPos;
                constexpr float maxDist = 32.0f;

                for (int step = 0; step < 72 && t < maxDist; ++step) {
                    p = camPos + rayDir * t;
                    HitResult res = mapScene(p);
                    if (res.dist < 0.002f) {
                        hit = true;
                        hitMat = res.mat;
                        break;
                    }
                    t += std::max(res.dist * 0.88f, 0.003f);
                }

                Vec3 surfaceRadiance(0, 0, 0);

                if (hit) {
                    Vec3 n = calcNormal(p);
                    Vec3 viewDir = rayDir * -1.0f;
                    float ao = calcAO(p, n);
                    float shadow = calcShadow(p + n * 0.02f, sunDir, 0.05f, 10.0f, 16.0f, 14);

                    Vec3 albedo(0.5f, 0.5f, 0.5f);
                    float roughness = 0.8f;
                    float metallic = 0.0f;
                    Vec3 sssContrib(0, 0, 0);

                    if (hitMat == MAT_TERRAIN) {
                        float cosSlope = std::clamp(n.y, 0.0f, 1.0f);
                        float slopeDeg = std::acos(cosSlope) * 57.2957f;
                        float rockFactor = std::clamp((slopeDeg - 28.0f) / 14.0f, 0.0f, 1.0f);

                        auto rockSample = sampleProceduralRock(p, n, 1.2f);
                        auto mossSample = sampleProceduralMoss(p, n, 1.5f);

                        albedo = Vec3(
                            std::lerp(mossSample.albedo.x, rockSample.albedo.x, rockFactor),
                            std::lerp(mossSample.albedo.y, rockSample.albedo.y, rockFactor),
                            std::lerp(mossSample.albedo.z, rockSample.albedo.z, rockFactor)
                        );
                        roughness = std::lerp(mossSample.roughness, rockSample.roughness, rockFactor);
                    } else if (hitMat == MAT_MONOLITH) {
                        Vec3 darkBasalt = Vec3(0.12f, 0.13f, 0.15f);
                        float strata = 0.5f + 0.5f * std::sin(p.y * 14.0f + FastNoise3D::perlin(p.x * 2.0f, p.y * 4.0f, p.z * 2.0f, 101) * 3.0f);
                        Vec3 rockAlbedo = Vec3(
                            std::lerp(darkBasalt.x, darkBasalt.x * 1.6f, strata),
                            std::lerp(darkBasalt.y, darkBasalt.y * 1.6f, strata),
                            std::lerp(darkBasalt.z, darkBasalt.z * 1.6f, strata)
                        );

                        auto moss = sampleProceduralMoss(p * 2.5f, n, 1.2f);
                        float mossMask = std::clamp((n.y * 0.7f + FastNoise3D::perlin(p.x * 2.5f, p.y * 2.5f, p.z * 2.5f, 44) * 0.6f - 0.2f) * 2.5f, 0.0f, 1.0f);

                        albedo = Vec3(
                            std::lerp(rockAlbedo.x, moss.albedo.x, mossMask),
                            std::lerp(rockAlbedo.y, moss.albedo.y, mossMask),
                            std::lerp(rockAlbedo.z, moss.albedo.z, mossMask)
                        );
                        roughness = std::lerp(0.88f, moss.roughness, mossMask);
                        metallic = 0.02f;
                    } else if (hitMat == MAT_TREE_TRUNK) {
                        auto wood = sampleProceduralWood(p, n, 1.0f);
                        albedo = wood.albedo;
                        roughness = wood.roughness;
                    } else if (hitMat == MAT_FOLIAGE) {
                        const auto& helper = getNearestFoliageHelper(p);

                        // Normal Transfer (The RileyB3D / Blender Data Transfer technique):
                        // Project smooth envelope normal from clump helper rather than using harsh micro-geometry normal
                        Vec3 nEnvelope = (p - helper.center).normalized();
                        nEnvelope = (nEnvelope + Vec3(0, 0.22f, 0)).normalized(); // Upward ambient bias

                        // Blend: 85% smooth envelope normal, 15% geometric leaf detail normal
                        n = (n * 0.15f + nEnvelope * 0.85f).normalized();

                        // Clump Depth & Ambient Occlusion Gradient
                        float distFromCenter = (p - helper.center).length();
                        float clumpFrac = std::clamp(distFromCenter / std::max(0.1f, helper.radius), 0.25f, 1.0f);

                        // Organic Color Gradient: inner leaves are deep emerald/forest green,
                        // outer leaves catch sunlight with vibrant yellow-green tips
                        Vec3 innerLeafCol(0.12f, 0.30f, 0.08f);
                        Vec3 outerLeafCol(0.32f, 0.68f, 0.16f);
                        float leafVar = FastNoise3D::perlin(p.x * 8.0f, p.y * 8.0f, p.z * 8.0f, 82);
                        albedo = Vec3(
                            std::lerp(innerLeafCol.x, outerLeafCol.x, clumpFrac * (0.8f + 0.4f * leafVar)),
                            std::lerp(innerLeafCol.y, outerLeafCol.y, clumpFrac * (0.8f + 0.4f * leafVar)),
                            std::lerp(innerLeafCol.z, outerLeafCol.z, clumpFrac * (0.8f + 0.4f * leafVar))
                        );
                        roughness = 0.58f;
                        metallic = 0.0f;

                        // Deep canopy self-shadowing
                        ao *= std::clamp(clumpFrac * 1.25f, 0.30f, 1.0f);

                        // Thin-Wall Dual-Sided Subsurface Scattering & Forward Transmission
                        // (Principled BSDF Thin Wall = 1.0 with saturated chlorophyl glow)
                        sssContrib = evaluateThinWallTransmission(
                            sunDir,
                            viewDir,
                            n,
                            sunColor,
                            leafProfile,
                            0.38f, // Wrap factor
                            1.0f   // Transmission weight
                        );
                    }

                    // Direct Lighting
                    float nDotL = std::max(0.0f, n.dot(sunDir));
                    Vec3 h = (sunDir + viewDir).normalized();
                    float nDotH = std::max(0.0f, n.dot(h));
                    float specPower = (2.0f / (roughness * roughness + 1e-4f)) - 2.0f;
                    float spec = std::pow(nDotH, std::clamp(specPower, 1.0f, 128.0f)) * (1.0f - roughness);

                    Vec3 directDiffuse(
                        (albedo.x * sunColor.x * nDotL * shadow) / 3.14159f,
                        (albedo.y * sunColor.y * nDotL * shadow) / 3.14159f,
                        (albedo.z * sunColor.z * nDotL * shadow) / 3.14159f
                    );
                    Vec3 directSpec = sunColor * (spec * shadow * (metallic * 0.8f + 0.04f));

                    // Spherical Harmonics Ambient Irradiance
                    Vec3 ambientIrradiance = skySH.evaluateIrradiance(n);
                    Vec3 ambientDiffuse(
                        albedo.x * ambientIrradiance.x * 0.35f * ao,
                        albedo.y * ambientIrradiance.y * 0.35f * ao,
                        albedo.z * ambientIrradiance.z * 0.35f * ao
                    );

                    if (hitMat == MAT_FOLIAGE) {
                        surfaceRadiance = directDiffuse * 0.45f + ambientDiffuse + sssContrib * (shadow * 0.65f + 0.35f);
                    } else {
                        surfaceRadiance = directDiffuse + directSpec + ambientDiffuse + sssContrib * shadow;
                    }
                } else {
                    // Sky & Sun Glow
                    float skyGrad = std::clamp(rayDir.y * 0.5f + 0.5f, 0.0f, 1.0f);
                    Vec3 skyCol(
                        std::lerp(skyHorizon.x, skyZenith.x, skyGrad),
                        std::lerp(skyHorizon.y, skyZenith.y, skyGrad),
                        std::lerp(skyHorizon.z, skyZenith.z, skyGrad)
                    );

                    float sunDot = std::max(0.0f, rayDir.dot(sunDir));
                    float sunDisc = std::pow(sunDot, 1200.0f) * 8.0f;
                    float sunGlow = std::pow(sunDot, 16.0f) * 1.5f;
                    skyCol = skyCol + sunColor * (sunDisc + sunGlow);

                    surfaceRadiance = skyCol;
                    t = maxDist;
                }

                // Volumetric Participating Media & God Rays
                constexpr int volSteps = 12;
                float volStepSize = t / static_cast<float>(volSteps);
                float transmittance = 1.0f;
                Vec3 inscattering(0, 0, 0);

                float cosSun = rayDir.dot(sunDir);
                float phaseMie = henyeyGreensteinPhase(cosSun, fogAnisotropy);

                for (int s = 0; s < volSteps; ++s) {
                    float stepDist = (static_cast<float>(s) + 0.5f) * volStepSize;
                    Vec3 pVol = camPos + rayDir * stepDist;

                    float heightAtten = std::exp(-std::max(pVol.y, 0.0f) / fogHeightScale);
                    float density = fogDensity * heightAtten;

                    if (density > 1e-5f) {
                        float shadowVal = calcShadow(pVol, sunDir, 0.12f, 7.0f, 10.0f, 5);
                        float stepOpticalDepth = density * volStepSize;
                        float stepTransmittance = std::exp(-stepOpticalDepth);

                        Vec3 sunLight = sunColor * (shadowVal * phaseMie * 4.2f);
                        Vec3 ambientLight = skyHorizon * 0.25f;
                        Vec3 totalLight = sunLight + ambientLight;

                        Vec3 stepInscatter(
                            totalLight.x * fogScatteringColor.x * (1.0f - stepTransmittance) * transmittance,
                            totalLight.y * fogScatteringColor.y * (1.0f - stepTransmittance) * transmittance,
                            totalLight.z * fogScatteringColor.z * (1.0f - stepTransmittance) * transmittance
                        );
                        inscattering = inscattering + stepInscatter;
                        transmittance *= stepTransmittance;

                        if (transmittance < 0.02f) break;
                    }
                }

                Vec3 finalPixel = surfaceRadiance * transmittance + inscattering;
                hdrBuffer[y * W + x] = finalPixel;
            }
        }
    };

    // Dispatch parallel threads
    int rowsPerThread = H / numThreads;
    for (int t = 0; t < numThreads; ++t) {
        int yStart = t * rowsPerThread;
        int yEnd = (t == numThreads - 1) ? H : (t + 1) * rowsPerThread;
        futures.push_back(std::async(std::launch::async, renderStrip, yStart, yEnd));
    }
    for (auto& f : futures) f.wait();

    std::cout << "[Native C++20 Render Complete] Post-processing ACES Filmic Tone Mapping..." << std::endl;

    // Post processing & output PPM
    std::ofstream ppmFile("build/nature_render.ppm", std::ios::binary);
    ppmFile << "P6\n" << W << " " << H << "\n255\n";

    std::vector<uint8_t> rgbBytes(W * H * 3);
    for (int y = 0; y < H; ++y) {
        for (int x = 0; x < W; ++x) {
            int i = y * W + x;
            Vec3 hdr = hdrBuffer[i];

            // Exposure & Tone Mapping
            Vec3 exposed = hdr * 1.18f;
            Vec3 mapped = acesFilmic(exposed);

            // Subtle Cinematic Vignette
            float uvX = (static_cast<float>(x) / static_cast<float>(W)) - 0.5f;
            float uvY = (static_cast<float>(y) / static_cast<float>(H)) - 0.5f;
            float vignette = std::clamp(1.0f - (uvX * uvX + uvY * uvY) * 0.65f, 0.7f, 1.0f);

            uint8_t r = static_cast<uint8_t>(std::clamp(std::pow(mapped.x * vignette, 1.0f / 2.2f) * 255.0f, 0.0f, 255.0f));
            uint8_t g = static_cast<uint8_t>(std::clamp(std::pow(mapped.y * vignette, 1.0f / 2.2f) * 255.0f, 0.0f, 255.0f));
            uint8_t b = static_cast<uint8_t>(std::clamp(std::pow(mapped.z * vignette, 1.0f / 2.2f) * 255.0f, 0.0f, 255.0f));

            int byteIdx = i * 3;
            rgbBytes[byteIdx + 0] = r;
            rgbBytes[byteIdx + 1] = g;
            rgbBytes[byteIdx + 2] = b;
        }
    }

    ppmFile.write(reinterpret_cast<const char*>(rgbBytes.data()), rgbBytes.size());
    ppmFile.close();

    std::cout << "✅ Saved PPM: build/nature_render.ppm (" << (rgbBytes.size() / 1024) << " KB)" << std::endl;
    return 0;
}
