/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_PATHTRACER_HPP
#define SCRATCHBOX_PATHTRACER_HPP

#include "scratchbox_bvh.hpp"
#include "scratchbox_denoise.hpp"
#include "scratchbox_gltf_scene.hpp"
#include "scratchbox_light_tree.hpp"
#include "scratchbox_sky.hpp"
#include "scratchbox_view_transform.hpp"
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <string>
#include <thread>
#include <vector>

namespace scratchbox {
namespace render {

using math::AABB;
using math::Ray;
using math::Vec2;
using math::Vec3;
using math::Vec4;

enum class ShadingMode {
    Relit,  // texture is surface albedo, lit by the physical sun and sky
    Baked   // texture is captured radiance (the photograph itself); only sky and haze are added
};

struct CameraSpec {
    Vec3 position{0.0f, 0.0f, 0.0f};
    Vec3 target{0.0f, 0.0f, -1.0f};
    Vec3 up{0.0f, 1.0f, 0.0f};
    float verticalFovDeg{40.0f};
    float apertureRadius{0.0f};
    float focusDistance{0.0f};  // 0 focuses on the target
};

struct RenderSettings {
    int width{1280};
    int height{720};
    int samplesPerPixel{64};
    int maxBounces{4};  // indirect bounces; 0 renders direct lighting only
    int threads{0};     // 0 uses every hardware thread
    ShadingMode mode{ShadingMode::Relit};
    float clampIndirect{10.0f};  // luminance cap on indirect contributions; 0 disables
    uint32_t seed{1};
};

/** What lights the scene besides its own lights: the physical sun and sky, or (with no sky) a uniform studio dome. */
/**
 * Haze beyond the sky model's own: a grey extinction per metre at the layer's base (a visibility V gives 3.912 / V,
 * Koschmieder) and, when scaleHeight > 0, a density that falls off as exp(-(y - baseY) / scaleHeight) above baseY,
 * which thins the sky model's haze with height too. Heights are in the traced file's coordinates. The viewport's
 * aerial perspective pass draws the same layer (common/spatial/height-haze.ts).
 */
struct HeightHaze {
    Vec3 extinction{0.0f, 0.0f, 0.0f};
    float scaleHeight{0.0f};
    float baseY{0.0f};
};

struct Environment {
    const sky::PhysicalSky* sky{nullptr};
    Vec3 studioRadiance{1.0f, 1.0f, 1.0f};
    HeightHaze haze{};
};

struct RenderOutput {
    int width{0};
    int height{0};
    std::vector<Vec3> color;  // scene-linear radiance, before exposure
    denoise::GuideBuffers guides;
    size_t nanSamples{0};
    size_t rays{0};  // closest-hit and shadow rays traced
    double renderMs{0.0};
    float geometryCoverage{0.0f};
};

namespace detail {

constexpr float kPi = 3.14159265358979323846f;
constexpr float kRayEpsilon = 2e-3f;

inline uint64_t splitmix64(uint64_t x) {
    x += 0x9E3779B97F4A7C15ull;
    x = (x ^ (x >> 30)) * 0xBF58476D1CE4E5B9ull;
    x = (x ^ (x >> 27)) * 0x94D049BB133111EBull;
    return x ^ (x >> 31);
}

class Pcg32 {
public:
    Pcg32(uint64_t seed, uint64_t stream) : inc_((stream << 1u) | 1u) {
        nextU32();
        state_ += seed;
        nextU32();
    }

    uint32_t nextU32() {
        uint64_t old = state_;
        state_ = old * 6364136223846793005ull + inc_;
        auto xorshifted = static_cast<uint32_t>(((old >> 18u) ^ old) >> 27u);
        auto rot = static_cast<uint32_t>(old >> 59u);
        return (xorshifted >> rot) | (xorshifted << ((32u - rot) & 31u));
    }

