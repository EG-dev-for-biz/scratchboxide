/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

#ifndef SCRATCHBOX_PARTICLES_HPP
#define SCRATCHBOX_PARTICLES_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_sdf.hpp"
#include "scratchbox_io.hpp"

#include <vector>
#include <memory>
#include <cmath>
#include <algorithm>
#include <functional>
#include <string>

namespace scratchbox {
namespace particles {

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
// Thermal Emission / Blackbody Radiation Approximation (Planck's Law)
// ============================================================================
inline Vec4 blackbodyToColor(float kelvin, float alpha = 1.0f) {
    float temp = std::clamp(kelvin / 100.0f, 10.0f, 120.0f);
    float r = 0.0f, g = 0.0f, b = 0.0f;

    // Red
    if (temp <= 66.0f) {
        r = 1.0f;
    } else {
        r = std::clamp(1.292936186f * std::pow(temp - 60.0f, -0.1332047592f), 0.0f, 1.0f);
    }

    // Green
    if (temp <= 66.0f) {
        g = std::clamp(0.39008157876f * std::log(temp) - 0.63184144378f, 0.0f, 1.0f);
    } else {
        g = std::clamp(1.129817658f * std::pow(temp - 60.0f, -0.0755148492f), 0.0f, 1.0f);
    }

    // Blue
    if (temp >= 66.0f) {
        b = 1.0f;
    } else if (temp <= 19.0f) {
        b = 0.0f;
    } else {
        b = std::clamp(0.54320678911f * std::log(temp - 10.0f) - 1.19625408914f, 0.0f, 1.0f);
    }

    return Vec4(r, g, b, alpha);
}

inline Vec4 lerpVec4(const Vec4& a, const Vec4& b, float t) {
    return Vec4(
        std::lerp(a.x, b.x, t),
        std::lerp(a.y, b.y, t),
        std::lerp(a.z, b.z, t),
        std::lerp(a.w, b.w, t)
    );
}

// ============================================================================
// Particle State
// ============================================================================
struct Particle {
    uint32_t id{0};
    Vec3 position{0.0f, 0.0f, 0.0f};
    Vec3 velocity{0.0f, 0.0f, 0.0f};
    Vec3 acceleration{0.0f, 0.0f, 0.0f};
    
    float mass{1.0f};
    float invMass{1.0f};
    
    float age{0.0f};
    float lifetime{2.0f};
    
    float sizeStart{0.15f};
    float sizeEnd{0.0f};
    
    Vec4 colorStart{1.0f, 0.6f, 0.1f, 1.0f};
    Vec4 colorEnd{0.2f, 0.05f, 0.0f, 0.0f};
    
    float tempStart{4500.0f}; // Kelvin
    float tempEnd{1000.0f};
    
    float rotation{0.0f};
    float angularVelocity{0.0f};
    
    bool active{true};

    Particle() = default;

    inline float normalizedAge() const {
        return lifetime > 0.0f ? std::clamp(age / lifetime, 0.0f, 1.0f) : 1.0f;
    }

    inline bool isDead() const {
        return age >= lifetime || !active;
    }

    inline float currentSize() const {
        float t = normalizedAge();
        return std::lerp(sizeStart, sizeEnd, t);
    }

    inline Vec4 currentColor() const {
        float t = normalizedAge();
        return lerpVec4(colorStart, colorEnd, t);
    }

    inline float currentTemperature() const {
        float t = normalizedAge();
        return std::lerp(tempStart, tempEnd, t);
    }
};

// ============================================================================
// Integrator & Emitter Enums
// ============================================================================
enum class IntegratorType {
    SymplecticEuler,
    VelocityVerlet,
    RungeKutta4
};

enum class EmitterShape {
    Point,
    Sphere,
    Box,
    Disk,
    Cone
};

enum class ParticleRenderMode {
    BillboardQuads,
    CrossPlanes,
    InstancedOctahedra
};

// ============================================================================
// Particle Emitter
// ============================================================================
class ParticleEmitter {
public:
    std::string name{"main_emitter"};
    EmitterShape shape{EmitterShape::Point};
    Vec3 position{0.0f, 0.0f, 0.0f};
    Vec3 direction{0.0f, 1.0f, 0.0f};
    
