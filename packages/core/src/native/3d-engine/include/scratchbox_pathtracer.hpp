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
#include "scratchbox_sky.hpp"
#include "scratchbox_view_transform.hpp"
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
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
        float specularWeight = luminance(f0_ * scale + Vec3(bias, bias, bias));
        float diffuseWeight = (1.0f - metallic_) * luminance(base_);
        specularProbability_ = std::clamp(specularWeight / std::max(specularWeight + diffuseWeight, 1e-6f), 0.02f, 0.9f);
    }

    Vec3 eval(const Vec3& wiWorld) const {
        Vec3 l = toLocal(wiWorld);
        if (l.z <= 0.0f || wo_.z <= 0.0f) return Vec3(0, 0, 0);
        Vec3 h = (wo_ + l).normalized();
        Vec3 f = schlickFresnel(f0_, std::max(wo_.dot(h), 0.0f));
        Vec3 specular = f * (ggxDistribution(h.z, a2_) * smithVisibilityCorrelated(wo_.z, l.z, a2_));
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
    Vec3 wo_;
    float metallic_;
    float alpha_{1.0f};
    float a2_{1.0f};
    float specularProbability_{0.5f};
};

} // namespace detail

/**
 * Unidirectional Monte Carlo path tracer over a flattened glTF scene: next-event estimation of the
 * solar disc, sky dome lighting on escape, distance-based aerial perspective, and a ground plane at
 * the scene's measured street level so the surroundings of a tile are not an empty void.
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
        estimateGround();
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
        frame.sky = &sky;
        frame.settings = &settings;
        frame.sunIrradiance = sky.sunIrradiance();
        frame.sunVisible = detail::luminance(frame.sunIrradiance) > 1e-8f;
        frame.hazeExtinction = sky.hazeExtinction();
        Vec3 horizontalIrradiance = frame.sunIrradiance * std::max(0.0f, sky.sunDirection().y) + sky.skyIrradianceHorizontal();
        frame.bakedRadianceScale = detail::luminance(horizontalIrradiance) / detail::kPi;

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
        const sky::PhysicalSky* sky{nullptr};
        const RenderSettings* settings{nullptr};
        Vec3 sunIrradiance;
        bool sunVisible{false};
        Vec3 hazeExtinction;
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

    Hit intersect(const Vec3& origin, const Vec3& dir) const {
        Hit hit;
        bvh::RayHit rh;
        if (bvh_.raycast(Ray(origin, dir), rh)) {
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
            s.emission = mat.emissiveFactor;

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
        const sky::PhysicalSky& sky = *frame.sky;
        const RenderSettings& settings = *frame.settings;
        PathSample result;
        Vec3 radiance(0, 0, 0);
        Vec3 throughput(1, 1, 1);
        for (int bounce = 0;; ++bounce) {
            ++rayCount;
            Hit hit = intersect(origin, dir);
            if (!hit.valid) {
                Vec3 skyLight = sky.skyRadiance(dir);
                if (bounce == 0) skyLight += sky.sunDiscRadiance(dir);
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

            Vec3 opticalDepth = frame.hazeExtinction * hit.t;
            Vec3 transmittance(std::exp(-opticalDepth.x), std::exp(-opticalDepth.y), std::exp(-opticalDepth.z));
            accumulate(radiance, throughput * (sky.horizonRadiance(dir) * (Vec3(1, 1, 1) - transmittance)), bounce, settings.clampIndirect);
            throughput = throughput * transmittance;

            if (settings.mode == ShadingMode::Baked) {
                radiance += throughput * surface.baseColor * frame.bakedRadianceScale;
                break;
            }
            radiance += throughput * surface.emission;

            const Vec3 wo = -dir;
            detail::MetallicRoughnessBsdf bsdf(surface, wo);
            if (frame.sunVisible) {
                Vec3 wi = sky.sampleSunDirection(rng.next(), rng.next());
                float cosShading = surface.shadingNormal.dot(wi);
                if (cosShading > 0.0f && surface.geometricNormal.dot(wi) > 0.0f) {
                    Ray shadowRay(surface.position + surface.geometricNormal * detail::kRayEpsilon, wi);
                    ++rayCount;
                    if (!bvh_.raycastAny(shadowRay, 1e9f)) {
                        accumulate(radiance, throughput * bsdf.eval(wi) * frame.sunIrradiance * cosShading, bounce, settings.clampIndirect);
                    }
                }
            }

            if (bounce >= settings.maxBounces) break;
            Vec3 wi, weight;
            if (!bsdf.sample(rng, wi, weight) || surface.geometricNormal.dot(wi) <= 0.0f) break;
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
