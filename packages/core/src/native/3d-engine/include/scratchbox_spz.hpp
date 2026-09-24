/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

#ifndef SCRATCHBOX_SPZ_HPP
#define SCRATCHBOX_SPZ_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_io.hpp"
#include <vector>
#include <string>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <sstream>
#include <algorithm>
#include <unordered_map>
#include <zlib.h>

namespace scratchbox {
namespace spz {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using math::Quat;
using math::Mat3;
using math::Mat4;
using geometry::Vertex;
using geometry::ScratchboxMesh;
using io::GlbWriter;

// ============================================================================
// 1. Core Gaussian Splat Data Structure
// ============================================================================

struct GaussianSplat {
    Vec3 position{0.0f, 0.0f, 0.0f};      // Center position μ [x, y, z] in local meters
    Vec3 scale{0.02f, 0.02f, 0.02f};     // 3D scale / covariance radii [sx, sy, sz]
    Quat rotation{0.0f, 0.0f, 0.0f, 1.0f}; // Orientation quaternion [x, y, z, w]
    Vec3 color{1.0f, 1.0f, 1.0f};         // Linear RGB color [0.0 - 1.0]
    float opacity{1.0f};                  // Alpha opacity [0.0 - 1.0]
    std::vector<float> sh;                // Optional higher-order Spherical Harmonics coefficients (shDim * 3 floats)
};

// ============================================================================
// 2. Gzip Compression Utilities via zlib
// ============================================================================

class GzipCodec {
public:
    static bool isGzip(const uint8_t* data, size_t size) {
        return size >= 2 && data[0] == 0x1F && data[1] == 0x8B;
    }

    static std::vector<uint8_t> compress(const uint8_t* data, size_t size) {
        z_stream zs;
        std::memset(&zs, 0, sizeof(zs));

        // 16 + MAX_WBITS sets gzip header encoding in zlib
        if (deflateInit2(&zs, Z_DEFAULT_COMPRESSION, Z_DEFLATED, 16 + MAX_WBITS, 8, Z_DEFAULT_STRATEGY) != Z_OK) {
            return {};
        }

        zs.next_in = const_cast<Bytef*>(reinterpret_cast<const Bytef*>(data));
        zs.avail_in = static_cast<uInt>(size);

        std::vector<uint8_t> out;
        out.resize(deflateBound(&zs, static_cast<uLong>(size)));

        zs.next_out = reinterpret_cast<Bytef*>(out.data());
        zs.avail_out = static_cast<uInt>(out.size());

        int ret = deflate(&zs, Z_FINISH);
        if (ret != Z_STREAM_END) {
            deflateEnd(&zs);
            return {};
        }

        out.resize(zs.total_out);
        deflateEnd(&zs);
        return out;
    }

    static std::vector<uint8_t> decompress(const uint8_t* data, size_t size) {
        z_stream zs;
        std::memset(&zs, 0, sizeof(zs));

        // 16 + MAX_WBITS enables gzip decoding in zlib
        if (inflateInit2(&zs, 16 + MAX_WBITS) != Z_OK) {
            return {};
        }

        zs.next_in = const_cast<Bytef*>(reinterpret_cast<const Bytef*>(data));
        zs.avail_in = static_cast<uInt>(size);

        std::vector<uint8_t> out;
        size_t bufferSize = size * 4 + 1024;
        out.resize(bufferSize);

        zs.next_out = reinterpret_cast<Bytef*>(out.data());
        zs.avail_out = static_cast<uInt>(out.size());

        while (true) {
            int ret = inflate(&zs, Z_NO_FLUSH);
            if (ret == Z_STREAM_END) {
                break;
            }
            if (ret != Z_OK) {
                inflateEnd(&zs);
                return {};
            }

            // Expand buffer if needed
            size_t oldSize = out.size();
            out.resize(oldSize * 2);
            zs.next_out = reinterpret_cast<Bytef*>(out.data() + oldSize);
            zs.avail_out = static_cast<uInt>(oldSize);
        }

        out.resize(zs.total_out);
        inflateEnd(&zs);
        return out;
    }
};

// ============================================================================
// 3. Standard .splat Codec (32-Byte Flat Format)
// ============================================================================

/**
 * Standard 32-byte per Gaussian binary format:
 *   [0..11]:   float32 position (x, y, z)
 *   [12..23]:  float32 scale (sx, sy, sz)
 *   [24..27]:  uint8 RGBA color & opacity
 *   [28..31]:  uint8 rotation quaternion (qx, qy, qz, qw) quantized to [0..255]
 */
class SplatCodec {
public:
    static constexpr size_t BYTES_PER_SPLAT = 32;

