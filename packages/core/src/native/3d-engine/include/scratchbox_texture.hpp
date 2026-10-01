/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_TEXTURE_HPP
#define SCRATCHBOX_TEXTURE_HPP

#include "scratchbox_math.hpp"
#include <vector>
#include <cmath>
#include <algorithm>
#include <cstdint>
#include <string>
#include <cstring>

namespace scratchbox {
namespace texture {

using math::Vec2;
using math::Vec3;
using math::Vec4;

/**
 * High-performance 2D image buffer supporting 1 (Grayscale), 3 (RGB), or 4 (RGBA) channels.
 */
struct ImageBuffer {
    int width{0};
    int height{0};
    int channels{3}; // 1 = L, 3 = RGB, 4 = RGBA
    std::vector<uint8_t> data;

    ImageBuffer() = default;
    ImageBuffer(int w, int h, int ch = 3, uint8_t defaultVal = 0)
        : width(w), height(h), channels(ch), data(static_cast<size_t>(w * h * ch), defaultVal) {}

    bool empty() const {
        return width <= 0 || height <= 0 || data.empty();
    }

    size_t getIndex(int x, int y) const {
        return static_cast<size_t>((y * width + x) * channels);
    }

    Vec3 getPixelRGB(int x, int y) const {
        if (x < 0) x = (x % width + width) % width;
        else if (x >= width) x = x % width;
        if (y < 0) y = (y % height + height) % height;
        else if (y >= height) y = y % height;

        size_t idx = getIndex(x, y);
        if (channels == 1) {
            float v = static_cast<float>(data[idx]) / 255.0f;
            return {v, v, v};
        }
        return {
            static_cast<float>(data[idx]) / 255.0f,
            static_cast<float>(data[idx + 1]) / 255.0f,
            static_cast<float>(data[idx + 2]) / 255.0f
        };
    }

    void setPixelRGB(int x, int y, const Vec3& col) {
        if (x < 0 || x >= width || y < 0 || y >= height) return;
        size_t idx = getIndex(x, y);
        uint8_t r = static_cast<uint8_t>(std::clamp(col.x, 0.0f, 1.0f) * 255.0f + 0.5f);
        uint8_t g = static_cast<uint8_t>(std::clamp(col.y, 0.0f, 1.0f) * 255.0f + 0.5f);
        uint8_t b = static_cast<uint8_t>(std::clamp(col.z, 0.0f, 1.0f) * 255.0f + 0.5f);

        if (channels == 1) {
            data[idx] = static_cast<uint8_t>(0.2126f * r + 0.7152f * g + 0.0722f * b);
        } else {
            data[idx] = r;
            data[idx + 1] = g;
            data[idx + 2] = b;
            if (channels == 4) data[idx + 3] = 255;
        }
    }

    float getLuminance(int x, int y) const {
        Vec3 c = getPixelRGB(x, y);
        return 0.2126f * c.x + 0.7152f * c.y + 0.0722f * c.z;
    }

    void setPixelLuminance(int x, int y, float val) {
        if (x < 0 || x >= width || y < 0 || y >= height) return;
        size_t idx = getIndex(x, y);
        uint8_t byteVal = static_cast<uint8_t>(std::clamp(val, 0.0f, 1.0f) * 255.0f + 0.5f);
        if (channels == 1) {
            data[idx] = byteVal;
        } else {
            data[idx] = byteVal;
            data[idx + 1] = byteVal;
            data[idx + 2] = byteVal;
            if (channels == 4) data[idx + 3] = 255;
        }
    }