    float spreadAngle{PI * 0.15f}; // Cone angle radians
    float speedMin{2.0f};
    float speedMax{5.0f};
    
    float lifetimeMin{1.0f};
    float lifetimeMax{3.0f};
    
    float sizeStart{0.2f};
    float sizeEnd{0.02f};
    
    Vec4 colorStart{1.0f, 0.65f, 0.15f, 1.0f};
    Vec4 colorEnd{0.3f, 0.05f, 0.0f, 0.0f};
    
    float tempStart{4800.0f};
    float tempEnd{800.0f};
    
    float emissionRate{150.0f}; // Particles per second
    float sphereRadius{1.0f};
    Vec3 boxExtents{1.0f, 1.0f, 1.0f};

    float spawnAccumulator{0.0f};

    ParticleEmitter() = default;

    static ParticleEmitter fountain(const Vec3& pos = Vec3(0, 0, 0), float heightSpeed = 8.0f) {
        ParticleEmitter e;
        e.name = "fountain";
        e.shape = EmitterShape::Cone;
        e.position = pos;
        e.direction = Vec3(0, 1, 0);
        e.spreadAngle = PI * 0.12f;
        e.speedMin = heightSpeed * 0.8f;
        e.speedMax = heightSpeed * 1.2f;
        e.lifetimeMin = 2.0f;
        e.lifetimeMax = 3.5f;
        e.sizeStart = 0.12f;
        e.sizeEnd = 0.04f;
        e.colorStart = Vec4(0.2f, 0.7f, 1.0f, 1.0f);
        e.colorEnd = Vec4(0.05f, 0.2f, 0.8f, 0.0f);
        e.emissionRate = 200.0f;
        return e;
    }

    static ParticleEmitter fireVortex(const Vec3& pos = Vec3(0, 0, 0)) {
        ParticleEmitter e;
        e.name = "fire_vortex";
        e.shape = EmitterShape::Cone;
        e.position = pos;
        e.direction = Vec3(0, 1, 0);
        e.spreadAngle = PI * 0.25f;
        e.speedMin = 3.0f;
        e.speedMax = 7.0f;
        e.lifetimeMin = 1.2f;
        e.lifetimeMax = 2.5f;
        e.sizeStart = 0.25f;
        e.sizeEnd = 0.05f;
        e.colorStart = Vec4(1.0f, 0.7f, 0.1f, 1.0f);
        e.colorEnd = Vec4(0.4f, 0.05f, 0.0f, 0.0f);
        e.tempStart = 5500.0f;
        e.tempEnd = 900.0f;
        e.emissionRate = 250.0f;
        return e;
    }

    static ParticleEmitter celestialExplosion(const Vec3& pos = Vec3(0, 0, 0)) {
        ParticleEmitter e;
        e.name = "celestial_nova";
        e.shape = EmitterShape::Sphere;
        e.position = pos;
        e.sphereRadius = 0.5f;
        e.speedMin = 4.0f;
        e.speedMax = 12.0f;
        e.lifetimeMin = 2.5f;
        e.lifetimeMax = 4.0f;
        e.sizeStart = 0.30f;
        e.sizeEnd = 0.01f;
        e.colorStart = Vec4(0.9f, 0.4f, 1.0f, 1.0f);
        e.colorEnd = Vec4(0.1f, 0.0f, 0.4f, 0.0f);
        e.tempStart = 9000.0f;
        e.tempEnd = 1200.0f;
        e.emissionRate = 400.0f;
        return e;
    }