    static std::vector<uint8_t> encode(const std::vector<GaussianSplat>& splats) {
        std::vector<uint8_t> buffer(splats.size() * BYTES_PER_SPLAT);
        uint8_t* ptr = buffer.data();

        for (const auto& s : splats) {
            // Position
            float pos[3] = {s.position.x, s.position.y, s.position.z};
            std::memcpy(ptr, pos, sizeof(pos));

            // Scale
            float scale[3] = {s.scale.x, s.scale.y, s.scale.z};
            std::memcpy(ptr + 12, scale, sizeof(scale));

            // Color (RGBA)
            ptr[24] = static_cast<uint8_t>(std::clamp(s.color.x * 255.0f, 0.0f, 255.0f));
            ptr[25] = static_cast<uint8_t>(std::clamp(s.color.y * 255.0f, 0.0f, 255.0f));
            ptr[26] = static_cast<uint8_t>(std::clamp(s.color.z * 255.0f, 0.0f, 255.0f));
            ptr[27] = static_cast<uint8_t>(std::clamp(s.opacity * 255.0f, 0.0f, 255.0f));

            // Normalized quaternion quantized [-1..1] -> [0..255]
            Quat q = s.rotation.normalized();
            ptr[28] = static_cast<uint8_t>(std::clamp((q.x * 0.5f + 0.5f) * 255.0f, 0.0f, 255.0f));
            ptr[29] = static_cast<uint8_t>(std::clamp((q.y * 0.5f + 0.5f) * 255.0f, 0.0f, 255.0f));
            ptr[30] = static_cast<uint8_t>(std::clamp((q.z * 0.5f + 0.5f) * 255.0f, 0.0f, 255.0f));
            ptr[31] = static_cast<uint8_t>(std::clamp((q.w * 0.5f + 0.5f) * 255.0f, 0.0f, 255.0f));

            ptr += BYTES_PER_SPLAT;
        }

        return buffer;
    }

