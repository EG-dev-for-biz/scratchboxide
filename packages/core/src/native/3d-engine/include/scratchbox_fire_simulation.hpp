/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

#ifndef SCRATCHBOX_FIRE_SIMULATION_HPP
#define SCRATCHBOX_FIRE_SIMULATION_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_particles.hpp"
#include "scratchbox_io.hpp"

#include <vector>
#include <memory>
#include <cmath>
#include <algorithm>
#include <string>
#include <functional>

namespace scratchbox {
namespace fire {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using math::FastNoise3D;
using math::PI;
using math::TWO_PI;
using geometry::ScratchboxMesh;
using geometry::Vertex;
using geometry::PbrMaterial;

// ============================================================================
// 1. Analytical Blackbody Radiation & Stokes Deceleration
// ============================================================================

/**
 * Planckian Thermal Blackbody Radiation Approximation (Kelvin -> Linear RGB)
 */
inline Vec4 blackbody(float kelvin, float alpha = 1.0f) {
    float temp = std::clamp(kelvin / 100.0f, 10.0f, 120.0f);
    float r = 0.0f, g = 0.0f, b = 0.0f;

    // Red component
    if (temp <= 66.0f) {
        r = 1.0f;
    } else {
        r = std::clamp(1.292936186f * std::pow(temp - 60.0f, -0.1332047592f), 0.0f, 1.0f);
    }

    // Green component
    if (temp <= 66.0f) {
        g = std::clamp(0.39008157876f * std::log(temp) - 0.63184144378f, 0.0f, 1.0f);
    } else {
        g = std::clamp(1.129817658f * std::pow(temp - 60.0f, -0.0755148492f), 0.0f, 1.0f);
    }

    // Blue component
    if (temp >= 66.0f) {
        b = 1.0f;
    } else if (temp <= 19.0f) {
        b = 0.0f;
    } else {
        b = std::clamp(0.54320678911f * std::log(temp - 10.0f) - 1.19625408914f, 0.0f, 1.0f);
    }

    return Vec4(r, g, b, alpha);
}

/**
 * Aerodynamic Stokes / Quadratic Drag Deceleration:
 * v(t) = v0 * exp(-k * t)
 * x(t) = (v0 / k) * (1 - exp(-k * t))
 */
inline float stokesDrag(float v0, float k, float t) {
    if (k <= 1e-4f) return v0 * t;
    return (v0 / k) * (1.0f - std::exp(-k * t));
}

/**
 * Beer-Lambert Volume Extinction Law: T(s) = exp(-sigma_a * s)
 */
inline float beerLambert(float opticalDepth) {
    return std::exp(-opticalDepth);
}

/**
 * Asymmetric Multipole Harmonic Lobe (Breaks Spherical Symmetry!)
 */
inline float asymmetricHarmonicLobe(float theta, float phi, float strength = 0.5f) {
    float sinPhi = std::sin(phi);
    return 1.0f + strength * (
        std::cos(3.0f * theta + 0.4f) * sinPhi * 0.45f +
        std::sin(5.0f * theta) * sinPhi * 0.30f +
        std::cos(2.0f * phi) * 0.25f
    );
}

// ============================================================================
// 2. Individual Flame & Ember Parcel State
// ============================================================================

enum class FlameParcelType {
    ConvectiveCore,     // White-hot rising central vortex
    BillowMushroom,     // Expanding bulbous cauliflower billow
    EjectaStreamer,     // High-velocity asymmetric jet
    FloatingEmber       // Long-lived incandescent micro-sparks
};

struct FlameParcel {
    uint32_t id{0};
    FlameParcelType type{FlameParcelType::ConvectiveCore};

    Vec3 origin{0.0f, 0.0f, 0.0f};
    Vec3 initialVelocity{0.0f, 0.0f, 0.0f};
    Vec3 currentPosition{0.0f, 0.0f, 0.0f};

    float age{0.0f};
    float lifetime{2.5f};
    float baseSize{0.15f};
    float speedScale{1.0f};
    float dragCoeff{1.15f};

    float temperature{5200.0f}; // Kelvin
    Vec4 color{1.0f, 0.6f, 0.1f, 1.0f};
    bool active{true};