    Particle spawn(uint32_t seed) const {
        Particle p;
        p.id = seed;
        p.active = true;
        p.age = 0.0f;

        // Pseudo-random hashing
        auto hashFloat = [](uint32_t s, float minVal, float maxVal) -> float {
            s = (s ^ 61) ^ (s >> 16);
            s = s + (s << 3);
            s = s ^ (s >> 4);
            s = s * 0x27d4eb2d;
            s = s ^ (s >> 15);
            float norm = static_cast<float>(s & 0xFFFFFF) / 16777215.0f;
            return minVal + norm * (maxVal - minVal);
        };

        p.lifetime = hashFloat(seed * 7 + 1, lifetimeMin, lifetimeMax);
        p.sizeStart = sizeStart;
        p.sizeEnd = sizeEnd;
        p.colorStart = colorStart;
        p.colorEnd = colorEnd;
        p.tempStart = tempStart;
        p.tempEnd = tempEnd;
        p.rotation = hashFloat(seed * 13 + 2, 0.0f, TWO_PI);
        p.angularVelocity = hashFloat(seed * 17 + 3, -2.0f, 2.0f);

        // Position & Velocity by shape
        Vec3 spawnPos = position;
        Vec3 initVel(0, 0, 0);
        float speed = hashFloat(seed * 23 + 4, speedMin, speedMax);

        if (shape == EmitterShape::Point || shape == EmitterShape::Cone) {
            spawnPos = position;
            float phi = hashFloat(seed * 29 + 5, 0.0f, TWO_PI);
            float costheta = hashFloat(seed * 31 + 6, std::cos(spreadAngle), 1.0f);
            float sintheta = std::sqrt(std::max(0.0f, 1.0f - costheta * costheta));

            Vec3 dir(sintheta * std::cos(phi), costheta, sintheta * std::sin(phi));
            Vec3 forward = direction.normalized();
            Vec3 up = std::abs(forward.y) < 0.99f ? Vec3(0, 1, 0) : Vec3(1, 0, 0);
            Vec3 right = forward.cross(up).normalized();
            up = right.cross(forward).normalized();

            initVel = (right * dir.x + forward * dir.y + up * dir.z).normalized() * speed;
        } else if (shape == EmitterShape::Sphere) {
            float u = hashFloat(seed * 37 + 7, 0.0f, 1.0f);
            float v = hashFloat(seed * 41 + 8, 0.0f, 1.0f);
            float theta = u * TWO_PI;
            float phi = std::acos(2.0f * v - 1.0f);
            float r = sphereRadius * std::cbrt(hashFloat(seed * 43 + 9, 0.0f, 1.0f));

            Vec3 radial(std::sin(phi) * std::cos(theta), std::cos(phi), std::sin(phi) * std::sin(theta));
            spawnPos = position + radial * r;
            initVel = radial * speed;
        } else if (shape == EmitterShape::Box) {
            spawnPos = position + Vec3(
                hashFloat(seed * 47 + 10, -boxExtents.x, boxExtents.x),
                hashFloat(seed * 53 + 11, -boxExtents.y, boxExtents.y),
                hashFloat(seed * 59 + 12, -boxExtents.z, boxExtents.z)
            );
            initVel = direction.normalized() * speed;
        }

        p.position = spawnPos;
        p.velocity = initVel;
        p.acceleration = Vec3(0, 0, 0);
        return p;
    }
};

// ============================================================================
// Force Fields
// ============================================================================
class IForceField {
public:
    virtual ~IForceField() = default;
    virtual Vec3 evaluate(const Particle& p, float time) const = 0;
};

class GravityField : public IForceField {
public:
    Vec3 gravity{0.0f, -9.81f, 0.0f};

    GravityField(const Vec3& g = Vec3(0, -9.81f, 0)) : gravity(g) {}

    Vec3 evaluate(const Particle& p, float /*time*/) const override {
        return gravity * p.mass;
    }
};

class PointAttractorField : public IForceField {
public:
    Vec3 center{0.0f, 0.0f, 0.0f};
    float strength{10.0f}; // Positive = attract, negative = repel
    float softening{0.2f};
    float maxDistance{50.0f};

    PointAttractorField(const Vec3& c, float s = 10.0f, float soft = 0.2f)
        : center(c), strength(s), softening(soft) {}