    static std::vector<GaussianSplat> decode(const uint8_t* data, size_t size) {
        size_t count = size / BYTES_PER_SPLAT;
        std::vector<GaussianSplat> splats;
        splats.reserve(count);

        const uint8_t* ptr = data;
        for (size_t i = 0; i < count; ++i) {
            GaussianSplat s;

            // Position
            float pos[3];
            std::memcpy(pos, ptr, sizeof(pos));
            s.position = Vec3(pos[0], pos[1], pos[2]);

            // Scale
            float scale[3];
            std::memcpy(scale, ptr + 12, sizeof(scale));
            s.scale = Vec3(scale[0], scale[1], scale[2]);

            // Color & Opacity
            s.color = Vec3(ptr[24] / 255.0f, ptr[25] / 255.0f, ptr[26] / 255.0f);
            s.opacity = ptr[27] / 255.0f;

            // Rotation Quaternion [0..255] -> [-1..1]
            float qx = (ptr[28] / 255.0f) * 2.0f - 1.0f;
            float qy = (ptr[29] / 255.0f) * 2.0f - 1.0f;
            float qz = (ptr[30] / 255.0f) * 2.0f - 1.0f;
            float qw = (ptr[31] / 255.0f) * 2.0f - 1.0f;
            s.rotation = Quat(qx, qy, qz, qw).normalized();

            splats.push_back(s);
            ptr += BYTES_PER_SPLAT;
        }

        return splats;
    }
};

// ============================================================================
// 4. SPZ (Scaniverse / Niantic) Codec
// ============================================================================

/**
 * High-compression SPZ format (Quantized attributes + gzip deflate).
 * Header:
 *   Magic: 'S', 'P', 'Z', '1' (4 bytes)
 *   Version: uint32 (4 bytes)
 *   NumPoints: uint32 (4 bytes)
 *   FractionalBits: uint8 (1 byte)
 *   Flags: uint8 (1 byte)
 *   Reserved: uint16 (2 bytes)
 */
class SpzCodec {
public:
    static constexpr uint32_t SPZ_MAGIC_LEGACY = 0x315a5053; // 'S','P','Z','1'
    static constexpr uint32_t SPZ_MAGIC_NIANTIC = 0x5053474e; // 'N','G','S','P'
    static constexpr uint8_t DEFAULT_FRACTIONAL_BITS = 12; // 1/4096 meter precision

#pragma pack(push, 1)
    struct SpzHeader {
        uint32_t magic{SPZ_MAGIC_NIANTIC};
        uint32_t version{2};
        uint32_t numPoints{0};
        uint8_t shDegree{0};
        uint8_t fractionalBits{DEFAULT_FRACTIONAL_BITS};
        uint8_t flags{0};
        uint8_t reserved{0};
    };
#pragma pack(pop)
    static_assert(sizeof(SpzHeader) == 16, "NGSP header must be exactly 16 bytes");

    // Niantic SPZ v2 body layout (SoA, SH degree 0):
    //   positions 24-bit fixed (9n) | alphas u8 (n) | colors u8 SH-DC (3n) | scales u8 log (3n) | rotations u8 xyz (3n)
    static constexpr float SH_C0 = 0.28209479177387814f;
    static constexpr float COLOR_SCALE = 0.15f;

    static inline uint8_t toU8(float x) { return static_cast<uint8_t>(std::clamp(std::round(x), 0.0f, 255.0f)); }

    static size_t nianticBodyBytes(size_t n, uint8_t shDegree) {
        size_t shDim = (shDegree == 1) ? 3 : (shDegree == 2) ? 8 : (shDegree == 3) ? 15 : 0;
        return n * (9 + 1 + 3 + 3 + 3) + n * shDim * 3;
    }

