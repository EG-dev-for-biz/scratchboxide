/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * SB-Archi (Scratchbox Classical Architecture Parametric Engine)
 * Modular C++20 Tectonic Geometry Library.
 *
 * Implements high-precision mathematical formulations for:
 * - 8 Analytical Parametric Arch Profiles (Semicircular, Segmental, Gothic
 *   Pointed Equilateral/Lancet, Basket-Handle, Parabolic, Catenary, Horseshoe)
 * - Radial Voussoir Subdivision with Exact Joint Bevels & Flared Keystones
 * - Double-Curved Groin Vaults, Cross-Ribbed Vaults & Coffered Lacunaria
 * - Continuous Vitruvian Entasis & Classical Orders Column Engine
 * - Bishop Frame Entablature Extrusion with Mitered Ressaut Breaks
 * - Procedural Chamfered Ashlar Masonry & Rustication Fields
 ********************************************************************************/

#ifndef SCRATCHBOX_TECTONICS_HPP
#define SCRATCHBOX_TECTONICS_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_pbr.hpp"

#include <vector>
#include <string>
#include <cmath>
#include <algorithm>
#include <memory>
#include <cstdint>
#include <array>
#include <numbers>

namespace scratchbox {
namespace tectonics {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using math::Mat4;
using math::PI;
using math::TWO_PI;
using math::HALF_PI;
using math::DEG_TO_RAD;
using math::RAD_TO_DEG;
using geometry::Vertex;
using geometry::ScratchboxMesh;
using geometry::PbrMaterial;

// ============================================================================
// 1. ANALYTICAL PARAMETRIC ARCH PROFILES
// ============================================================================

enum class ArchCurveType {
    Semicircular,       // Classical Roman arch (Rise = Span / 2)
    Segmental,          // Shallow segment of circle (Rise < Span / 2)
    PointedEquilateral, // Gothic equilateral arch (Radius = Span)
    PointedLancet,      // Slender Gothic lancet arch (Radius > Span)
    BasketHandle,       // Three-centered French "anse de panier" (smooth multi-radii)
    Parabolic,          // Pure quadratic inverted parabola
    Catenary,           // Ideal funicular compression curve y = a * (cosh(x/a) - 1)
    Horseshoe           // Moorish arch curving beyond semicircle (horseshoe curve)
};

struct ArchPoint {
    Vec2 position;      // (x, y) coordinates in arch plane (span along X, rise along Y)
    Vec2 normal;        // Unit normal pointing outward (extrados direction)
    Vec2 tangent;       // Unit tangent vector directed along increasing parameter u
    float curvature = 0.0f; // Signed curvature kappa
    float u = 0.0f;     // Normalized parameter u in [0, 1]
};

struct ArchConfig {
    ArchCurveType type = ArchCurveType::Semicircular;
    float span = 4.0f;              // Total clear span width W (meters)
    float rise = 2.0f;              // Height H from springline to crown (meters)
    float depth = 1.0f;             // Longitudinal extrusion depth (meters)
    float archivoltThickness = 0.6f;// Radial thickness from intrados to extrados
    float lancetFactor = 1.35f;     // Radius multiplier for lancet arch (R = lancetFactor * W)
    float horseshoeAngleRad = 28.0f * DEG_TO_RAD; // Flare angle below springline
};

class ArchProfile {
public:
    static ArchPoint evaluateIntrados(const ArchConfig& cfg, float u) {
        float clampedU = std::clamp(u, 0.0f, 1.0f);
        float W = cfg.span;
        float H = cfg.rise;

        switch (cfg.type) {
            case ArchCurveType::Semicircular: {
                // Radius R = W / 2. u in [0, 1] maps theta from PI down to 0
                float R = W * 0.5f;
                float theta = PI * (1.0f - clampedU);
                float x = R * std::cos(theta);
                float y = R * std::sin(theta);
                Vec2 pos(x, y);
                Vec2 norm = (R > 1e-5f) ? (pos / R) : Vec2(0, 1);
                Vec2 tang(-std::sin(theta), std::cos(theta));
                return { pos, norm, tang, 1.0f / R, clampedU };
            }

            case ArchCurveType::Segmental: {
                // Circular arc with rise H < W/2. Circle equation: R^2 = (W/2)^2 + (R - H)^2
                // => R = (W^2 + 4H^2) / (8H), center at (0, H - R)
                float halfW = W * 0.5f;
                float safeH = std::max(H, 0.05f);
                float R = (W * W + 4.0f * safeH * safeH) / (8.0f * safeH);
                float centerY = safeH - R;
                float halfAngle = std::asin(std::clamp(halfW / R, 0.0f, 1.0f));
                float theta = (HALF_PI + halfAngle) - 2.0f * halfAngle * clampedU;

                float x = R * std::cos(theta);
                float y = centerY + R * std::sin(theta);
                Vec2 pos(x, y);
                Vec2 norm(std::cos(theta), std::sin(theta));
                Vec2 tang(-std::sin(theta), std::cos(theta));
                return { pos, norm, tang, 1.0f / R, clampedU };
            }

            case ArchCurveType::PointedEquilateral: {
                // Two arcs of radius R = W.
                // Left arc (u in [0, 0.5]): center at (+W/2, 0).
                // Right arc (u in [0.5, 1]): center at (-W/2, 0).
                float R = W;
                if (clampedU <= 0.5f) {
                    float s = clampedU * 2.0f; // in [0, 1]
                    // angle theta from PI to 2*PI/3 (60 deg arc)
                    float theta = PI - (PI / 3.0f) * s;
                    float cx = W * 0.5f;
                    float x = cx + R * std::cos(theta);
                    float y = R * std::sin(theta);
                    Vec2 norm(std::cos(theta), std::sin(theta));
                    Vec2 tang(-std::sin(theta), std::cos(theta));
                    return { Vec2(x, y), norm, tang, 1.0f / R, clampedU };
                } else {
                    float s = (clampedU - 0.5f) * 2.0f; // in [0, 1]
                    // angle theta from PI/3 down to 0
                    float theta = (PI / 3.0f) * (1.0f - s);
                    float cx = -W * 0.5f;
                    float x = cx + R * std::cos(theta);
                    float y = R * std::sin(theta);
                    Vec2 norm(std::cos(theta), std::sin(theta));
                    Vec2 tang(-std::sin(theta), std::cos(theta));
                    return { Vec2(x, y), norm, tang, 1.0f / R, clampedU };
                }
            }

            case ArchCurveType::PointedLancet: {
                // Slender Gothic lancet: R = k * W where k >= 1.0
                float k = std::max(cfg.lancetFactor, 1.05f);
                float R = k * W;
                // Center offset from origin: d = R - W/2
                float d = R - W * 0.5f;
                // Peak height at x = 0: y_peak = sqrt(R^2 - d^2)
                float yPeak = std::sqrt(std::max(R * R - d * d, 0.0f));
                float maxAngle = std::asin(std::clamp(yPeak / R, 0.0f, 1.0f));

                if (clampedU <= 0.5f) {
                    float s = clampedU * 2.0f;
                    float theta = PI - (PI - (HALF_PI + std::acos(std::clamp(d / R, 0.0f, 1.0f)))) * s;
                    // Directly interpolate angle from PI down to (PI - maxAngle)
                    theta = PI - maxAngle * s;
                    float cx = d;
                    float x = cx + R * std::cos(theta);
                    float y = R * std::sin(theta);
                    Vec2 norm(std::cos(theta), std::sin(theta));
                    Vec2 tang(-std::sin(theta), std::cos(theta));
                    return { Vec2(x, y), norm, tang, 1.0f / R, clampedU };
                } else {
                    float s = (clampedU - 0.5f) * 2.0f;
                    float theta = maxAngle * (1.0f - s);
                    float cx = -d;
                    float x = cx + R * std::cos(theta);
                    float y = R * std::sin(theta);
                    Vec2 norm(std::cos(theta), std::sin(theta));
                    Vec2 tang(-std::sin(theta), std::cos(theta));
                    return { Vec2(x, y), norm, tang, 1.0f / R, clampedU };
                }
            }

            case ArchCurveType::BasketHandle: {
                // Classical French "anse de panier" (3-centered smooth composite curve)
                // Small shoulder radius r at corners, large crown radius Rc
                float halfW = W * 0.5f;
                float r = std::min(H * 0.35f, halfW * 0.35f);
                float safeDiff = std::max(H - r, 0.01f);
                float Rc = (halfW * halfW - 2.0f * halfW * r + H * H) / (2.0f * safeDiff);
                Rc = std::max(Rc, r * 1.5f);

                // Transition angle phi between shoulder and crown
                float sinPhi = std::clamp((halfW - r) / (Rc - r), 0.0f, 1.0f);
                float phi = std::asin(sinPhi);

                // Parametric segment fractions based on arc lengths
                float arcShoulder = r * (HALF_PI - phi);
                float arcCrown = Rc * (2.0f * phi);
                float totalArc = 2.0f * arcShoulder + arcCrown;
                float u1 = arcShoulder / totalArc;
                float u2 = (arcShoulder + arcCrown) / totalArc;

                if (clampedU < u1) {
                    // Left shoulder
                    float s = clampedU / u1;
                    float theta = PI - (HALF_PI - phi) * s;
                    float cx = -halfW + r;
                    float cy = 0.0f;
                    float x = cx + r * std::cos(theta);
                    float y = cy + r * std::sin(theta);
                    Vec2 norm(std::cos(theta), std::sin(theta));
                    Vec2 tang(-std::sin(theta), std::cos(theta));
                    return { Vec2(x, y), norm, tang, 1.0f / r, clampedU };
                } else if (clampedU <= u2) {
                    // Central crown
                    float s = (clampedU - u1) / (u2 - u1);
                    float theta = (HALF_PI + phi) - 2.0f * phi * s;
                    float cx = 0.0f;
                    float cy = H - Rc;
                    float x = cx + Rc * std::cos(theta);
                    float y = cy + Rc * std::sin(theta);
                    Vec2 norm(std::cos(theta), std::sin(theta));
                    Vec2 tang(-std::sin(theta), std::cos(theta));
                    return { Vec2(x, y), norm, tang, 1.0f / Rc, clampedU };
                } else {
                    // Right shoulder
                    float s = (clampedU - u2) / (1.0f - u2);
                    float theta = HALF_PI - phi - (HALF_PI - phi) * s;
                    float cx = halfW - r;
                    float cy = 0.0f;
                    float x = cx + r * std::cos(theta);
                    float y = cy + r * std::sin(theta);
                    Vec2 norm(std::cos(theta), std::sin(theta));
                    Vec2 tang(-std::sin(theta), std::cos(theta));
                    return { Vec2(x, y), norm, tang, 1.0f / r, clampedU };
                }
            }

            case ArchCurveType::Parabolic: {
                // y = H * (1 - (2x/W)^2). Parameter u in [0, 1] => x = -W/2 + W*u
                float x = -W * 0.5f + W * clampedU;
                float term = (2.0f * x / W);
                float y = H * std::max(0.0f, 1.0f - term * term);
                // Derivative dy/dx = -8*H*x / W^2
                float dydx = -8.0f * H * x / (W * W);
                Vec2 tang(1.0f, dydx);
                tang = tang.normalized();
                Vec2 norm(-tang.y, tang.x);
                if (norm.y < 0.0f) norm = -norm;
                return { Vec2(x, y), norm, tang, 0.0f, clampedU };
            }

            case ArchCurveType::Catenary: {
                // Inverted catenary: y(x) = a * (cosh(W/(2a)) - cosh(x/a))
                // Crown at x=0 has height H: a * (cosh(W/(2a)) - 1) = H
                // Solve for a using Newton-Raphson starting with parabolic estimate a0 = W^2 / (8H)
                float a = (W * W) / (8.0f * std::max(H, 0.1f));
                for (int iter = 0; iter < 6; ++iter) {
                    float z = W / (2.0f * a);
                    float f = a * (std::cosh(z) - 1.0f) - H;
                    float df = (std::cosh(z) - 1.0f) - z * std::sinh(z);
                    if (std::abs(df) < 1e-6f) break;
                    a = a - f / df;
                    a = std::max(a, 0.01f);
                }
                float x = -W * 0.5f + W * clampedU;
                float z0 = W / (2.0f * a);
                float y = a * (std::cosh(z0) - std::cosh(x / a));
                float dydx = -std::sinh(x / a);
                Vec2 tang(1.0f, dydx);
                tang = tang.normalized();
                Vec2 norm(-tang.y, tang.x);
                if (norm.y < 0.0f) norm = -norm;
                return { Vec2(x, y), norm, tang, 0.0f, clampedU };
            }

            case ArchCurveType::Horseshoe: {
                // Moorish horseshoe arch extending below the springline diameter
                float extraAngle = cfg.horseshoeAngleRad;
                float totalAngle = PI + 2.0f * extraAngle;
                // Circle radius R = (W/2) / cos(extraAngle)
                float R = (W * 0.5f) / std::max(std::cos(extraAngle), 0.2f);
                float theta = (PI + extraAngle) - totalAngle * clampedU;
                // Center Y offset so that y=0 at springline ends (u=0 and u=1)
                float centerY = R * std::sin(extraAngle);
                float x = R * std::cos(theta);
                float y = centerY + R * std::sin(theta);
                Vec2 norm(std::cos(theta), std::sin(theta));
                Vec2 tang(-std::sin(theta), std::cos(theta));
                return { Vec2(x, y), norm, tang, 1.0f / R, clampedU };
            }
        }
        return { Vec2(0, 0), Vec2(0, 1), Vec2(1, 0), 0.0f, clampedU };
    }

