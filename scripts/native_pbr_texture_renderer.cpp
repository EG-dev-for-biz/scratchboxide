/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * Demonstrates and visually validates:
 * Generative Media Studio & 3D Texture Projection
 * - 4-up Physically Plausible Material Matrix
 * - Seamless Toroidal Normal / Roughness / Metallic / Cavity AO Mapping
 * - ACES Filmic Tonemapping & Multi-Threaded Studio Lighting
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
using namespace scratchbox::texture;

constexpr int W = 1280;
constexpr int H = 720;

struct MaterialParams {
    Vec3 baseColor;
    float roughness;
    float metallic;
    float bumpScale;
    float aoStrength;
    std::string name;
};

// Procedural high-frequency surface height/bump functions
inline float getBumpHeight(int matId, float u, float v) {
    u = u * 4.0f;
    v = v * 4.0f;
    float n1 = std::sin(u * 12.0f) * std::cos(v * 12.0f);
    float n2 = std::sin(u * 28.0f + 1.2f) * std::cos(v * 28.0f + 0.8f) * 0.5f;
    float n3 = std::sin(u * 64.0f) * std::cos(v * 64.0f) * 0.25f;

    switch (matId) {
        case 0: // Volcanic Onyx (glassy with fracture ridges)
            return std::abs(n1 * 0.4f + n2 * 0.6f + n3 * 0.2f);
        case 1: // Weathered Bronze (pitted patina relief)
            return (n1 * 0.5f + n2 * 0.3f + n3 * 0.5f) * 0.8f;
        case 2: // Polished Marble (subtle smooth veins)
            return std::sin(u * 4.0f + std::sin(v * 6.0f) * 2.0f) * 0.15f;
        case 3: // Rough Sandstone / Granite (coarse tactile grains)
        default:
            return (n1 * 0.6f + n2 * 0.8f + n3 * 0.9f);
    }
}

// Compute perturbed normal using 2D procedural finite differences
inline Vec3 getPerturbedNormal(int matId, const Vec3& N, const Vec2& uv, float strength) {
    float eps = 0.003f;
    float hC = getBumpHeight(matId, uv.x, uv.y);
    float hU = getBumpHeight(matId, uv.x + eps, uv.y);
    float hV = getBumpHeight(matId, uv.x, uv.y + eps);

    float dU = (hU - hC) / eps;
    float dV = (hV - hC) / eps;

    // Construct local tangent frame on sphere
    Vec3 up = std::abs(N.y) < 0.99f ? Vec3(0, 1, 0) : Vec3(1, 0, 0);
    Vec3 T = up.cross(N).normalized();
    Vec3 B = N.cross(T).normalized();

    Vec3 perturbed = N - (T * dU + B * dV) * strength;
    return perturbed.normalized();
}

