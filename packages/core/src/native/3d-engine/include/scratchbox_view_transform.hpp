/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_VIEW_TRANSFORM_HPP
#define SCRATCHBOX_VIEW_TRANSFORM_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_texture.hpp"
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <vector>

namespace scratchbox {
namespace view {

using math::Vec3;

enum class AgxLook {
    Base,
    Punchy
};

inline float luminance(const Vec3& c) {
    return 0.2126f * c.x + 0.7152f * c.y + 0.0722f * c.z;
}

inline float srgbEncode(float linear) {
    float v = std::clamp(linear, 0.0f, 1.0f);
    return v <= 0.0031308f ? 12.92f * v : 1.055f * std::pow(v, 1.0f / 2.4f) - 0.055f;
}

inline float srgbDecode(float encoded) {
    float v = std::clamp(encoded, 0.0f, 1.0f);
    return v <= 0.04045f ? v / 12.92f : std::pow((v + 0.055f) / 1.055f, 2.4f);
}

namespace detail {

constexpr float kAgxMinEv = -12.47393f;
constexpr float kAgxMaxEv = 4.026069f;

inline float agxContrast(float x) {
    float x2 = x * x;
    float x4 = x2 * x2;
    return 15.5f * x4 * x2 - 40.14f * x4 * x + 31.96f * x4 - 6.868f * x2 * x + 0.4298f * x2 + 0.1191f * x - 0.00232f;
}

} // namespace detail

/**
 * AgX view transform: maps scene-linear Rec.709 radiance to display-encoded sRGB in [0, 1].
 * Bright saturated colors roll off toward white instead of clipping per channel.
 */
inline Vec3 agxDisplay(const Vec3& rgb, AgxLook look = AgxLook::Base) {
    Vec3 v(0.842479062253094f * rgb.x + 0.0784335999999992f * rgb.y + 0.0792237451477643f * rgb.z,
           0.0423282422610123f * rgb.x + 0.878468636469772f * rgb.y + 0.0791661274605434f * rgb.z,
           0.0423756549057051f * rgb.x + 0.0784336f * rgb.y + 0.879142973793104f * rgb.z);
    for (int c = 0; c < 3; ++c) {
        float x = std::log2(std::max(v[c], 1e-10f));
        x = (std::clamp(x, detail::kAgxMinEv, detail::kAgxMaxEv) - detail::kAgxMinEv) / (detail::kAgxMaxEv - detail::kAgxMinEv);
        v[c] = detail::agxContrast(x);
    }
    if (look == AgxLook::Punchy) {
        const float power = 1.35f;
        const float saturation = 1.4f;
        v = Vec3(std::pow(std::max(v.x, 0.0f), power), std::pow(std::max(v.y, 0.0f), power), std::pow(std::max(v.z, 0.0f), power));
        float luma = luminance(v);
        v = Vec3(luma + saturation * (v.x - luma), luma + saturation * (v.y - luma), luma + saturation * (v.z - luma));
    }
    Vec3 out(1.19687900512017f * v.x - 0.0980208811401368f * v.y - 0.0990297440797205f * v.z,
             -0.0528968517574562f * v.x + 1.15190312990417f * v.y - 0.0989611768448433f * v.z,
             -0.0529716355144438f * v.x - 0.0980434501171241f * v.y + 1.15107367264116f * v.z);
    return Vec3(std::clamp(out.x, 0.0f, 1.0f), std::clamp(out.y, 0.0f, 1.0f), std::clamp(out.z, 0.0f, 1.0f));
}

/** Per-channel clip followed by the sRGB transfer function (a "Standard" view transform). */
inline Vec3 standardDisplay(const Vec3& rgb) {
    return Vec3(srgbEncode(rgb.x), srgbEncode(rgb.y), srgbEncode(rgb.z));
}

/**
 * Exposure in EV that maps the log-average luminance of the selected pixels to `key`.
 * An empty mask selects every pixel.
 */
inline float autoExposureEv(const std::vector<Vec3>& hdr, const std::vector<uint8_t>& mask = {}, float key = 0.18f) {
    double sumLog = 0.0;
    size_t count = 0;
    for (size_t i = 0; i < hdr.size(); ++i) {
        if (!mask.empty() && !mask[i]) continue;
        float l = luminance(hdr[i]);
        if (!std::isfinite(l)) continue;
        sumLog += std::log(std::max(l, 1e-6f));
        ++count;
    }
    if (count == 0) return 0.0f;
    double average = std::exp(sumLog / static_cast<double>(count));
    return static_cast<float>(std::log2(key / average));
}

inline float autoExposureEv(const std::vector<Vec3>& hdr, float key) {
    return autoExposureEv(hdr, {}, key);
}

/** Applies exposure and the AgX view transform, producing an 8-bit RGB image. */
inline texture::ImageBuffer toDisplayImage(const std::vector<Vec3>& hdr, int width, int height, float exposureEv, AgxLook look = AgxLook::Base) {
    texture::ImageBuffer image(width, height, 3);
    const float scale = std::exp2(exposureEv);
    for (int y = 0; y < height; ++y) {
        for (int x = 0; x < width; ++x) {
            const Vec3& c = hdr[static_cast<size_t>(y) * width + x];
            Vec3 safe(std::isfinite(c.x) ? c.x : 0.0f, std::isfinite(c.y) ? c.y : 0.0f, std::isfinite(c.z) ? c.z : 0.0f);
            image.setPixelRGB(x, y, agxDisplay(safe * scale, look));
        }
    }
    return image;
}

} // namespace view
} // namespace scratchbox

#endif // SCRATCHBOX_VIEW_TRANSFORM_HPP