    float next() { return static_cast<float>(nextU32() >> 8) * (1.0f / 16777216.0f); }

private:
    uint64_t state_{0};
    uint64_t inc_;
};

inline float luminance(const Vec3& c) { return view::luminance(c); }

/**
 * Mean haze density along a straight segment between heights y0 and y1, for a density exp(-(y - base) / H) above
 * `base` and 1 at and below it; 1 with no scale height. A segment's optical depth is extinction x length x this.
 * The Metal kernel and common/spatial/height-haze.ts carry the same expression.
 */
inline float hazeColumnFactor(float y0, float y1, float scaleHeight, float base) {
    if (!(scaleHeight > 0.0f)) return 1.0f;
    const float a = (y0 - base) / scaleHeight, b = (y1 - base) / scaleHeight;
    auto column = [](float t) { return t <= 0.0f ? t : 1.0f - std::exp(-t); };
    const float span = b - a;
    if (std::fabs(span) < 1e-4f) return a <= 0.0f ? 1.0f : std::exp(-a);
    return (column(b) - column(a)) / span;
}
inline float maxComponent(const Vec3& v) { return std::max(v.x, std::max(v.y, v.z)); }
inline bool isFinite(const Vec3& v) { return std::isfinite(v.x) && std::isfinite(v.y) && std::isfinite(v.z); }

inline float tentSample(float u) {
    float r = 2.0f * u;
    return r < 1.0f ? std::sqrt(r) - 1.0f : 1.0f - std::sqrt(2.0f - r);
}

inline Vec2 concentricDisk(float u1, float u2) {
    float a = 2.0f * u1 - 1.0f, b = 2.0f * u2 - 1.0f;
    if (a == 0.0f && b == 0.0f) return Vec2(0.0f, 0.0f);
    float r, phi;
    if (std::abs(a) > std::abs(b)) {
        r = a;
        phi = (kPi / 4.0f) * (b / a);
    } else {
        r = b;
        phi = (kPi / 2.0f) - (kPi / 4.0f) * (a / b);
    }
    return Vec2(r * std::cos(phi), r * std::sin(phi));
}

inline void orthonormalBasis(const Vec3& n, Vec3& t, Vec3& b) {
    float sign = std::copysign(1.0f, n.z);
    float a = -1.0f / (sign + n.z);
    float c = n.x * n.y * a;
    t = Vec3(1.0f + sign * n.x * n.x * a, sign * c, -sign * n.x);
    b = Vec3(c, sign + n.y * n.y * a, -n.y);
}

inline const std::array<float, 256>& srgbToLinearTable() {
    static const std::array<float, 256> table = [] {
        std::array<float, 256> t{};
        for (int i = 0; i < 256; ++i) t[i] = view::srgbDecode(static_cast<float>(i) / 255.0f);
        return t;
    }();
    return table;
}

inline int wrapCoordinate(int i, int n, int mode) {
    if (mode == 33071) return std::clamp(i, 0, n - 1);
    if (mode == 33648) {
        int period = 2 * n;
        int m = ((i % period) + period) % period;
        return m < n ? m : period - 1 - m;
    }
    return ((i % n) + n) % n;
}

/** Bilinear texture lookup; `srgb` decodes the texels to linear first (colour maps), else they are read as stored (data maps). */
inline Vec3 sampleTexture(const texture::ImageBuffer& img, const Vec2& uv, int wrapS, int wrapT, bool srgb) {
    if (img.width <= 0 || img.height <= 0) return Vec3(1, 1, 1);
    const auto& lut = srgbToLinearTable();
    float fx = std::clamp(uv.x, -1e5f, 1e5f) * img.width - 0.5f;
    float fy = std::clamp(uv.y, -1e5f, 1e5f) * img.height - 0.5f;
    if (!std::isfinite(fx) || !std::isfinite(fy)) return Vec3(0, 0, 0);
    float x0f = std::floor(fx), y0f = std::floor(fy);
    float tx = fx - x0f, ty = fy - y0f;
    int x0 = static_cast<int>(x0f), y0 = static_cast<int>(y0f);
    int xa = wrapCoordinate(x0, img.width, wrapS), xb = wrapCoordinate(x0 + 1, img.width, wrapS);
    int ya = wrapCoordinate(y0, img.height, wrapT), yb = wrapCoordinate(y0 + 1, img.height, wrapT);
    auto decode = [&](uint8_t v) { return srgb ? lut[v] : static_cast<float>(v) * (1.0f / 255.0f); };
    auto fetch = [&](int x, int y) {
        size_t idx = (static_cast<size_t>(y) * img.width + x) * img.channels;
        if (img.channels >= 3) return Vec3(decode(img.data[idx]), decode(img.data[idx + 1]), decode(img.data[idx + 2]));
        float v = decode(img.data[idx]);
        return Vec3(v, v, v);
    };
    Vec3 top = fetch(xa, ya) * (1.0f - tx) + fetch(xb, ya) * tx;
    Vec3 bottom = fetch(xa, yb) * (1.0f - tx) + fetch(xb, yb) * tx;
    return top * (1.0f - ty) + bottom * ty;
}

/** Bilinear lookup of a texture's alpha (its fourth channel; 1 for a texture without one). The Metal kernels match it. */
inline float sampleAlpha(const texture::ImageBuffer& img, const Vec2& uv, int wrapS, int wrapT) {
    if (img.channels != 4 || img.width <= 0 || img.height <= 0) return 1.0f;
    float fx = std::clamp(uv.x, -1e5f, 1e5f) * img.width - 0.5f;
    float fy = std::clamp(uv.y, -1e5f, 1e5f) * img.height - 0.5f;
    if (!std::isfinite(fx) || !std::isfinite(fy)) return 1.0f;
    float x0f = std::floor(fx), y0f = std::floor(fy);
    float tx = fx - x0f, ty = fy - y0f;
    int x0 = static_cast<int>(x0f), y0 = static_cast<int>(y0f);
    int xa = wrapCoordinate(x0, img.width, wrapS), xb = wrapCoordinate(x0 + 1, img.width, wrapS);
    int ya = wrapCoordinate(y0, img.height, wrapT), yb = wrapCoordinate(y0 + 1, img.height, wrapT);
    auto fetch = [&](int x, int y) { return img.data[(static_cast<size_t>(y) * img.width + x) * 4 + 3] * (1.0f / 255.0f); };
    float top = fetch(xa, ya) * (1.0f - tx) + fetch(xb, ya) * tx;
    float bottom = fetch(xa, yb) * (1.0f - tx) + fetch(xb, yb) * tx;
    return top * (1.0f - ty) + bottom * ty;
}

/** Bilinear lookup of an sRGB-encoded colour texture, filtered in linear space. */
inline Vec3 sampleTextureLinear(const texture::ImageBuffer& img, const Vec2& uv, int wrapS, int wrapT) {
    return sampleTexture(img, uv, wrapS, wrapT, true);
}

struct SurfacePoint {
    Vec3 position;
    Vec3 geometricNormal{0, 1, 0};
    Vec3 shadingNormal{0, 1, 0};
    Vec3 baseColor{0.5f, 0.5f, 0.5f};
    Vec3 emission{0, 0, 0};
    float metallic{0.0f};
    float roughness{1.0f};
};

inline Vec3 schlickFresnel(const Vec3& f0, float cosTheta) {
    float m = 1.0f - std::clamp(cosTheta, 0.0f, 1.0f);
    float m5 = m * m * m * m * m;
    return f0 + (Vec3(1, 1, 1) - f0) * m5;
}

inline float ggxDistribution(float cosH, float a2) {
    float d = cosH * cosH * (a2 - 1.0f) + 1.0f;
    return a2 / (kPi * d * d);
}

inline float smithG1(float cosX, float a2) {
    return 2.0f * cosX / (cosX + std::sqrt(a2 + (1.0f - a2) * cosX * cosX));
}

inline float smithVisibilityCorrelated(float cosV, float cosL, float a2) {
    float gv = cosL * std::sqrt(cosV * cosV * (1.0f - a2) + a2);
    float gl = cosV * std::sqrt(cosL * cosL * (1.0f - a2) + a2);
    return 0.5f / (gv + gl);
}

/**
 * Directional albedo Ess(cos theta_o, roughness) of this file's single-scatter GGX lobe with F = 1 (height-correlated
 * Smith, the same alpha floor), for the multiple-scattering compensation. Integrated once by visible-normal quadrature
 * (each sample's weight is G2 / G1) on a kEssSize x kEssSize grid, cos theta_o and roughness from 0 to 1. The Metal
 * kernels read the same numbers (ggxEssMetalSource), looked up the same way, so the two tracers stay at parity.
 * Lazarov's environment-BRDF fit, tried first, under-reads Ess for this lobe: a white rough metal came back at 1.16.
 */
constexpr int kEssSize = 32;

inline const std::array<float, kEssSize * kEssSize>& ggxEssTable() {
    static const std::array<float, kEssSize * kEssSize> table = [] {
        std::array<float, kEssSize * kEssSize> t{};
        constexpr int n = 64;
        for (int j = 0; j < kEssSize; ++j) {
            const double roughness = double(j) / (kEssSize - 1);
            const double alpha = std::max(roughness * roughness, 0.002);
            const double a2 = alpha * alpha;
            for (int i = 0; i < kEssSize; ++i) {
                const double mu = std::max(double(i) / (kEssSize - 1), 1e-4);
                const double wox = std::sqrt(std::max(0.0, 1.0 - mu * mu)), woz = mu;
                // Visible-normal sampling (Heitz 2018) of the stretched view direction.
                double vx = alpha * wox, vz = woz;
                const double vl = std::sqrt(vx * vx + vz * vz);
                vx /= vl; vz /= vl;
                const double g1o = 2.0 * woz / (woz + std::sqrt(a2 + (1.0 - a2) * woz * woz));
                double sum = 0.0;
                for (int a = 0; a < n; ++a) for (int b = 0; b < n; ++b) {
                    const double u1 = (a + 0.5) / n, u2 = (b + 0.5) / n;
                    // t1 = (0, 1, 0) for a view in the xz plane; t2 = vh x t1.
                    const double t2x = -vz, t2z = vx;
                    const double r = std::sqrt(u1), phi = 2.0 * 3.14159265358979323846 * u2;
                    const double p1 = r * std::cos(phi);
                    double p2 = r * std::sin(phi);
                    const double sv = 0.5 * (1.0 + vz);
                    p2 = (1.0 - sv) * std::sqrt(std::max(0.0, 1.0 - p1 * p1)) + sv * p2;
                    const double pz = std::sqrt(std::max(0.0, 1.0 - p1 * p1 - p2 * p2));
                    // nh = t1 * p1 + t2 * p2 + vh * pz; then unstretched.
                    double hx = alpha * (t2x * p2 + vx * pz), hy = alpha * p1, hz = std::max(1e-6, t2z * p2 + vz * pz);
                    const double hl = std::sqrt(hx * hx + hy * hy + hz * hz);
                    hx /= hl; hy /= hl; hz /= hl;
                    const double d = wox * hx + woz * hz;
                    const double lz = 2.0 * d * hz - woz;
                    if (lz <= 0.0) continue;
                    const double gv = lz * std::sqrt(woz * woz * (1.0 - a2) + a2);
                    const double gl = woz * std::sqrt(lz * lz * (1.0 - a2) + a2);
                    sum += (2.0 * woz * lz / (gv + gl)) / g1o;
                }
                t[static_cast<size_t>(j * kEssSize + i)] = static_cast<float>(std::min(1.0, sum / (n * n)));
            }
        }
        return t;
    }();
    return table;
}

/** Bilinear lookup of ggxEssTable; the Metal ggxEss does the same float arithmetic. */
inline float ggxEss(float cosV, float roughness) {
    const auto& t = ggxEssTable();
    const float x = std::clamp(cosV, 0.0f, 1.0f) * float(kEssSize - 1);
    const float y = std::clamp(roughness, 0.0f, 1.0f) * float(kEssSize - 1);
    const int x0 = std::min(static_cast<int>(x), kEssSize - 2), y0 = std::min(static_cast<int>(y), kEssSize - 2);
    const float fx = x - float(x0), fy = y - float(y0);
    const float a = t[size_t(y0 * kEssSize + x0)] * (1.0f - fx) + t[size_t(y0 * kEssSize + x0 + 1)] * fx;
    const float b = t[size_t((y0 + 1) * kEssSize + x0)] * (1.0f - fx) + t[size_t((y0 + 1) * kEssSize + x0 + 1)] * fx;
    return a * (1.0f - fy) + b * fy;
}

/** The table and lookup as Metal source, appended to the kernels (which declare ggxEss before using it). */
inline std::string ggxEssMetalSource() {
    std::string out = "\nconstant float kGgxEss[" + std::to_string(kEssSize * kEssSize) + "] = {";
    char buf[32];
    const auto& t = ggxEssTable();
    for (size_t i = 0; i < t.size(); ++i) {
        std::snprintf(buf, sizeof buf, "%s%.9ef", i ? "," : "", double(t[i]));
        out += buf;
    }
    out += "};\n"
           "float ggxEss(float cosV, float roughness) {\n"
           "    const int n = " + std::to_string(kEssSize) + ";\n"
           "    float x = clamp(cosV, 0.0f, 1.0f) * float(n - 1);\n"
           "    float y = clamp(roughness, 0.0f, 1.0f) * float(n - 1);\n"
           "    int x0 = min(int(x), n - 2), y0 = min(int(y), n - 2);\n"
           "    float fx = x - float(x0), fy = y - float(y0);\n"
           "    float a = kGgxEss[y0 * n + x0] * (1.0f - fx) + kGgxEss[y0 * n + x0 + 1] * fx;\n"
           "    float b = kGgxEss[(y0 + 1) * n + x0] * (1.0f - fx) + kGgxEss[(y0 + 1) * n + x0 + 1] * fx;\n"
           "    return a * (1.0f - fy) + b * fy;\n"
           "}\n";
    return out;
}

/** glTF metallic-roughness BSDF: Lambert diffuse plus GGX specular with visible-normal sampling. */
class MetallicRoughnessBsdf {
public:
    MetallicRoughnessBsdf(const SurfacePoint& s, const Vec3& wo) : base_(s.baseColor), metallic_(s.metallic) {
        n_ = s.shadingNormal;
        orthonormalBasis(n_, t_, b_);
        float alpha = std::max(s.roughness * s.roughness, 0.002f);
        alpha_ = alpha;
        a2_ = alpha * alpha;
        f0_ = Vec3(0.04f, 0.04f, 0.04f) * (1.0f - metallic_) + base_ * metallic_;
        wo_ = toLocal(wo);
        float cosV = std::max(wo_.z, 1e-4f);
        // The specular lobe is chosen in proportion to its directional albedo (Lazarov's fit of the GGX
        // environment BRDF) rather than Fresnel alone; see makeBsdf in the Metal kernels, which must match.
        const float r0 = s.roughness * -1.0f + 1.0f, r1 = s.roughness * -0.0275f + 0.0425f;
        const float r2 = s.roughness * -0.572f + 1.04f, r3 = s.roughness * 0.022f - 0.04f;
        const float a004 = std::min(r0 * r0, std::exp2(-9.28f * cosV)) * r0 + r1;
        const float scale = a004 * -1.04f + r2, bias = a004 * 1.04f + r3;
        // Multiple-scattering compensation (Turquin 2019), as in the Metal kernels: the lobe is scaled by
        // 1 + f0 (1 / Ess - 1), Ess its directional albedo at F = 1.
        const float ess = std::clamp(ggxEss(cosV, s.roughness), 0.05f, 1.0f);
        msScale_ = Vec3(1, 1, 1) + f0_ * (1.0f / ess - 1.0f);
        float specularWeight = luminance(msScale_ * (f0_ * scale + Vec3(bias, bias, bias)));
        float diffuseWeight = (1.0f - metallic_) * luminance(base_);
        specularProbability_ = std::clamp(specularWeight / std::max(specularWeight + diffuseWeight, 1e-6f), 0.02f, 0.9f);
    }