    Vec3 evaluate(const Particle& p, float /*time*/) const override {
        Vec3 delta = center - p.position;
        float rSq = delta.lengthSq();
        if (rSq > maxDistance * maxDistance) return Vec3(0, 0, 0);

        float denom = std::pow(rSq + softening * softening, 1.5f);
        return delta * (strength * p.mass / denom);
    }
};

class VortexField : public IForceField {
public:
    Vec3 axis{0.0f, 1.0f, 0.0f};
    Vec3 center{0.0f, 0.0f, 0.0f};
    float swirlSpeed{4.0f};
    float inwardPull{1.0f};
    float upwardSpeed{1.5f};

    VortexField(const Vec3& c = Vec3(0, 0, 0), float swirl = 4.0f, float pull = 1.0f, float up = 1.5f)
        : axis(Vec3(0, 1, 0)), center(c), swirlSpeed(swirl), inwardPull(pull), upwardSpeed(up) {}

    Vec3 evaluate(const Particle& p, float /*time*/) const override {
        Vec3 delta = p.position - center;
        Vec3 projOnAxis = axis * delta.dot(axis);
        Vec3 radial = delta - projOnAxis;
        float r = radial.length();
        if (r < 1e-4f) return axis * upwardSpeed;

        Vec3 tangent = axis.cross(radial).normalized();
        Vec3 radialInward = -radial.normalized();

        return (tangent * (swirlSpeed / std::max(0.5f, r)) + radialInward * inwardPull + axis * upwardSpeed) * p.mass;
    }
};

class DragField : public IForceField {
public:
    float dragCoefficient{0.5f};

    DragField(float cd = 0.5f) : dragCoefficient(cd) {}

    Vec3 evaluate(const Particle& p, float /*time*/) const override {
        float speed = p.velocity.length();
        if (speed < 1e-6f) return Vec3(0, 0, 0);
        return p.velocity * (-dragCoefficient * speed * p.mass);
    }
};

/**
 * Divergence-Free 3D Curl Noise Turbulence Field.
 * Guarantees zero divergence (div v = 0) so particles swirl naturally without compressing or clustering!
 */
class CurlNoiseField : public IForceField {
public:
    float frequency{0.4f};
    float amplitude{3.0f};
    float timeEvolutionSpeed{0.2f};

    CurlNoiseField(float freq = 0.4f, float amp = 3.0f, float speed = 0.2f)
        : frequency(freq), amplitude(amp), timeEvolutionSpeed(speed) {}

    Vec3 evaluate(const Particle& p, float time) const override {
        const float eps = 1e-3f;
        Vec3 pos = p.position * frequency;
        float t = time * timeEvolutionSpeed;

        auto psiX = [t](const Vec3& v) { return FastNoise3D::fbm(v.x + 12.3f, v.y + 45.6f, v.z + t, 3); };
        auto psiY = [t](const Vec3& v) { return FastNoise3D::fbm(v.x + 78.9f, v.y + 10.1f, v.z + t, 3); };
        auto psiZ = [t](const Vec3& v) { return FastNoise3D::fbm(v.x + 23.4f, v.y + 67.8f, v.z + t, 3); };

        float dPz_dy = (psiZ(pos + Vec3(0, eps, 0)) - psiZ(pos - Vec3(0, eps, 0))) / (2.0f * eps);
        float dPy_dz = (psiY(pos + Vec3(0, 0, eps)) - psiY(pos - Vec3(0, 0, eps))) / (2.0f * eps);

        float dPx_dz = (psiX(pos + Vec3(0, 0, eps)) - psiX(pos - Vec3(0, 0, eps))) / (2.0f * eps);
        float dPz_dx = (psiZ(pos + Vec3(eps, 0, 0)) - psiZ(pos - Vec3(eps, 0, 0))) / (2.0f * eps);

        float dPy_dx = (psiY(pos + Vec3(eps, 0, 0)) - psiY(pos - Vec3(eps, 0, 0))) / (2.0f * eps);
        float dPx_dy = (psiX(pos + Vec3(0, eps, 0)) - psiX(pos - Vec3(0, eps, 0))) / (2.0f * eps);

        Vec3 curlVel(
            dPz_dy - dPy_dz,
            dPx_dz - dPz_dx,
            dPy_dx - dPx_dy
        );

        return curlVel * amplitude;
    }
};

// ============================================================================
// Particle Colliders
// ============================================================================
class IParticleCollider {
public:
    virtual ~IParticleCollider() = default;
    virtual bool resolve(Particle& p, float dt) const = 0;
};

class PlaneCollider : public IParticleCollider {
public:
    Vec3 point{0.0f, 0.0f, 0.0f};
    Vec3 normal{0.0f, 1.0f, 0.0f};
    float restitution{0.6f};
    float friction{0.2f};