    float normalizedAge() const {
        return lifetime > 0.0f ? std::clamp(age / lifetime, 0.0f, 1.0f) : 1.0f;
    }

    bool isDead() const {
        return age >= lifetime || !active;
    }
};

// ============================================================================
// 3. High-Performance Native C++20 Fire Explosion Simulation Engine
// ============================================================================

class FireExplosionSimulation {
public:
    std::string name{"native_fire_explosion"};
    std::vector<FlameParcel> parcels;
    size_t capacity{50000};
    Vec3 center{0.0f, 2.0f, 0.0f};
    float scale{1.0f};
    float simulationTime{0.0f};
    float blastTime{0.0f};

    FireExplosionSimulation(const std::string& simName = "native_fire_explosion", size_t count = 50000)
        : name(simName), capacity(count) {
        parcels.reserve(count);
        initialize(count);
    }

    void initialize(size_t count) {
        parcels.clear();
        parcels.resize(count);

        auto hashFloat = [](uint32_t s, float minVal, float maxVal) -> float {
            s = (s ^ 61) ^ (s >> 16);
            s = s + (s << 3);
            s = s ^ (s >> 4);
            s = s * 0x27d4eb2d;
            s = s ^ (s >> 15);
            float norm = static_cast<float>(s & 0xFFFFFF) / 16777215.0f;
            return minVal + norm * (maxVal - minVal);
        };

        const std::vector<Vec3> jetDirs = {
            Vec3(0.85f, 0.45f, 0.28f).normalized(),
            Vec3(-0.72f, 0.65f, 0.25f).normalized(),
            Vec3(0.25f, 0.88f, -0.40f).normalized(),
            Vec3(-0.35f, 0.75f, -0.55f).normalized(),
            Vec3(0.65f, 0.35f, -0.68f).normalized(),
            Vec3(-0.55f, 0.25f, 0.80f).normalized(),
            Vec3(0.15f, 0.95f, 0.25f).normalized(),
            Vec3(-0.85f, 0.35f, -0.38f).normalized()
        };

        for (size_t i = 0; i < count; ++i) {
            FlameParcel& p = parcels[i];
            p.id = static_cast<uint32_t>(i);
            p.active = true;

            float pType = hashFloat(static_cast<uint32_t>(i * 7 + 1), 0.0f, 1.0f);

            if (pType < 0.60f) {
                // Type 1: Convective Core & Rising Mushroom Plume (60%)
                p.type = FlameParcelType::ConvectiveCore;
                float stalkY = hashFloat(static_cast<uint32_t>(i * 11 + 2), -0.2f, 1.2f);
                float stalkR = 0.25f * std::sqrt(hashFloat(static_cast<uint32_t>(i * 13 + 3), 0.0f, 1.0f));
                float ang = hashFloat(static_cast<uint32_t>(i * 17 + 4), 0.0f, TWO_PI);

                p.origin = Vec3(std::cos(ang) * stalkR, stalkY, std::sin(ang) * stalkR);

                float theta = hashFloat(static_cast<uint32_t>(i * 19 + 5), 0.0f, TWO_PI);
                float phi = std::acos(hashFloat(static_cast<uint32_t>(i * 23 + 6), -1.0f, 1.0f));
                float lobeMod = asymmetricHarmonicLobe(theta, phi, 0.55f);

                float dx = std::sin(phi) * std::cos(theta);
                float dy = std::cos(phi);
                float dz = std::sin(phi) * std::sin(theta);

                float speed = hashFloat(static_cast<uint32_t>(i * 29 + 7), 2.0f, 6.5f) * lobeMod;
                p.initialVelocity = Vec3(dx * speed * 0.9f, (dy * 0.6f + 1.2f) * speed * 1.4f, dz * speed * 0.9f);

                p.lifetime = hashFloat(static_cast<uint32_t>(i * 31 + 8), 1.8f, 3.8f);
                p.baseSize = hashFloat(static_cast<uint32_t>(i * 37 + 9), 0.12f, 0.26f);
                p.speedScale = hashFloat(static_cast<uint32_t>(i * 41 + 10), 0.85f, 1.25f);
                p.dragCoeff = 1.15f;
                p.age = hashFloat(static_cast<uint32_t>(i * 43 + 11), 0.0f, p.lifetime);

            } else if (pType < 0.85f) {
                // Type 2: Asymmetric Ejecta Streamers / Fire Tendrils (25%)
                p.type = FlameParcelType::EjectaStreamer;
                size_t jetIdx = i % jetDirs.size();
                Vec3 jet = jetDirs[jetIdx];
                float spread = 0.22f;
                Vec3 jDir = (jet + Vec3(
                    hashFloat(static_cast<uint32_t>(i * 47 + 12), -spread, spread),
                    hashFloat(static_cast<uint32_t>(i * 53 + 13), -spread, spread),
                    hashFloat(static_cast<uint32_t>(i * 59 + 14), -spread, spread)
                )).normalized();

                p.origin = Vec3(
                    hashFloat(static_cast<uint32_t>(i * 61 + 15), -0.1f, 0.1f),
                    hashFloat(static_cast<uint32_t>(i * 67 + 16), 0.1f, 0.4f),
                    hashFloat(static_cast<uint32_t>(i * 71 + 17), -0.1f, 0.1f)
                );

                float speed = hashFloat(static_cast<uint32_t>(i * 73 + 18), 4.5f, 12.0f);
                p.initialVelocity = jDir * speed;

                p.lifetime = hashFloat(static_cast<uint32_t>(i * 79 + 19), 1.2f, 2.2f);
                p.baseSize = hashFloat(static_cast<uint32_t>(i * 83 + 20), 0.08f, 0.16f);
                p.speedScale = 1.2f;
                p.dragCoeff = 1.45f;
                p.age = hashFloat(static_cast<uint32_t>(i * 89 + 21), 0.0f, p.lifetime);

            } else {
                // Type 3: Incandescent Micro-Embers / Sparks (15%)
                p.type = FlameParcelType::FloatingEmber;
                p.origin = Vec3(
                    hashFloat(static_cast<uint32_t>(i * 97 + 22), -0.4f, 0.4f),
                    hashFloat(static_cast<uint32_t>(i * 101 + 23), 0.2f, 0.8f),
                    hashFloat(static_cast<uint32_t>(i * 103 + 24), -0.4f, 0.4f)
                );

                float spkSpeed = hashFloat(static_cast<uint32_t>(i * 107 + 25), 1.5f, 4.5f);
                p.initialVelocity = Vec3(
                    hashFloat(static_cast<uint32_t>(i * 109 + 26), -1.0f, 1.0f) * spkSpeed,
                    hashFloat(static_cast<uint32_t>(i * 113 + 27), 2.0f, 5.0f),
                    hashFloat(static_cast<uint32_t>(i * 127 + 28), -1.0f, 1.0f) * spkSpeed
                );

                p.lifetime = hashFloat(static_cast<uint32_t>(i * 131 + 29), 2.5f, 5.0f);
                p.baseSize = hashFloat(static_cast<uint32_t>(i * 137 + 30), 0.03f, 0.06f);
                p.speedScale = 0.8f;
                p.dragCoeff = 0.85f;
                p.age = hashFloat(static_cast<uint32_t>(i * 139 + 31), 0.0f, p.lifetime);
            }
        }
    }