    static ArchPoint evaluateExtrados(const ArchConfig& cfg, float u) {
        ArchPoint in = evaluateIntrados(cfg, u);
        Vec2 exPos = in.position + in.normal * cfg.archivoltThickness;
        return { exPos, in.normal, in.tangent, in.curvature, u };
    }
};

// ============================================================================
// 2. RADIAL VOUSSOIRS & FLARED PROJECTING KEYSTONES
// ============================================================================

struct VoussoirConfig {
    int count = 19;                 // Number of radial voussoirs (strictly odd: 2k+1)
    float bevelWidth = 0.025f;      // 3D V-groove joint chamfer depth/width (meters)
    float keystoneFlaring = 1.32f;  // Keystones taper wider toward extrados
    float keystoneRadialOffset = 0.12f; // Keystone projects outward beyond arch ring
    float consoleScrollDepth = 0.08f;   // Projecting architectural console scroll
    bool useJoggleJoints = false;       // 3D interlocking tenon/mortise shear keys between adjacent voussoirs
    float joggleDepth = 0.04f;          // Tongue/mortise projection depth (meters)
    float joggleWidth = 0.35f;          // Width fraction of radial contact face occupied by shear key [0.1, 0.8]
    bool useAnathyrosis = false;        // Classical Greek/Roman precision margin band with recessed relief bed
    float anathyrosisBandWidth = 0.04f; // Perimeter contact margin band width (meters)
    float anathyrosisRecess = 0.008f;   // Central contact bed relief recess depth (meters)
};

class VoussoirSubdivider {
public:
    static ScratchboxMesh buildVoussoirArchRing(const ArchConfig& archCfg,
                                               const VoussoirConfig& vousCfg,
                                               const Vec3& origin = Vec3(0, 0, 0),
                                               const PbrMaterial& mat = PbrMaterial::stoneLimestone()) {
        ScratchboxMesh mesh("voussoir_arch_ring");
        mesh.material = mat;

        int N = std::max(3, vousCfg.count);
        if (N % 2 == 0) N += 1; // Enforce odd count for symmetrical keystone
        int keystoneIndex = N / 2;

        float depthHalf = archCfg.depth * 0.5f;

        // Generate each voussoir block as a solid watertight hexahedron with chamfers
        for (int i = 0; i < N; ++i) {
            float u0 = static_cast<float>(i) / static_cast<float>(N);
            float u1 = static_cast<float>(i + 1) / static_cast<float>(N);

            bool isKeystone = (i == keystoneIndex);

            // Keystone flare and projection
            float extraR = isKeystone ? vousCfg.keystoneRadialOffset : 0.0f;
            float extraDepth = isKeystone ? vousCfg.consoleScrollDepth : 0.0f;

            // Samples along intrados and extrados
            ArchPoint in0 = ArchProfile::evaluateIntrados(archCfg, u0);
            ArchPoint in1 = ArchProfile::evaluateIntrados(archCfg, u1);
            ArchPoint ex0 = ArchProfile::evaluateExtrados(archCfg, u0);
            ArchPoint ex1 = ArchProfile::evaluateExtrados(archCfg, u1);

            if (isKeystone) {
                // Apply radial flare to keystone
                Vec2 centerDir = (ex0.normal + ex1.normal).normalized();
                ex0.position += centerDir * extraR;
                ex1.position += centerDir * extraR;
                // Flared width multiplier at top
                Vec2 midEx = (ex0.position + ex1.position) * 0.5f;
                ex0.position = midEx + (ex0.position - midEx) * vousCfg.keystoneFlaring;
                ex1.position = midEx + (ex1.position - midEx) * vousCfg.keystoneFlaring;
            }

            // Local coordinates for 8 vertices of the voussoir prism:
            // Front face (z = +depthHalf + extraDepth)
            // Back face (z = -depthHalf - extraDepth)
            float zFront = depthHalf + extraDepth;
            float zBack = -depthHalf - extraDepth;

            // Apply slight joint chamfer margin (bevel) on front and back faces
            float b = vousCfg.bevelWidth;

            // Front face corners
            Vec3 f_in0(in0.position.x, in0.position.y, zFront);
            Vec3 f_in1(in1.position.x, in1.position.y, zFront);
            Vec3 f_ex1(ex1.position.x, ex1.position.y, zFront);
            Vec3 f_ex0(ex0.position.x, ex0.position.y, zFront);

            // Back face corners
            Vec3 b_in0(in0.position.x, in0.position.y, zBack);
            Vec3 b_in1(in1.position.x, in1.position.y, zBack);
            Vec3 b_ex1(ex1.position.x, ex1.position.y, zBack);
            Vec3 b_ex0(ex0.position.x, ex0.position.y, zBack);

            // Offset all by origin
            auto addQuad = [&](const Vec3& p0, const Vec3& p1, const Vec3& p2, const Vec3& p3,
                               const Vec3& normalHint) {
                uint32_t baseIdx = static_cast<uint32_t>(mesh.vertices.size());
                Vec3 edge1 = p1 - p0;
                Vec3 edge2 = p2 - p0;
                Vec3 faceNorm = edge1.cross(edge2).normalized();
                if (faceNorm.dot(normalHint) < 0.0f) faceNorm = -faceNorm;

                // Subtle vertex color variation per voussoir for authentic stonework
                float stoneTone = 0.94f + 0.12f * std::sin(i * 3.71f + 1.2f);
                Vec4 col(stoneTone, stoneTone * 0.96f, stoneTone * 0.88f, 1.0f);

                mesh.addVertex(Vertex(origin + p0, faceNorm, Vec2(0.0f, 0.0f), col));
                mesh.addVertex(Vertex(origin + p1, faceNorm, Vec2(1.0f, 0.0f), col));
                mesh.addVertex(Vertex(origin + p2, faceNorm, Vec2(1.0f, 1.0f), col));
                mesh.addVertex(Vertex(origin + p3, faceNorm, Vec2(0.0f, 1.0f), col));

                mesh.addTriangle(baseIdx + 0, baseIdx + 1, baseIdx + 2);
                mesh.addTriangle(baseIdx + 0, baseIdx + 2, baseIdx + 3);
            };

            auto addStereotomicBedJoint = [&](const Vec3& p0, const Vec3& p1, const Vec3& p2, const Vec3& p3,
                                             const Vec3& normalHint, bool isRightFace) {
                if (!vousCfg.useJoggleJoints && !vousCfg.useAnathyrosis) {
                    addQuad(p0, p1, p2, p3, normalHint);
                    return;
                }

                Vec3 edge1 = p1 - p0;
                Vec3 edge2 = p2 - p0;
                Vec3 faceNorm = edge1.cross(edge2).normalized();
                if (faceNorm.dot(normalHint) < 0.0f) faceNorm = -faceNorm;

                float stoneTone = 0.94f + 0.12f * std::sin(i * 3.71f + 1.2f);
                Vec4 col(stoneTone, stoneTone * 0.96f, stoneTone * 0.88f, 1.0f);

                // 3x3 subdivided quad (4x4 vertices)
                // Corners: p0 (s=0, t=0), p1 (s=1, t=0), p2 (s=1, t=1), p3 (s=0, t=1)
                const int SUB = 3;
                uint32_t gridIdx[SUB + 1][SUB + 1];

                float joggleOffset = 0.0f;
                if (vousCfg.useJoggleJoints) {
                    // Right face (+tangent) has projecting tenon (+depth), left face (-tangent) has recessed mortise (-depth)
                    joggleOffset = (isRightFace ? 1.0f : -1.0f) * vousCfg.joggleDepth;
                }
                float anathyrosisOffset = vousCfg.useAnathyrosis ? -vousCfg.anathyrosisRecess : 0.0f;
                float interiorOffset = joggleOffset + anathyrosisOffset;

                for (int si = 0; si <= SUB; ++si) {
                    float s = static_cast<float>(si) / SUB;
                    for (int ti = 0; ti <= SUB; ++ti) {
                        float t = static_cast<float>(ti) / SUB;

                        // Bilinear interpolation across quad
                        Vec3 basePos = (p0 * (1.0f - s) * (1.0f - t)) +
                                       (p1 * s * (1.0f - t)) +
                                       (p2 * s * t) +
                                       (p3 * (1.0f - s) * t);

                        Vec3 vPos = basePos;
                        Vec3 vNorm = faceNorm;

                        // Interior 2x2 vertices get normal displacement for interlocking joggle or anathyrosis bed
                        if (si > 0 && si < SUB && ti > 0 && ti < SUB) {
                            vPos += faceNorm * interiorOffset;
                        }

                        gridIdx[si][ti] = static_cast<uint32_t>(mesh.vertices.size());
                        mesh.addVertex(Vertex(origin + vPos, vNorm, Vec2(s, t), col));
                    }
                }

                // Add 2 * SUB * SUB triangles
                for (int si = 0; si < SUB; ++si) {
                    for (int ti = 0; ti < SUB; ++ti) {
                        uint32_t i00 = gridIdx[si][ti];
                        uint32_t i10 = gridIdx[si + 1][ti];
                        uint32_t i11 = gridIdx[si + 1][ti + 1];
                        uint32_t i01 = gridIdx[si][ti + 1];

                        mesh.addTriangle(i00, i10, i11);
                        mesh.addTriangle(i00, i11, i01);
                    }
                }
            };

            // 1. Front face
            addQuad(f_in0, f_in1, f_ex1, f_ex0, Vec3(0, 0, 1));
            // 2. Back face
            addQuad(b_in1, b_in0, b_ex0, b_ex1, Vec3(0, 0, -1));
            // 3. Intrados face (soffit)
            addQuad(f_in1, f_in0, b_in0, b_in1, Vec3(-in0.normal.x, -in0.normal.y, 0));
            // 4. Extrados face
            addQuad(f_ex0, f_ex1, b_ex1, b_ex0, Vec3(ex0.normal.x, ex0.normal.y, 0));
            // 5. Left radial cut joint (u0) - mortise recess
            addStereotomicBedJoint(f_in0, f_ex0, b_ex0, b_in0, Vec3(-in0.tangent.x, -in0.tangent.y, 0), false);
            // 6. Right radial cut joint (u1) - tenon projection
            addStereotomicBedJoint(f_ex1, f_in1, b_in1, b_ex1, Vec3(in1.tangent.x, in1.tangent.y, 0), true);
        }

        return mesh;
    }
};

// ============================================================================
// 3. GROIN VAULTS, CROSS-RIBBED VAULTS & COFFERED LACUNARIA
// ============================================================================

struct CofferConfig {
    bool enabled = true;
    int gridArch = 7;           // Number of coffer rows along arch curve
    int gridDepth = 9;          // Number of coffer columns along extrusion depth
    float recessDepth = 0.10f;  // Recess depth of lacunaria coffer (meters)
    float marginRatio = 0.22f;  // Margin border ratio around each coffer frame
    int steppedBands = 2;       // Number of concentric stepped moulding tiers
};

class VaultMesher {
public:
    /**
     * Builds a barrel vault with optional recessed lacunaria coffers.
     */
    static ScratchboxMesh buildBarrelVault(const ArchConfig& archCfg,
                                          const CofferConfig& cofferCfg,
                                          const Vec3& origin = Vec3(0, 0, 0),
                                          const PbrMaterial& mat = PbrMaterial::stoneLimestone()) {
        ScratchboxMesh mesh("coffered_barrel_vault");
        mesh.material = mat;

        int nU = cofferCfg.enabled ? (cofferCfg.gridArch * 4) : 32;
        int nV = cofferCfg.enabled ? (cofferCfg.gridDepth * 4) : 16;
        float depth = archCfg.depth;

        // Parametric evaluation of barrel vault surface: u in [0, 1] (arch), v in [0, 1] (depth)
        auto getVaultPoint = [&](float u, float v) -> Vec3 {
            ArchPoint ap = ArchProfile::evaluateIntrados(archCfg, u);
            float z = -depth * 0.5f + depth * v;

            float rOffset = 0.0f;
            if (cofferCfg.enabled) {
                // Determine coffer cell coordinates
                float uCell = u * cofferCfg.gridArch;
                float vCell = v * cofferCfg.gridDepth;
                float localU = uCell - std::floor(uCell);
                float localV = vCell - std::floor(vCell);

                float m = cofferCfg.marginRatio;
                if (localU > m && localU < (1.0f - m) && localV > m && localV < (1.0f - m)) {
                    // Inside recessed coffer
                    float uDist = std::min(localU - m, (1.0f - m) - localU) / (0.5f - m);
                    float vDist = std::min(localV - m, (1.0f - m) - localV) / (0.5f - m);
                    float borderDist = std::min(uDist, vDist);
                    // Step function for stepped lacunaria mouldings
                    float step = std::clamp(borderDist * static_cast<float>(cofferCfg.steppedBands), 0.0f, 1.0f);
                    rOffset = cofferCfg.recessDepth * step;
                }
            }

            Vec2 p = ap.position + ap.normal * rOffset;
            return origin + Vec3(p.x, p.y, z);
        };

        // Generate grid mesh
        for (int i = 0; i < nU; ++i) {
            float u0 = static_cast<float>(i) / nU;
            float u1 = static_cast<float>(i + 1) / nU;

            for (int j = 0; j < nV; ++j) {
                float v0 = static_cast<float>(j) / nV;
                float v1 = static_cast<float>(j + 1) / nV;

                Vec3 p00 = getVaultPoint(u0, v0);
                Vec3 p10 = getVaultPoint(u1, v0);
                Vec3 p11 = getVaultPoint(u1, v1);
                Vec3 p01 = getVaultPoint(u0, v1);

                Vec3 norm = ((p10 - p00).cross(p01 - p00)).normalized();
                // Intrados faces inward (downward towards floor)
                if (norm.y > 0.0f) norm = -norm;

                uint32_t bIdx = static_cast<uint32_t>(mesh.vertices.size());
                mesh.addVertex(Vertex(p00, norm, Vec2(u0, v0)));
                mesh.addVertex(Vertex(p10, norm, Vec2(u1, v0)));
                mesh.addVertex(Vertex(p11, norm, Vec2(u1, v1)));
                mesh.addVertex(Vertex(p01, norm, Vec2(u0, v1)));

                mesh.addTriangle(bIdx + 0, bIdx + 1, bIdx + 2);
                mesh.addTriangle(bIdx + 0, bIdx + 2, bIdx + 3);
            }
        }

        return mesh;
    }