    PlaneCollider(const Vec3& pt = Vec3(0, 0, 0), const Vec3& n = Vec3(0, 1, 0), float rest = 0.6f, float f = 0.2f)
        : point(pt), normal(n.normalized()), restitution(rest), friction(f) {}

    bool resolve(Particle& p, float /*dt*/) const override {
        float dist = (p.position - point).dot(normal);
        float particleRadius = p.currentSize() * 0.5f;

        if (dist < particleRadius) {
            p.position = p.position + normal * (particleRadius - dist);

            float vn = p.velocity.dot(normal);
            if (vn < 0.0f) {
                Vec3 normalVel = normal * vn;
                Vec3 tangentVel = p.velocity - normalVel;
                p.velocity = tangentVel * (1.0f - friction) - normalVel * restitution;
            }
            return true;
        }
        return false;
    }
};

class SphereCollider : public IParticleCollider {
public:
    Vec3 center{0.0f, 0.0f, 0.0f};
    float radius{2.0f};
    float restitution{0.7f};
    float friction{0.15f};

    SphereCollider(const Vec3& c, float r, float rest = 0.7f, float f = 0.15f)
        : center(c), radius(r), restitution(rest), friction(f) {}

    bool resolve(Particle& p, float /*dt*/) const override {
        Vec3 delta = p.position - center;
        float d = delta.length();
        float totalRadius = radius + p.currentSize() * 0.5f;

        if (d < totalRadius) {
            Vec3 n = d > 1e-5f ? delta / d : Vec3(0, 1, 0);
            p.position = center + n * totalRadius;

            float vn = p.velocity.dot(n);
            if (vn < 0.0f) {
                Vec3 normalVel = n * vn;
                Vec3 tangentVel = p.velocity - normalVel;
                p.velocity = tangentVel * (1.0f - friction) - normalVel * restitution;
            }
            return true;
        }
        return false;
    }
};

using SDFDistanceFn = std::function<float(const Vec3&)>;

class SDFCollider : public IParticleCollider {
public:
    SDFDistanceFn sdfDistance;
    float restitution{0.65f};
    float friction{0.2f};

    SDFCollider(SDFDistanceFn distFn, float rest = 0.65f, float f = 0.2f)
        : sdfDistance(std::move(distFn)), restitution(rest), friction(f) {}

    Vec3 normal(const Vec3& p, float eps = 1e-3f) const {
        float d = sdfDistance(p);
        float nx = sdfDistance(p + Vec3(eps, 0, 0)) - d;
        float ny = sdfDistance(p + Vec3(0, eps, 0)) - d;
        float nz = sdfDistance(p + Vec3(0, 0, eps)) - d;
        Vec3 n(nx, ny, nz);
        return n.normalized();
    }

    bool resolve(Particle& p, float /*dt*/) const override {
        if (!sdfDistance) return false;
        float dist = sdfDistance(p.position);
        float radius = p.currentSize() * 0.5f;

        if (dist < radius) {
            Vec3 n = normal(p.position);
            p.position = p.position + n * (radius - dist);

            float vn = p.velocity.dot(n);
            if (vn < 0.0f) {
                Vec3 normalVel = n * vn;
                Vec3 tangentVel = p.velocity - normalVel;
                p.velocity = tangentVel * (1.0f - friction) - normalVel * restitution;
            }
            return true;
        }
        return false;
    }
};

// ============================================================================
// Complete 3D Particle Simulation Engine
// ============================================================================
class ParticleSystem {
public:
    std::string name{"particle_system"};
    std::vector<Particle> particles;
    std::vector<ParticleEmitter> emitters;
    std::vector<std::shared_ptr<IForceField>> forceFields;
    std::vector<std::shared_ptr<IParticleCollider>> colliders;