    void step(float dt) {
        simulationTime += dt;
        blastTime += dt;

        float blastSurge = std::exp(-blastTime * 1.2f) * 1.8f;

        for (auto& p : parcels) {
            p.age += dt;
            if (p.age >= p.lifetime) {
                p.age = std::fmod(p.age, p.lifetime);
            }

            float normAge = p.normalizedAge();
            float speed = p.speedScale * (1.0f + blastSurge);

            // Aerodynamic Stokes drag deceleration
            float dragDisplacement = stokesDrag(speed, p.dragCoeff, p.age);
            Vec3 pos = p.origin + p.initialVelocity * dragDisplacement;

            // Convective buoyancy (+Y rise)
            pos.y += std::pow(p.age, 1.4f) * 0.75f;

            // Helical toroidal swirl
            float rXZ = std::hypot(pos.x, pos.z);
            float swirlAngle = (p.age * 1.5f) / (0.35f + rXZ * 0.8f);
            float cosS = std::cos(swirlAngle), sinS = std::sin(swirlAngle);
            float rotX = pos.x * cosS - pos.z * sinS;
            float rotZ = pos.x * sinS + pos.z * cosS;
            pos.x = rotX;
            pos.z = rotZ;

            // Divergence-free 3D curl turbulence advection
            float tAdv = simulationTime * 0.5f;
            float cX = std::sin(pos.z * 1.4f + tAdv) * 0.35f;
            float cY = std::sin(pos.x * 1.4f + tAdv) * 0.35f;
            float cZ = std::cos(pos.y * 1.4f + tAdv) * 0.35f;
            pos = pos + Vec3(cX, cY, cZ) * (std::pow(p.age, 1.1f) * 0.85f);

            p.currentPosition = center + pos * scale;

            // Graceful Optical Dissipation & Temperature
            // Fast cubic hermite attack, prolonged body, exponential decay
            float attack = std::min(1.0f, normAge / 0.04f);
            float smoothAttack = attack * attack * (3.0f - 2.0f * attack);
            float decay = normAge > 0.40f ? std::exp(-4.2f * (normAge - 0.40f)) * (1.0f - std::pow(normAge, 3.0f)) : 1.0f;
            float alpha = smoothAttack * decay;

            // Planckian thermal gradient
            float heat = std::pow(std::max(0.0f, 1.0f - normAge), 1.35f) * (0.85f + 0.45f * blastSurge);
            p.temperature = std::lerp(550.0f, 5600.0f, heat);
            p.color = blackbody(p.temperature, alpha);
        }
    }