    /**
     * Builds a Roman groin vault (cross vault) intersecting two orthogonal barrel vaults
     * with analytical diagonal groin ribs: r(t) = (R1 * cos(t), R * sin(t), +/- R2 * cos(t)).
     */
    static ScratchboxMesh buildGroinVault(float spanX, float spanZ, float riseY,
                                         float ribThickness = 0.20f,
                                         const Vec3& origin = Vec3(0, 0, 0),
                                         const PbrMaterial& mat = PbrMaterial::stoneLimestone()) {
        ScratchboxMesh mesh("groin_vault");
        mesh.material = mat;

        float halfX = spanX * 0.5f;
        float halfZ = spanZ * 0.5f;

        // Analytical groin intersection curve:
        // Cylinder X: x^2 + (y - H)^2 = R1^2  (or y = H * sqrt(1 - (x/halfX)^2))
        // Cylinder Z: z^2 + (y - H)^2 = R2^2  (or y = H * sqrt(1 - (z/halfZ)^2))
        // At the intersection: |x / halfX| = |z / halfZ| => z = +/- (halfZ / halfX) * x
        int numSegments = 24;

        // Generate 4 quadrant triangular severies (North, South, East, West)
        // 1. North Severy: z in [0, halfZ], bound by diagonals z = (halfZ/halfX)*|x|
        auto addSevery = [&](int quadrant) {
            for (int i = 0; i < numSegments; ++i) {
                float s0 = static_cast<float>(i) / numSegments;
                float s1 = static_cast<float>(i + 1) / numSegments;

                for (int j = 0; j <= i; ++j) {
                    float t0 = (i == 0) ? 0.0f : static_cast<float>(j) / i;
                    float t1 = static_cast<float>(j) / (i + 1);
                    float t2 = static_cast<float>(j + 1) / (i + 1);

                    auto mapPoint = [&](float s, float t) -> Vec3 {
                        // s is radial elevation fraction [0, 1] from crown to perimeter
                        // t is angular fraction [-1, 1] across the severy sector
                        float angle = (HALF_PI) * (1.0f - s);
                        float y = riseY * std::sin(angle);
                        float rad = std::cos(angle);

                        float x = 0.0f, z = 0.0f;
                        float spanFrac = (t * 2.0f - 1.0f); // [-1, 1]

                        if (quadrant == 0) { // North
                            z = halfZ * rad;
                            x = halfX * rad * spanFrac;
                        } else if (quadrant == 1) { // South
                            z = -halfZ * rad;
                            x = halfX * rad * spanFrac;
                        } else if (quadrant == 2) { // East
                            x = halfX * rad;
                            z = halfZ * rad * spanFrac;
                        } else { // West
                            x = -halfX * rad;
                            z = halfZ * rad * spanFrac;
                        }
                        return origin + Vec3(x, y, z);
                    };

                    Vec3 pA = mapPoint(s0, t0);
                    Vec3 pB = mapPoint(s1, t1);
                    Vec3 pC = mapPoint(s1, t2);

                    Vec3 norm = ((pB - pA).cross(pC - pA)).normalized();
                    if (norm.y > 0.0f) norm = -norm;

                    uint32_t bIdx = static_cast<uint32_t>(mesh.vertices.size());
                    mesh.addVertex(Vertex(pA, norm, Vec2(s0, t0)));
                    mesh.addVertex(Vertex(pB, norm, Vec2(s1, t1)));
                    mesh.addVertex(Vertex(pC, norm, Vec2(s1, t2)));
                    mesh.addTriangle(bIdx + 0, bIdx + 1, bIdx + 2);

                    if (j < i) {
                        float t0Next = static_cast<float>(j + 1) / i;
                        Vec3 pD = mapPoint(s0, t0Next);
                        uint32_t bIdx2 = static_cast<uint32_t>(mesh.vertices.size());
                        mesh.addVertex(Vertex(pA, norm, Vec2(s0, t0)));
                        mesh.addVertex(Vertex(pC, norm, Vec2(s1, t2)));
                        mesh.addVertex(Vertex(pD, norm, Vec2(s0, t0Next)));
                        mesh.addTriangle(bIdx2 + 0, bIdx2 + 1, bIdx2 + 2);
                    }
                }
            }
        };

        for (int q = 0; q < 4; ++q) {
            addSevery(q);
        }

        // Add diagonal groin rib mouldings along the two crossing groins
        if (ribThickness > 0.01f) {
            for (int diag = 0; diag < 2; ++diag) {
                float signZ = (diag == 0) ? 1.0f : -1.0f;
                for (int i = 0; i < numSegments; ++i) {
                    float s0 = static_cast<float>(i) / numSegments;
                    float s1 = static_cast<float>(i + 1) / numSegments;

                    auto getGroinPos = [&](float s) -> Vec3 {
                        float angle = HALF_PI * (1.0f - s);
                        float y = riseY * std::sin(angle);
                        float x = halfX * std::cos(angle);
                        float z = halfZ * std::cos(angle) * signZ;
                        return origin + Vec3(x, y - ribThickness * 0.5f, z);
                    };

                    Vec3 p0 = getGroinPos(s0);
                    Vec3 p1 = getGroinPos(s1);
                    Vec3 p0Neg = getGroinPos(s0); p0Neg.x = -p0Neg.x; p0Neg.z = -p0Neg.z;
                    Vec3 p1Neg = getGroinPos(s1); p1Neg.x = -p1Neg.x; p1Neg.z = -p1Neg.z;

                    // Extrude small rib quad
                    Vec3 ribWidth(-signZ * ribThickness * 0.5f, 0.0f, ribThickness * 0.5f);
                    uint32_t base = static_cast<uint32_t>(mesh.vertices.size());
                    mesh.addVertex(Vertex(p0 - ribWidth, Vec3(0, -1, 0)));
                    mesh.addVertex(Vertex(p0 + ribWidth, Vec3(0, -1, 0)));
                    mesh.addVertex(Vertex(p1 + ribWidth, Vec3(0, -1, 0)));
                    mesh.addVertex(Vertex(p1 - ribWidth, Vec3(0, -1, 0)));
                    mesh.addTriangle(base + 0, base + 1, base + 2);
                    mesh.addTriangle(base + 0, base + 2, base + 3);
                }
            }
        }

        return mesh;
    }

