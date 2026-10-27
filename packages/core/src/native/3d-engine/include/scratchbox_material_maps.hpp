/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_MATERIAL_MAPS_HPP
#define SCRATCHBOX_MATERIAL_MAPS_HPP

#include "scratchbox_texture.hpp"
#include "scratchbox_png.hpp"
#include "scratchbox_jpeg.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <fstream>
#include <stdexcept>
#include <string>
#include <tuple>
#include <utility>
#include <vector>

/**
 * Material maps from a surface library (photographed or scanned PBR sets: a colour map, a normal map, roughness,
 * ambient occlusion, metalness, or one packed AO/roughness/metalness map) made ready for a GLB: decoded from PNG (8 or
 * 16 bit) or baseline JPEG, area-resampled down to at most `maxSize` pixels on a side (a library's 8K maps would
 * make a building GLB too large to view), and packed into glTF's albedo, normal and ORM (R occlusion, G roughness,
 * B metalness) textures. Resampling keeps a seamless tile seamless (each output pixel averages the source pixels it
 * covers). The colour map is averaged in linear light, and its mean linear colour is returned so a caller can match
 * the set to a measured colour by appearance and tint it there.
 */
namespace scratchbox {
namespace material_maps {

struct Sources {
    std::string color, normal, roughness, ao, metalness;
    std::string arm;  // a packed map: R occlusion, G roughness, B metalness
};

struct Prepared {
    texture::ImageBuffer albedo, normal, orm;
    /** Per-pixel statistics of the resampled maps: colour in linear sRGB and CIELAB (D65), mean and standard deviation. */
    std::array<double, 3> meanLinear{0, 0, 0}, spreadLinear{0, 0, 0}, meanLab{0, 0, 0}, spreadLab{0, 0, 0};
    double meanRoughness{1.0}, spreadRoughness{0.0}, meanMetalness{0.0};
    /** Share of pixels with metalness at least 0.5, and the 95th percentile of metalness (0 without a metalness map). */
    double metalShare{0.0}, metalnessP95{0.0};
    /** RMS angle in degrees between the normal map's normals and the flat normal, at the output size (0 without a normal map). */
    double normalTiltRmsDeg{0.0};
    int sourceWidth{0}, sourceHeight{0};
};

namespace detail {

inline float srgbToLinear(float c) { return c <= 0.04045f ? c / 12.92f : std::pow((c + 0.055f) / 1.055f, 2.4f); }
inline float linearToSrgb(float c) { return c <= 0.0031308f ? c * 12.92f : 1.055f * std::pow(c, 1.0f / 2.4f) - 0.055f; }

/** CIELAB (D65) of a linear sRGB colour. */
inline std::array<double, 3> linearToLab(double r, double g, double b) {
    const double X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, Y = 0.2126 * r + 0.7152 * g + 0.0722 * b,
                 Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
    auto f = [](double t) { return t > 0.008856 ? std::cbrt(t) : 7.787 * t + 16.0 / 116.0; };
    const double fx = f(X), fy = f(Y), fz = f(Z);
    return {116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)};
}

/** Mean and standard deviation of n values read through `at`. */
template <class F> inline std::pair<double, double> meanSpread(size_t n, F at) {
    double s = 0, s2 = 0;
    for (size_t i = 0; i < n; ++i) { const double v = at(i); s += v; s2 += v * v; }
    const double m = n ? s / n : 0.0;
    return {m, n ? std::sqrt(std::max(0.0, s2 / n - m * m)) : 0.0};
}

inline texture::ImageBuffer readImage(const std::string& path, bool luma) {
    std::ifstream in(path, std::ios::binary);
    if (!in) throw std::runtime_error("cannot open texture map " + path);
    std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    if (bytes.size() >= 8 && bytes[0] == 0x89 && bytes[1] == 'P') {
        auto r = png::decode(bytes.data(), bytes.size(), luma ? png::OutputFormat::Luma : png::OutputFormat::Rgb);
        if (!r.ok) throw std::runtime_error("cannot decode " + path + ": " + r.error);
        return std::move(r.image);
    }
    if (bytes.size() >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8) {
        auto r = jpeg::decode(bytes, luma ? jpeg::OutputFormat::Luma : jpeg::OutputFormat::Rgb);
        if (!r.ok) throw std::runtime_error("cannot decode " + path + ": " + r.error);
        return std::move(r.image);
    }
    throw std::runtime_error("texture map " + path + " is neither PNG nor JPEG");
}

/** Area resampling to dw x dh: each output pixel is the coverage-weighted mean of the source pixels under it, taken in
 * linear light when `srgb`. Separable: a horizontal pass, then a vertical one. */
inline std::vector<float> resample(const texture::ImageBuffer& src, int dw, int dh, bool srgb) {
    const int sw = src.width, sh = src.height, ch = src.channels;
    std::array<float, 256> lut{};
    for (int i = 0; i < 256; ++i) lut[i] = srgb ? srgbToLinear(i / 255.0f) : i / 255.0f;
    auto spans = [](int from, int to) {
        // for each output index, the (source index, weight) pairs it covers, weights summing to 1
        std::vector<std::vector<std::pair<int, float>>> out(to);
        const double step = double(from) / to;
        for (int o = 0; o < to; ++o) {
            const double a = o * step, b = (o + 1) * step;
            for (int s = int(std::floor(a)); s < int(std::ceil(b)) && s < from; ++s) {
                const double w = std::min(b, double(s + 1)) - std::max(a, double(s));
                if (w > 1e-9) out[o].push_back({s, float(w / step)});
            }
        }
        return out;
    };
    const auto hx = spans(sw, dw), hy = spans(sh, dh);
    std::vector<float> rows(size_t(dw) * sh * ch, 0.0f);
    for (int y = 0; y < sh; ++y) {
        const uint8_t* row = src.data.data() + size_t(y) * sw * ch;
        float* dst = rows.data() + size_t(y) * dw * ch;
        for (int x = 0; x < dw; ++x)
            for (const auto& [s, w] : hx[x])
                for (int c = 0; c < ch; ++c) dst[size_t(x) * ch + c] += w * lut[row[size_t(s) * ch + c]];
    }
    std::vector<float> out(size_t(dw) * dh * ch, 0.0f);
    for (int y = 0; y < dh; ++y)
        for (const auto& [s, w] : hy[y]) {
            const float* srow = rows.data() + size_t(s) * dw * ch;
            float* drow = out.data() + size_t(y) * dw * ch;
            for (size_t i = 0; i < size_t(dw) * ch; ++i) drow[i] += w * srow[i];
        }
    return out;
}

inline texture::ImageBuffer toImage(const std::vector<float>& v, int w, int h, int ch, bool srgb) {
    texture::ImageBuffer img(w, h, ch);
    for (size_t i = 0; i < v.size(); ++i) {
        const float c = std::clamp(srgb ? linearToSrgb(v[i]) : v[i], 0.0f, 1.0f);
        img.data[i] = uint8_t(std::lround(c * 255.0f));
    }
    return img;
}

}  // namespace detail

/** Decodes, resamples and packs a library set's maps; `maxSize` bounds the longer side of the output (never upscaled).
 * The colour map is required; a missing normal map leaves a flat one, missing ORM channels leave occlusion 1,
 * roughness 1 and metalness 0. */
inline Prepared prepare(const Sources& in, int maxSize) {
    if (in.color.empty()) throw std::runtime_error("a library material needs its colour map");
    if (maxSize < 16) throw std::runtime_error("max_size must be at least 16 pixels");
    Prepared out;
    const texture::ImageBuffer color = detail::readImage(in.color, false);
    out.sourceWidth = color.width;
    out.sourceHeight = color.height;
    const double scale = std::min(1.0, double(maxSize) / std::max(color.width, color.height));
    const int w = std::max(1, int(std::lround(color.width * scale))), h = std::max(1, int(std::lround(color.height * scale)));

    const auto albedo = detail::resample(color, w, h, true);
    const size_t px = size_t(w) * h;
    std::vector<std::array<double, 3>> lab(px);
    for (size_t i = 0; i < px; ++i) lab[i] = detail::linearToLab(albedo[i * 3], albedo[i * 3 + 1], albedo[i * 3 + 2]);
    for (int c = 0; c < 3; ++c) {
        std::tie(out.meanLinear[c], out.spreadLinear[c]) = detail::meanSpread(px, [&](size_t i) { return double(albedo[i * 3 + c]); });
        std::tie(out.meanLab[c], out.spreadLab[c]) = detail::meanSpread(px, [&](size_t i) { return lab[i][c]; });
    }
    out.albedo = detail::toImage(albedo, w, h, 3, true);

    if (!in.normal.empty()) {
        auto n = detail::resample(detail::readImage(in.normal, false), w, h, false);
        // averaged normals shorten: renormalize each one (encoded 0..1 <-> -1..1)
        for (size_t i = 0; i + 2 < n.size(); i += 3) {
            float x = n[i] * 2 - 1, y = n[i + 1] * 2 - 1, z = n[i + 2] * 2 - 1;
            const float len = std::sqrt(x * x + y * y + z * z);
            if (len > 1e-6f) { x /= len; y /= len; z /= len; } else { x = 0; y = 0; z = 1; }
            n[i] = x * 0.5f + 0.5f; n[i + 1] = y * 0.5f + 0.5f; n[i + 2] = z * 0.5f + 0.5f;
        }
        double tilt2 = 0;
        for (size_t i = 0; i + 2 < n.size(); i += 3) {
            const double a = std::acos(std::clamp(double(n[i + 2]) * 2 - 1, -1.0, 1.0)) * 180.0 / 3.14159265358979323846;
            tilt2 += a * a;
        }
        out.normalTiltRmsDeg = px ? std::sqrt(tilt2 / double(px)) : 0.0;
        out.normal = detail::toImage(n, w, h, 3, false);
    } else {
        out.normal = texture::ImageBuffer(w, h, 3);
        for (size_t i = 0; i + 2 < out.normal.data.size(); i += 3) { out.normal.data[i] = 128; out.normal.data[i + 1] = 128; out.normal.data[i + 2] = 255; }
    }

    std::vector<float> orm(size_t(w) * h * 3, 0.0f);
    for (size_t i = 0; i < size_t(w) * h; ++i) { orm[i * 3] = 1.0f; orm[i * 3 + 1] = 1.0f; orm[i * 3 + 2] = 0.0f; }
    if (!in.arm.empty()) {
        orm = detail::resample(detail::readImage(in.arm, false), w, h, false);
    }
    auto channel = [&](const std::string& path, int c) {
        if (path.empty()) return;
        const auto v = detail::resample(detail::readImage(path, true), w, h, false);
        for (size_t i = 0; i < v.size(); ++i) orm[i * 3 + c] = v[i];
    };
    channel(in.ao, 0);
    channel(in.roughness, 1);
    channel(in.metalness, 2);
    std::tie(out.meanRoughness, out.spreadRoughness) = detail::meanSpread(px, [&](size_t i) { return double(orm[i * 3 + 1]); });
    out.meanMetalness = detail::meanSpread(px, [&](size_t i) { return double(orm[i * 3 + 2]); }).first;
    if (px) {
        std::vector<float> metal(px);
        size_t metallic = 0;
        for (size_t i = 0; i < px; ++i) { metal[i] = orm[i * 3 + 2]; metallic += metal[i] >= 0.5f; }
        const size_t k = std::min(px - 1, size_t(std::floor(0.95 * double(px - 1))));
        std::nth_element(metal.begin(), metal.begin() + std::ptrdiff_t(k), metal.end());
        out.metalShare = double(metallic) / double(px);
        out.metalnessP95 = metal[k];
    }
    out.orm = detail::toImage(orm, w, h, 3, false);
    return out;
}

/** A map's channels remapped as v * scale + offset per channel, in linear light when `srgb` (a colour map) or as stored
 * (roughness, occlusion, metalness): a measured colour or roughness baked into a library map, since glTF's factors can
 * only lower a map's values. Results past 0..1 saturate. */
inline texture::ImageBuffer remapChannels(const std::vector<uint8_t>& pngBytes, const std::array<double, 3>& scale,
                                          const std::array<double, 3>& offset, bool srgb) {
    auto r = png::decode(pngBytes.data(), pngBytes.size(), png::OutputFormat::Rgb);
    if (!r.ok) throw std::runtime_error("cannot decode the map to remap: " + r.error);
    std::array<std::array<uint8_t, 256>, 3> lut{};
    for (int c = 0; c < 3; ++c)
        for (int i = 0; i < 256; ++i) {
            const float in = srgb ? detail::srgbToLinear(i / 255.0f) : i / 255.0f;
            const float v = std::clamp(float(in * scale[c] + offset[c]), 0.0f, 1.0f);
            lut[c][i] = uint8_t(std::lround((srgb ? detail::linearToSrgb(v) : v) * 255.0f));
        }
    for (size_t i = 0; i < r.image.data.size(); ++i) r.image.data[i] = lut[i % 3][r.image.data[i]];
    return std::move(r.image);
}

namespace detail {

/** Linear sRGB of a CIELAB (D65) colour (the inverse of linearToLab). */
inline std::array<double, 3> labToLinear(double L, double a, double b) {
    const double fy = (L + 16.0) / 116.0, fx = fy + a / 500.0, fz = fy - b / 200.0;
    auto inv = [](double f) { return f * f * f > 0.008856 ? f * f * f : (f - 16.0 / 116.0) / 7.787; };
    const double X = inv(fx) * 0.95047, Y = inv(fy), Z = inv(fz) * 1.08883;
    return {3.2406 * X - 1.5372 * Y - 0.4986 * Z, -0.9689 * X + 1.8758 * Y + 0.0415 * Z, 0.0557 * X - 0.2040 * Y + 1.0570 * Z};
}

}  // namespace detail

struct LabTransfer {
    texture::ImageBuffer image;
    /** The result's CIELAB mean and spread and linear sRGB mean, measured after clipping to the displayable range. */
    std::array<double, 3> meanLab{0, 0, 0}, spreadLab{0, 0, 0}, meanLinear{0, 0, 0};
    /** The source map's CIELAB mean and spread. */
    std::array<double, 3> fromMeanLab{0, 0, 0}, fromSpreadLab{0, 0, 0};
};

/**
 * A colour map's CIELAB distribution moved to a wanted one: per channel, v' = (v - mean) * (wantSpread / spread) + wantMean,
 * so the map's grain, veining and colour variation are kept and only their centre and amplitude change. A channel with
 * almost no spread of its own (under 0.3, e.g. a greyscale map's a and b) is shifted, not scaled: no variation can be
 * made from none. A negative wanted spread keeps the channel's own. Scale ratios are held to 0.25..4. Returns the measured result, which can differ from the wanted
 * distribution where colours clip.
 */
inline LabTransfer transferLab(const std::vector<uint8_t>& pngBytes, const std::array<double, 3>& wantMean,
                               const std::array<double, 3>& wantSpread) {
    auto r = png::decode(pngBytes.data(), pngBytes.size(), png::OutputFormat::Rgb);
    if (!r.ok) throw std::runtime_error("cannot decode the colour map to transfer: " + r.error);
    const size_t px = r.image.data.size() / 3;
    std::array<float, 256> lut{};
    for (int i = 0; i < 256; ++i) lut[i] = detail::srgbToLinear(i / 255.0f);
    std::vector<std::array<double, 3>> lab(px);
    for (size_t i = 0; i < px; ++i)
        lab[i] = detail::linearToLab(lut[r.image.data[i * 3]], lut[r.image.data[i * 3 + 1]], lut[r.image.data[i * 3 + 2]]);
    std::array<double, 3> mean{}, spread{}, ratio{};
    for (int c = 0; c < 3; ++c) {
        std::tie(mean[c], spread[c]) = detail::meanSpread(px, [&](size_t i) { return lab[i][c]; });
        ratio[c] = spread[c] < 0.3 || wantSpread[c] < 0 ? 1.0 : std::clamp(wantSpread[c] / spread[c], 0.25, 4.0);
    }
    LabTransfer out;
    out.fromMeanLab = mean;
    out.fromSpreadLab = spread;
    out.image = texture::ImageBuffer(r.image.width, r.image.height, 3);
    std::vector<std::array<double, 3>> res(px);
    std::array<double, 3> linSum{0, 0, 0};
    for (size_t i = 0; i < px; ++i) {
        std::array<double, 3> v;
        for (int c = 0; c < 3; ++c) v[c] = (lab[i][c] - mean[c]) * ratio[c] + wantMean[c];
        const auto rgb = detail::labToLinear(std::clamp(v[0], 0.0, 100.0), v[1], v[2]);
        std::array<float, 3> lin;
        for (int c = 0; c < 3; ++c) {
            lin[c] = std::clamp(float(rgb[c]), 0.0f, 1.0f);
            out.image.data[i * 3 + c] = uint8_t(std::lround(std::clamp(detail::linearToSrgb(lin[c]), 0.0f, 1.0f) * 255.0f));
            lin[c] = lut[out.image.data[i * 3 + c]];
            linSum[c] += lin[c];
        }
        res[i] = detail::linearToLab(lin[0], lin[1], lin[2]);
    }
    for (int c = 0; c < 3; ++c) {
        std::tie(out.meanLab[c], out.spreadLab[c]) = detail::meanSpread(px, [&](size_t i) { return res[i][c]; });
        out.meanLinear[c] = px ? linSum[c] / px : 0.0;
    }
    return out;
}

}  // namespace material_maps
}  // namespace scratchbox

#endif  // SCRATCHBOX_MATERIAL_MAPS_HPP