    ScratchboxMesh toMesh(const Vec3& cameraPos = Vec3(0, 5, 12), size_t sampleCount = 4000) const {
        ScratchboxMesh mesh;
        mesh.name = "fire_explosion_mesh";
        mesh.material = PbrMaterial::emissiveGlow(Vec3(1.0f, 0.55f, 0.1f), 3.5f);

        size_t actualCount = std::min(sampleCount, parcels.size());
        mesh.vertices.reserve(actualCount * 4);
        mesh.indices.reserve(actualCount * 6);

        for (size_t i = 0; i < actualCount; ++i) {
            const auto& p = parcels[i];
            if (p.color.w <= 0.01f) continue;

            float normAge = p.normalizedAge();
            float sizeEnvelope = std::sin(PI * std::pow(normAge, 0.42f));
            float sz = p.baseSize * std::max(0.04f, sizeEnvelope) * 0.5f;

            Vec3 look = (cameraPos - p.currentPosition).normalized();
            if (look.lengthSq() < 1e-4f) look = Vec3(0, 0, 1);
            Vec3 up(0, 1, 0);
            if (std::abs(look.dot(up)) > 0.99f) up = Vec3(1, 0, 0);
            Vec3 right = up.cross(look).normalized();
            up = look.cross(right).normalized();

            uint32_t baseIdx = static_cast<uint32_t>(mesh.vertices.size());

            Vertex v0, v1, v2, v3;
            v0.position = p.currentPosition - right * sz - up * sz;
            v0.normal = look;
            v0.uv = Vec2(0.0f, 0.0f);
            v0.color = p.color;

            v1.position = p.currentPosition + right * sz - up * sz;
            v1.normal = look;
            v1.uv = Vec2(1.0f, 0.0f);
            v1.color = p.color;

            v2.position = p.currentPosition + right * sz + up * sz;
            v2.normal = look;
            v2.uv = Vec2(1.0f, 1.0f);
            v2.color = p.color;

            v3.position = p.currentPosition - right * sz + up * sz;
            v3.normal = look;
            v3.uv = Vec2(0.0f, 1.0f);
            v3.color = p.color;

            mesh.vertices.push_back(v0);
            mesh.vertices.push_back(v1);
            mesh.vertices.push_back(v2);
            mesh.vertices.push_back(v3);

            mesh.indices.push_back(baseIdx + 0);
            mesh.indices.push_back(baseIdx + 1);
            mesh.indices.push_back(baseIdx + 2);

            mesh.indices.push_back(baseIdx + 0);
            mesh.indices.push_back(baseIdx + 2);
            mesh.indices.push_back(baseIdx + 3);
        }

        return mesh;
    }
};

} // namespace fire
} // namespace scratchbox

#endif // SCRATCHBOX_FIRE_SIMULATION_HPP
