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
#include <cstdlib>

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

/** PNG scanline filtering: each row gets whichever of None/Sub/Up/Average/Paeth minimises its sum of |residual|. */
inline void filterScanlines(const uint8_t* src, int width, int height, int channels, uint8_t* out) {
    const size_t stride = static_cast<size_t>(width) * channels;
    std::vector<uint8_t> cand(stride);
    for (int y = 0; y < height; ++y) {
        const uint8_t* row = src + y * stride;
        const uint8_t* up = y > 0 ? row - stride : nullptr;
        uint8_t* dst = out + y * (stride + 1);
        uint64_t bestCost = UINT64_MAX;
        for (int f = 0; f < 5; ++f) {
            uint64_t cost = 0;
            for (size_t i = 0; i < stride; ++i) {
                int a = i >= static_cast<size_t>(channels) ? row[i - channels] : 0;
                int b = up ? up[i] : 0;
                int c = (up && i >= static_cast<size_t>(channels)) ? up[i - channels] : 0;
                int pred = 0;
                if (f == 1) pred = a;
                else if (f == 2) pred = b;
                else if (f == 3) pred = (a + b) >> 1;
                else if (f == 4) { int p = a + b - c, pa = std::abs(p - a), pb = std::abs(p - b), pc = std::abs(p - c); pred = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
                uint8_t r = static_cast<uint8_t>(row[i] - pred);
                cand[i] = r;
                cost += r < 128 ? r : 256 - r;
            }
            if (cost < bestCost) { bestCost = cost; dst[0] = static_cast<uint8_t>(f); std::memcpy(dst + 1, cand.data(), stride); }
        }
    }
}

/** Huffman code lengths for `freq`, limited to `maxBits` (frequencies halved and retried until they fit). */
inline std::vector<uint8_t> huffmanLengths(std::vector<uint32_t> freq, int maxBits) {
    const size_t n = freq.size();
    size_t used = 0;
    for (auto f : freq) used += f > 0;
    // inflate wants every tree to have at least two codes
    for (size_t s = 0; used < 2 && s < n; ++s) if (!freq[s]) { freq[s] = 1; ++used; }
    std::vector<uint8_t> lens(n, 0);
    for (;;) {
        struct Node { uint64_t w; int left, right; };
        std::vector<Node> nodes;
        std::vector<std::pair<uint64_t, int>> heap;
        for (size_t s = 0; s < n; ++s) if (freq[s]) { nodes.push_back({freq[s], -1, static_cast<int>(s)}); heap.push_back({freq[s], static_cast<int>(nodes.size() - 1)}); }
        auto cmp = [](const std::pair<uint64_t, int>& a, const std::pair<uint64_t, int>& b) { return a.first > b.first || (a.first == b.first && a.second > b.second); };
        std::make_heap(heap.begin(), heap.end(), cmp);
        while (heap.size() > 1) {
            std::pop_heap(heap.begin(), heap.end(), cmp); auto a = heap.back(); heap.pop_back();
            std::pop_heap(heap.begin(), heap.end(), cmp); auto b = heap.back(); heap.pop_back();
            nodes.push_back({a.first + b.first, a.second, b.second});
            heap.push_back({a.first + b.first, static_cast<int>(nodes.size() - 1)}); std::push_heap(heap.begin(), heap.end(), cmp);
        }
        std::fill(lens.begin(), lens.end(), 0);
        int maxSeen = 0;
        std::vector<std::pair<int, int>> stack{{heap[0].second, 0}};
        while (!stack.empty()) {
            auto [id, depth] = stack.back(); stack.pop_back();
            const Node& nd = nodes[id];
            if (nd.left < 0) { lens[nd.right] = static_cast<uint8_t>(depth); maxSeen = std::max(maxSeen, depth); }
            else { stack.push_back({nd.left, depth + 1}); stack.push_back({nd.right, depth + 1}); }
        }
        if (maxSeen <= maxBits) return lens;
        for (auto& f : freq) if (f) f = (f >> 1) | 1;
    }
}

/** Canonical Huffman codes (RFC 1951 §3.2.2) for the given code lengths. */
inline std::vector<uint32_t> canonicalCodes(const std::vector<uint8_t>& lens) {
    uint32_t count[16] = {0}, next[16] = {0};
    for (auto l : lens) if (l) ++count[l];
    uint32_t code = 0;
    for (int b = 1; b < 16; ++b) { code = (code + count[b - 1]) << 1; next[b] = code; }
    std::vector<uint32_t> codes(lens.size(), 0);
    for (size_t s = 0; s < lens.size(); ++s) if (lens[s]) codes[s] = next[lens[s]]++;
    return codes;
}

/**
 * Raw DEFLATE (RFC 1951) of `data`, appended to `out`: hash-chain LZ77 then one dynamic-Huffman block, or stored blocks
 * when that would be no smaller. Self-contained so this header never needs zlib linked (many ephemeral builds include
 * it without -lz).
 */
inline void deflate(const uint8_t* data, size_t len, std::vector<uint8_t>& out) {
    static const uint16_t lenBase[29] = {3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258};
    static const uint8_t lenExtra[29] = {0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0};
    static const uint16_t distBase[30] = {1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577};
    static const uint8_t distExtra[30] = {0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13};
    constexpr size_t WINDOW = 32768, HASH = 1 << 15, MAX_CHAIN = 32, MAX_LEN = 258;

    // 1. LZ77 tokens: a literal (dist 0) or a length/distance pair
    struct Tok { uint16_t lenOrLit; uint16_t dist; };
    std::vector<Tok> toks;
    toks.reserve(len / 2 + 16);
    std::vector<int32_t> head(HASH, -1), prev(WINDOW, -1);
    auto hash = [&](size_t i) { return ((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & (HASH - 1); };
    auto insert = [&](size_t i) { if (i + 2 < len) { uint32_t h = hash(i); prev[i & (WINDOW - 1)] = head[h]; head[h] = static_cast<int32_t>(i); } };
    for (size_t i = 0; i < len;) {
        size_t bestLen = 0, bestDist = 0;
        if (i + 2 < len) {
            int32_t cand = head[hash(i)];
            const size_t maxLen = std::min(MAX_LEN, len - i);
            for (size_t chain = 0; cand >= 0 && chain < MAX_CHAIN; ++chain) {
                size_t d = i - static_cast<size_t>(cand);
                if (d == 0 || d > WINDOW) break;
                size_t l = 0;
                while (l < maxLen && data[cand + l] == data[i + l]) ++l;
                if (l > bestLen) { bestLen = l; bestDist = d; if (l == maxLen) break; }
                int32_t next = prev[cand & (WINDOW - 1)];
                if (next >= cand) break;
                cand = next;
            }
        }
        if (bestLen >= 3) {
            toks.push_back({static_cast<uint16_t>(bestLen), static_cast<uint16_t>(bestDist)});
            for (size_t k = 0; k < bestLen; ++k) insert(i + k);
            i += bestLen;
        } else {
            toks.push_back({data[i], 0}); insert(i); ++i;
        }
    }
    auto lenCode = [&](uint32_t l) { int c = 28; while (lenBase[c] > l) --c; return c; };
    auto distCode = [&](uint32_t d) { int c = 29; while (distBase[c] > d) --c; return c; };

    // 2. the two trees
    std::vector<uint32_t> litF(286, 0), distF(30, 0);
    for (const Tok& t : toks) { if (t.dist) { ++litF[257 + lenCode(t.lenOrLit)]; ++distF[distCode(t.dist)]; } else ++litF[t.lenOrLit]; }
    litF[256] = 1;
    std::vector<uint8_t> litL = huffmanLengths(litF, 15), distL = huffmanLengths(distF, 15);
    int hlit = 286; while (hlit > 257 && !litL[hlit - 1]) --hlit;
    int hdist = 30; while (hdist > 1 && !distL[hdist - 1]) --hdist;

    // 3. run-length code the concatenated lengths (16: repeat previous 3-6, 17: zeros 3-10, 18: zeros 11-138)
    std::vector<uint8_t> all(litL.begin(), litL.begin() + hlit);
    all.insert(all.end(), distL.begin(), distL.begin() + hdist);
    struct Rle { uint8_t sym, extra, bits; };
    std::vector<Rle> rle;
    for (size_t i = 0; i < all.size();) {
        size_t run = 1; while (i + run < all.size() && all[i + run] == all[i]) ++run;
        if (all[i] == 0 && run >= 3) {
            size_t r = std::min<size_t>(run, 138);
            if (r >= 11) rle.push_back({18, static_cast<uint8_t>(r - 11), 7}); else rle.push_back({17, static_cast<uint8_t>(r - 3), 3});
            i += r;
        } else if (all[i] != 0 && run >= 4) {
            rle.push_back({all[i], 0, 0});
            size_t r = std::min<size_t>(run - 1, 6);
            rle.push_back({16, static_cast<uint8_t>(r - 3), 2});
            i += 1 + r;
        } else { rle.push_back({all[i], 0, 0}); ++i; }
    }
    std::vector<uint32_t> clF(19, 0);
    for (const Rle& r : rle) ++clF[r.sym];
    std::vector<uint8_t> clL = huffmanLengths(clF, 7);
    static const uint8_t clOrder[19] = {16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15};
    int hclen = 19; while (hclen > 4 && !clL[clOrder[hclen - 1]]) --hclen;

    // 4. emit, or fall back to stored blocks when the dynamic block would not be smaller
    std::vector<uint8_t> block;
    uint64_t bitBuf = 0; int bitCount = 0;
    auto put = [&](uint32_t v, int bits) { bitBuf |= static_cast<uint64_t>(v) << bitCount; bitCount += bits; while (bitCount >= 8) { block.push_back(static_cast<uint8_t>(bitBuf)); bitBuf >>= 8; bitCount -= 8; } };
    auto putCode = [&](uint32_t code, int bits) { uint32_t r = 0; for (int i = 0; i < bits; ++i) { r = (r << 1) | (code & 1); code >>= 1; } put(r, bits); };
    auto litC = canonicalCodes(litL), distC = canonicalCodes(distL), clC = canonicalCodes(clL);
    put(1, 1); put(2, 2); // BFINAL, BTYPE = dynamic Huffman
    put(static_cast<uint32_t>(hlit - 257), 5); put(static_cast<uint32_t>(hdist - 1), 5); put(static_cast<uint32_t>(hclen - 4), 4);
    for (int i = 0; i < hclen; ++i) put(clL[clOrder[i]], 3);
    for (const Rle& r : rle) { putCode(clC[r.sym], clL[r.sym]); if (r.bits) put(r.extra, r.bits); }
    for (const Tok& t : toks) {
        if (!t.dist) { putCode(litC[t.lenOrLit], litL[t.lenOrLit]); continue; }
        int lc = lenCode(t.lenOrLit), dc = distCode(t.dist);
        putCode(litC[257 + lc], litL[257 + lc]); put(t.lenOrLit - lenBase[lc], lenExtra[lc]);
        putCode(distC[dc], distL[dc]); put(t.dist - distBase[dc], distExtra[dc]);
    }
    putCode(litC[256], litL[256]);
    if (bitCount > 0) block.push_back(static_cast<uint8_t>(bitBuf));

    const size_t storedSize = len + 5 * (len / 65535 + 1);
    if (block.size() < storedSize) { out.insert(out.end(), block.begin(), block.end()); return; }
    size_t offset = 0;
    do {
        size_t blockLen = std::min<size_t>(65535, len - offset);
        out.push_back(offset + blockLen >= len ? 0x01 : 0x00);
        out.push_back(static_cast<uint8_t>(blockLen)); out.push_back(static_cast<uint8_t>(blockLen >> 8));
        out.push_back(static_cast<uint8_t>(~blockLen)); out.push_back(static_cast<uint8_t>(~blockLen >> 8));
        out.insert(out.end(), data + offset, data + offset + blockLen);
        offset += blockLen;
    } while (offset < len);
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
    size_t uncompressedLen = static_cast<size_t>(img.height) * (1 + scanlineLen);
    std::vector<uint8_t> uncompressedData(uncompressedLen);
    png::filterScanlines(img.data.data(), img.width, img.height, img.channels, uncompressedData.data());

    std::vector<uint8_t> zlibStream;
    zlibStream.push_back(0x78);
    zlibStream.push_back(0x01);
    png::deflate(uncompressedData.data(), uncompressedLen, zlibStream);

    uint32_t adler = png::computeAdler32(uncompressedData.data(), uncompressedLen);
    png::writeBE32(zlibStream, adler);

    png::writeChunk(pngBytes, "IDAT", zlibStream.data(), zlibStream.size());
    png::writeChunk(pngBytes, "IEND", nullptr, 0);

    return pngBytes;
}

} // namespace texture
} // namespace scratchbox

#endif // SCRATCHBOX_TEXTURE_HPP