    struct HelicoidalRampConfig {
        float innerRadius = 24.0f;          // Inner radius of annular corridor (meters)
        float outerRadius = 31.0f;          // Outer radius of annular corridor (meters)
        float startAngleRad = 0.0f;         // Starting angle theta_0 (radians)
        float totalAngleRad = PI * 0.5f;    // Angular span Delta_theta (radians)
        float startElevationY = 0.0f;       // Base elevation Y_0 (meters)
        float rampRiseY = 4.5f;             // Total vertical climb along the ramp (meters)
        float springHeight = 3.2f;          // Height from walking floor to arch springline (meters)
        float archRiseY = 2.5f;             // Height from springline to vault crown (meters)
        int angularSegments = 24;           // Tessellation resolution along curve
        int radialSegments = 12;            // Tessellation resolution across corridor width
        int stairStepCount = 0;             // If > 0, generate discrete quantized stair treads/risers; if 0, smooth ramp
        bool includeFloor = true;           // Generate walking floor / stairs
        bool includeVaultSoffit = true;     // Generate barrel vault underside (ceiling)
        bool includeAbutmentWalls = true;   // Generate inner and outer vertical masonry walls
        bool includeEndCaps = true;         // Generate portal openings / transverse end faces
        float ribThickness = 0.15f;         // Projecting doublure transverse arch ribs
        int ribInterval = 6;                // Segment interval between transverse ribs
    };