    static std::vector<uint8_t> encode(const std::vector<GaussianSplat>& splats, uint8_t fractionalBits = DEFAULT_FRACTIONAL_BITS, uint8_t shDegree = 0) {
        const size_t n = splats.size();
        const size_t shDim = (shDegree == 1) ? 3 : (shDegree == 2) ? 8 : (shDegree == 3) ? 15 : 0;
        const size_t shCoeffsPerSplat = shDim * 3;
        std::vector<uint8_t> raw(sizeof(SpzHeader) + nianticBodyBytes(n, shDegree));

        SpzHeader header;
        header.numPoints = static_cast<uint32_t>(n);
        header.shDegree = shDegree;
        header.fractionalBits = fractionalBits;
        std::memcpy(raw.data(), &header, sizeof(SpzHeader));

        uint8_t* pos = raw.data() + sizeof(SpzHeader);
        uint8_t* alpha = pos + 9 * n;
        uint8_t* color = alpha + n;
        uint8_t* scale = color + 3 * n;
        uint8_t* rot = scale + 3 * n;
        uint8_t* shPtr = rot + 3 * n;
        const float posScale = static_cast<float>(1 << fractionalBits);

        for (size_t i = 0; i < n; ++i) {
            const auto& s = splats[i];
            const float p[3] = {s.position.x, s.position.y, s.position.z};
            for (int k = 0; k < 3; ++k) {
                int32_t fixed32 = static_cast<int32_t>(std::round(p[k] * posScale));
                fixed32 = std::clamp(fixed32, -8388608, 8388607); // 24-bit signed range
                pos[(i * 3 + k) * 3 + 0] = static_cast<uint8_t>(fixed32 & 0xff);
                pos[(i * 3 + k) * 3 + 1] = static_cast<uint8_t>((fixed32 >> 8) & 0xff);
                pos[(i * 3 + k) * 3 + 2] = static_cast<uint8_t>((fixed32 >> 16) & 0xff);
            }

            alpha[i] = toU8(s.opacity * 255.0f); // opacity is already sigmoid(alpha_logit)

            const float c[3] = {s.color.x, s.color.y, s.color.z};
            for (int k = 0; k < 3; ++k) {
                float shDc = (c[k] - 0.5f) / SH_C0;
                color[i * 3 + k] = toU8(shDc * (COLOR_SCALE * 255.0f) + 0.5f * 255.0f);
            }

            const float sc[3] = {s.scale.x, s.scale.y, s.scale.z};
            for (int k = 0; k < 3; ++k) {
                scale[i * 3 + k] = toU8((std::log(std::max(sc[k], 1e-6f)) + 10.0f) * 16.0f);
            }

            Quat q = s.rotation.normalized();
            const float sign = (q.w < 0.0f) ? -127.5f : 127.5f;
            rot[i * 3 + 0] = toU8(q.x * sign + 127.5f);
            rot[i * 3 + 1] = toU8(q.y * sign + 127.5f);
            rot[i * 3 + 2] = toU8(q.z * sign + 127.5f);

            if (shDegree > 0 && shCoeffsPerSplat > 0) {
                for (size_t cIdx = 0; cIdx < shCoeffsPerSplat; ++cIdx) {
                    float val = (cIdx < s.sh.size()) ? s.sh[cIdx] : 0.0f;
                    shPtr[i * shCoeffsPerSplat + cIdx] = toU8(val * 127.5f + 127.5f);
                }
            }
        }

        return GzipCodec::compress(raw.data(), raw.size());
    }

