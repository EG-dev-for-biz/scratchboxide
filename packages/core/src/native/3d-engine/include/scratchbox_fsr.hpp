/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

#ifndef SCRATCHBOX_FSR_HPP
#define SCRATCHBOX_FSR_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_texture.hpp"
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <thread>
#include <vector>

namespace scratchbox {
namespace fsr {

using math::Vec2;
using math::Vec3;
using texture::ImageBuffer;

namespace detail {

inline float getLuma(const Vec3& c) {
    return 0.2126f * c.x + 0.7152f * c.y + 0.0722f * c.z;
}

inline float lanczos2(float x) {
    float ax = std::abs(x);
    if (ax < 1e-6f) return 1.0f;
    if (ax >= 2.0f) return 0.0f;
    constexpr float pi = 3.14159265358979323846f;
    float pi_x = pi * ax;
    return (std::sin(pi_x) / pi_x) * (std::sin(0.5f * pi_x) / (0.5f * pi_x));
}

inline Vec3 minVec3(const Vec3& a, const Vec3& b) {
    return {std::min(a.x, b.x), std::min(a.y, b.y), std::min(a.z, b.z)};
}

inline Vec3 maxVec3(const Vec3& a, const Vec3& b) {
    return {std::max(a.x, b.x), std::max(a.y, b.y), std::max(a.z, b.z)};
}

inline Vec3 clampVec3(const Vec3& v, const Vec3& lo, const Vec3& hi) {
    return {
        std::clamp(v.x, lo.x, hi.x),
        std::clamp(v.y, lo.y, hi.y),
        std::clamp(v.z, lo.z, hi.z)
    };
}

template <typename Fn>
inline void parallelRows(int height, Fn&& fn) {
    unsigned workers = std::max(1u, std::min(std::thread::hardware_concurrency(), 32u));
    std::vector<std::thread> pool;
    for (unsigned w = 0; w < workers; ++w) {
        pool.emplace_back([&, w]() {
            for (int y = static_cast<int>(w); y < height; y += static_cast<int>(workers)) {
                fn(y);
            }
        });
    }
    for (auto& t : pool) t.join();
}

} // namespace detail

/**
 * Pass 1: EASU (Edge-Adaptive Spatial Upsampling)
 *
 * 12-tap edge-directed reconstruction:
 * Evaluates gradient orientation and curvature, stretching the sampling filter
 * along edges while compressing across them to preserve sharp contours.
 */
inline ImageBuffer applyEASU(const ImageBuffer& input, int outW, int outH) {
    if (input.empty() || outW <= 0 || outH <= 0) return ImageBuffer();

    const int inW = input.width;
    const int inH = input.height;
    const int channels = input.channels;

    ImageBuffer output(outW, outH, channels);

    detail::parallelRows(outH, [&](int outY) {
        float ppy = (static_cast<float>(outY) + 0.5f) * (static_cast<float>(inH) / static_cast<float>(outH)) - 0.5f;
        int fpy = static_cast<int>(std::floor(ppy));
        float fy = ppy - static_cast<float>(fpy);

        for (int outX = 0; outX < outW; ++outX) {
            float ppx = (static_cast<float>(outX) + 0.5f) * (static_cast<float>(inW) / static_cast<float>(outW)) - 0.5f;
            int fpx = static_cast<int>(std::floor(ppx));
            float fx = ppx - static_cast<float>(fpx);

            // 12-tap sampling:
            //       [a] [d]
            //   [e] [b] [c] [h]
            //   [i] [f] [g] [l]
            //       [j] [k]
            Vec3 c_b = input.getPixelRGB(fpx + 0, fpy + 0);
            Vec3 c_c = input.getPixelRGB(fpx + 1, fpy + 0);
            Vec3 c_f = input.getPixelRGB(fpx + 0, fpy + 1);
            Vec3 c_g = input.getPixelRGB(fpx + 1, fpy + 1);

            Vec3 c_a = input.getPixelRGB(fpx + 0, fpy - 1);
            Vec3 c_d = input.getPixelRGB(fpx + 1, fpy - 1);
            Vec3 c_e = input.getPixelRGB(fpx - 1, fpy + 0);
            Vec3 c_h = input.getPixelRGB(fpx + 2, fpy + 0);
            Vec3 c_i = input.getPixelRGB(fpx - 1, fpy + 1);
            Vec3 c_l = input.getPixelRGB(fpx + 2, fpy + 1);
            Vec3 c_j = input.getPixelRGB(fpx + 0, fpy + 2);
            Vec3 c_k = input.getPixelRGB(fpx + 1, fpy + 2);

            float l_b = detail::getLuma(c_b);
            float l_c = detail::getLuma(c_c);
            float l_f = detail::getLuma(c_f);
            float l_g = detail::getLuma(c_g);

            float l_a = detail::getLuma(c_a);
            float l_d = detail::getLuma(c_d);
            float l_e = detail::getLuma(c_e);
            float l_h = detail::getLuma(c_h);
            float l_i = detail::getLuma(c_i);
            float l_l = detail::getLuma(c_l);
            float l_j = detail::getLuma(c_j);
            float l_k = detail::getLuma(c_k);

            // Compute edge gradient direction vector
            float dirX = (l_b - l_c) + (l_f - l_g);
            float dirY = (l_b - l_f) + (l_c - l_g);
            dirX += ((l_a - l_d) + (l_j - l_k)) * 0.5f;
            dirY += ((l_e - l_i) + (l_h - l_l)) * 0.5f;

            float len = std::sqrt(dirX * dirX + dirY * dirY);
            float ndirX = len > 1e-4f ? dirX / len : 1.0f;
            float ndirY = len > 1e-4f ? dirY / len : 0.0f;

            float stretch = std::clamp(1.0f + len * 2.0f, 1.0f, 3.0f);
            float invStretch = 1.0f / stretch;

            // Rotation matrix mapping into edge orientation
            auto evaluateTap = [&](float dx, float dy) -> float {
                float rx = fx - dx;
                float ry = fy - dy;
                float tx = (ndirX * rx - ndirY * ry) * invStretch;
                float ty = (ndirY * rx + ndirX * ry) * stretch;
                return detail::lanczos2(std::sqrt(tx * tx + ty * ty));
            };

            float w_b = evaluateTap(0.0f, 0.0f);
            float w_c = evaluateTap(1.0f, 0.0f);
            float w_f = evaluateTap(0.0f, 1.0f);
            float w_g = evaluateTap(1.0f, 1.0f);

            float w_a = evaluateTap(0.0f, -1.0f) * 0.25f;
            float w_d = evaluateTap(1.0f, -1.0f) * 0.25f;
            float w_e = evaluateTap(-1.0f, 0.0f) * 0.25f;
            float w_h = evaluateTap(2.0f, 0.0f) * 0.25f;
            float w_i = evaluateTap(-1.0f, 1.0f) * 0.25f;
            float w_l = evaluateTap(2.0f, 1.0f) * 0.25f;
            float w_j = evaluateTap(0.0f, 2.0f) * 0.25f;
            float w_k = evaluateTap(1.0f, 2.0f) * 0.25f;

            Vec3 sumColor = c_b * w_b + c_c * w_c + c_f * w_f + c_g * w_g +
                            c_a * w_a + c_d * w_d + c_e * w_e + c_h * w_h +
                            c_i * w_i + c_l * w_l + c_j * w_j + c_k * w_k;

            float sumWeight = w_b + w_c + w_f + w_g +
                              w_a + w_d + w_e + w_h +
                              w_i + w_l + w_j + w_k;

            Vec3 finalColor = sumColor * (1.0f / std::max(sumWeight, 1e-4f));

            // Clamp to local 2x2 bounds to strictly prevent overshoot
            Vec3 minC = detail::minVec3(detail::minVec3(c_b, c_c), detail::minVec3(c_f, c_g));
            Vec3 maxC = detail::maxVec3(detail::maxVec3(c_b, c_c), detail::maxVec3(c_f, c_g));
            finalColor = detail::clampVec3(finalColor, minC, maxC);

            output.setPixelRGB(outX, outY, finalColor);
        }
    });

    return output;
}

/**
 * Pass 2: RCAS (Robust Contrast-Adaptive Sharpening)
 *
 * 5-tap stencil sharpening with mathematical overshoot limiting.
 * Clamps negative lobe weights to prevent ringing or glowing edge halos.
 */
inline ImageBuffer applyRCAS(const ImageBuffer& input, float sharpness = 0.8f) {
    if (input.empty()) return ImageBuffer();

    const int w = input.width;
    const int h = input.height;
    const int channels = input.channels;
    const float s = std::clamp(sharpness, 0.0f, 1.0f);

    ImageBuffer output(w, h, channels);

    detail::parallelRows(h, [&](int y) {
        for (int x = 0; x < w; ++x) {
            Vec3 c_m = input.getPixelRGB(x, y);
            Vec3 c_n = input.getPixelRGB(x, y - 1);
            Vec3 c_s = input.getPixelRGB(x, y + 1);
            Vec3 c_w = input.getPixelRGB(x - 1, y);
            Vec3 c_e = input.getPixelRGB(x + 1, y);

            float l_m = detail::getLuma(c_m);
            float l_n = detail::getLuma(c_n);
            float l_s = detail::getLuma(c_s);
            float l_w = detail::getLuma(c_w);
            float l_e = detail::getLuma(c_e);

            float minL = std::min({l_m, l_n, l_s, l_w, l_e});
            float maxL = std::max({l_m, l_n, l_s, l_w, l_e});

            float contrast = maxL - minL;
            float amp = std::clamp(std::min(minL, 1.0f - maxL) / std::max(contrast, 1e-4f), 0.0f, 1.0f);
            float weight = -amp * (s * 0.20f);

            Vec3 sharpened = (c_m + (c_n + c_s + c_w + c_e) * weight) * (1.0f / (1.0f + 4.0f * weight));

            Vec3 minC = detail::minVec3(c_m, detail::minVec3(detail::minVec3(c_n, c_s), detail::minVec3(c_w, c_e)));
            Vec3 maxC = detail::maxVec3(c_m, detail::maxVec3(detail::maxVec3(c_n, c_s), detail::maxVec3(c_w, c_e)));
            sharpened = detail::clampVec3(sharpened, minC, maxC);

            output.setPixelRGB(x, y, sharpened);
        }
    });

    return output;
}

/**
 * Full 2-Pass AMD FidelityFX Super Resolution 1.0 Pipeline (EASU + RCAS).
 */
inline ImageBuffer applyFSR1(const ImageBuffer& input, int outW, int outH, float sharpness = 0.8f) {
    ImageBuffer upscaled = applyEASU(input, outW, outH);
    return applyRCAS(upscaled, sharpness);
}

} // namespace fsr
} // namespace scratchbox

#endif // SCRATCHBOX_FSR_HPP