    Vec3 eval(const Vec3& wiWorld) const {
        Vec3 l = toLocal(wiWorld);
        if (l.z <= 0.0f || wo_.z <= 0.0f) return Vec3(0, 0, 0);
        Vec3 h = (wo_ + l).normalized();
        Vec3 f = schlickFresnel(f0_, std::max(wo_.dot(h), 0.0f));
        Vec3 specular = msScale_ * f * (ggxDistribution(h.z, a2_) * smithVisibilityCorrelated(wo_.z, l.z, a2_));
        Vec3 diffuse = base_ * ((1.0f - metallic_) / kPi) * (Vec3(1, 1, 1) - f);
        return diffuse + specular;
    }

    float pdf(const Vec3& wiWorld) const {
        Vec3 l = toLocal(wiWorld);
        if (l.z <= 0.0f || wo_.z <= 0.0f) return 0.0f;
        Vec3 h = (wo_ + l).normalized();
        float specularPdf = smithG1(wo_.z, a2_) * ggxDistribution(h.z, a2_) / (4.0f * wo_.z);
        float diffusePdf = l.z / kPi;
        return specularProbability_ * specularPdf + (1.0f - specularProbability_) * diffusePdf;
    }

    bool sample(Pcg32& rng, Vec3& wiWorld, Vec3& weight) const {
        if (wo_.z <= 0.0f) return false;
        float choice = rng.next();
        float u1 = rng.next(), u2 = rng.next();
        Vec3 l;
        if (choice < specularProbability_) {
            Vec3 h = sampleVisibleNormal(u1, u2);
            l = h * (2.0f * wo_.dot(h)) - wo_;
        } else {
            float r = std::sqrt(u1), phi = 2.0f * kPi * u2;
            l = Vec3(r * std::cos(phi), r * std::sin(phi), std::sqrt(std::max(0.0f, 1.0f - u1)));
        }
        if (l.z <= 0.0f) return false;
        wiWorld = toWorld(l);
        float p = pdf(wiWorld);
        if (p <= 1e-8f) return false;
        weight = eval(wiWorld) * (l.z / p);
        return isFinite(weight);
    }

private:
    Vec3 toLocal(const Vec3& v) const { return Vec3(v.dot(t_), v.dot(b_), v.dot(n_)); }
    Vec3 toWorld(const Vec3& v) const { return t_ * v.x + b_ * v.y + n_ * v.z; }