    size_t maxParticles{10000};
    uint32_t seedCounter{1337};
    float simulationTime{0.0f};

    ParticleSystem(const std::string& sysName = "particle_system", size_t capacity = 10000)
        : name(sysName), maxParticles(capacity) {
        particles.reserve(capacity);
    }

    void addEmitter(const ParticleEmitter& emitter) {
        emitters.push_back(emitter);
    }

    void addForceField(std::shared_ptr<IForceField> field) {
        forceFields.push_back(field);
    }

    void addCollider(std::shared_ptr<IParticleCollider> collider) {
        colliders.push_back(collider);
    }

    size_t getActiveParticleCount() const {
        size_t count = 0;
        for (const auto& p : particles) {
            if (p.active) ++count;
        }
        return count;
    }

    void step(float dt, IntegratorType integrator = IntegratorType::SymplecticEuler) {
        simulationTime += dt;

        // 1. Spawning from emitters
        for (auto& emitter : emitters) {
            emitter.spawnAccumulator += emitter.emissionRate * dt;
            int countToSpawn = static_cast<int>(emitter.spawnAccumulator);
            emitter.spawnAccumulator -= countToSpawn;

            for (int i = 0; i < countToSpawn; ++i) {
                if (particles.size() >= maxParticles) {
                    bool recycled = false;
                    for (auto& p : particles) {
                        if (p.isDead()) {
                            p = emitter.spawn(++seedCounter);
                            recycled = true;
                            break;
                        }
                    }
                    if (!recycled) break;
                } else {
                    particles.push_back(emitter.spawn(++seedCounter));
                }
            }
        }

        // 2. Physics & Integration
        for (auto& p : particles) {
            if (!p.active) continue;

            p.age += dt;
            if (p.isDead()) {
                p.active = false;
                continue;
            }

            p.rotation += p.angularVelocity * dt;

            Vec3 totalForce(0, 0, 0);
            for (const auto& ff : forceFields) {
                totalForce += ff->evaluate(p, simulationTime);
            }
            p.acceleration = totalForce * p.invMass;

            if (integrator == IntegratorType::SymplecticEuler) {
                p.velocity += p.acceleration * dt;
                p.position += p.velocity * dt;
            } else if (integrator == IntegratorType::VelocityVerlet) {
                p.position += p.velocity * dt + p.acceleration * (0.5f * dt * dt);
                p.velocity += p.acceleration * dt;
            } else if (integrator == IntegratorType::RungeKutta4) {
                Vec3 k1_v = p.acceleration;
                Vec3 k1_x = p.velocity;

                Vec3 k2_v = p.acceleration;
                Vec3 k2_x = p.velocity + k1_v * (0.5f * dt);

                Vec3 k3_v = p.acceleration;
                Vec3 k3_x = p.velocity + k2_v * (0.5f * dt);

                Vec3 k4_v = p.acceleration;
                Vec3 k4_x = p.velocity + k3_v * dt;

                p.position += (k1_x + k2_x * 2.0f + k3_x * 2.0f + k4_x) * (dt / 6.0f);
                p.velocity += (k1_v + k2_v * 2.0f + k3_v * 2.0f + k4_v) * (dt / 6.0f);
            }

            for (const auto& col : colliders) {
                col->resolve(p, dt);
            }
        }
    }

