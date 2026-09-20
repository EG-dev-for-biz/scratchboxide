/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

#ifndef SCRATCHBOX_SDF_HPP
#define SCRATCHBOX_SDF_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include <cmath>
#include <algorithm>

namespace scratchbox {
namespace sdf {

using math::Vec2;
using math::Vec3;

// ============================================================================
// Primitives (Inigo Quilez standard formulations)
// ============================================================================

inline float sdSphere(const Vec3& p, float radius) {
    return p.length() - radius;
}

inline float sdBox(const Vec3& p, const Vec3& b) {
    Vec3 q(std::abs(p.x) - b.x, std::abs(p.y) - b.y, std::abs(p.z) - b.z);
    Vec3 outside(std::max(q.x, 0.0f), std::max(q.y, 0.0f), std::max(q.z, 0.0f));
    float inside = std::min(std::max(q.x, std::max(q.y, q.z)), 0.0f);
    return outside.length() + inside;
}

inline float sdRoundBox(const Vec3& p, const Vec3& b, float r) {
    return sdBox(p, b) - r;
}

inline float sdTorus(const Vec3& p, float majorRadius, float minorRadius) {
    Vec2 q(Vec2(p.x, p.z).length() - majorRadius, p.y);
    return q.length() - minorRadius;
}

inline float sdCylinder(const Vec3& p, float radius, float height) {
    Vec2 d(Vec2(p.x, p.z).length() - radius, std::abs(p.y) - height * 0.5f);
    Vec2 outside(std::max(d.x, 0.0f), std::max(d.y, 0.0f));
    float inside = std::min(std::max(d.x, d.y), 0.0f);
    return outside.length() + inside;
}

inline float sdCapsule(const Vec3& p, const Vec3& a, const Vec3& b, float radius) {
    Vec3 pa = p - a;
    Vec3 ba = b - a;
    float h = std::clamp(pa.dot(ba) / ba.dot(ba), 0.0f, 1.0f);
    return (pa - ba * h).length() - radius;
}

inline float sdGyroid(const Vec3& p, float scale = 1.0f, float thickness = 0.1f) {
    Vec3 sp = p * scale;
    float g = std::abs(std::sin(sp.x) * std::cos(sp.y) +
                       std::sin(sp.y) * std::cos(sp.z) +
                       std::sin(sp.z) * std::cos(sp.x)) - thickness;
    return g / scale;
}

// ============================================================================
// Smooth CSG Boolean Operators
// ============================================================================

inline float opUnion(float d1, float d2) {
    return std::min(d1, d2);
}

inline float opSubtraction(float d1, float d2) {
    return std::max(-d1, d2);
}

inline float opIntersection(float d1, float d2) {
    return std::max(d1, d2);
}

inline float opSmoothUnion(float d1, float d2, float k = 0.2f) {
    float h = std::clamp(0.5f + 0.5f * (d2 - d1) / k, 0.0f, 1.0f);
    return std::lerp(d2, d1, h) - k * h * (1.0f - h);
}

inline float opSmoothSubtraction(float d1, float d2, float k = 0.2f) {
    float h = std::clamp(0.5f - 0.5f * (d2 + d1) / k, 0.0f, 1.0f);
    return std::lerp(d2, -d1, h) + k * h * (1.0f - h);
}

inline float opSmoothIntersection(float d1, float d2, float k = 0.2f) {
    float h = std::clamp(0.5f - 0.5f * (d2 - d1) / k, 0.0f, 1.0f);
    return std::lerp(d2, d1, h) + k * h * (1.0f - h);
}

// ============================================================================
// Domain Deformations
// ============================================================================

inline Vec3 opRepeat(const Vec3& p, const Vec3& c) {
    return Vec3(
        std::fmod(p.x + 0.5f * c.x, c.x) - 0.5f * c.x,
        std::fmod(p.y + 0.5f * c.y, c.y) - 0.5f * c.y,
        std::fmod(p.z + 0.5f * c.z, c.z) - 0.5f * c.z
    );
}

inline Vec3 opTwist(const Vec3& p, float k) {
    float c = std::cos(k * p.y);
    float s = std::sin(k * p.y);
    return Vec3(c * p.x - s * p.z, p.y, s * p.x + c * p.z);
}

inline Vec3 opBend(const Vec3& p, float k) {
    float c = std::cos(k * p.x);
    float s = std::sin(k * p.x);
    return Vec3(c * p.x - s * p.y, s * p.x + c * p.y, p.z);
}

} // namespace sdf
} // namespace scratchbox

#endif // SCRATCHBOX_SDF_HPP