    Vec3 sampleVisibleNormal(float u1, float u2) const {
        Vec3 vh = Vec3(alpha_ * wo_.x, alpha_ * wo_.y, wo_.z).normalized();
        float lensq = vh.x * vh.x + vh.y * vh.y;
        Vec3 t1 = lensq > 0.0f ? Vec3(-vh.y, vh.x, 0.0f) / std::sqrt(lensq) : Vec3(1, 0, 0);
        Vec3 t2 = vh.cross(t1);
        float r = std::sqrt(u1);
        float phi = 2.0f * kPi * u2;
        float p1 = r * std::cos(phi);
        float p2 = r * std::sin(phi);
        float s = 0.5f * (1.0f + vh.z);
        p2 = (1.0f - s) * std::sqrt(std::max(0.0f, 1.0f - p1 * p1)) + s * p2;
        Vec3 nh = t1 * p1 + t2 * p2 + vh * std::sqrt(std::max(0.0f, 1.0f - p1 * p1 - p2 * p2));
        return Vec3(alpha_ * nh.x, alpha_ * nh.y, std::max(1e-6f, nh.z)).normalized();
    }

    Vec3 n_, t_, b_;
    Vec3 base_;
    Vec3 f0_;
    Vec3 msScale_;
    Vec3 wo_;
    float metallic_;
    float alpha_{1.0f};
    float a2_{1.0f};
    float specularProbability_{0.5f};
};

} // namespace detail

/**
 * Unidirectional Monte Carlo path tracer over a flattened glTF scene. Surfaces of alpha-masked materials (glTF
 * MASK) are there only where their base colour's alpha reaches the cutoff: rays and shadow rays pass the rest.
 * Next-event estimation of the
 * solar disc and of the scene's own lights (emissive triangles and glTF punctual lights, one picked per
 * vertex from the light tree of scratchbox_light_tree.hpp and weighted against the BSDF by the power
 * heuristic), sky dome or studio dome lighting on escape, distance-based aerial perspective, and a ground
 * plane at the scene's measured street level so the surroundings of a tile are not an empty void.
 */
class PathTracer {
public:
    explicit PathTracer(const gltf::GltfScene& scene, bool groundPlane = true) : scene_(scene), groundEnabled_(groundPlane) {
        origin_ = scene.bounds.center();
        mesh_.name = scene.mesh.name;
        mesh_.indices = scene.mesh.indices;
        mesh_.vertices.reserve(scene.mesh.vertices.size());
        for (const auto& v : scene.mesh.vertices) {
            geometry::Vertex local = v;
            local.position = v.position - origin_;
            mesh_.addVertex(local);
        }
        bvh_.build(mesh_);
        buildAlphaMask();
        estimateGround();
        for (const gltf::SceneLight& l : scene.lights) {
            gltf::SceneLight local = l;
            local.position = l.position - origin_;
            punctual_.push_back(local);
        }
        buildLights();
    }

    // The BVH keeps a pointer to mesh_, so the tracer must stay at a fixed address.
    PathTracer(const PathTracer&) = delete;
    PathTracer& operator=(const PathTracer&) = delete;

    /** World-space height of the ground plane (street level measured from the tile's horizontal surfaces). */
    float groundHeight() const { return groundLocalY_ + origin_.y; }
    Vec3 groundAlbedo() const { return groundAlbedo_; }

    // Uniform matte material in place of the captured textures (geometry-only clay blockouts).
    void setClayMaterial(const Vec3& albedo, float roughness, float metallic) {
        clay_ = true;
        clayAlbedo_ = albedo;
        clayRoughness_ = std::clamp(roughness, 0.02f, 1.0f);
        clayMetallic_ = std::clamp(metallic, 0.0f, 1.0f);
        buildAlphaMask();
        buildLights();
    }

    /** The lights next-event estimation samples (the clay material emits nothing, so then only punctual lights). */
    const lights::LightSet& lightSet() const { return lights_; }

    /** Off: no light samples, and emission is found by BSDF rays alone (the tracer before its light tree). */
    void setLightSampling(bool enabled) {
        lightSampling_ = enabled;
        buildLights();
    }
    size_t triangleCount() const { return mesh_.indices.size() / 3; }
    size_t bvhNodeCount() const { return bvh_.getNodeCount(); }

    /**
     * Frames the scene bounds from a compass heading (direction the camera looks, clockwise from north)
     * and a downward pitch, so the bounding sphere fits the narrower field of view.
     */
    static CameraSpec frameBounds(const AABB& bounds, float groundHeight, float aspect, float verticalFovDeg,
                                  float pitchDeg, float headingDeg, float distanceScale) {
        Vec3 center = bounds.center();
        Vec3 target(center.x, groundHeight + 0.25f * (bounds.max.y - groundHeight), center.z);
        float radius = 0.5f * bounds.size().length();
        float vHalf = 0.5f * verticalFovDeg * math::DEG_TO_RAD;
        float hHalf = std::atan(std::tan(vHalf) * aspect);
        float distance = radius / std::sin(std::min(vHalf, hHalf)) * distanceScale;
        float p = pitchDeg * math::DEG_TO_RAD, h = headingDeg * math::DEG_TO_RAD;
        Vec3 forward(std::cos(p) * std::sin(h), -std::sin(p), -std::cos(p) * std::cos(h));
        CameraSpec camera;
        camera.position = target - forward * distance;
        camera.target = target;
        camera.verticalFovDeg = verticalFovDeg;
        return camera;
    }

    RenderOutput render(const CameraSpec& worldCamera, const sky::PhysicalSky& sky, const RenderSettings& settings) const {
        return render(worldCamera, Environment{&sky, Vec3(0, 0, 0)}, settings);
    }