    ScratchboxMesh toMesh(ParticleRenderMode mode = ParticleRenderMode::BillboardQuads, const Vec3& cameraPos = Vec3(0, 5, 12)) const {
        ScratchboxMesh mesh;
        mesh.name = name + "_mesh";
        mesh.material = PbrMaterial::emissiveGlow(Vec3(1.0f, 0.7f, 0.2f), 2.5f);

        size_t activeCount = getActiveParticleCount();
        if (activeCount == 0) return mesh;

        if (mode == ParticleRenderMode::BillboardQuads) {
            mesh.vertices.reserve(activeCount * 4);
            mesh.indices.reserve(activeCount * 6);

            for (const auto& p : particles) {
                if (!p.active) continue;

                float sz = p.currentSize() * 0.5f;
                Vec4 col = p.currentColor();
                
                Vec3 look = (cameraPos - p.position).normalized();
                if (look.lengthSq() < 1e-4f) look = Vec3(0, 0, 1);
                Vec3 up(0, 1, 0);
                if (std::abs(look.dot(up)) > 0.99f) up = Vec3(1, 0, 0);
                Vec3 right = up.cross(look).normalized();
                up = look.cross(right).normalized();

                float cosR = std::cos(p.rotation);
                float sinR = std::sin(p.rotation);
                Vec3 rVec = right * cosR + up * sinR;
                Vec3 uVec = -right * sinR + up * cosR;

                uint32_t baseIdx = static_cast<uint32_t>(mesh.vertices.size());

                Vertex v0, v1, v2, v3;
                v0.position = p.position - rVec * sz - uVec * sz;
                v0.normal = look;
                v0.uv = Vec2(0.0f, 0.0f);
                v0.color = col;

                v1.position = p.position + rVec * sz - uVec * sz;
                v1.normal = look;
                v1.uv = Vec2(1.0f, 0.0f);
                v1.color = col;

                v2.position = p.position + rVec * sz + uVec * sz;
                v2.normal = look;
                v2.uv = Vec2(1.0f, 1.0f);
                v2.color = col;

                v3.position = p.position - rVec * sz + uVec * sz;
                v3.normal = look;
                v3.uv = Vec2(0.0f, 1.0f);
                v3.color = col;

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
        } else if (mode == ParticleRenderMode::InstancedOctahedra) {
            mesh.vertices.reserve(activeCount * 6);
            mesh.indices.reserve(activeCount * 24);

            for (const auto& p : particles) {
                if (!p.active) continue;

                float sz = p.currentSize() * 0.5f;
                Vec4 col = p.currentColor();
                uint32_t baseIdx = static_cast<uint32_t>(mesh.vertices.size());

                Vec3 top = p.position + Vec3(0, sz, 0);
                Vec3 bottom = p.position - Vec3(0, sz, 0);
                Vec3 px = p.position + Vec3(sz, 0, 0);
                Vec3 nx = p.position - Vec3(sz, 0, 0);
                Vec3 pz = p.position + Vec3(0, 0, sz);
                Vec3 nz = p.position - Vec3(0, 0, sz);

                for (const auto& pos : {top, bottom, px, nx, pz, nz}) {
                    Vertex v;
                    v.position = pos;
                    v.normal = (pos - p.position).normalized();
                    v.color = col;
                    v.uv = Vec2(0.5f, 0.5f);
                    mesh.vertices.push_back(v);
                }

                mesh.indices.push_back(baseIdx + 0); mesh.indices.push_back(baseIdx + 2); mesh.indices.push_back(baseIdx + 4);
                mesh.indices.push_back(baseIdx + 0); mesh.indices.push_back(baseIdx + 4); mesh.indices.push_back(baseIdx + 3);
                mesh.indices.push_back(baseIdx + 0); mesh.indices.push_back(baseIdx + 3); mesh.indices.push_back(baseIdx + 5);
                mesh.indices.push_back(baseIdx + 0); mesh.indices.push_back(baseIdx + 5); mesh.indices.push_back(baseIdx + 2);

                mesh.indices.push_back(baseIdx + 1); mesh.indices.push_back(baseIdx + 4); mesh.indices.push_back(baseIdx + 2);
                mesh.indices.push_back(baseIdx + 1); mesh.indices.push_back(baseIdx + 3); mesh.indices.push_back(baseIdx + 4);
                mesh.indices.push_back(baseIdx + 1); mesh.indices.push_back(baseIdx + 5); mesh.indices.push_back(baseIdx + 3);
                mesh.indices.push_back(baseIdx + 1); mesh.indices.push_back(baseIdx + 2); mesh.indices.push_back(baseIdx + 5);
            }
        }

        mesh.recomputeBounds();
        return mesh;
    }
};

} // namespace particles
} // namespace scratchbox

#endif // SCRATCHBOX_PARTICLES_HPP