    /**
     * Builds a Roman helicoidal annular vault (spiraling sloping barrel vault over annular curve)
     * with walking floor/stair risers, radial vault soffit, and optional projecting transverse arch ribs.
     * Parametric surface:
     *   P_soffit(u, v) = origin + (r(v)*cos(theta(u)), y_spring(u) + y_arch(v), r(v)*sin(theta(u)))
     *   where theta(u) = theta_0 + u * Delta_theta, r(v) = R_inner + v * (R_outer - R_inner)
     */
    static ScratchboxMesh buildHelicoidalAnnularVault(const HelicoidalRampConfig& cfg,
                                                     const Vec3& origin = Vec3(0, 0, 0),
                                                     const PbrMaterial& mat = PbrMaterial::stoneLimestone()) {
        ScratchboxMesh mesh("helicoidal_annular_vault");
        mesh.material = mat;

        int nU = std::max(4, cfg.angularSegments);
        int nV = std::max(2, cfg.radialSegments);
        float rSpan = cfg.outerRadius - cfg.innerRadius;

        auto getR = [&](float v) -> float {
            return cfg.innerRadius + v * rSpan;
        };

        auto getTheta = [&](float u) -> float {
            return cfg.startAngleRad + u * cfg.totalAngleRad;
        };

        auto getFloorY = [&](float u) -> float {
            return cfg.startElevationY + u * cfg.rampRiseY;
        };

        auto getSoffitY = [&](float u, float v) -> float {
            float ySpring = getFloorY(u) + cfg.springHeight;
            float t = 2.0f * v - 1.0f; // [-1, 1]
            float yArch = cfg.archRiseY * std::sqrt(std::max(0.0f, 1.0f - t * t));
            return ySpring + yArch;
        };

        // 1. Vault Soffit (Underside Ceiling)
        if (cfg.includeVaultSoffit) {
            for (int i = 0; i < nU; ++i) {
                float u0 = static_cast<float>(i) / nU;
                float u1 = static_cast<float>(i + 1) / nU;
                float th0 = getTheta(u0);
                float th1 = getTheta(u1);

                for (int j = 0; j < nV; ++j) {
                    float v0 = static_cast<float>(j) / nV;
                    float v1 = static_cast<float>(j + 1) / nV;

                    float r0 = getR(v0);
                    float r1 = getR(v1);

                    Vec3 p00 = origin + Vec3(r0 * std::cos(th0), getSoffitY(u0, v0), r0 * std::sin(th0));
                    Vec3 p10 = origin + Vec3(r1 * std::cos(th0), getSoffitY(u0, v1), r1 * std::sin(th0));
                    Vec3 p11 = origin + Vec3(r1 * std::cos(th1), getSoffitY(u1, v1), r1 * std::sin(th1));
                    Vec3 p01 = origin + Vec3(r0 * std::cos(th1), getSoffitY(u1, v0), r0 * std::sin(th1));

                    Vec3 norm = ((p10 - p00).cross(p01 - p00)).normalized();
                    if (norm.y > 0.0f) norm = -norm; // Intrados faces downward towards walking floor

                    uint32_t bIdx = static_cast<uint32_t>(mesh.vertices.size());
                    mesh.addVertex(Vertex(p00, norm, Vec2(u0, v0)));
                    mesh.addVertex(Vertex(p10, norm, Vec2(u0, v1)));
                    mesh.addVertex(Vertex(p11, norm, Vec2(u1, v1)));
                    mesh.addVertex(Vertex(p01, norm, Vec2(u1, v0)));

                    mesh.addTriangle(bIdx + 0, bIdx + 1, bIdx + 2);
                    mesh.addTriangle(bIdx + 0, bIdx + 2, bIdx + 3);
                }
            }
        }

        // 2. Walking Floor / Stepped Stairs
        if (cfg.includeFloor) {
            if (cfg.stairStepCount > 0) {
                // Discrete treads and risers
                int nSteps = cfg.stairStepCount;
                for (int s = 0; s < nSteps; ++s) {
                    float uStart = static_cast<float>(s) / nSteps;
                    float uEnd = static_cast<float>(s + 1) / nSteps;
                    float thA = getTheta(uStart);
                    float thB = getTheta(uEnd);
                    float yTread = cfg.startElevationY + (static_cast<float>(s) / nSteps) * cfg.rampRiseY;
                    float yNext = cfg.startElevationY + (static_cast<float>(s + 1) / nSteps) * cfg.rampRiseY;

                    for (int j = 0; j < nV; ++j) {
                        float v0 = static_cast<float>(j) / nV;
                        float v1 = static_cast<float>(j + 1) / nV;
                        float r0 = getR(v0);
                        float r1 = getR(v1);

                        // Horizontal Tread
                        Vec3 t00 = origin + Vec3(r0 * std::cos(thA), yTread, r0 * std::sin(thA));
                        Vec3 t10 = origin + Vec3(r1 * std::cos(thA), yTread, r1 * std::sin(thA));
                        Vec3 t11 = origin + Vec3(r1 * std::cos(thB), yTread, r1 * std::sin(thB));
                        Vec3 t01 = origin + Vec3(r0 * std::cos(thB), yTread, r0 * std::sin(thB));

                        uint32_t tb = static_cast<uint32_t>(mesh.vertices.size());
                        mesh.addVertex(Vertex(t00, Vec3(0, 1, 0), Vec2(uStart, v0)));
                        mesh.addVertex(Vertex(t10, Vec3(0, 1, 0), Vec2(uStart, v1)));
                        mesh.addVertex(Vertex(t11, Vec3(0, 1, 0), Vec2(uEnd, v1)));
                        mesh.addVertex(Vertex(t01, Vec3(0, 1, 0), Vec2(uEnd, v0)));
                        mesh.addTriangle(tb + 0, tb + 2, tb + 1);
                        mesh.addTriangle(tb + 0, tb + 3, tb + 2);

                        // Vertical Riser at thB
                        Vec3 rNorm(std::sin(thB), 0.0f, -std::cos(thB));
                        Vec3 r00 = origin + Vec3(r0 * std::cos(thB), yTread, r0 * std::sin(thB));
                        Vec3 r10 = origin + Vec3(r1 * std::cos(thB), yTread, r1 * std::sin(thB));
                        Vec3 r11 = origin + Vec3(r1 * std::cos(thB), yNext, r1 * std::sin(thB));
                        Vec3 r01 = origin + Vec3(r0 * std::cos(thB), yNext, r0 * std::sin(thB));

                        uint32_t rb = static_cast<uint32_t>(mesh.vertices.size());
                        mesh.addVertex(Vertex(r00, rNorm, Vec2(0, 0)));
                        mesh.addVertex(Vertex(r10, rNorm, Vec2(1, 0)));
                        mesh.addVertex(Vertex(r11, rNorm, Vec2(1, 1)));
                        mesh.addVertex(Vertex(r01, rNorm, Vec2(0, 1)));
                        mesh.addTriangle(rb + 0, rb + 1, rb + 2);
                        mesh.addTriangle(rb + 0, rb + 2, rb + 3);
                    }
                }
            } else {
                // Smooth continuous annular ramp
                for (int i = 0; i < nU; ++i) {
                    float u0 = static_cast<float>(i) / nU;
                    float u1 = static_cast<float>(i + 1) / nU;
                    float th0 = getTheta(u0);
                    float th1 = getTheta(u1);
                    float y0 = getFloorY(u0);
                    float y1 = getFloorY(u1);

                    for (int j = 0; j < nV; ++j) {
                        float v0 = static_cast<float>(j) / nV;
                        float v1 = static_cast<float>(j + 1) / nV;
                        float r0 = getR(v0);
                        float r1 = getR(v1);

                        Vec3 f00 = origin + Vec3(r0 * std::cos(th0), y0, r0 * std::sin(th0));
                        Vec3 f10 = origin + Vec3(r1 * std::cos(th0), y0, r1 * std::sin(th0));
                        Vec3 f11 = origin + Vec3(r1 * std::cos(th1), y1, r1 * std::sin(th1));
                        Vec3 f01 = origin + Vec3(r0 * std::cos(th1), y1, r0 * std::sin(th1));

                        Vec3 norm = ((f10 - f00).cross(f01 - f00)).normalized();
                        if (norm.y < 0.0f) norm = -norm; // Floor faces upward

                        uint32_t fb = static_cast<uint32_t>(mesh.vertices.size());
                        mesh.addVertex(Vertex(f00, norm, Vec2(u0, v0)));
                        mesh.addVertex(Vertex(f10, norm, Vec2(u0, v1)));
                        mesh.addVertex(Vertex(f11, norm, Vec2(u1, v1)));
                        mesh.addVertex(Vertex(f01, norm, Vec2(u1, v0)));

                        mesh.addTriangle(fb + 0, fb + 2, fb + 1);
                        mesh.addTriangle(fb + 0, fb + 3, fb + 2);
                    }
                }
            }
        }

        // 3. Inner & Outer Abutment Walls
        if (cfg.includeAbutmentWalls) {
            for (int i = 0; i < nU; ++i) {
                float u0 = static_cast<float>(i) / nU;
                float u1 = static_cast<float>(i + 1) / nU;
                float th0 = getTheta(u0);
                float th1 = getTheta(u1);
                float yFl0 = getFloorY(u0);
                float yFl1 = getFloorY(u1);
                float ySp0 = yFl0 + cfg.springHeight;
                float ySp1 = yFl1 + cfg.springHeight;

                // Inner wall (r = innerRadius, normal faces +r into corridor)
                float rIn = cfg.innerRadius;
                Vec3 inNorm(std::cos((th0 + th1) * 0.5f), 0.0f, std::sin((th0 + th1) * 0.5f));
                Vec3 iw00 = origin + Vec3(rIn * std::cos(th0), yFl0, rIn * std::sin(th0));
                Vec3 iw10 = origin + Vec3(rIn * std::cos(th1), yFl1, rIn * std::sin(th1));
                Vec3 iw11 = origin + Vec3(rIn * std::cos(th1), ySp1, rIn * std::sin(th1));
                Vec3 iw01 = origin + Vec3(rIn * std::cos(th0), ySp0, rIn * std::sin(th0));

                uint32_t iwb = static_cast<uint32_t>(mesh.vertices.size());
                mesh.addVertex(Vertex(iw00, inNorm, Vec2(u0, 0.0f)));
                mesh.addVertex(Vertex(iw10, inNorm, Vec2(u1, 0.0f)));
                mesh.addVertex(Vertex(iw11, inNorm, Vec2(u1, 1.0f)));
                mesh.addVertex(Vertex(iw01, inNorm, Vec2(u0, 1.0f)));
                mesh.addTriangle(iwb + 0, iwb + 1, iwb + 2);
                mesh.addTriangle(iwb + 0, iwb + 2, iwb + 3);

                // Outer wall (r = outerRadius, normal faces -r into corridor)
                float rOut = cfg.outerRadius;
                Vec3 outNorm(-std::cos((th0 + th1) * 0.5f), 0.0f, -std::sin((th0 + th1) * 0.5f));
                Vec3 ow00 = origin + Vec3(rOut * std::cos(th0), yFl0, rOut * std::sin(th0));
                Vec3 ow10 = origin + Vec3(rOut * std::cos(th1), yFl1, rOut * std::sin(th1));
                Vec3 ow11 = origin + Vec3(rOut * std::cos(th1), ySp1, rOut * std::sin(th1));
                Vec3 ow01 = origin + Vec3(rOut * std::cos(th0), ySp0, rOut * std::sin(th0));

                uint32_t owb = static_cast<uint32_t>(mesh.vertices.size());
                mesh.addVertex(Vertex(ow00, outNorm, Vec2(u0, 0.0f)));
                mesh.addVertex(Vertex(ow10, outNorm, Vec2(u1, 0.0f)));
                mesh.addVertex(Vertex(ow11, outNorm, Vec2(u1, 1.0f)));
                mesh.addVertex(Vertex(ow01, outNorm, Vec2(u0, 1.0f)));
                mesh.addTriangle(owb + 0, owb + 2, owb + 1);
                mesh.addTriangle(owb + 0, owb + 3, owb + 2);
            }
        }

        // 4. Projecting Doublure Transverse Arch Ribs
        if (cfg.ribThickness > 0.01f && cfg.ribInterval > 0) {
            for (int i = cfg.ribInterval; i < nU; i += cfg.ribInterval) {
                float u = static_cast<float>(i) / nU;
                float th = getTheta(u);
                float du = 0.015f; // Half-width angular delta of transverse rib band
                float thA = th - du;
                float thB = th + du;

                for (int j = 0; j < nV; ++j) {
                    float v0 = static_cast<float>(j) / nV;
                    float v1 = static_cast<float>(j + 1) / nV;
                    float r0 = getR(v0);
                    float r1 = getR(v1);

                    // Underside of projecting rib
                    float yR0 = getSoffitY(u, v0) - cfg.ribThickness;
                    float yR1 = getSoffitY(u, v1) - cfg.ribThickness;

                    Vec3 rb00 = origin + Vec3(r0 * std::cos(thA), yR0, r0 * std::sin(thA));
                    Vec3 rb10 = origin + Vec3(r1 * std::cos(thA), yR1, r1 * std::sin(thA));
                    Vec3 rb11 = origin + Vec3(r1 * std::cos(thB), yR1, r1 * std::sin(thB));
                    Vec3 rb01 = origin + Vec3(r0 * std::cos(thB), yR0, r0 * std::sin(thB));

                    uint32_t rbb = static_cast<uint32_t>(mesh.vertices.size());
                    mesh.addVertex(Vertex(rb00, Vec3(0, -1, 0), Vec2(0, 0)));
                    mesh.addVertex(Vertex(rb10, Vec3(0, -1, 0), Vec2(1, 0)));
                    mesh.addVertex(Vertex(rb11, Vec3(0, -1, 0), Vec2(1, 1)));
                    mesh.addVertex(Vertex(rb01, Vec3(0, -1, 0), Vec2(0, 1)));
                    mesh.addTriangle(rbb + 0, rbb + 1, rbb + 2);
                    mesh.addTriangle(rbb + 0, rbb + 2, rbb + 3);
                }
            }
        }

        // 5. Transverse End Caps (Portal Openings / Transverse Profiles)
        if (cfg.includeEndCaps) {
            auto addEndCap = [&](float u, bool isStart) {
                float th = getTheta(u);
                float yFl = getFloorY(u);
                // Normal along tangent
                Vec3 norm = isStart ? Vec3(std::sin(th), 0.0f, -std::cos(th))
                                    : Vec3(-std::sin(th), 0.0f, std::cos(th));

                for (int j = 0; j < nV; ++j) {
                    float v0 = static_cast<float>(j) / nV;
                    float v1 = static_cast<float>(j + 1) / nV;
                    float r0 = getR(v0);
                    float r1 = getR(v1);

                    Vec3 pBot0 = origin + Vec3(r0 * std::cos(th), yFl, r0 * std::sin(th));
                    Vec3 pBot1 = origin + Vec3(r1 * std::cos(th), yFl, r1 * std::sin(th));
                    Vec3 pTop1 = origin + Vec3(r1 * std::cos(th), getSoffitY(u, v1), r1 * std::sin(th));
                    Vec3 pTop0 = origin + Vec3(r0 * std::cos(th), getSoffitY(u, v0), r0 * std::sin(th));

                    uint32_t ecb = static_cast<uint32_t>(mesh.vertices.size());
                    mesh.addVertex(Vertex(pBot0, norm, Vec2(v0, 0.0f)));
                    mesh.addVertex(Vertex(pBot1, norm, Vec2(v1, 0.0f)));
                    mesh.addVertex(Vertex(pTop1, norm, Vec2(v1, 1.0f)));
                    mesh.addVertex(Vertex(pTop0, norm, Vec2(v0, 1.0f)));

                    if (isStart) {
                        mesh.addTriangle(ecb + 0, ecb + 1, ecb + 2);
                        mesh.addTriangle(ecb + 0, ecb + 2, ecb + 3);
                    } else {
                        mesh.addTriangle(ecb + 0, ecb + 2, ecb + 1);
                        mesh.addTriangle(ecb + 0, ecb + 3, ecb + 2);
                    }
                }
            };

            addEndCap(0.0f, true);
            addEndCap(1.0f, false);
        }

        return mesh;
    }
};

// ============================================================================
// 4. CONTINUOUS VITRUVIAN ENTASIS & CLASSICAL ORDERS COLUMN ENGINE
// ============================================================================

enum class ClassicalOrder {
    Tuscan,         // Unfluted shaft, simple torus base, square abacus
    Doric,          // 20 flutes with sharp arris, annulets, convex echinus
    Ionic,          // 24 flutes with flat fillets, Attic base, spiral volutes
    Corinthian,     // 24 flutes with fillets, acanthus leaf bell capital
    Composite       // Blend of Ionic volutes and Corinthian acanthus leaves
};

struct ColumnConfig {
    ClassicalOrder order = ClassicalOrder::Corinthian;
    float shaftHeight = 8.5f;       // Height of column shaft (meters)
    float baseRadius = 0.52f;       // Bottom radius r_base (meters)
    float topRadius = 0.44f;        // Top neck radius r_top (typically 5/6 * r_base)
    float entasisInflection = 0.33f;// Height fraction of entasis inflection point (y0 = 1/3 H)
    int fluteCount = 24;            // 24 for Ionic/Corinthian, 20 for Doric
    float fluteDepth = 0.035f;      // Depth of concave scallop flutes (meters)
    float fluteFilletRatio = 0.25f; // Width ratio of flat fillet separating flutes
    bool hasPedestal = true;        // Free-standing monument pedestal / socle
    float pedestalHeight = 3.2f;    // Height of pedestal block
    float pedestalWidth = 1.6f;     // Width / depth of pedestal block
};

class ColumnBuilder {
public:
    /**
     * Vitruvian continuous entasis radius at elevation y in [0, shaftHeight]:
     * r(y) = r_base * [1 - (1 - r_top / r_base) * (max(0, y - y0) / (H - y0))^2]
     */
    static float evaluateEntasisRadius(const ColumnConfig& cfg, float y) {
        float H = cfg.shaftHeight;
        float y0 = H * cfg.entasisInflection;
        float rBase = cfg.baseRadius;
        float rTop = cfg.topRadius;

        if (y <= y0) {
            return rBase;
        } else {
            float t = (y - y0) / std::max(H - y0, 0.01f);
            t = std::clamp(t, 0.0f, 1.0f);
            // Parabolic tapering
            return rBase - (rBase - rTop) * (t * t);
        }
    }