    RenderOutput render(const CameraSpec& worldCamera, const Environment& environment, const RenderSettings& settings) const {
        auto start = std::chrono::steady_clock::now();
        const int w = std::max(1, settings.width);
        const int h = std::max(1, settings.height);
        const int spp = std::max(1, settings.samplesPerPixel);
        const size_t n = static_cast<size_t>(w) * h;

        RenderOutput out;
        out.width = w;
        out.height = h;
        out.color.assign(n, Vec3(0, 0, 0));
        out.guides.width = w;
        out.guides.height = h;
        out.guides.albedo.assign(n, Vec3(0, 0, 0));
        out.guides.normal.assign(n, Vec3(0, 0, 0));
        out.guides.depth.assign(n, 0.0f);
        out.guides.variance.assign(n, 0.0f);
        out.guides.geometryMask.assign(n, 0);

        const Vec3 camPos = worldCamera.position - origin_;
        const Vec3 camTarget = worldCamera.target - origin_;
        Vec3 forward = (camTarget - camPos).normalized();
        if (forward.lengthSquared() < 0.5f) forward = Vec3(0, 0, -1);
        Vec3 right = forward.cross(worldCamera.up).normalized();
        if (right.lengthSquared() < 0.5f) right = Vec3(1, 0, 0);
        const Vec3 upv = right.cross(forward);
        const float tanHalf = std::tan(0.5f * worldCamera.verticalFovDeg * math::DEG_TO_RAD);
        const float aspect = static_cast<float>(w) / static_cast<float>(h);
        const float focusDistance = worldCamera.focusDistance > 0.0f ? worldCamera.focusDistance : (camTarget - camPos).length();

        Frame frame;
        frame.sky = environment.sky;
        frame.studioRadiance = environment.studioRadiance;
        frame.settings = &settings;
        if (const sky::PhysicalSky* sky = environment.sky) {
            frame.sunIrradiance = sky->sunIrradiance();
            frame.sunVisible = detail::luminance(frame.sunIrradiance) > 1e-8f;
            frame.hazeExtinction = sky->hazeExtinction() + environment.haze.extinction;
            frame.hazeScaleHeight = environment.haze.scaleHeight;
            frame.hazeBaseY = environment.haze.baseY;
            Vec3 horizontalIrradiance = frame.sunIrradiance * std::max(0.0f, sky->sunDirection().y) + sky->skyIrradianceHorizontal();
            frame.bakedRadianceScale = detail::luminance(horizontalIrradiance) / detail::kPi;
        } else {
            // A uniform dome of radiance L puts pi L on a horizontal surface, so baked radiance scales by L.
            frame.bakedRadianceScale = detail::luminance(environment.studioRadiance);
        }

        const int tileSize = 16;
        const int tilesX = (w + tileSize - 1) / tileSize;
        const int tilesY = (h + tileSize - 1) / tileSize;
        const int totalTiles = tilesX * tilesY;
        std::atomic<int> nextTile{0};
        std::atomic<size_t> nanSamples{0};
        std::atomic<size_t> coveredPixels{0};
        std::atomic<size_t> rays{0};

        auto worker = [&]() {
            size_t localNan = 0, localCovered = 0, localRays = 0;
            for (int tile = nextTile++; tile < totalTiles; tile = nextTile++) {
                const int x0 = (tile % tilesX) * tileSize;
                const int y0 = (tile / tilesX) * tileSize;
                for (int py = y0; py < std::min(y0 + tileSize, h); ++py) {
                    for (int px = x0; px < std::min(x0 + tileSize, w); ++px) {
                        const size_t pixel = static_cast<size_t>(py) * w + px;
                        detail::Pcg32 rng(detail::splitmix64(settings.seed), pixel);
                        Vec3 colorSum(0, 0, 0), albedoSum(0, 0, 0), normalSum(0, 0, 0);
                        double lumSum = 0.0, lumSq = 0.0, depthSum = 0.0;
                        int hits = 0;
                        for (int s = 0; s < spp; ++s) {
                            float sx = (static_cast<float>(px) + 0.5f + detail::tentSample(rng.next())) / w;
                            float sy = (static_cast<float>(py) + 0.5f + detail::tentSample(rng.next())) / h;
                            Vec3 dir = (forward + right * ((2.0f * sx - 1.0f) * tanHalf * aspect) + upv * ((1.0f - 2.0f * sy) * tanHalf)).normalized();
                            Vec3 origin = camPos;
                            if (worldCamera.apertureRadius > 0.0f) {
                                Vec2 lens = detail::concentricDisk(rng.next(), rng.next());
                                Vec3 focusPoint = camPos + dir * (focusDistance / std::max(dir.dot(forward), 1e-4f));
                                origin = camPos + (right * lens.x + upv * lens.y) * worldCamera.apertureRadius;
                                dir = (focusPoint - origin).normalized();
                            }
                            PathSample sample = tracePath(origin, dir, rng, frame, localRays);
                            if (!detail::isFinite(sample.radiance)) {
                                ++localNan;
                                continue;
                            }
                            colorSum += sample.radiance;
                            double l = detail::luminance(sample.radiance);
                            lumSum += l;
                            lumSq += l * l;
                            if (sample.hitGeometry) {
                                ++hits;
                                albedoSum += sample.albedo;
                                normalSum += sample.normal;
                                depthSum += sample.depth;
                            }
                        }
                        const float inv = 1.0f / static_cast<float>(spp);
                        out.color[pixel] = colorSum * inv;
                        double mean = lumSum / spp;
                        out.guides.variance[pixel] = static_cast<float>(std::max(0.0, lumSq / spp - mean * mean) / spp);
                        if (hits * 2 >= spp) {
                            out.guides.geometryMask[pixel] = 1;
                            out.guides.albedo[pixel] = albedoSum / static_cast<float>(hits);
                            out.guides.normal[pixel] = normalSum.normalized();
                            out.guides.depth[pixel] = static_cast<float>(depthSum / hits);
                            ++localCovered;
                        }
                    }
                }
            }
            nanSamples += localNan;
            coveredPixels += localCovered;
            rays += localRays;
        };

        unsigned threadCount = settings.threads > 0 ? static_cast<unsigned>(settings.threads)
                                                    : std::max(1u, std::thread::hardware_concurrency());
        std::vector<std::thread> pool;
        for (unsigned t = 0; t < threadCount; ++t) pool.emplace_back(worker);
        for (auto& t : pool) t.join();

        out.nanSamples = nanSamples.load();
        out.rays = rays.load();
        out.geometryCoverage = static_cast<float>(coveredPixels.load()) / static_cast<float>(n);
        out.renderMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
        return out;
    }

private:
    struct Frame {
        /** Null under the studio dome. */
        const sky::PhysicalSky* sky{nullptr};
        Vec3 studioRadiance{1, 1, 1};
        const RenderSettings* settings{nullptr};
        Vec3 sunIrradiance{0, 0, 0};
        bool sunVisible{false};
        Vec3 hazeExtinction{0, 0, 0};
        float hazeScaleHeight{0.0f};
        float hazeBaseY{0.0f};
        float bakedRadianceScale{1.0f};
    };

    struct Hit {
        bool valid{false};
        bool ground{false};
        float t{0.0f};
        Vec3 position;
        uint32_t triangle{0};
        float u{0.0f};
        float v{0.0f};
        Vec3 interpolatedNormal{0, 1, 0};
    };

    struct PathSample {
        Vec3 radiance{0, 0, 0};
        bool hitGeometry{false};
        Vec3 albedo{0, 0, 0};
        Vec3 normal{0, 0, 0};
        float depth{0.0f};
    };

    /** Which triangles are alpha-masked (none under the clay material, which is never cut out). */
    void buildAlphaMask() {
        const size_t triCount = mesh_.indices.size() / 3;
        maskTri_.assign(triCount, 0);
        anyMask_ = false;
        if (clay_) return;
        for (size_t t = 0; t < triCount && t < scene_.triangleMaterial.size(); ++t) {
            if (scene_.materials[scene_.triangleMaterial[t]].alphaMask) {
                maskTri_[t] = 1;
                anyMask_ = true;
            }
        }
    }

    /** Whether triangle `tri` is there at barycentrics (u, v): always, unless its alpha-masked base colour is cut out there. */
    bool surfaceAt(uint32_t tri, float u, float v) const {
        if (!anyMask_ || tri >= maskTri_.size() || !maskTri_[tri]) return true;
        const auto& mat = scene_.materials[scene_.triangleMaterial[tri]];
        float alpha = mat.baseColorFactor.w;
        if (mat.baseColorImage >= 0 && mat.baseColorImage < static_cast<int>(scene_.images.size())) {
            const auto& image = scene_.images[static_cast<size_t>(mat.baseColorImage)];
            if (image.decoded) {
                const auto& v0 = mesh_.vertices[mesh_.indices[tri * 3]];
                const auto& v1 = mesh_.vertices[mesh_.indices[tri * 3 + 1]];
                const auto& v2 = mesh_.vertices[mesh_.indices[tri * 3 + 2]];
                const float w = 1.0f - u - v;
                Vec2 uv(v0.uv.x * w + v1.uv.x * u + v2.uv.x * v, v0.uv.y * w + v1.uv.y * u + v2.uv.y * v);
                alpha *= detail::sampleAlpha(image.pixels, uv, mat.wrapS, mat.wrapT);
            }
        }
        return alpha >= mat.alphaCutoff;
    }

    /** Cut-out hits a ray passes before giving up (a dense canopy seen edge-on). */
    static constexpr int kMaxAlphaSkips = 64;

    /** The nearest surface along the ray: a cut-out texel of a masked triangle is passed and the ray continues past it. */
    bool raycastSurface(const Vec3& origin, const Vec3& dir, bvh::RayHit& out) const {
        if (!anyMask_) return bvh_.raycast(Ray(origin, dir), out);
        Vec3 o = origin;
        float travelled = 0.0f;
        for (int k = 0; k < kMaxAlphaSkips; ++k) {
            bvh::RayHit rh;
            if (!bvh_.raycast(Ray(o, dir), rh)) return false;
            if (surfaceAt(rh.triangleIndex, rh.u, rh.v)) {
                out = rh;
                out.t = travelled + rh.t;
                return true;
            }
            const float step = rh.t + 1e-4f;
            travelled += step;
            o = o + dir * step;
        }
        return false;
    }