    Vec3 sampleBilinear(float u, float v) const {
        if (width <= 0 || height <= 0) return {0, 0, 0};
        u = u - std::floor(u);
        v = v - std::floor(v);

        float fx = u * width - 0.5f;
        float fy = v * height - 0.5f;
        int x0 = static_cast<int>(std::floor(fx));
        int y0 = static_cast<int>(std::floor(fy));
        int x1 = x0 + 1;
        int y1 = y0 + 1;

        float wx = fx - x0;
        float wy = fy - y0;

        Vec3 c00 = getPixelRGB(x0, y0);
        Vec3 c10 = getPixelRGB(x1, y0);
        Vec3 c01 = getPixelRGB(x0, y1);
        Vec3 c11 = getPixelRGB(x1, y1);

        Vec3 c0 = c00 * (1.0f - wx) + c10 * wx;
        Vec3 c1 = c01 * (1.0f - wx) + c11 * wx;
        return c0 * (1.0f - wy) + c1 * wy;
    }
};

/**
 * PBR Texture Set holding decomposed maps.
 */
struct PbrTextureSet {
    ImageBuffer albedo;
    ImageBuffer normal;
    ImageBuffer roughness;
    ImageBuffer metallic;
    ImageBuffer ao;
    ImageBuffer orm;
    ImageBuffer height;
    bool isTileable{true};
};

/**
 * Reoriented Normal Mapping (RNM) for mathematically rigorous blending
 * of detail normals onto base normals without loss of length or grazing specular collapse.
 */
inline math::Vec3 blendNormalsRNM(const math::Vec3& n1, const math::Vec3& n2) {
    math::Vec3 u = {n1.x, n1.y, n1.z + 1.0f};
    math::Vec3 t = {-n2.x, -n2.y, n2.z};
    float uDotT = u.dot(t);
    float uz = std::max(0.0001f, u.z);
    math::Vec3 r = u * (uDotT / uz) - t;
    return r.normalized();
}

/**
 * Packs Ambient Occlusion (Red), Roughness (Green), and Metalness (Blue) into a single 3-channel
 * glTF 2.0 / Three.js standard ORM texture buffer, saving 66% VRAM and 2 texture samplers.
 */
inline ImageBuffer packOrmTexture(const ImageBuffer& ao, const ImageBuffer& roughness, const ImageBuffer& metallic) {
    int w = !ao.empty() ? ao.width : (!roughness.empty() ? roughness.width : (!metallic.empty() ? metallic.width : 256));
    int h = !ao.empty() ? ao.height : (!roughness.empty() ? roughness.height : (!metallic.empty() ? metallic.height : 256));
    ImageBuffer orm(w, h, 3);

    for (int y = 0; y < h; ++y) {
        for (int x = 0; x < w; ++x) {
            float r = !ao.empty() ? ao.getLuminance(x, y) : 1.0f;
            float g = !roughness.empty() ? roughness.getLuminance(x, y) : 0.5f;
            float b = !metallic.empty() ? metallic.getLuminance(x, y) : 0.0f;
            orm.setPixelRGB(x, y, {std::clamp(r, 0.0f, 1.0f), std::clamp(g, 0.0f, 1.0f), std::clamp(b, 0.0f, 1.0f)});
        }
    }
    return orm;
}

// ============================================================================
// Pillar 1: Seamless Toroidal Boundary Shift & Hermite Crossfade
// ============================================================================

/**
 * Applies a toroidal coordinate shift (Δx = W/2, Δy = H/2) and feathers the resulting
 * center crosshair seams using smooth Hermite interpolation to guarantee 100% mathematical periodic tileability.
 */
inline ImageBuffer makeToroidalSeamless(const ImageBuffer& src, float featherRatio = 0.15f) {
    if (src.empty()) return src;
    int w = src.width;
    int h = src.height;
    int ch = src.channels;
    ImageBuffer shifted(w, h, ch);

    int halfW = w / 2;
    int halfH = h / 2;

    // 1. Toroidal coordinate translation
    for (int y = 0; y < h; ++y) {
        int srcY = (y + halfH) % h;
        for (int x = 0; x < w; ++x) {
            int srcX = (x + halfW) % w;
            Vec3 col = src.getPixelRGB(srcX, srcY);
            shifted.setPixelRGB(x, y, col);
        }
    }

    // 2. Feather crosshairs across the center boundary
    ImageBuffer result = shifted;
    int blendDistX = std::max(2, static_cast<int>(w * featherRatio * 0.5f));
    int blendDistY = std::max(2, static_cast<int>(h * featherRatio * 0.5f));

    for (int y = 0; y < h; ++y) {
        float distY = std::abs(y - halfH);
        float weightY = 1.0f;
        if (distY < blendDistY) {
            float t = distY / static_cast<float>(blendDistY);
            weightY = t * t * (3.0f - 2.0f * t); // Hermite curve
        }

        for (int x = 0; x < w; ++x) {
            float distX = std::abs(x - halfW);
            float weightX = 1.0f;
            if (distX < blendDistX) {
                float t = distX / static_cast<float>(blendDistX);
                weightX = t * t * (3.0f - 2.0f * t);
            }

            float finalWeight = weightX * weightY;
            if (finalWeight < 0.999f) {
                Vec3 colShifted = shifted.getPixelRGB(x, y);
                Vec3 colOrig = src.getPixelRGB(x, y);
                Vec3 blended = colShifted * finalWeight + colOrig * (1.0f - finalWeight);
                result.setPixelRGB(x, y, blended);
            }
        }
    }

    return result;
}

// ============================================================================
// Pillar 3: Algorithmic PBR Decomposition
// ============================================================================

/**
 * Computes a high-fidelity tangent-space normal map from luminance gradients using 3x3 Scharr/Sobel kernels.
 * Normal = normalize(-strength * dh/dx, -strength * dh/dy, 1.0)
 */
inline ImageBuffer computeSobelNormalMap(const ImageBuffer& albedo, float bumpStrength = 3.5f) {
    if (albedo.empty()) return albedo;
    int w = albedo.width;
    int h = albedo.height;
    ImageBuffer normalMap(w, h, 3);

    for (int y = 0; y < h; ++y) {
        for (int x = 0; x < w; ++x) {
            float tl = albedo.getLuminance(x - 1, y - 1);
            float tc = albedo.getLuminance(x,     y - 1);
            float tr = albedo.getLuminance(x + 1, y - 1);
            float ml = albedo.getLuminance(x - 1, y);
            float mr = albedo.getLuminance(x + 1, y);
            float bl = albedo.getLuminance(x - 1, y + 1);
            float bc = albedo.getLuminance(x,     y + 1);
            float br = albedo.getLuminance(x + 1, y + 1);

            float dx = (tr + 10.0f / 3.0f * mr + br - (tl + 10.0f / 3.0f * ml + bl)) / 5.333f;
            float dy = (bl + 10.0f / 3.0f * bc + br - (tl + 10.0f / 3.0f * tc + tr)) / 5.333f;

            Vec3 n = {-dx * bumpStrength, -dy * bumpStrength, 1.0f};
            n = n.normalized();

            Vec3 rgb = {n.x * 0.5f + 0.5f, n.y * 0.5f + 0.5f, n.z * 0.5f + 0.5f};
            normalMap.setPixelRGB(x, y, rgb);
        }
    }

    return normalMap;
}

/**
 * Extracts high-pass spatial frequency roughness conforming to Cook-Torrance GGX microfacet distribution.
 */
inline ImageBuffer extractRoughnessMap(const ImageBuffer& albedo, float baseRoughness = 0.5f) {
    if (albedo.empty()) return albedo;
    int w = albedo.width;
    int h = albedo.height;
    ImageBuffer roughnessMap(w, h, 3);

    for (int y = 0; y < h; ++y) {
        for (int x = 0; x < w; ++x) {
            float center = albedo.getLuminance(x, y);
            float avg = (
                albedo.getLuminance(x - 1, y) +
                albedo.getLuminance(x + 1, y) +
                albedo.getLuminance(x, y - 1) +
                albedo.getLuminance(x, y + 1)
            ) * 0.25f;

            float variance = std::abs(center - avg);
            float rough = std::clamp(baseRoughness + variance * 2.2f, 0.08f, 0.98f);
            roughnessMap.setPixelRGB(x, y, {rough, rough, rough});
        }
    }

    return roughnessMap;
}

/**
 * Extracts inverted cavity Ambient Occlusion (AO) from local Laplacian concavity.
 */
inline ImageBuffer extractCavityAO(const ImageBuffer& albedo, float aoIntensity = 1.0f) {
    if (albedo.empty()) return albedo;
    int w = albedo.width;
    int h = albedo.height;
    ImageBuffer aoMap(w, h, 3);

    for (int y = 0; y < h; ++y) {
        for (int x = 0; x < w; ++x) {
            float center = albedo.getLuminance(x, y);
            float neighbors = (
                albedo.getLuminance(x - 1, y) +
                albedo.getLuminance(x + 1, y) +
                albedo.getLuminance(x, y - 1) +
                albedo.getLuminance(x, y + 1)
            ) * 0.25f;

            float concavity = std::max(0.0f, neighbors - center);
            float ao = std::clamp(1.0f - concavity * aoIntensity * 4.0f, 0.15f, 1.0f);
            aoMap.setPixelRGB(x, y, {ao, ao, ao});
        }
    }

    return aoMap;
}

/**
 * Decomposes an albedo image buffer into complete 5-channel PBR texture maps.
 */
inline PbrTextureSet decomposePbr(const ImageBuffer& albedo, bool isMetallic = false, float bumpStrength = 3.5f) {
    PbrTextureSet set;
    set.albedo = albedo;
    set.normal = computeSobelNormalMap(albedo, bumpStrength);
    set.roughness = extractRoughnessMap(albedo, isMetallic ? 0.35f : 0.65f);

    int w = albedo.width;
    int h = albedo.height;
    set.metallic = ImageBuffer(w, h, 3);
    float metalVal = isMetallic ? 1.0f : 0.0f;
    for (int y = 0; y < h; ++y) {
        for (int x = 0; x < w; ++x) {
            set.metallic.setPixelRGB(x, y, {metalVal, metalVal, metalVal});
        }
    }

    set.ao = extractCavityAO(albedo, 1.2f);
    set.orm = packOrmTexture(set.ao, set.roughness, set.metallic);
    set.isTileable = true;
    return set;
}

// ============================================================================
// Zero-Dependency PNG Binary Encoder (RFC 2083 / RFC 1950 / RFC 1951)
// ============================================================================

namespace png {

inline uint32_t updateCrc(uint32_t crc, const uint8_t* buf, size_t len) {
    static uint32_t crcTable[256];
    static bool tableComputed = false;
    if (!tableComputed) {
        for (uint32_t n = 0; n < 256; n++) {
            uint32_t c = n;
            for (int k = 0; k < 8; k++) {
                if (c & 1) c = 0xEDB88320L ^ (c >> 1);
                else c = c >> 1;
            }
            crcTable[n] = c;
        }
        tableComputed = true;
    }

    uint32_t c = crc ^ 0xFFFFFFFFL;
    for (size_t i = 0; i < len; ++i) {
        c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >> 8);
    }
    return c ^ 0xFFFFFFFFL;
}

inline uint32_t computeAdler32(const uint8_t* data, size_t len) {
    uint32_t s1 = 1;
    uint32_t s2 = 0;
    constexpr uint32_t MOD_ADLER = 65521;
    for (size_t i = 0; i < len; ++i) {
        s1 = (s1 + data[i]) % MOD_ADLER;
        s2 = (s2 + s1) % MOD_ADLER;
    }
    return (s2 << 16) | s1;
}

inline void writeBE32(std::vector<uint8_t>& out, uint32_t val) {
    out.push_back(static_cast<uint8_t>((val >> 24) & 0xFF));
    out.push_back(static_cast<uint8_t>((val >> 16) & 0xFF));
    out.push_back(static_cast<uint8_t>((val >> 8) & 0xFF));
    out.push_back(static_cast<uint8_t>(val & 0xFF));
}

inline void writeChunk(std::vector<uint8_t>& out, const char type[4], const uint8_t* data, size_t len) {
    writeBE32(out, static_cast<uint32_t>(len));
    size_t typeStart = out.size();
    out.insert(out.end(), type, type + 4);
    if (len > 0 && data) {
        out.insert(out.end(), data, data + len);
    }
    uint32_t crc = updateCrc(0, out.data() + typeStart, len + 4);
    writeBE32(out, crc);
}

} // namespace png

/**
 * Encodes an ImageBuffer into standard PNG bytes (zero external dependencies).
 * Fully readable by Three.js, glTF loaders, web browsers, and macOS Preview.
 */
inline std::vector<uint8_t> encodePng(const ImageBuffer& img) {
    if (img.empty()) return {};

    std::vector<uint8_t> pngBytes;
    const uint8_t header[8] = {0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A};
    pngBytes.insert(pngBytes.end(), header, header + 8);

    uint8_t ihdr[13];
    ihdr[0] = static_cast<uint8_t>((img.width >> 24) & 0xFF);
    ihdr[1] = static_cast<uint8_t>((img.width >> 16) & 0xFF);
    ihdr[2] = static_cast<uint8_t>((img.width >> 8) & 0xFF);
    ihdr[3] = static_cast<uint8_t>(img.width & 0xFF);

    ihdr[4] = static_cast<uint8_t>((img.height >> 24) & 0xFF);
    ihdr[5] = static_cast<uint8_t>((img.height >> 16) & 0xFF);
    ihdr[6] = static_cast<uint8_t>((img.height >> 8) & 0xFF);
    ihdr[7] = static_cast<uint8_t>(img.height & 0xFF);

    ihdr[8] = 8; // 8 bits per channel
    ihdr[9] = (img.channels == 4) ? 6 : (img.channels == 3 ? 2 : 0);
    ihdr[10] = 0; // deflate
    ihdr[11] = 0; // standard filter
    ihdr[12] = 0; // non-interlaced

    png::writeChunk(pngBytes, "IHDR", ihdr, 13);

    size_t scanlineLen = static_cast<size_t>(img.width * img.channels);
    size_t uncompressedLen = static_cast<size_t>(img.height * (1 + scanlineLen));
    std::vector<uint8_t> uncompressedData(uncompressedLen);

    uint8_t* uPtr = uncompressedData.data();
    for (int y = 0; y < img.height; ++y) {
        *uPtr++ = 0x00; // Filter: None
        size_t srcIdx = static_cast<size_t>(y * img.width * img.channels);
        std::memcpy(uPtr, img.data.data() + srcIdx, scanlineLen);
        uPtr += scanlineLen;
    }

    std::vector<uint8_t> zlibStream;
    zlibStream.push_back(0x78);
    zlibStream.push_back(0x01);

    size_t offset = 0;
    while (offset < uncompressedLen) {
        size_t blockLen = std::min(static_cast<size_t>(65535), uncompressedLen - offset);
        bool isLast = (offset + blockLen >= uncompressedLen);

        zlibStream.push_back(isLast ? 0x01 : 0x00);
        uint16_t len16 = static_cast<uint16_t>(blockLen);
        uint16_t nlen16 = static_cast<uint16_t>(~len16);

        zlibStream.push_back(static_cast<uint8_t>(len16 & 0xFF));
        zlibStream.push_back(static_cast<uint8_t>((len16 >> 8) & 0xFF));
        zlibStream.push_back(static_cast<uint8_t>(nlen16 & 0xFF));
        zlibStream.push_back(static_cast<uint8_t>((nlen16 >> 8) & 0xFF));

        zlibStream.insert(zlibStream.end(), uncompressedData.data() + offset, uncompressedData.data() + offset + blockLen);
        offset += blockLen;
    }

    uint32_t adler = png::computeAdler32(uncompressedData.data(), uncompressedLen);
    png::writeBE32(zlibStream, adler);

    png::writeChunk(pngBytes, "IDAT", zlibStream.data(), zlibStream.size());
    png::writeChunk(pngBytes, "IEND", nullptr, 0);

    return pngBytes;
}

} // namespace texture
} // namespace scratchbox

#endif // SCRATCHBOX_TEXTURE_HPP