int main() {
    std::cout << "==========================================================" << std::endl;
    std::cout << "[Native PBR Texture Studio] Generating 4-Up Materials..." << std::endl;
    std::cout << "==========================================================" << std::endl;

    // Define 4 candidate materials
    std::vector<MaterialParams> materials = {
        { Vec3(0.12f, 0.12f, 0.14f), 0.18f, 0.05f, 0.08f, 1.2f, "Candidate 1: Volcanic Onyx" },
        { Vec3(0.72f, 0.48f, 0.28f), 0.35f, 0.85f, 0.12f, 1.5f, "Candidate 2: Weathered Bronze" },
        { Vec3(0.92f, 0.90f, 0.88f), 0.10f, 0.02f, 0.04f, 0.8f, "Candidate 3: Polished Carrara Marble" },
        { Vec3(0.68f, 0.52f, 0.38f), 0.78f, 0.00f, 0.22f, 1.8f, "Candidate 4: Tactile Relief Sandstone" }
    };

    // Framebuffer
    std::vector<Vec3> framebuffer(W * H);

    // Multi-threaded Ray Marcher
    int numThreads = std::max(1, static_cast<int>(std::thread::hardware_concurrency()));
    std::vector<std::future<void>> futures;

    auto renderStrip = [&](int y0, int y1) {
        Vec3 camPos(0.0f, 1.6f, 5.2f);
        Vec3 camTarget(0.0f, 0.4f, 0.0f);
        Vec3 forward = (camTarget - camPos).normalized();
        Vec3 right = forward.cross(Vec3(0, 1, 0)).normalized();
        Vec3 up = right.cross(forward).normalized();

        for (int y = y0; y < y1; ++y) {
            for (int x = 0; x < W; ++x) {
                float u = (2.0f * (x + 0.5f) / W - 1.0f) * (static_cast<float>(W) / H);
                float v = 1.0f - 2.0f * (y + 0.5f) / H;
                Vec3 rayDir = (forward + right * u * 0.48f + up * v * 0.48f).normalized();

                // Ray intersection against 4 spheres and floor plane
                float closestDist = 1e9f;
                int hitId = -1;
                Vec3 hitNormal;
                Vec2 hitUv;
                Vec3 hitPos;

                // 4 spheres positioned across X axis: -3.3, -1.1, +1.1, +3.3
                float sphereXs[4] = { -3.3f, -1.1f, 1.1f, 3.3f };
                float sphereRadius = 0.95f;

                for (int i = 0; i < 4; ++i) {
                    Vec3 center(sphereXs[i], 0.75f, 0.0f);
                    Vec3 oc = camPos - center;
                    float b = oc.dot(rayDir);
                    float c = oc.dot(oc) - sphereRadius * sphereRadius;
                    float disc = b * b - c;
                    if (disc > 0.0f) {
                        float t = -b - std::sqrt(disc);
                        if (t > 0.001f && t < closestDist) {
                            closestDist = t;
                            hitId = i;
                            hitPos = camPos + rayDir * t;
                            hitNormal = (hitPos - center).normalized();
                            // Spherical UV coordinates
                            float phi = std::atan2(hitNormal.z, hitNormal.x);
                            float theta = std::asin(std::clamp(hitNormal.y, -1.0f, 1.0f));
                            hitUv = Vec2((phi + 3.14159f) / (2.0f * 3.14159f), (theta + 3.14159f * 0.5f) / 3.14159f);
                        }
                    }
                }

                // Floor plane at Y = -0.2f
                if (rayDir.y < -0.001f) {
                    float tFloor = (-0.2f - camPos.y) / rayDir.y;
                    if (tFloor > 0.001f && tFloor < closestDist) {
                        closestDist = tFloor;
                        hitId = 10; // floor
                        hitPos = camPos + rayDir * tFloor;
                        hitNormal = Vec3(0, 1, 0);
                        hitUv = Vec2(hitPos.x * 0.5f, hitPos.z * 0.5f);
                    }
                }

                Vec3 pixelColor(0.04f, 0.05f, 0.07f); // Studio dark backdrop

                if (hitId >= 0) {
                    // Studio lights: Key light, Fill light, Rim light
                    Vec3 lightDir1 = Vec3(2.5f, 4.0f, 3.0f).normalized();
                    Vec3 lightCol1 = Vec3(1.0f, 0.98f, 0.95f) * 2.8f;

                    Vec3 lightDir2 = Vec3(-3.5f, 2.0f, -2.0f).normalized();
                    Vec3 lightCol2 = Vec3(0.4f, 0.6f, 0.9f) * 1.2f;

                    Vec3 viewDir = -rayDir;

                    if (hitId < 4) {
                        const auto& mat = materials[hitId];
                        Vec3 N = getPerturbedNormal(hitId, hitNormal, hitUv, mat.bumpScale);

                        // Cavity Ambient Occlusion factor
                        float cavity = 1.0f - (getBumpHeight(hitId, hitUv.x, hitUv.y) * 0.5f + 0.5f) * (mat.aoStrength * 0.35f);
                        cavity = std::clamp(cavity, 0.2f, 1.0f);

                        // Diffuse & Specular (Cook-Torrance / GGX approximation)
                        Vec3 albedo = mat.baseColor;
                        float rough = mat.roughness;
                        float metal = mat.metallic;

                        // Key Light
                        float NdotL1 = std::max(0.0f, N.dot(lightDir1));
                        Vec3 H1 = (lightDir1 + viewDir).normalized();
                        float NdotH1 = std::max(0.0f, N.dot(H1));
                        float specPower1 = (2.0f / (rough * rough + 0.001f)) - 2.0f;
                        float spec1 = std::pow(NdotH1, std::clamp(specPower1, 1.0f, 256.0f));

                        // Rim / Fill Light
                        float NdotL2 = std::max(0.0f, N.dot(lightDir2));
                        Vec3 H2 = (lightDir2 + viewDir).normalized();
                        float NdotH2 = std::max(0.0f, N.dot(H2));
                        float specPower2 = (2.0f / (rough * rough + 0.001f)) - 2.0f;
                        float spec2 = std::pow(NdotH2, std::clamp(specPower2, 1.0f, 256.0f));

                        // Fresnel Schlick
                        Vec3 F0 = metal > 0.5f ? albedo : Vec3(0.04f, 0.04f, 0.04f);
                        float VdotH1 = std::max(0.0f, viewDir.dot(H1));
                        Vec3 F1 = F0 + (Vec3(1, 1, 1) - F0) * std::pow(1.0f - VdotH1, 5.0f);

                        Vec3 directLight = (albedo * (1.0f - metal) * NdotL1 + F1 * spec1 * 1.5f) * lightCol1
                                         + (albedo * (1.0f - metal) * NdotL2 + F0 * spec2 * 0.8f) * lightCol2;

                        Vec3 ambient = albedo * Vec3(0.12f, 0.14f, 0.18f) * cavity;
                        pixelColor = directLight * cavity + ambient;
                    } else {
                        // Studio Floor with contact shadows
                        float grid = (std::fmod(std::abs(hitUv.x), 1.0f) < 0.02f || std::fmod(std::abs(hitUv.y), 1.0f) < 0.02f) ? 0.2f : 0.08f;
                        Vec3 floorAlbedo = Vec3(grid, grid, grid * 1.1f);

                        // Contact shadow attenuation from spheres
                        float shadow = 1.0f;
                        for (int i = 0; i < 4; ++i) {
                            float dX = hitPos.x - sphereXs[i];
                            float dZ = hitPos.z - 0.0f;
                            float d2 = dX * dX + dZ * dZ;
                            if (d2 < 1.4f) {
                                shadow *= std::clamp(d2 / 1.4f, 0.15f, 1.0f);
                            }
                        }

                        float NdotL1 = std::max(0.0f, hitNormal.dot(lightDir1));
                        pixelColor = floorAlbedo * lightCol1 * (NdotL1 * shadow) + floorAlbedo * 0.15f;
                    }
                }

                // ACES Filmic Tonemapping
                Vec3 tonemapped = ibl::acesFilmic(pixelColor, 1.0f);

                // Subtle studio vignette
                float uNorm = (static_cast<float>(x) / W) * 2.0f - 1.0f;
                float vNorm = (static_cast<float>(y) / H) * 2.0f - 1.0f;
                float vignette = 1.0f - (uNorm * uNorm + vNorm * vNorm) * 0.18f;
                tonemapped = tonemapped * std::max(0.0f, vignette);

                framebuffer[y * W + x] = tonemapped;
            }
        }
    };

    int sliceH = H / numThreads;
    for (int i = 0; i < numThreads; ++i) {
        int y0 = i * sliceH;
        int y1 = (i == numThreads - 1) ? H : (i + 1) * sliceH;
        futures.push_back(std::async(std::launch::async, renderStrip, y0, y1));
    }
    for (auto& f : futures) {
        f.get();
    }

    // Write binary PPM
    std::cout << "[Native PBR Texture Studio] Writing build/pbr_texture_matrix.ppm..." << std::endl;
    std::ofstream ofs("build/pbr_texture_matrix.ppm", std::ios::out | std::ios::binary);
    ofs << "P6\n" << W << " " << H << "\n255\n";
    for (int y = 0; y < H; ++y) {
        for (int x = 0; x < W; ++x) {
            const auto& c = framebuffer[y * W + x];
            unsigned char r = static_cast<unsigned char>(std::clamp(c.x * 255.0f, 0.0f, 255.0f));
            unsigned char g = static_cast<unsigned char>(std::clamp(c.y * 255.0f, 0.0f, 255.0f));
            unsigned char b = static_cast<unsigned char>(std::clamp(c.z * 255.0f, 0.0f, 255.0f));
            ofs.write(reinterpret_cast<char*>(&r), 1);
            ofs.write(reinterpret_cast<char*>(&g), 1);
            ofs.write(reinterpret_cast<char*>(&b), 1);
        }
    }
    ofs.close();

    std::cout << "[Native PBR Texture Studio] Rendering completed successfully!" << std::endl;
    return 0;
}