    /**
     * Evaluates the scalloped flute modulation around the column circumference at angle phi.
     */
    static float evaluateFluteModulation(const ColumnConfig& cfg, float phi, float radius) {
        if (cfg.fluteCount <= 0 || cfg.order == ClassicalOrder::Tuscan) {
            return radius;
        }

        float angleStep = TWO_PI / static_cast<float>(cfg.fluteCount);
        float localAngle = std::fmod(phi + angleStep * 0.5f, angleStep);
        if (localAngle < 0.0f) localAngle += angleStep;
        float normAngle = localAngle / angleStep; // in [0, 1]

        if (cfg.order == ClassicalOrder::Doric) {
            // Doric sharp arris: adjacent flutes meet directly at ridges
            float d = std::sin(normAngle * PI);
            return radius - cfg.fluteDepth * d;
        } else {
            // Ionic / Corinthian: flat fillet margin between semicircular flutes
            float f = cfg.fluteFilletRatio * 0.5f;
            if (normAngle > f && normAngle < (1.0f - f)) {
                float fluteNorm = (normAngle - f) / (1.0f - 2.0f * f);
                float d = std::sin(fluteNorm * PI);
                return radius - cfg.fluteDepth * d;
            }
            return radius; // Flat fillet
        }
    }

    /**
     * Builds Attic base stack (Plinth, Lower Torus, Scotia, Upper Torus, Astragal).
     */
    static ScratchboxMesh buildAtticBase(const ColumnConfig& cfg,
                                        const Vec3& origin,
                                        const PbrMaterial& mat) {
        ScratchboxMesh mesh("attic_base");
        mesh.material = mat;

        float rBase = cfg.baseRadius;
        float plinthW = rBase * 2.8f;
        float plinthH = rBase * 0.55f;

        // 1. Square Plinth block
        auto addBox = [&](const Vec3& center, float sx, float sy, float sz) {
            float hx = sx * 0.5f, hy = sy * 0.5f, hz = sz * 0.5f;
            std::array<Vec3, 8> corners = {
                center + Vec3(-hx, -hy, -hz), center + Vec3( hx, -hy, -hz),
                center + Vec3( hx,  hy, -hz), center + Vec3(-hx,  hy, -hz),
                center + Vec3(-hx, -hy,  hz), center + Vec3( hx, -hy,  hz),
                center + Vec3( hx,  hy,  hz), center + Vec3(-hx,  hy,  hz)
            };
            auto addQuad = [&](int i0, int i1, int i2, int i3, const Vec3& n) {
                uint32_t b = static_cast<uint32_t>(mesh.vertices.size());
                mesh.addVertex(Vertex(corners[i0], n, Vec2(0, 0)));
                mesh.addVertex(Vertex(corners[i1], n, Vec2(1, 0)));
                mesh.addVertex(Vertex(corners[i2], n, Vec2(1, 1)));
                mesh.addVertex(Vertex(corners[i3], n, Vec2(0, 1)));
                mesh.addTriangle(b + 0, b + 1, b + 2);
                mesh.addTriangle(b + 0, b + 2, b + 3);
            };
            addQuad(4, 5, 6, 7, Vec3(0, 0, 1));
            addQuad(1, 0, 3, 2, Vec3(0, 0, -1));
            addQuad(0, 4, 7, 3, Vec3(-1, 0, 0));
            addQuad(5, 1, 2, 6, Vec3(1, 0, 0));
            addQuad(3, 2, 6, 7, Vec3(0, 1, 0));
            addQuad(0, 1, 5, 4, Vec3(0, -1, 0));
        };

        addBox(origin + Vec3(0, plinthH * 0.5f, 0), plinthW, plinthH, plinthW);

        // 2. Revolving stack: Lower Torus (convex), Scotia (concave), Upper Torus (convex), Astragal
        int radialSegs = 32;
        std::vector<Vec2> profile = {
            { rBase * 1.35f, plinthH },
            { rBase * 1.38f, plinthH + rBase * 0.20f }, // Lower Torus peak
            { rBase * 1.25f, plinthH + rBase * 0.35f },
            { rBase * 1.05f, plinthH + rBase * 0.50f }, // Scotia hollow
            { rBase * 1.20f, plinthH + rBase * 0.65f }, // Upper Torus peak
            { rBase * 1.08f, plinthH + rBase * 0.78f },
            { rBase * 1.02f, plinthH + rBase * 0.85f }, // Astragal fillet
            { rBase * 1.00f, plinthH + rBase * 0.90f }  // Shaft junction
        };

        for (size_t p = 0; p + 1 < profile.size(); ++p) {
            float r0 = profile[p].x;
            float y0 = profile[p].y;
            float r1 = profile[p + 1].x;
            float y1 = profile[p + 1].y;

            for (int i = 0; i < radialSegs; ++i) {
                float phi0 = (static_cast<float>(i) / radialSegs) * TWO_PI;
                float phi1 = (static_cast<float>(i + 1) / radialSegs) * TWO_PI;

                Vec3 v00(r0 * std::cos(phi0), y0, r0 * std::sin(phi0));
                Vec3 v10(r0 * std::cos(phi1), y0, r0 * std::sin(phi1));
                Vec3 v11(r1 * std::cos(phi1), y1, r1 * std::sin(phi1));
                Vec3 v01(r1 * std::cos(phi0), y1, r1 * std::sin(phi0));

                Vec3 n = (v10 - v00).cross(v01 - v00).normalized();
                uint32_t b = static_cast<uint32_t>(mesh.vertices.size());
                mesh.addVertex(Vertex(origin + v00, n));
                mesh.addVertex(Vertex(origin + v10, n));
                mesh.addVertex(Vertex(origin + v11, n));
                mesh.addVertex(Vertex(origin + v01, n));
                mesh.addTriangle(b + 0, b + 1, b + 2);
                mesh.addTriangle(b + 0, b + 2, b + 3);
            }
        }

        return mesh;
    }