    Hit intersect(const Vec3& origin, const Vec3& dir) const {
        Hit hit;
        bvh::RayHit rh;
        if (raycastSurface(origin, dir, rh)) {
            hit.valid = true;
            hit.t = rh.t;
            hit.position = rh.position;
            hit.triangle = rh.triangleIndex;
            hit.u = rh.u;
            hit.v = rh.v;
            hit.interpolatedNormal = rh.normal;
        }
        if (groundEnabled_ && dir.y < -1e-6f) {
            float t = (groundLocalY_ - origin.y) / dir.y;
            if (t > detail::kRayEpsilon && (!hit.valid || t < hit.t)) {
                hit = Hit{};
                hit.valid = true;
                hit.ground = true;
                hit.t = t;
                hit.position = origin + dir * t;
            }
        }
        return hit;
    }

    Vec3 triangleAlbedo(uint32_t tri, float u, float v) const {
        const auto& v0 = mesh_.vertices[mesh_.indices[tri * 3]];
        const auto& v1 = mesh_.vertices[mesh_.indices[tri * 3 + 1]];
        const auto& v2 = mesh_.vertices[mesh_.indices[tri * 3 + 2]];
        float w = 1.0f - u - v;
        Vec2 uv(v0.uv.x * w + v1.uv.x * u + v2.uv.x * v, v0.uv.y * w + v1.uv.y * u + v2.uv.y * v);
        const auto& mat = scene_.materials[scene_.triangleMaterial[tri]];
        Vec3 base(mat.baseColorFactor.x, mat.baseColorFactor.y, mat.baseColorFactor.z);
        if (mat.baseColorImage >= 0 && mat.baseColorImage < static_cast<int>(scene_.images.size())) {
            const auto& image = scene_.images[static_cast<size_t>(mat.baseColorImage)];
            if (image.decoded) base = base * detail::sampleTextureLinear(image.pixels, uv, mat.wrapS, mat.wrapT);
        }
        Vec4 vertCol = v0.color * w + v1.color * u + v2.color * v;
        if (vertCol.w > 0.001f && (vertCol.x != 1.0f || vertCol.y != 1.0f || vertCol.z != 1.0f)) {
            base = base * Vec3(vertCol.x, vertCol.y, vertCol.z);
        }
        return base;
    }

    /** Emitted radiance of a triangle at barycentrics (u, v): the factor (with its strength) times the emissive texture. */
    Vec3 triangleEmission(uint32_t tri, float u, float v) const {
        const auto& mat = scene_.materials[scene_.triangleMaterial[tri]];
        Vec3 e = mat.emissiveFactor;
        if (detail::luminance(e) <= 0.0f) return Vec3(0, 0, 0);
        if (mat.emissiveImage >= 0 && mat.emissiveImage < static_cast<int>(scene_.images.size())) {
            const auto& image = scene_.images[static_cast<size_t>(mat.emissiveImage)];
            if (image.decoded) {
                const auto& v0 = mesh_.vertices[mesh_.indices[tri * 3]];
                const auto& v1 = mesh_.vertices[mesh_.indices[tri * 3 + 1]];
                const auto& v2 = mesh_.vertices[mesh_.indices[tri * 3 + 2]];
                const float w = 1.0f - u - v;
                Vec2 uv(v0.uv.x * w + v1.uv.x * u + v2.uv.x * v, v0.uv.y * w + v1.uv.y * u + v2.uv.y * v);
                e = e * detail::sampleTextureLinear(image.pixels, uv, mat.emissiveWrapS, mat.emissiveWrapT);
            }
        }
        return e;
    }

    void buildLights() {
        if (!lightSampling_) {
            lights_ = lights::LightSet{};
            lights_.triangleLight.assign(mesh_.indices.size() / 3, lights::kNoLight);
            return;
        }
        lights_ = lights::buildLightSet(
            [&](uint32_t i) { return mesh_.vertices[i].position; }, mesh_.indices,
            [&](size_t t, float u, float v) { return triangleEmission(static_cast<uint32_t>(t), u, v); },
            punctual_, !clay_);
    }

    /** Whether anything (the scene or the ground plane) lies on the segment from `o` along `d` before `tMax`. */
    bool occluded(const Vec3& o, const Vec3& d, float tMax) const {
        if (!anyMask_) {
            if (bvh_.raycastAny(Ray(o, d), tMax)) return true;
        } else {
            // Cut-out texels let the light through: a shadow ray stops only at a surface that is there.
            bvh::RayHit rh;
            if (raycastSurface(o, d, rh) && rh.t < tMax) return true;
        }
        if (groundEnabled_ && d.y < -1e-6f) {
            const float t = (groundLocalY_ - o.y) / d.y;
            if (t > detail::kRayEpsilon && t < tMax) return true;
        }
        return false;
    }

    /**
     * One light sample at a vertex: a light picked from the tree, a point on it (uniform by area on a triangle),
     * a shadow ray, and the result weighted against the BSDF by the power heuristic when the path goes on (`mis`),
     * else in full. Delta lights (points, spots, distant) take no weight.
     */
    void sampleLight(const detail::SurfacePoint& surface, const detail::MetallicRoughnessBsdf& bsdf, const Vec3& throughput,
                     float uSelect, float u1, float u2, bool mis, int bounce, float clampIndirect, Vec3& radiance, size_t& rayCount) const {
        uint32_t index = lights::kNoLight;
        const float select = lights::pickLight(lights_, surface.position, surface.shadingNormal, uSelect, index);
        if (!(select > 0.0f)) return;
        const lights::LightRecord& light = lights_.records[index];
        Vec3 wi, incident;
        float distance = 1e9f, lightPdf = 0.0f;
        if (light.kind == lights::kTriangleLight) {
            const float su = std::sqrt(u1);
            const float bu = su * (1.0f - u2), bv = su * u2;
            const Vec3 e1 = lights::vec(light.e1), e2 = lights::vec(light.e2);
            const Vec3 y = lights::vec(light.p0) + e1 * bu + e2 * bv;
            const Vec3 v = y - surface.position;
            const float d2 = v.lengthSquared();
            if (!(d2 > 1e-12f)) return;
            distance = std::sqrt(d2);
            wi = v / distance;
            const float cosLight = std::abs(e1.cross(e2).normalized().dot(wi));
            if (cosLight < 1e-6f) return;
            const Vec3 emitted = triangleEmission(light.triangle, bu, bv);
            if (!(detail::luminance(emitted) > 0.0f)) return;
            lightPdf = select * d2 / (light.area * cosLight);
            incident = emitted / lightPdf;
        } else if (light.kind == lights::kPointLight) {
            const Vec3 v = lights::vec(light.p0) - surface.position;
            const float d2 = v.lengthSquared();
            if (!(d2 > 1e-12f)) return;
            distance = std::sqrt(d2);
            wi = v / distance;
            incident = lights::vec(light.intensity) * (lights::pointFalloff(light, wi, distance) / (d2 * select));
        } else {
            wi = -lights::vec(light.e1);
            incident = lights::vec(light.intensity) / select;
        }
        const float cosShading = surface.shadingNormal.dot(wi);
        if (cosShading <= 0.0f || surface.geometricNormal.dot(wi) <= 0.0f) return;
        const Vec3 f = bsdf.eval(wi);
        const float weight = mis && lightPdf > 0.0f ? lights::powerHeuristic(lightPdf, bsdf.pdf(wi)) : 1.0f;
        const Vec3 contribution = throughput * f * incident * (cosShading * weight);
        if (!(detail::maxComponent(contribution) > 0.0f)) return;
        ++rayCount;
        const float tMax = distance < 1e9f ? std::max(distance - 2.0f * detail::kRayEpsilon, 1e-4f) : 1e9f;
        if (occluded(surface.position + surface.geometricNormal * detail::kRayEpsilon, wi, tMax)) return;
        accumulate(radiance, contribution, bounce, clampIndirect);
    }