    static std::vector<GaussianSplat> decode(const uint8_t* data, size_t size) {
        std::vector<uint8_t> raw;
        if (GzipCodec::isGzip(data, size)) {
            raw = GzipCodec::decompress(data, size);
        } else {
            raw.assign(data, data + size);
        }
        if (raw.size() < sizeof(SpzHeader)) return {};

        SpzHeader header;
        std::memcpy(&header, raw.data(), sizeof(SpzHeader));
        std::vector<GaussianSplat> splats;
        const size_t n = header.numPoints;
        const size_t body = raw.size() - sizeof(SpzHeader);

        if (header.magic == SPZ_MAGIC_NIANTIC && body >= nianticBodyBytes(n, header.shDegree) && body != n * 22) {
            // Spec-exact Niantic layout (including SH bands when header.shDegree > 0)
            const uint8_t* pos = raw.data() + sizeof(SpzHeader);
            const uint8_t* alpha = pos + 9 * n;
            const uint8_t* color = alpha + n;
            const uint8_t* scale = color + 3 * n;
            const uint8_t* rot = scale + 3 * n;
            const uint8_t* shPtr = rot + 3 * n;
            const size_t shDim = (header.shDegree == 1) ? 3 : (header.shDegree == 2) ? 8 : (header.shDegree == 3) ? 15 : 0;
            const size_t shCoeffsPerSplat = shDim * 3;
            const float posScale = 1.0f / static_cast<float>(1 << header.fractionalBits);
            splats.reserve(n);
            for (size_t i = 0; i < n; ++i) {
                GaussianSplat s;
                float p[3];
                for (int k = 0; k < 3; ++k) {
                    const uint8_t* b = pos + (i * 3 + k) * 3;
                    int32_t v = b[0] | (b[1] << 8) | (b[2] << 16);
                    if (v & 0x800000) v |= static_cast<int32_t>(0xff000000);
                    p[k] = static_cast<float>(v) * posScale;
                }
                s.position = Vec3(p[0], p[1], p[2]);
                s.opacity = alpha[i] / 255.0f;
                float c[3];
                for (int k = 0; k < 3; ++k) {
                    float shDc = (color[i * 3 + k] / 255.0f - 0.5f) / COLOR_SCALE;
                    c[k] = std::clamp(shDc * SH_C0 + 0.5f, 0.0f, 1.0f);
                }
                s.color = Vec3(c[0], c[1], c[2]);
                s.scale = Vec3(
                    std::exp(scale[i * 3 + 0] / 16.0f - 10.0f),
                    std::exp(scale[i * 3 + 1] / 16.0f - 10.0f),
                    std::exp(scale[i * 3 + 2] / 16.0f - 10.0f));
                float qx = rot[i * 3 + 0] / 127.5f - 1.0f;
                float qy = rot[i * 3 + 1] / 127.5f - 1.0f;
                float qz = rot[i * 3 + 2] / 127.5f - 1.0f;
                float qw = std::sqrt(std::max(0.0f, 1.0f - (qx * qx + qy * qy + qz * qz)));
                s.rotation = Quat(qx, qy, qz, qw).normalized();

                if (header.shDegree > 0 && shCoeffsPerSplat > 0) {
                    s.sh.resize(shCoeffsPerSplat);
                    for (size_t cIdx = 0; cIdx < shCoeffsPerSplat; ++cIdx) {
                        s.sh[cIdx] = (static_cast<float>(shPtr[i * shCoeffsPerSplat + cIdx]) - 127.5f) / 127.5f;
                    }
                }

                splats.push_back(s);
            }
        } else if (header.magic == SPZ_MAGIC_NIANTIC && body == n * 22) {
            // Interim planar layout written by earlier Scratchbox builds (int32 pos | i8 log-scale | i8 quat | u8 rgba)
            const uint8_t* ptr = raw.data() + sizeof(SpzHeader);
            const int32_t* px = reinterpret_cast<const int32_t*>(ptr);
            const int32_t* py = px + n; const int32_t* pz = py + n;
            const int8_t* sx = reinterpret_cast<const int8_t*>(pz + n);
            const int8_t* sy = sx + n; const int8_t* sz = sy + n;
            const int8_t* qx = sz + n; const int8_t* qy = qx + n; const int8_t* qz = qy + n;
            const uint8_t* r = reinterpret_cast<const uint8_t*>(qz + n);
            const uint8_t* g = r + n; const uint8_t* b = g + n; const uint8_t* a = b + n;
            const float posScale = 1.0f / static_cast<float>(1 << header.fractionalBits);
            splats.reserve(n);
            for (size_t i = 0; i < n; ++i) {
                GaussianSplat s;
                s.position = Vec3(px[i] * posScale, py[i] * posScale, pz[i] * posScale);
                s.scale = Vec3(std::exp((sx[i] + 128.0f) / 255.0f * 12.0f - 8.0f),
                               std::exp((sy[i] + 128.0f) / 255.0f * 12.0f - 8.0f),
                               std::exp((sz[i] + 128.0f) / 255.0f * 12.0f - 8.0f));
                float fx = qx[i] / 127.0f, fy = qy[i] / 127.0f, fz = qz[i] / 127.0f;
                float w2 = 1.0f - (fx * fx + fy * fy + fz * fz);
                s.rotation = Quat(fx, fy, fz, w2 > 0.0f ? std::sqrt(w2) : 0.0f).normalized();
                s.color = Vec3(r[i] / 255.0f, g[i] / 255.0f, b[i] / 255.0f);
                s.opacity = a[i] / 255.0f;
                splats.push_back(s);
            }
        } else if (header.magic == SPZ_MAGIC_LEGACY) {
            // Legacy SPZ1 layout (interleaved 22-byte records; fractionalBits at byte 12)
            uint8_t legacyFractionalBits = raw[12];
            float posScale = 1.0f / static_cast<float>(1 << legacyFractionalBits);
            const uint8_t* ptr = raw.data() + sizeof(SpzHeader);
            size_t count = std::min<size_t>(n, body / 22);
            splats.reserve(count);
            for (size_t i = 0; i < count; ++i) {
                GaussianSplat s;
                int32_t ix, iy, iz;
                std::memcpy(&ix, ptr, 4); std::memcpy(&iy, ptr + 4, 4); std::memcpy(&iz, ptr + 8, 4);
                s.position = Vec3(ix * posScale, iy * posScale, iz * posScale);
                ptr += 12;
                float scales[3];
                for (int k = 0; k < 3; ++k) {
                    int8_t quant = static_cast<int8_t>(*ptr++);
                    scales[k] = std::exp(((quant + 128.0f) / 255.0f) * 12.0f - 8.0f);
                }
                s.scale = Vec3(scales[0], scales[1], scales[2]);
                float qx = static_cast<int8_t>(*ptr++) / 127.0f;
                float qy = static_cast<int8_t>(*ptr++) / 127.0f;
                float qz = static_cast<int8_t>(*ptr++) / 127.0f;
                float qw2 = 1.0f - (qx * qx + qy * qy + qz * qz);
                s.rotation = Quat(qx, qy, qz, qw2 > 0.0f ? std::sqrt(qw2) : 0.0f).normalized();
                float cr = *ptr++ / 255.0f, cg = *ptr++ / 255.0f, cb = *ptr++ / 255.0f;
                s.color = Vec3(cr, cg, cb);
                s.opacity = *ptr++ / 255.0f;
                splats.push_back(s);
            }
        }
        return splats;
    }
};

class PlyCodec {
public:
    static bool saveToPlyFile(const std::string& filepath, const std::vector<GaussianSplat>& splats) {
        std::ofstream out(filepath, std::ios::binary);
        if (!out.is_open()) return false;

        out << "ply\n"
            << "format binary_little_endian 1.0\n"
            << "element vertex " << splats.size() << "\n"
            << "property float x\n"
            << "property float y\n"
            << "property float z\n"
            << "property float scale_0\n"
            << "property float scale_1\n"
            << "property float scale_2\n"
            << "property uchar red\n"
            << "property uchar green\n"
            << "property uchar blue\n"
            << "property uchar opacity\n"
            << "property float rot_0\n"
            << "property float rot_1\n"
            << "property float rot_2\n"
            << "property float rot_3\n"
            << "end_header\n";

        for (const auto& s : splats) {
            float pos[3] = {s.position.x, s.position.y, s.position.z};
            out.write(reinterpret_cast<const char*>(pos), 12);

            float scale[3] = {s.scale.x, s.scale.y, s.scale.z};
            out.write(reinterpret_cast<const char*>(scale), 12);

            uint8_t rgba[4] = {
                static_cast<uint8_t>(std::clamp(s.color.x * 255.0f, 0.0f, 255.0f)),
                static_cast<uint8_t>(std::clamp(s.color.y * 255.0f, 0.0f, 255.0f)),
                static_cast<uint8_t>(std::clamp(s.color.z * 255.0f, 0.0f, 255.0f)),
                static_cast<uint8_t>(std::clamp(s.opacity * 255.0f, 0.0f, 255.0f))
            };
            out.write(reinterpret_cast<const char*>(rgba), 4);

            float rot[4] = {s.rotation.w, s.rotation.x, s.rotation.y, s.rotation.z};
            out.write(reinterpret_cast<const char*>(rot), 16);
        }

        return out.good();
    }
};

// ============================================================================
// 5. Splat-to-Mesh & Binary glTF 2.0 Streaming Engine
// ============================================================================

class SplatMeshBuilder {
public:
    /**
     * Converts a collection of 3D Gaussians into an oriented surfel quad mesh.
     * Each quad is oriented perpendicular to the Gaussian's shortest scale axis (normal),
     * spanned by its two longest principal axes.
     */
    static ScratchboxMesh buildSurfelMesh(
        const std::vector<GaussianSplat>& splats,
        float radiusMultiplier = 1.25f,
        float minOpacityThreshold = 0.05f
    ) {
        ScratchboxMesh mesh;
        mesh.vertices.reserve(splats.size() * 4);
        mesh.indices.reserve(splats.size() * 6);

        for (const auto& s : splats) {
            if (s.opacity < minOpacityThreshold) continue;

            // Find principal tangent vectors (spanned by x and y scale axes)
            Vec3 u = s.rotation.rotate(Vec3(s.scale.x * radiusMultiplier, 0.0f, 0.0f));
            Vec3 v = s.rotation.rotate(Vec3(0.0f, s.scale.y * radiusMultiplier, 0.0f));
            Vec3 normal = s.rotation.rotate(Vec3(0.0f, 0.0f, 1.0f)).normalized();

            Vec3 p0 = s.position - u - v;
            Vec3 p1 = s.position + u - v;
            Vec3 p2 = s.position + u + v;
            Vec3 p3 = s.position - u + v;

            Vec4 col(s.color.x, s.color.y, s.color.z, s.opacity);
            uint32_t base = static_cast<uint32_t>(mesh.vertices.size());

            mesh.vertices.push_back({p0, normal, Vec2(0.0f, 0.0f), col});
            mesh.vertices.push_back({p1, normal, Vec2(1.0f, 0.0f), col});
            mesh.vertices.push_back({p2, normal, Vec2(1.0f, 1.0f), col});
            mesh.vertices.push_back({p3, normal, Vec2(0.0f, 1.0f), col});

            // Quad triangles (0-1-2 and 0-2-3)
            mesh.indices.push_back(base + 0);
            mesh.indices.push_back(base + 1);
            mesh.indices.push_back(base + 2);

            mesh.indices.push_back(base + 0);
            mesh.indices.push_back(base + 2);
            mesh.indices.push_back(base + 3);
        }

        return mesh;
    }