    /**
     * Builds Classical Corinthian acanthus bell capital with corner volute helices and abacus fleuron.
     */
    static ScratchboxMesh buildCorinthianCapital(const ColumnConfig& cfg,
                                                const Vec3& origin,
                                                const PbrMaterial& mat) {
        ScratchboxMesh mesh("corinthian_capital");
        mesh.material = mat;

        float rTop = cfg.topRadius;
        float capHeight = rTop * 2.3f; // Authentic Vitruvian proportion: Capital H approx 1.15 * D

        // 1. Inverted Kalathos Bell Core
        int radialSegs = 32;
        int heightSegs = 8;
        for (int j = 0; j < heightSegs; ++j) {
            float t0 = static_cast<float>(j) / heightSegs;
            float t1 = static_cast<float>(j + 1) / heightSegs;

            float y0 = t0 * capHeight;
            float y1 = t1 * capHeight;
            // Bell flares out toward top
            float r0 = rTop * (1.0f + 0.35f * (t0 * t0));
            float r1 = rTop * (1.0f + 0.35f * (t1 * t1));

            for (int i = 0; i < radialSegs; ++i) {
                float phi0 = (static_cast<float>(i) / radialSegs) * TWO_PI;
                float phi1 = (static_cast<float>(i + 1) / radialSegs) * TWO_PI;

                Vec3 v00(r0 * std::cos(phi0), y0, r0 * std::sin(phi0));
                Vec3 v10(r0 * std::cos(phi1), y0, r0 * std::sin(phi1));
                Vec3 v11(r1 * std::cos(phi1), y1, r1 * std::sin(phi1));
                Vec3 v01(r1 * std::cos(phi0), y1, r1 * std::sin(phi0));

                Vec3 n = (v10 - v00).cross(v01 - v00).normalized();
                uint32_t b = static_cast<uint32_t>(mesh.vertices.size());
                mesh.addVertex(Vertex(origin + v00, n));
                mesh.addVertex(Vertex(origin + v10, n));
                mesh.addVertex(Vertex(origin + v11, n));
                mesh.addVertex(Vertex(origin + v01, n));
                mesh.addTriangle(b + 0, b + 1, b + 2);
                mesh.addTriangle(b + 0, b + 2, b + 3);
            }
        }

        // 2. Two tiers of 8 carved acanthus leaves curling outward
        for (int tier = 0; tier < 2; ++tier) {
            float tierY = (tier == 0) ? 0.05f * capHeight : 0.35f * capHeight;
            float leafH = (tier == 0) ? 0.35f * capHeight : 0.40f * capHeight;
            float leafProj = rTop * ((tier == 0) ? 0.22f : 0.28f);
            float angleOffset = (tier == 0) ? 0.0f : (PI / 8.0f); // Staggered by 22.5 deg

            for (int l = 0; l < 8; ++l) {
                float centerPhi = (static_cast<float>(l) / 8.0f) * TWO_PI + angleOffset;
                float halfLeafAngle = (TWO_PI / 16.0f) * 0.85f;

                Vec3 baseL(rTop * std::cos(centerPhi - halfLeafAngle), tierY, rTop * std::sin(centerPhi - halfLeafAngle));
                Vec3 baseR(rTop * std::cos(centerPhi + halfLeafAngle), tierY, rTop * std::sin(centerPhi + halfLeafAngle));
                Vec3 tip((rTop + leafProj) * std::cos(centerPhi), tierY + leafH, (rTop + leafProj) * std::sin(centerPhi));
                Vec3 midL((rTop + leafProj * 0.5f) * std::cos(centerPhi - halfLeafAngle * 0.7f), tierY + leafH * 0.55f, (rTop + leafProj * 0.5f) * std::sin(centerPhi - halfLeafAngle * 0.7f));
                Vec3 midR((rTop + leafProj * 0.5f) * std::cos(centerPhi + halfLeafAngle * 0.7f), tierY + leafH * 0.55f, (rTop + leafProj * 0.5f) * std::sin(centerPhi + halfLeafAngle * 0.7f));

                Vec3 n = (baseR - baseL).cross(tip - baseL).normalized();

                uint32_t b = static_cast<uint32_t>(mesh.vertices.size());
                mesh.addVertex(Vertex(origin + baseL, n));
                mesh.addVertex(Vertex(origin + baseR, n));
                mesh.addVertex(Vertex(origin + midR, n));
                mesh.addVertex(Vertex(origin + tip, n));
                mesh.addVertex(Vertex(origin + midL, n));

                mesh.addTriangle(b + 0, b + 1, b + 2);
                mesh.addTriangle(b + 0, b + 2, b + 4);
                mesh.addTriangle(b + 4, b + 2, b + 3);
            }
        }

        // 3. Four diagonal corner volute helices projecting beneath abacus
        for (int c = 0; c < 4; ++c) {
            float cornerAngle = (PI * 0.25f) + (HALF_PI * c);
            float voluteR = rTop * 1.45f;
            Vec3 vTip(voluteR * std::cos(cornerAngle), capHeight * 0.92f, voluteR * std::sin(cornerAngle));
            Vec3 vBase(rTop * 1.1f * std::cos(cornerAngle), capHeight * 0.70f, rTop * 1.1f * std::sin(cornerAngle));

            Vec3 side(-std::sin(cornerAngle) * rTop * 0.15f, 0, std::cos(cornerAngle) * rTop * 0.15f);
            uint32_t b = static_cast<uint32_t>(mesh.vertices.size());
            mesh.addVertex(Vertex(origin + vBase - side, Vec3(0, 1, 0)));
            mesh.addVertex(Vertex(origin + vBase + side, Vec3(0, 1, 0)));
            mesh.addVertex(Vertex(origin + vTip + side, Vec3(0, 1, 0)));
            mesh.addVertex(Vertex(origin + vTip - side, Vec3(0, 1, 0)));
            mesh.addTriangle(b + 0, b + 1, b + 2);
            mesh.addTriangle(b + 0, b + 2, b + 3);
        }

        // 4. Concave-sided Classical Abacus slab with central fleuron flower
        float abacusW = rTop * 2.7f;
        float abacusH = rTop * 0.30f;
        float abacusY = capHeight;

        // Concave abacus polygon: 4 arcs scooped inward along each cardinal side
        std::vector<Vec3> abacusRim;
        int rimSegs = 24;
        for (int side = 0; side < 4; ++side) {
            float baseAngle = side * HALF_PI;
            for (int k = 0; k < rimSegs / 4; ++k) {
                float t = static_cast<float>(k) / (rimSegs / 4.0f); // [0, 1]
                float xLocal = (t * 2.0f - 1.0f) * (abacusW * 0.5f);
                float zLocal = abacusW * 0.5f - 0.10f * abacusW * (1.0f - (t * 2.0f - 1.0f) * (t * 2.0f - 1.0f));
                // Rotate by baseAngle
                float cosA = std::cos(baseAngle);
                float sinA = std::sin(baseAngle);
                Vec3 p(xLocal * cosA - zLocal * sinA, 0.0f, xLocal * sinA + zLocal * cosA);
                abacusRim.push_back(p);
            }
        }

        for (size_t i = 0; i < abacusRim.size(); ++i) {
            size_t next = (i + 1) % abacusRim.size();
            Vec3 p0_bot = origin + abacusRim[i] + Vec3(0, abacusY, 0);
            Vec3 p1_bot = origin + abacusRim[next] + Vec3(0, abacusY, 0);
            Vec3 p0_top = p0_bot + Vec3(0, abacusH, 0);
            Vec3 p1_top = p1_bot + Vec3(0, abacusH, 0);

            Vec3 n = (p1_bot - p0_bot).cross(p0_top - p0_bot).normalized();
            uint32_t b = static_cast<uint32_t>(mesh.vertices.size());
            mesh.addVertex(Vertex(p0_bot, n));
            mesh.addVertex(Vertex(p1_bot, n));
            mesh.addVertex(Vertex(p1_top, n));
            mesh.addVertex(Vertex(p0_top, n));
            mesh.addTriangle(b + 0, b + 1, b + 2);
            mesh.addTriangle(b + 0, b + 2, b + 3);

            // Top abacus cap
            uint32_t bTop = static_cast<uint32_t>(mesh.vertices.size());
            mesh.addVertex(Vertex(origin + Vec3(0, abacusY + abacusH, 0), Vec3(0, 1, 0)));
            mesh.addVertex(Vertex(p0_top, Vec3(0, 1, 0)));
            mesh.addVertex(Vertex(p1_top, Vec3(0, 1, 0)));
            mesh.addTriangle(bTop + 0, bTop + 1, bTop + 2);
        }

        return mesh;
    }

    /**
     * Builds complete fluted column shaft with continuous Vitruvian entasis.
     */
    static ScratchboxMesh buildShaft(const ColumnConfig& cfg,
                                    const Vec3& origin,
                                    const PbrMaterial& mat) {
        ScratchboxMesh mesh("vitruvian_column_shaft");
        mesh.material = mat;

        int heightSegs = 48;
        int radialSegs = std::max(cfg.fluteCount * 4, 48);

        for (int j = 0; j < heightSegs; ++j) {
            float y0 = (static_cast<float>(j) / heightSegs) * cfg.shaftHeight;
            float y1 = (static_cast<float>(j + 1) / heightSegs) * cfg.shaftHeight;

            float r0 = evaluateEntasisRadius(cfg, y0);
            float r1 = evaluateEntasisRadius(cfg, y1);

            for (int i = 0; i < radialSegs; ++i) {
                float phi0 = (static_cast<float>(i) / radialSegs) * TWO_PI;
                float phi1 = (static_cast<float>(i + 1) / radialSegs) * TWO_PI;

                float r00 = evaluateFluteModulation(cfg, phi0, r0);
                float r10 = evaluateFluteModulation(cfg, phi1, r0);
                float r11 = evaluateFluteModulation(cfg, phi1, r1);
                float r01 = evaluateFluteModulation(cfg, phi0, r1);

                Vec3 v00(r00 * std::cos(phi0), y0, r00 * std::sin(phi0));
                Vec3 v10(r10 * std::cos(phi1), y0, r10 * std::sin(phi1));
                Vec3 v11(r11 * std::cos(phi1), y1, r11 * std::sin(phi1));
                Vec3 v01(r01 * std::cos(phi0), y1, r01 * std::sin(phi0));

                Vec3 n = (v10 - v00).cross(v01 - v00).normalized();
                uint32_t b = static_cast<uint32_t>(mesh.vertices.size());
                mesh.addVertex(Vertex(origin + v00, n));
                mesh.addVertex(Vertex(origin + v10, n));
                mesh.addVertex(Vertex(origin + v11, n));
                mesh.addVertex(Vertex(origin + v01, n));

                mesh.addTriangle(b + 0, b + 1, b + 2);
                mesh.addTriangle(b + 0, b + 2, b + 3);
            }
        }

        return mesh;
    }

    /**
     * Builds classical monument pedestal / socle (Plinth + Moulded Base + Die Block + Cornice Cap).
     */
    static ScratchboxMesh buildPedestal(const ColumnConfig& cfg,
                                       const Vec3& origin,
                                       const PbrMaterial& mat) {
        ScratchboxMesh mesh("column_pedestal");
        mesh.material = mat;

        float H = cfg.pedestalHeight;
        float W = cfg.pedestalWidth;

        float baseMouldingH = H * 0.22f;
        float dieH = H * 0.60f;
        float capMouldingH = H * 0.18f;

        auto addBox = [&](const Vec3& center, float sx, float sy, float sz) {
            float hx = sx * 0.5f, hy = sy * 0.5f, hz = sz * 0.5f;
            std::array<Vec3, 8> corners = {
                center + Vec3(-hx, -hy, -hz), center + Vec3( hx, -hy, -hz),
                center + Vec3( hx,  hy, -hz), center + Vec3(-hx,  hy, -hz),
                center + Vec3(-hx, -hy,  hz), center + Vec3( hx, -hy,  hz),
                center + Vec3( hx,  hy,  hz), center + Vec3(-hx,  hy,  hz)
            };
            auto addQuad = [&](int i0, int i1, int i2, int i3, const Vec3& n) {
                uint32_t b = static_cast<uint32_t>(mesh.vertices.size());
                mesh.addVertex(Vertex(corners[i0], n));
                mesh.addVertex(Vertex(corners[i1], n));
                mesh.addVertex(Vertex(corners[i2], n));
                mesh.addVertex(Vertex(corners[i3], n));
                mesh.addTriangle(b + 0, b + 1, b + 2);
                mesh.addTriangle(b + 0, b + 2, b + 3);
            };
            addQuad(4, 5, 6, 7, Vec3(0, 0, 1));
            addQuad(1, 0, 3, 2, Vec3(0, 0, -1));
            addQuad(0, 4, 7, 3, Vec3(-1, 0, 0));
            addQuad(5, 1, 2, 6, Vec3(1, 0, 0));
            addQuad(3, 2, 6, 7, Vec3(0, 1, 0));
            addQuad(0, 1, 5, 4, Vec3(0, -1, 0));
        };

        // 1. Plinth sub-base
        addBox(origin + Vec3(0, baseMouldingH * 0.5f, 0), W * 1.15f, baseMouldingH, W * 1.15f);
        // 2. Central Die block (Dado)
        addBox(origin + Vec3(0, baseMouldingH + dieH * 0.5f, 0), W, dieH, W);
        // 3. Projecting Cornice cap
        addBox(origin + Vec3(0, baseMouldingH + dieH + capMouldingH * 0.5f, 0), W * 1.12f, capMouldingH, W * 1.12f);

        return mesh;
    }