    detail::SurfacePoint shade(const Hit& hit, const Vec3& dir) const {
        detail::SurfacePoint s;
        s.position = hit.position;
        if (hit.ground) {
            s.baseColor = clay_ ? clayAlbedo_ : groundAlbedo_;
            s.roughness = clay_ ? clayRoughness_ : 0.9f;
        } else {
            const auto& p0 = mesh_.vertices[mesh_.indices[hit.triangle * 3]].position;
            const auto& p1 = mesh_.vertices[mesh_.indices[hit.triangle * 3 + 1]].position;
            const auto& p2 = mesh_.vertices[mesh_.indices[hit.triangle * 3 + 2]].position;
            Vec3 ng = (p1 - p0).cross(p2 - p0).normalized();
            if (ng.lengthSquared() < 0.5f) ng = hit.interpolatedNormal;
            s.geometricNormal = ng;
            s.shadingNormal = hit.interpolatedNormal.lengthSquared() > 0.5f ? hit.interpolatedNormal : ng;
            if (clay_) {
                s.baseColor = clayAlbedo_;
                s.metallic = clayMetallic_;
                s.roughness = clayRoughness_;
            } else {
                const auto& v0 = mesh_.vertices[mesh_.indices[hit.triangle * 3]];
            const auto& v1 = mesh_.vertices[mesh_.indices[hit.triangle * 3 + 1]];
            const auto& v2 = mesh_.vertices[mesh_.indices[hit.triangle * 3 + 2]];
            float w = 1.0f - hit.u - hit.v;
            Vec2 uv(v0.uv.x * w + v1.uv.x * hit.u + v2.uv.x * hit.v,
                    v0.uv.y * w + v1.uv.y * hit.u + v2.uv.y * hit.v);

            const auto& mat = scene_.materials[scene_.triangleMaterial[hit.triangle]];
            s.baseColor = triangleAlbedo(hit.triangle, hit.u, hit.v);
            s.metallic = std::clamp(mat.metallicFactor, 0.0f, 1.0f);
            s.roughness = std::clamp(mat.roughnessFactor, 0.02f, 1.0f);
            s.emission = triangleEmission(hit.triangle, hit.u, hit.v);

            // Metallic-Roughness map sampling
            if (mat.metallicRoughnessImage >= 0 && mat.metallicRoughnessImage < static_cast<int>(scene_.images.size())) {
                const auto& mrImg = scene_.images[static_cast<size_t>(mat.metallicRoughnessImage)];
                if (mrImg.decoded) {
                    // Data maps are stored linear: no sRGB decode.
                    Vec3 mrSample = detail::sampleTexture(mrImg.pixels, uv, mat.mrWrapS, mat.mrWrapT, false);
                    s.roughness = std::clamp(s.roughness * mrSample.y, 0.02f, 1.0f); // Green = Roughness
                    s.metallic = std::clamp(s.metallic * mrSample.z, 0.0f, 1.0f);   // Blue = Metalness
                }
            }

            // Occlusion map sampling
            if (mat.occlusionImage >= 0 && mat.occlusionImage < static_cast<int>(scene_.images.size())) {
                const auto& occImg = scene_.images[static_cast<size_t>(mat.occlusionImage)];
                if (occImg.decoded) {
                    Vec3 occSample = detail::sampleTexture(occImg.pixels, uv, 10497, 10497, false);
                    float ao = 1.0f + mat.occlusionStrength * (occSample.x - 1.0f); // Red = Occlusion
                    s.baseColor = s.baseColor * std::clamp(ao, 0.05f, 1.0f);
                }
            }

            // Normal map perturbation
            if (mat.normalImage >= 0 && mat.normalImage < static_cast<int>(scene_.images.size())) {
                const auto& nImg = scene_.images[static_cast<size_t>(mat.normalImage)];
                if (nImg.decoded) {
                    Vec3 nSample = detail::sampleTexture(nImg.pixels, uv, mat.normalWrapS, mat.normalWrapT, false);
                    Vec3 tanNormal(
                        (2.0f * nSample.x - 1.0f) * mat.normalScale,
                        (2.0f * nSample.y - 1.0f) * mat.normalScale,
                        2.0f * nSample.z - 1.0f
                    );
                    tanNormal = tanNormal.normalized();

                    // Evaluate Tangent and Bitangent
                    Vec4 tanInterp = v0.tangent * w + v1.tangent * hit.u + v2.tangent * hit.v;
                    Vec3 T(tanInterp.x, tanInterp.y, tanInterp.z);
                    Vec3 N = s.shadingNormal;
                    float sign = tanInterp.w < 0.0f ? -1.0f : 1.0f;

                    if (T.lengthSquared() < 0.1f) {
                        // Derive tangent on the fly from triangle derivatives
                        Vec3 dp1 = v1.position - v0.position;
                        Vec3 dp2 = v2.position - v0.position;
                        Vec2 duv1 = v1.uv - v0.uv;
                        Vec2 duv2 = v2.uv - v0.uv;
                        float det = duv1.x * duv2.y - duv2.x * duv1.y;
                        if (std::abs(det) > 1e-7f) {
                            T = ((dp1 * duv2.y - dp2 * duv1.y) * (1.0f / det)).normalized();
                        } else {
                            T = (std::abs(N.y) < 0.99f ? Vec3(0, 1, 0) : Vec3(1, 0, 0)).cross(N).normalized();
                        }
                    }

                    // Gram-Schmidt orthonormalize T against N
                    T = (T - N * N.dot(T)).normalized();
                    if (T.lengthSquared() > 0.5f) {
                        Vec3 B = N.cross(T) * sign;
                        s.shadingNormal = (T * tanNormal.x + B * tanNormal.y + N * tanNormal.z).normalized();
                    }
                }
            }
        }
    }
        Vec3 wo = -dir;
        if (s.geometricNormal.dot(wo) < 0.0f) s.geometricNormal = -s.geometricNormal;
        if (s.shadingNormal.dot(s.geometricNormal) < 0.0f) s.shadingNormal = -s.shadingNormal;
        if (s.shadingNormal.dot(wo) <= 1e-4f) s.shadingNormal = s.geometricNormal;
        return s;
    }

    static void accumulate(Vec3& radiance, Vec3 contribution, int bounce, float clampIndirect) {
        if (bounce >= 1 && clampIndirect > 0.0f) {
            float l = detail::luminance(contribution);
            if (l > clampIndirect) contribution = contribution * (clampIndirect / l);
        }
        radiance += contribution;
    }