    /**
     * Voxel grid downsampler for Gaussian Splats to maintain smooth interactive 120 FPS frame rates.
     */
    static std::vector<GaussianSplat> voxelize(
        const std::vector<GaussianSplat>& splats,
        float voxelSizeMeters
    ) {
        if (voxelSizeMeters <= 1e-4f) return splats;

        struct Bucket {
            Vec3 sumPos{0, 0, 0};
            Vec3 sumScale{0, 0, 0};
            Vec3 sumColor{0, 0, 0};
            float sumOpacity{0.0f};
            Quat primeRot{0, 0, 0, 1};
            size_t count{0};
        };

        std::unordered_map<std::string, Bucket> grid;

        for (const auto& s : splats) {
            int bx = static_cast<int>(std::floor(s.position.x / voxelSizeMeters));
            int by = static_cast<int>(std::floor(s.position.y / voxelSizeMeters));
            int bz = static_cast<int>(std::floor(s.position.z / voxelSizeMeters));
            std::string key = std::to_string(bx) + "," + std::to_string(by) + "," + std::to_string(bz);

            auto& b = grid[key];
            if (b.count == 0) {
                b.primeRot = s.rotation;
            }
            b.sumPos = b.sumPos + s.position;
            b.sumScale = b.sumScale + s.scale;
            b.sumColor = b.sumColor + s.color;
            b.sumOpacity += s.opacity;
            b.count++;
        }

        std::vector<GaussianSplat> output;
        output.reserve(grid.size());

        for (const auto& [_, b] : grid) {
            float inv = 1.0f / static_cast<float>(b.count);
            GaussianSplat g;
            g.position = b.sumPos * inv;
            g.scale = b.sumScale * inv;
            g.color = b.sumColor * inv;
            g.opacity = b.sumOpacity * inv;
            g.rotation = b.primeRot;
            output.push_back(g);
        }

        return output;
    }

    /**
     * Direct binary glTF 2.0 (.glb) export of the surfel mesh.
     */
    static std::vector<uint8_t> exportToGlb(
        const std::vector<GaussianSplat>& splats,
        float radiusMultiplier = 1.25f
    ) {
        ScratchboxMesh mesh = buildSurfelMesh(splats, radiusMultiplier);
        return GlbWriter::writeGlb(mesh);
    }
};

} // namespace spz
} // namespace scratchbox

#endif // SCRATCHBOX_SPZ_HPP
