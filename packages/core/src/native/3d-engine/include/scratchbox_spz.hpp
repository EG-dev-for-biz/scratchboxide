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
        uint16_t reserved{0};
    };
#pragma pack(pop)

    static std::vector<uint8_t> encode(const std::vector<GaussianSplat>& splats, uint8_t fractionalBits = DEFAULT_FRACTIONAL_BITS) {
        size_t numPoints = splats.size();
        size_t totalBytes = sizeof(SpzHeader) + numPoints * 22;
        std::vector<uint8_t> uncompressed(totalBytes);

        SpzHeader header;
        header.numPoints = static_cast<uint32_t>(numPoints);
        header.fractionalBits = fractionalBits;
        std::memcpy(uncompressed.data(), &header, sizeof(SpzHeader));

        uint8_t* ptr = uncompressed.data() + sizeof(SpzHeader);
        float posScale = static_cast<float>(1 << header.fractionalBits);

        int32_t* px_arr = reinterpret_cast<int32_t*>(ptr);
        int32_t* py_arr = px_arr + numPoints;
        int32_t* pz_arr = py_arr + numPoints;

        int8_t* sx_arr = reinterpret_cast<int8_t*>(pz_arr + numPoints);
        int8_t* sy_arr = sx_arr + numPoints;
        int8_t* sz_arr = sy_arr + numPoints;

        int8_t* qx_arr = sz_arr + numPoints;
        int8_t* qy_arr = qx_arr + numPoints;
        int8_t* qz_arr = qy_arr + numPoints;

        uint8_t* r_arr = reinterpret_cast<uint8_t*>(qz_arr + numPoints);
        uint8_t* g_arr = r_arr + numPoints;
        uint8_t* b_arr = g_arr + numPoints;
        uint8_t* a_arr = b_arr + numPoints;

        for (size_t i = 0; i < numPoints; ++i) {
            const auto& s = splats[i];

            px_arr[i] = static_cast<int32_t>(std::round(s.position.x * posScale));
            py_arr[i] = static_cast<int32_t>(std::round(s.position.y * posScale));
            pz_arr[i] = static_cast<int32_t>(std::round(s.position.z * posScale));

            for (int k = 0; k < 3; ++k) {
                float val = (k == 0) ? s.scale.x : (k == 1 ? s.scale.y : s.scale.z);
                float logVal = std::log(std::max(val, 1e-5f));
                float normVal = (logVal + 8.0f) / 12.0f;
                int8_t quant = static_cast<int8_t>(std::clamp(normVal * 255.0f - 128.0f, -128.0f, 127.0f));
                if (k == 0) sx_arr[i] = quant;
                else if (k == 1) sy_arr[i] = quant;
                else sz_arr[i] = quant;
            }

            Quat q = s.rotation.normalized();
            if (q.w < 0.0f) {
                q.x = -q.x; q.y = -q.y; q.z = -q.z; q.w = -q.w;
            }
            qx_arr[i] = static_cast<int8_t>(std::clamp(q.x * 127.0f, -128.0f, 127.0f));
            qy_arr[i] = static_cast<int8_t>(std::clamp(q.y * 127.0f, -128.0f, 127.0f));
            qz_arr[i] = static_cast<int8_t>(std::clamp(q.z * 127.0f, -128.0f, 127.0f));

            r_arr[i] = static_cast<uint8_t>(std::clamp(s.color.x * 255.0f, 0.0f, 255.0f));
            g_arr[i] = static_cast<uint8_t>(std::clamp(s.color.y * 255.0f, 0.0f, 255.0f));
            b_arr[i] = static_cast<uint8_t>(std::clamp(s.color.z * 255.0f, 0.0f, 255.0f));
            a_arr[i] = static_cast<uint8_t>(std::clamp(s.opacity * 255.0f, 0.0f, 255.0f));
        }

        return GzipCodec::compress(uncompressed.data(), uncompressed.size());
    }

    static std::vector<GaussianSplat> decode(const uint8_t* data, size_t size) {
        std::vector<uint8_t> uncompressed;

        if (GzipCodec::isGzip(data, size)) {
            uncompressed = GzipCodec::decompress(data, size);
        } else {
            uncompressed.assign(data, data + size);
        }

        if (uncompressed.size() < sizeof(SpzHeader)) {
            return {};
        }

        SpzHeader header;
        std::memcpy(&header, uncompressed.data(), sizeof(SpzHeader));

        std::vector<GaussianSplat> splats;

        if (header.magic == SPZ_MAGIC_NIANTIC) {
            size_t count = header.numPoints;
            float posScale = 1.0f / static_cast<float>(1 << header.fractionalBits);
            const uint8_t* ptr = uncompressed.data() + sizeof(SpzHeader);

            const int32_t* px_arr = reinterpret_cast<const int32_t*>(ptr);
            const int32_t* py_arr = px_arr + count;
            const int32_t* pz_arr = py_arr + count;

            const int8_t* sx_arr = reinterpret_cast<const int8_t*>(pz_arr + count);
            const int8_t* sy_arr = sx_arr + count;
            const int8_t* sz_arr = sy_arr + count;

            const int8_t* qx_arr = sz_arr + count;
            const int8_t* qy_arr = qx_arr + count;
            const int8_t* qz_arr = qy_arr + count;

            const uint8_t* r_arr = reinterpret_cast<const uint8_t*>(qz_arr + count);
            const uint8_t* g_arr = r_arr + count;
            const uint8_t* b_arr = g_arr + count;
            const uint8_t* a_arr = b_arr + count;

            splats.reserve(count);
            for (size_t i = 0; i < count; ++i) {
                GaussianSplat s;
                s.position = Vec3(px_arr[i] * posScale, py_arr[i] * posScale, pz_arr[i] * posScale);

                float sx_norm = (sx_arr[i] + 128.0f) / 255.0f;
                float sy_norm = (sy_arr[i] + 128.0f) / 255.0f;
                float sz_norm = (sz_arr[i] + 128.0f) / 255.0f;
                s.scale = Vec3(
                    std::exp(sx_norm * 12.0f - 8.0f),
                    std::exp(sy_norm * 12.0f - 8.0f),
                    std::exp(sz_norm * 12.0f - 8.0f)
                );

                float qx = qx_arr[i] / 127.0f;
                float qy = qy_arr[i] / 127.0f;
                float qz = qz_arr[i] / 127.0f;
                float qw2 = 1.0f - (qx * qx + qy * qy + qz * qz);
                float qw = qw2 > 0.0f ? std::sqrt(qw2) : 0.0f;
                s.rotation = Quat(qx, qy, qz, qw).normalized();

                s.color = Vec3(r_arr[i] / 255.0f, g_arr[i] / 255.0f, b_arr[i] / 255.0f);
                s.opacity = a_arr[i] / 255.0f;

                splats.push_back(s);
            }
        } else if (header.magic == SPZ_MAGIC_LEGACY) {
            float posScale = 1.0f / static_cast<float>(1 << header.fractionalBits);
            const uint8_t* ptr = uncompressed.data() + sizeof(SpzHeader);
            size_t availablePoints = (uncompressed.size() - sizeof(SpzHeader)) / 22;
            size_t count = std::min<size_t>(header.numPoints, availablePoints);

            splats.reserve(count);
            for (size_t i = 0; i < count; ++i) {
                GaussianSplat s;

                // Position
                int32_t ix, iy, iz;
                std::memcpy(&ix, ptr, 4);
                std::memcpy(&iy, ptr + 4, 4);
                std::memcpy(&iz, ptr + 8, 4);
                s.position = Vec3(ix * posScale, iy * posScale, iz * posScale);
                ptr += 12;

                // Scale
                float scales[3];
                for (int k = 0; k < 3; ++k) {
                    int8_t quant = static_cast<int8_t>(*ptr++);
                    float normVal = (quant + 128.0f) / 255.0f;
                    float logVal = normVal * 12.0f - 8.0f;
                    scales[k] = std::exp(logVal);
                }
                s.scale = Vec3(scales[0], scales[1], scales[2]);

                // Rotation
                int8_t iqx = static_cast<int8_t>(*ptr++);
                int8_t iqy = static_cast<int8_t>(*ptr++);
                int8_t iqz = static_cast<int8_t>(*ptr++);
                float qx = iqx / 127.0f;
                float qy = iqy / 127.0f;
                float qz = iqz / 127.0f;
                float qw2 = 1.0f - (qx * qx + qy * qy + qz * qz);
                float qw = qw2 > 0.0f ? std::sqrt(qw2) : 0.0f;
                s.rotation = Quat(qx, qy, qz, qw).normalized();

                // Color & Opacity
                float cr = *ptr++ / 255.0f;
                float cg = *ptr++ / 255.0f;
                float cb = *ptr++ / 255.0f;
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