    PathSample tracePath(Vec3 origin, Vec3 dir, detail::Pcg32& rng, const Frame& frame, size_t& rayCount) const {
        const sky::PhysicalSky* sky = frame.sky;
        const RenderSettings& settings = *frame.settings;
        PathSample result;
        Vec3 radiance(0, 0, 0);
        Vec3 throughput(1, 1, 1);
        const bool sampleLights = !lights_.empty();
        // The previous vertex, for weighting emission a BSDF ray finds against the light sample taken there.
        Vec3 prevPosition(0, 0, 0), prevNormal(0, 1, 0);
        float prevBsdfPdf = 0.0f;
        for (int bounce = 0;; ++bounce) {
            ++rayCount;
            Hit hit = intersect(origin, dir);
            if (!hit.valid) {
                Vec3 skyLight = sky ? sky->skyRadiance(dir) : frame.studioRadiance;
                if (sky && bounce == 0) skyLight += sky->sunDiscRadiance(dir);
                accumulate(radiance, throughput * skyLight, bounce, settings.clampIndirect);
                break;
            }
            detail::SurfacePoint surface = shade(hit, dir);
            if (bounce == 0) {
                result.hitGeometry = true;
                result.albedo = surface.baseColor;
                result.normal = surface.shadingNormal;
                result.depth = hit.t;
            }

            if (sky) {
                const float column = detail::hazeColumnFactor(origin.y, origin.y + dir.y * hit.t, frame.hazeScaleHeight, frame.hazeBaseY);
                Vec3 opticalDepth = frame.hazeExtinction * (hit.t * column);
                Vec3 transmittance(std::exp(-opticalDepth.x), std::exp(-opticalDepth.y), std::exp(-opticalDepth.z));
                accumulate(radiance, throughput * (sky->horizonRadiance(dir) * (Vec3(1, 1, 1) - transmittance)), bounce, settings.clampIndirect);
                throughput = throughput * transmittance;
            }

            if (settings.mode == ShadingMode::Baked) {
                radiance += throughput * surface.baseColor * frame.bakedRadianceScale;
                break;
            }
            const uint32_t emitter = hit.ground ? lights::kNoLight : lights_.triangleLight[hit.triangle];
            if (bounce == 0 || emitter == lights::kNoLight) {
                radiance += throughput * surface.emission;
            } else {
                // Found by the BSDF ray of the previous vertex, which also sampled the lights: weight the two.
                const float cosLight = std::abs(surface.geometricNormal.dot(dir));
                const float lightPdf = cosLight > 1e-6f
                    ? lights::selectPdf(lights_, prevPosition, prevNormal, emitter) * hit.t * hit.t / (lights_.records[emitter].area * cosLight)
                    : 0.0f;
                accumulate(radiance, throughput * surface.emission * lights::powerHeuristic(prevBsdfPdf, lightPdf), bounce, settings.clampIndirect);
            }

            const Vec3 wo = -dir;
            detail::MetallicRoughnessBsdf bsdf(surface, wo);
            if (frame.sunVisible) {
                const float s1 = rng.next();
                const float s2 = rng.next();
                Vec3 wi = sky->sampleSunDirection(s1, s2);
                float cosShading = surface.shadingNormal.dot(wi);
                if (cosShading > 0.0f && surface.geometricNormal.dot(wi) > 0.0f) {
                    ++rayCount;
                    if (!occluded(surface.position + surface.geometricNormal * detail::kRayEpsilon, wi, 1e9f)) {
                        accumulate(radiance, throughput * bsdf.eval(wi) * frame.sunIrradiance * cosShading, bounce, settings.clampIndirect);
                    }
                }
            }
            if (sampleLights) {
                const float uSelect = rng.next();
                const float u1 = rng.next();
                const float u2 = rng.next();
                sampleLight(surface, bsdf, throughput, uSelect, u1, u2, bounce < settings.maxBounces, bounce, settings.clampIndirect, radiance, rayCount);
            }

            if (bounce >= settings.maxBounces) break;
            Vec3 wi, weight;
            if (!bsdf.sample(rng, wi, weight) || surface.geometricNormal.dot(wi) <= 0.0f) break;
            prevPosition = surface.position;
            prevNormal = surface.shadingNormal;
            prevBsdfPdf = bsdf.pdf(wi);
            throughput = throughput * weight;
            if (bounce >= 2) {
                float q = std::min(0.95f, detail::maxComponent(throughput));
                if (q <= 0.0f || rng.next() > q) break;
                throughput = throughput / q;
            }
            origin = surface.position + surface.geometricNormal * detail::kRayEpsilon;
            dir = wi;
        }
        result.radiance = radiance;
        return result;
    }

    // Street level is the height holding the most upward-facing surface area below the area-weighted
    // median; roofs spread over many heights while streets share one.
    void estimateGround() {
        struct FlatSample {
            float height;
            float area;
            uint32_t triangle;
        };
        std::vector<FlatSample> flats;
        const size_t triCount = mesh_.indices.size() / 3;
        double totalArea = 0.0;
        for (size_t t = 0; t < triCount; ++t) {
            const auto& p0 = mesh_.vertices[mesh_.indices[t * 3]].position;
            const auto& p1 = mesh_.vertices[mesh_.indices[t * 3 + 1]].position;
            const auto& p2 = mesh_.vertices[mesh_.indices[t * 3 + 2]].position;
            Vec3 cr = (p1 - p0).cross(p2 - p0);
            float len = cr.length();
            if (len <= 1e-8f || std::abs(cr.y / len) < 0.9f) continue;
            float area = 0.5f * len;
            flats.push_back({(p0.y + p1.y + p2.y) / 3.0f, area, static_cast<uint32_t>(t)});
            totalArea += area;
        }
        if (flats.empty()) {
            groundLocalY_ = mesh_.bounds.min.y;
            return;
        }
        std::sort(flats.begin(), flats.end(), [](const FlatSample& a, const FlatSample& b) { return a.height < b.height; });
        double running = 0.0;
        float medianHeight = flats.back().height;
        for (const auto& f : flats) {
            running += f.area;
            if (running >= 0.5 * totalArea) {
                medianHeight = f.height;
                break;
            }
        }
        const float binSize = 0.5f;
        const float low = flats.front().height;
        const int bins = std::max(1, static_cast<int>((medianHeight - low) / binSize) + 1);
        std::vector<double> histogram(static_cast<size_t>(bins), 0.0);
        for (const auto& f : flats) {
            if (f.height > medianHeight) break;
            int b = std::clamp(static_cast<int>((f.height - low) / binSize), 0, bins - 1);
            histogram[static_cast<size_t>(b)] += f.area;
        }
        int best = static_cast<int>(std::max_element(histogram.begin(), histogram.end()) - histogram.begin());
        float street = low + (static_cast<float>(best) + 0.5f) * binSize;

        Vec3 albedoSum(0, 0, 0);
        double albedoArea = 0.0;
        for (const auto& f : flats) {
            if (f.height < street - 1.0f || f.height > street + 1.5f) continue;
            albedoSum += triangleAlbedo(f.triangle, 1.0f / 3.0f, 1.0f / 3.0f) * f.area;
            albedoArea += f.area;
        }
        if (albedoArea > 0.0) groundAlbedo_ = albedoSum / static_cast<float>(albedoArea);
        groundLocalY_ = street - 0.25f;
    }

    const gltf::GltfScene& scene_;
    std::vector<gltf::SceneLight> punctual_;
    lights::LightSet lights_;
    bool lightSampling_{true};
    std::vector<uint8_t> maskTri_;
    bool anyMask_{false};
    bool groundEnabled_;
    Vec3 origin_;
    geometry::ScratchboxMesh mesh_;
    bvh::BvhTree bvh_;
    float groundLocalY_{0.0f};
    Vec3 groundAlbedo_{0.18f, 0.18f, 0.18f};
    bool clay_{false};
    Vec3 clayAlbedo_{0.716f, 0.672f, 0.610f};
    float clayRoughness_{0.82f};
    float clayMetallic_{0.02f};
};

} // namespace render
} // namespace scratchbox

#endif // SCRATCHBOX_PATHTRACER_HPP