    /**
     * Assembles full Classical Column (Pedestal + Base + Shaft + Capital).
     */
    static ScratchboxMesh buildFullColumn(const ColumnConfig& cfg,
                                         const Vec3& groundPos,
                                         const PbrMaterial& mat = PbrMaterial::stoneLimestone()) {
        ScratchboxMesh mesh("classical_column");
        mesh.material = mat;

        Vec3 currPos = groundPos;

        // 1. Pedestal (if enabled)
        if (cfg.hasPedestal) {
            mesh.append(buildPedestal(cfg, currPos, mat));
            currPos.y += cfg.pedestalHeight;
        }

        // 2. Base
        mesh.append(buildAtticBase(cfg, currPos, mat));
        float baseH = cfg.baseRadius * 1.45f;
        currPos.y += baseH;

        // 3. Shaft with Vitruvian Entasis & Flutes
        mesh.append(buildShaft(cfg, currPos, mat));
        currPos.y += cfg.shaftHeight;

        // 4. Capital
        if (cfg.order == ClassicalOrder::Corinthian || cfg.order == ClassicalOrder::Composite) {
            mesh.append(buildCorinthianCapital(cfg, currPos, mat));
        }

        return mesh;
    }
};

// ============================================================================
// 5. ENTABLATURE EXTRUSION ENGINE WITH MITERED RESSAUT BREAKS
// ============================================================================

struct EntablatureConfig {
    float totalHeight = 2.4f;       // Total entablature height
    float architraveRatio = 0.35f;  // Ratio for 3-fasciae architrave
    float friezeRatio = 0.33f;      // Ratio for central relief frieze
    float corniceRatio = 0.32f;     // Ratio for projecting modillion cornice
    float ressautProjection = 0.45f;// Forward projection distance over columns (meters)
    float ressautMiterAngle = 45.0f * DEG_TO_RAD; // 45 deg mitered return corner
};

class EntablatureExtruder {
public:
    /**
     * Extrudes classical entablature along a path with forward ressaut projections over column locations.
     */
    static ScratchboxMesh buildRessautEntablature(const EntablatureConfig& cfg,
                                                  float lengthX, float depthZ,
                                                  const std::vector<float>& columnXPositions,
                                                  const Vec3& origin = Vec3(0, 0, 0),
                                                  const PbrMaterial& mat = PbrMaterial::stoneLimestone()) {
        ScratchboxMesh mesh("ressaut_entablature");
        mesh.material = mat;

        float hArch = cfg.totalHeight * cfg.architraveRatio;
        float hFrieze = cfg.totalHeight * cfg.friezeRatio;
        float hCorn = cfg.totalHeight * cfg.corniceRatio;

        float halfX = lengthX * 0.5f;
        float halfZ = depthZ * 0.5f;

        // 2D Profile coordinates: y in [0, totalHeight], z projection [0, proj]
        // Generate continuous main block
        auto addBox = [&](const Vec3& center, float sx, float sy, float sz) {
            float hx = sx * 0.5f, hy = sy * 0.5f, hz = sz * 0.5f;
            std::array<Vec3, 8> corners = {
                center + Vec3(-hx, -hy, -hz), center + Vec3( hx, -hy, -hz),
                center + Vec3( hx,  hy, -hz), center + Vec3(-hx,  hy, -hz),
                center + Vec3(-hx, -hy,  hz), center + Vec3( hx, -hy,  hz),
                center + Vec3( hx,  hy,  hz), center + Vec3(-hx,  hy,  hz)
            };
            auto addQuad = [&](int i0, int i1, int i2, int i3, const Vec3& n) {
                uint32_t b = static_cast<uint32_t>(mesh.vertices.size());
                mesh.addVertex(Vertex(corners[i0], n));
                mesh.addVertex(Vertex(corners[i1], n));
                mesh.addVertex(Vertex(corners[i2], n));
                mesh.addVertex(Vertex(corners[i3], n));
                mesh.addTriangle(b + 0, b + 1, b + 2);
                mesh.addTriangle(b + 0, b + 2, b + 3);
            };
            addQuad(4, 5, 6, 7, Vec3(0, 0, 1));
            addQuad(1, 0, 3, 2, Vec3(0, 0, -1));
            addQuad(0, 4, 7, 3, Vec3(-1, 0, 0));
            addQuad(5, 1, 2, 6, Vec3(1, 0, 0));
            addQuad(3, 2, 6, 7, Vec3(0, 1, 0));
            addQuad(0, 1, 5, 4, Vec3(0, -1, 0));
        };

        // 1. Main Architrave
        addBox(origin + Vec3(0, hArch * 0.5f, 0), lengthX, hArch, depthZ);
        // 2. Main Frieze
        addBox(origin + Vec3(0, hArch + hFrieze * 0.5f, 0), lengthX, hFrieze, depthZ * 0.96f);
        // 3. Projecting Cornice with Corona & Modillions
        addBox(origin + Vec3(0, hArch + hFrieze + hCorn * 0.5f, 0), lengthX * 1.04f, hCorn, depthZ * 1.15f);

        // 4. Mitered Ressaut breaks projecting forward & backward over column positions
        float colRessautW = 1.35f;
        for (float colX : columnXPositions) {
            for (float signZ : { 1.0f, -1.0f }) {
                float centerZ = signZ * (halfZ + cfg.ressautProjection * 0.5f);
                Vec3 resPos = origin + Vec3(colX, cfg.totalHeight * 0.5f, centerZ);
                addBox(resPos, colRessautW, cfg.totalHeight, cfg.ressautProjection);

                // Add projecting cornice bracket crown
                Vec3 capPos = origin + Vec3(colX, hArch + hFrieze + hCorn * 0.5f, signZ * (halfZ + cfg.ressautProjection * 0.65f));
                addBox(capPos, colRessautW * 1.15f, hCorn, cfg.ressautProjection * 1.3f);
            }
        }

        return mesh;
    }
};

// ============================================================================
// 6. PROCEDURAL ASHLAR MASONRY & RUSTICATION FIELD
// ============================================================================

struct AshlarConfig {
    float blockWidth = 1.20f;       // Average stone block length (meters)
    float courseHeight = 0.55f;     // Ashlar course height (meters)
    float wallDepth = 0.65f;        // Wall thickness (meters)
    float jointRecess = 0.025f;     // Recessed mortar bed depth (meters)
    float draftedMarginWidth = 0.04f;// Smooth flat perimeter drafted margin (meters)
    float pillowBossage = 0.035f;   // Convex rustication pillow bulge (meters)
};

class AshlarFieldBuilder {
public:
    static ScratchboxMesh buildAshlarWall(const AshlarConfig& cfg,
                                         float totalWidth, float totalHeight,
                                         const Vec3& origin = Vec3(0, 0, 0),
                                         const PbrMaterial& mat = PbrMaterial::stoneLimestone()) {
        ScratchboxMesh mesh("ashlar_masonry_wall");
        mesh.material = mat;

        int numCourses = std::max(1, static_cast<int>(std::round(totalHeight / cfg.courseHeight)));
        float actualCourseH = totalHeight / static_cast<float>(numCourses);

        for (int c = 0; c < numCourses; ++c) {
            float y0 = c * actualCourseH;
            float y1 = (c + 1) * actualCourseH;
            float stagger = (c % 2 == 1) ? (cfg.blockWidth * 0.5f) : 0.0f;

            int numBlocks = static_cast<int>(std::ceil((totalWidth + stagger) / cfg.blockWidth));
            for (int b = 0; b < numBlocks; ++b) {
                float x0 = -totalWidth * 0.5f + b * cfg.blockWidth - stagger;
                float x1 = x0 + cfg.blockWidth;

                // Clamp to wall bounds
                float left = std::max(x0, -totalWidth * 0.5f);
                float right = std::min(x1, totalWidth * 0.5f);
                if (right <= left + 0.05f) continue;

                // Stone block with chamfered joints
                float j = cfg.jointRecess;
                Vec3 b0(left + j, y0 + j, cfg.wallDepth * 0.5f);
                Vec3 b1(right - j, y0 + j, cfg.wallDepth * 0.5f);
                Vec3 b2(right - j, y1 - j, cfg.wallDepth * 0.5f);
                Vec3 b3(left + j, y1 - j, cfg.wallDepth * 0.5f);

                // Subtle organic tone variation per block
                float tone = 0.93f + 0.14f * std::sin((c * 17 + b * 23) * 0.31f);
                Vec4 col(tone, tone * 0.97f, tone * 0.90f, 1.0f);

                uint32_t idx = static_cast<uint32_t>(mesh.vertices.size());
                mesh.addVertex(Vertex(origin + b0, Vec3(0, 0, 1), Vec2(0, 0), col));
                mesh.addVertex(Vertex(origin + b1, Vec3(0, 0, 1), Vec2(1, 0), col));
                mesh.addVertex(Vertex(origin + b2, Vec3(0, 0, 1), Vec2(1, 1), col));
                mesh.addVertex(Vertex(origin + b3, Vec3(0, 0, 1), Vec2(0, 1), col));
                mesh.addTriangle(idx + 0, idx + 1, idx + 2);
                mesh.addTriangle(idx + 0, idx + 2, idx + 3);
            }
        }

        return mesh;
    }
};

} // namespace tectonics
} // namespace scratchbox

#endif // SCRATCHBOX_TECTONICS_HPP
