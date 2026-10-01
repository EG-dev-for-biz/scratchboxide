/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_DENOISE_HPP
#define SCRATCHBOX_DENOISE_HPP

#include "scratchbox_math.hpp"
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <thread>
#include <vector>

namespace scratchbox {
namespace denoise {

using math::Vec3;

/** First-hit feature buffers written by the renderer alongside the noisy color. */
struct GuideBuffers {
    int width{0};
    int height{0};
    std::vector<Vec3> albedo;
    std::vector<Vec3> normal;
    std::vector<float> depth;
    std::vector<float> variance;        // luminance variance of each pixel's color estimate; may be empty
    std::vector<uint8_t> geometryMask;  // 1 = surface pixel to filter, 0 = background kept unchanged
};

struct DenoiseSettings {
    int iterations{5};
    float sigmaNormal{128.0f};
    float sigmaDepth{1.0f};
    float sigmaLuminance{4.0f};
};

namespace detail {

inline float luminance(const Vec3& c) {
    return 0.2126f * c.x + 0.7152f * c.y + 0.0722f * c.z;
}

inline float normalWeight(float cosine, float sigma) {
    float x = std::max(cosine, 0.0f);
    if (sigma == 128.0f) {
        for (int i = 0; i < 7; ++i) x *= x;
        return x;
    }
    return std::pow(x, sigma);
}

template <typename Fn>
inline void parallelRows(int height, Fn&& fn) {
    unsigned workers = std::max(1u, std::min(std::thread::hardware_concurrency(), 32u));
    std::vector<std::thread> pool;
    for (unsigned w = 0; w < workers; ++w) {
        pool.emplace_back([&, w]() {
            for (int y = static_cast<int>(w); y < height; y += static_cast<int>(workers)) fn(y);
        });
    }
    for (auto& t : pool) t.join();
}

} // namespace detail

/**
 * Edge-avoiding a-trous wavelet filter on demodulated illumination (color / albedo), steered by
 * normal, depth-gradient and variance-scaled luminance weights, then remodulated by albedo so
 * texture detail stays sharp. Returns `color` unchanged when the guide buffers do not match.
 */
inline std::vector<Vec3> denoiseATrous(const std::vector<Vec3>& color, const GuideBuffers& g, const DenoiseSettings& s = {}) {
    const int w = g.width;
    const int h = g.height;
    const size_t n = static_cast<size_t>(w) * h;
    if (w <= 0 || h <= 0 || color.size() != n || g.albedo.size() != n || g.normal.size() != n
        || g.depth.size() != n || g.geometryMask.size() != n) {
        return color;
    }
    const float albedoFloor = 1e-3f;
    auto demodulator = [&](size_t i) {
        const Vec3& a = g.albedo[i];
        return Vec3(std::max(a.x, albedoFloor), std::max(a.y, albedoFloor), std::max(a.z, albedoFloor));
    };

    std::vector<Vec3> illum(n), next(n);
    std::vector<float> variance(n, 0.0f), nextVariance(n, 0.0f), blurredVariance(n, 0.0f);
    std::vector<Vec3> normals(n);
    for (size_t i = 0; i < n; ++i) {
        normals[i] = g.normal[i].normalized();
        if (!g.geometryMask[i]) continue;
        Vec3 a = demodulator(i);
        illum[i] = Vec3(color[i].x / a.x, color[i].y / a.y, color[i].z / a.z);
        float la = std::max(detail::luminance(a), albedoFloor);
        variance[i] = g.variance.size() == n ? std::max(g.variance[i], 0.0f) / (la * la) : 0.0f;
    }

    if (g.variance.size() != n) {
        detail::parallelRows(h, [&](int y) {
            for (int x = 0; x < w; ++x) {
                size_t i = static_cast<size_t>(y) * w + x;
                if (!g.geometryMask[i]) continue;
                double sum = 0.0, sumSq = 0.0;
                int count = 0;
                for (int dy = -1; dy <= 1; ++dy) {
                    for (int dx = -1; dx <= 1; ++dx) {
                        int qx = x + dx, qy = y + dy;
                        if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
                        size_t q = static_cast<size_t>(qy) * w + qx;
                        if (!g.geometryMask[q]) continue;
                        double l = detail::luminance(illum[q]);
                        sum += l;
                        sumSq += l * l;
                        ++count;
                    }
                }
                double mean = sum / count;
                variance[i] = static_cast<float>(std::max(0.0, sumSq / count - mean * mean));
            }
        });
    }

    std::vector<float> gradX(n, 0.0f), gradY(n, 0.0f);
    auto depthAt = [&](int x, int y, float fallback) {
        if (x < 0 || y < 0 || x >= w || y >= h) return fallback;
        size_t q = static_cast<size_t>(y) * w + x;
        return g.geometryMask[q] ? g.depth[q] : fallback;
    };
    for (int y = 0; y < h; ++y) {
        for (int x = 0; x < w; ++x) {
            size_t i = static_cast<size_t>(y) * w + x;
            if (!g.geometryMask[i]) continue;
            float z = g.depth[i];
            gradX[i] = std::min(std::abs(depthAt(x + 1, y, z) - z), std::abs(z - depthAt(x - 1, y, z)));
            gradY[i] = std::min(std::abs(depthAt(x, y + 1, z) - z), std::abs(z - depthAt(x, y - 1, z)));
        }
    }

    const float kernel[5] = {1.0f / 16.0f, 1.0f / 4.0f, 3.0f / 8.0f, 1.0f / 4.0f, 1.0f / 16.0f};
    const float gauss3[3] = {0.25f, 0.5f, 0.25f};
    for (int iteration = 0; iteration < s.iterations; ++iteration) {
        const int step = 1 << iteration;
        detail::parallelRows(h, [&](int y) {
            for (int x = 0; x < w; ++x) {
                size_t i = static_cast<size_t>(y) * w + x;
                if (!g.geometryMask[i]) continue;
                float sum = 0.0f, weight = 0.0f;
                for (int dy = -1; dy <= 1; ++dy) {
                    for (int dx = -1; dx <= 1; ++dx) {
                        int qx = x + dx, qy = y + dy;
                        if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
                        size_t q = static_cast<size_t>(qy) * w + qx;
                        if (!g.geometryMask[q]) continue;
                        float k = gauss3[dx + 1] * gauss3[dy + 1];
                        sum += variance[q] * k;
                        weight += k;
                    }
                }
                blurredVariance[i] = weight > 0.0f ? sum / weight : variance[i];
            }
        });

        detail::parallelRows(h, [&](int y) {
            for (int x = 0; x < w; ++x) {
                size_t p = static_cast<size_t>(y) * w + x;
                if (!g.geometryMask[p]) {
                    next[p] = illum[p];
                    nextVariance[p] = variance[p];
                    continue;
                }
                const float lp = detail::luminance(illum[p]);
                const float zp = g.depth[p];
                const Vec3& np = normals[p];
                const float sigmaL = s.sigmaLuminance * std::sqrt(blurredVariance[p]) + 1e-4f;
                Vec3 sumColor(0, 0, 0);
                float sumWeight = 0.0f, sumVariance = 0.0f;
                for (int ky = -2; ky <= 2; ++ky) {
                    for (int kx = -2; kx <= 2; ++kx) {
                        int qx = x + kx * step, qy = y + ky * step;
                        if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
                        size_t q = static_cast<size_t>(qy) * w + qx;
                        if (!g.geometryMask[q]) continue;
                        float wgt = kernel[kx + 2] * kernel[ky + 2];
                        if (q != p) {
                            float wn = detail::normalWeight(np.dot(normals[q]), s.sigmaNormal);
                            float expectedDz = gradX[p] * std::abs(static_cast<float>(kx * step))
                                             + gradY[p] * std::abs(static_cast<float>(ky * step));
                            float wz = std::exp(-std::abs(zp - g.depth[q]) / (s.sigmaDepth * expectedDz + 1e-3f * std::max(zp, 1.0f)));
                            float wl = std::exp(-std::abs(lp - detail::luminance(illum[q])) / sigmaL);
                            wgt *= wn * wz * wl;
                        }
                        sumColor += illum[q] * wgt;
                        sumWeight += wgt;
                        sumVariance += variance[q] * wgt * wgt;
                    }
                }
                next[p] = sumColor / sumWeight;
                nextVariance[p] = sumVariance / (sumWeight * sumWeight);
            }
        });
        illum.swap(next);
        variance.swap(nextVariance);
    }

    std::vector<Vec3> out(color);
    for (size_t i = 0; i < n; ++i) {
        if (!g.geometryMask[i]) continue;
        Vec3 a = demodulator(i);
        out[i] = Vec3(illum[i].x * a.x, illum[i].y * a.y, illum[i].z * a.z);
    }
    return out;
}

} // namespace denoise
} // namespace scratchbox

#endif // SCRATCHBOX_DENOISE_HPP
