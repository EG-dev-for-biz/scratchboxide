/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_VIRTUAL_GEOMETRY_HPP
#define SCRATCHBOX_VIRTUAL_GEOMETRY_HPP

/**
 * Virtual geometry builder: GLB scene -> cluster LOD DAG -> streamable .sbvg file.
 *
 * The pipeline is the Nanite / meshoptimizer clusterlod scheme:
 *   1. Load every triangle primitive of the GLB scene graph with its node world transform.
 *   2. Weld split-attribute vertices by exact position, drop degenerate triangles, compute
 *      area-weighted normals.
 *   3. Split the mesh into clusters of at most kMaxClusterVertices / kMaxClusterTriangles.
 *   4. Repeatedly partition the current level's clusters into groups of adjacent clusters,
 *      simplify each group to half its triangles with the vertices it shares with other groups
 *      locked (so neighbouring groups stay watertight at any mix of levels), and split the
 *      result into the next level's clusters. Simplification only collapses edges onto existing
 *      vertices, so every level indexes the same vertex buffer.
 *   5. Every cluster stores the LOD sphere + error of the group that produced it ("self") and of
 *      the group it was simplified in ("parent"). A renderer draws a cluster when its projected
 *      self error is within the pixel threshold and its projected parent error is not; errors
 *      and spheres are monotonic up the DAG, so that test picks a crack-free cut per cluster with
 *      no traversal.
 *
 * The .sbvg file is written coarsest level first, each level as one contiguous block holding its
 * clusters, the vertices it introduces, its vertex references and its packed triangles. A client
 * that has received levels [top .. L] can render a complete surface by treating level L as leaves,
 * so the model is visible after the first few kilobytes and sharpens as the stream arrives.
 *
 * Layout (little-endian, 4-byte words), version 2:
 *   header (128 bytes)          see writeSbvg (word 24: skipped non-triangle primitives)
 *   level table                 levelCount * 16 words, coarsest level first; the block's byte
 *                               offset and length are 64-bit (lo, hi word pairs at words 9-10 and
 *                               11-12), so files past 4 GiB are addressable. Version 1 used 12-word
 *                               rows with 32-bit offsets at words 9 and 10.
 *   level blocks (16-byte aligned), each:
 *     clusters   clusterCount * 32 words  (see writeSbvg for the record layout)
 *     vertices   vertexCount * 6 f32      (position xyz relative to origin, normal xyz)
 *     refs       refCount u32             (global vertex index per cluster-local vertex)
 *     triangles  triCount u32             (cluster-local i0 | i1 << 8 | i2 << 16)
 */

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <limits>
#include <queue>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

namespace scratchbox {
namespace vgeo {

constexpr uint32_t kMaxClusterVertices = 128;
constexpr uint32_t kMaxClusterTriangles = 128;
constexpr uint32_t kGroupSize = 8;
constexpr uint32_t kSbvgMagic = 0x47564253; // 'SBVG'
constexpr uint32_t kSbvgVersion = 2;
constexpr uint32_t kSbvgHeaderBytes = 128;
constexpr uint32_t kSbvgLevelWords = 16;
constexpr uint32_t kSbvgClusterWords = 32;
constexpr float kRootParentError = 3.0e38f;
/** Node instances a glTF scene graph may expand to (shared children are visited once per parent). */
constexpr uint64_t kMaxNodeInstances = 1u << 20;
/** Vertices (after instancing) the loader accepts; vertex ids are 32-bit. */
constexpr uint64_t kMaxSourceVertices = 1u << 29;
/** Triangles (after instancing) the loader accepts. */
constexpr uint64_t kMaxSourceTriangles = 1u << 30;
constexpr int kMaxJsonDepth = 512;

/** A malformed or unsupported GLB: the message says which part. */
struct GlbFormatError : std::runtime_error {
    explicit GlbFormatError(const std::string& what) : std::runtime_error(what) {}
};

/**
 * True when a level of `nextTris` triangles is worth adding above a level of `currentTris`
 * (it removes at least 5%). 64-bit: currentTris * 95 overflows 32 bits above ~45M triangles.
 */
inline bool levelReducesEnough(uint64_t nextTris, uint64_t currentTris) {
    return nextTris <= currentTris * 95 / 100;
}

// ============================================================================
// Small vector math
// ============================================================================

struct F3 {
    float x{0}, y{0}, z{0};
    F3() = default;
    F3(float ax, float ay, float az) : x(ax), y(ay), z(az) {}
    F3 operator+(const F3& o) const { return {x + o.x, y + o.y, z + o.z}; }
    F3 operator-(const F3& o) const { return {x - o.x, y - o.y, z - o.z}; }
    F3 operator*(float s) const { return {x * s, y * s, z * s}; }
    F3& operator+=(const F3& o) { x += o.x; y += o.y; z += o.z; return *this; }
};

inline float dot(const F3& a, const F3& b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
inline F3 cross(const F3& a, const F3& b) { return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x}; }
inline float length(const F3& a) { return std::sqrt(dot(a, a)); }
inline F3 normalize(const F3& a) { float l = length(a); return l > 0 ? a * (1.0f / l) : F3(0, 0, 0); }
inline F3 fmin3(const F3& a, const F3& b) { return {std::min(a.x, b.x), std::min(a.y, b.y), std::min(a.z, b.z)}; }
inline F3 fmax3(const F3& a, const F3& b) { return {std::max(a.x, b.x), std::max(a.y, b.y), std::max(a.z, b.z)}; }

struct Sphere {
    F3 center;
    float radius{0};
};

// ============================================================================
// Minimal JSON reader (enough for glTF)
// ============================================================================

struct Json {
    enum Type { Null, Bool, Number, String, Array, Object } type{Null};
    double num{0};
    bool b{false};
    std::string str;
    std::vector<Json> arr;
    std::vector<std::string> keys; // object keys, parallel to arr

    const Json& operator[](const std::string& key) const {
        static const Json nullValue;
        if (type != Object) return nullValue;
        for (size_t i = 0; i < keys.size(); ++i) {
            if (keys[i] == key) return arr[i];
        }
        return nullValue;
    }
    const Json& operator[](size_t i) const {
        static const Json nullValue;
        return (type == Array && i < arr.size()) ? arr[i] : nullValue;
    }
    bool isNull() const { return type == Null; }
    size_t size() const { return type == Array ? arr.size() : 0; }
    double asNumber(double def) const { return type == Number ? num : def; }
    /** Integer value; `def` when absent. Throws on a non-integral or out-of-range number. */
    int64_t asInt(int64_t def) const {
        if (type != Number) return def;
        if (!(num >= -9.0e15 && num <= 9.0e15) || num != std::floor(num)) throw GlbFormatError("glTF JSON: integer expected, got " + std::to_string(num));
        return static_cast<int64_t>(num);
    }
};

class JsonParser {
public:
    JsonParser(const char* text, size_t len) : p_(text), end_(text + len) {}

    Json parse() {
        Json v = value();
        return v;
    }

private:
    const char* p_;
    const char* end_;

    int depth_{0};

    [[noreturn]] void fail(const char* what) { throw GlbFormatError(std::string("glTF JSON parse error: ") + what); }

    void literal(const char* word) {
        size_t n = std::strlen(word);
        if (static_cast<size_t>(end_ - p_) < n || std::memcmp(p_, word, n) != 0) fail("bad literal");
        p_ += n;
    }

    void ws() {
        while (p_ < end_ && (*p_ == ' ' || *p_ == '\t' || *p_ == '\n' || *p_ == '\r')) ++p_;
    }

    Json value() {
        ws();
        if (p_ >= end_) fail("unexpected end");
        if (++depth_ > kMaxJsonDepth) fail("nesting too deep");
        struct DepthGuard { int& d; ~DepthGuard() { --d; } } guard{depth_};
        Json v;
        char c = *p_;
        if (c == '{') {
            v.type = Json::Object;
            ++p_;
            ws();
            if (p_ < end_ && *p_ == '}') { ++p_; return v; }
            while (true) {
                ws();
                if (p_ >= end_ || *p_ != '"') fail("expected key");
                v.keys.push_back(string());
                ws();
                if (p_ >= end_ || *p_ != ':') fail("expected ':'");
                ++p_;
                v.arr.push_back(value());
                ws();
                if (p_ < end_ && *p_ == ',') { ++p_; continue; }
                if (p_ < end_ && *p_ == '}') { ++p_; break; }
                fail("expected ',' or '}'");
            }
        } else if (c == '[') {
            v.type = Json::Array;
            ++p_;
            ws();
            if (p_ < end_ && *p_ == ']') { ++p_; return v; }
            while (true) {
                v.arr.push_back(value());
                ws();
                if (p_ < end_ && *p_ == ',') { ++p_; continue; }
                if (p_ < end_ && *p_ == ']') { ++p_; break; }
                fail("expected ',' or ']'");
            }
        } else if (c == '"') {
            v.type = Json::String;
            v.str = string();
        } else if (c == 't' || c == 'f') {
            v.type = Json::Bool;
            v.b = (c == 't');
            literal(v.b ? "true" : "false");
        } else if (c == 'n') {
            literal("null");
        } else {
            v.type = Json::Number;
            char* numEnd = nullptr;
            std::string buf(p_, static_cast<size_t>(std::min<ptrdiff_t>(end_ - p_, 64)));
            v.num = std::strtod(buf.c_str(), &numEnd);
            if (numEnd == buf.c_str()) fail("bad number");
            p_ += (numEnd - buf.c_str());
        }
        return v;
    }

    std::string string() {
        ++p_; // opening quote
        std::string out;
        while (p_ < end_ && *p_ != '"') {
            if (*p_ == '\\' && p_ + 1 < end_) {
                ++p_;
                char e = *p_;
                if (e == 'u') {
                    // Names only: keep the escape verbatim, nothing in the loader reads them.
                    out += "\\u";
                } else if (e == 'n') out += '\n';
                else if (e == 't') out += '\t';
                else out += e;
            } else {
                out += *p_;
            }
            ++p_;
        }
        if (p_ >= end_) fail("unterminated string");
        ++p_; // closing quote
        return out;
    }
};

// ============================================================================
// GLB scene loading (all triangle primitives, node world transforms applied)
// ============================================================================

struct SourceMesh {
    std::vector<F3> positions;
    std::vector<uint32_t> indices;
    uint32_t skippedPrimitives{0}; // primitives without a surface (points / lines) or without POSITION
};

using Mat4 = std::array<double, 16>; // column-major

inline Mat4 mat4Identity() {
    Mat4 m{};
    m[0] = m[5] = m[10] = m[15] = 1.0;
    return m;
}

inline Mat4 mat4Mul(const Mat4& a, const Mat4& b) {
    Mat4 r{};
    for (size_t c = 0; c < 4; ++c) {
        for (size_t row = 0; row < 4; ++row) {
            double s = 0;
            for (size_t k = 0; k < 4; ++k) s += a[k * 4 + row] * b[c * 4 + k];
            r[c * 4 + row] = s;
        }
    }
    return r;
}

inline Mat4 nodeLocalMatrix(const Json& node) {
    const Json& m = node["matrix"];
    if (m.size() == 16) {
        Mat4 out{};
        for (size_t i = 0; i < 16; ++i) out[i] = m[i].asNumber(0);
        return out;
    }
    double tx = 0, ty = 0, tz = 0, qx = 0, qy = 0, qz = 0, qw = 1, sx = 1, sy = 1, sz = 1;
    const Json& t = node["translation"];
    if (t.size() == 3) { tx = t[0].asNumber(0); ty = t[1].asNumber(0); tz = t[2].asNumber(0); }
    const Json& r = node["rotation"];
    if (r.size() == 4) { qx = r[0].asNumber(0); qy = r[1].asNumber(0); qz = r[2].asNumber(0); qw = r[3].asNumber(1); }
    const Json& s = node["scale"];
    if (s.size() == 3) { sx = s[0].asNumber(1); sy = s[1].asNumber(1); sz = s[2].asNumber(1); }

    Mat4 out{};
    out[0] = (1 - 2 * (qy * qy + qz * qz)) * sx;
    out[1] = (2 * (qx * qy + qz * qw)) * sx;
    out[2] = (2 * (qx * qz - qy * qw)) * sx;
    out[4] = (2 * (qx * qy - qz * qw)) * sy;
    out[5] = (1 - 2 * (qx * qx + qz * qz)) * sy;
    out[6] = (2 * (qy * qz + qx * qw)) * sy;
    out[8] = (2 * (qx * qz + qy * qw)) * sz;
    out[9] = (2 * (qy * qz - qx * qw)) * sz;
    out[10] = (1 - 2 * (qx * qx + qy * qy)) * sz;
    out[12] = tx;
    out[13] = ty;
    out[14] = tz;
    out[15] = 1;
    return out;
}

inline double mat4Det3(const Mat4& m) {
    return m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
}

class GlbSceneLoader {
public:
    static SourceMesh loadFile(const std::string& path) {
        std::ifstream f(path, std::ios::binary | std::ios::ate);
        if (!f) throw std::runtime_error("cannot open GLB: " + path);
        std::streamsize size = f.tellg();
        f.seekg(0);
        std::vector<uint8_t> data(static_cast<size_t>(size));
        if (!f.read(reinterpret_cast<char*>(data.data()), size)) throw std::runtime_error("cannot read GLB: " + path);
        return load(data.data(), data.size());
    }

    static SourceMesh load(const uint8_t* data, size_t len) {
        if (len < 20) throw GlbFormatError("GLB too small");
        uint32_t magic, version, jsonLen, jsonType;
        std::memcpy(&magic, data, 4);
        std::memcpy(&version, data + 4, 4);
        std::memcpy(&jsonLen, data + 12, 4);
        std::memcpy(&jsonType, data + 16, 4);
        if (magic != 0x46546C67) throw GlbFormatError("not a GLB file (bad magic)");
        if (version != 2) throw GlbFormatError("unsupported GLB version");
        if (jsonType != 0x4E4F534A || uint64_t(jsonLen) > len - 20) throw GlbFormatError("GLB JSON chunk missing");

        Json root = JsonParser(reinterpret_cast<const char*>(data + 20), jsonLen).parse();

        const uint8_t* bin = nullptr;
        size_t binLen = 0;
        size_t binHeader = 20 + size_t(jsonLen);
        if (len - binHeader >= 8) {
            uint32_t chunkLen, chunkType;
            std::memcpy(&chunkLen, data + binHeader, 4);
            std::memcpy(&chunkType, data + binHeader + 4, 4);
            if (chunkType == 0x004E4942) {
                bin = data + binHeader + 8;
                binLen = std::min<size_t>(chunkLen, len - binHeader - 8);
            }
        }

        const Json& required = root["extensionsRequired"];
        for (size_t i = 0; i < required.size(); ++i) {
            const std::string& ext = required[i].str;
            if (ext == "KHR_draco_mesh_compression" || ext == "EXT_meshopt_compression" || ext == "KHR_mesh_quantization") {
                throw GlbFormatError("GLB requires " + ext + ", which the virtual geometry builder does not decode; "
                                     "export the mesh uncompressed with float positions");
            }
        }

        GlbSceneLoader loader(root, bin, binLen);
        loader.walk();
        return std::move(loader.out_);
    }

private:
    const Json& root_;
    const uint8_t* bin_;
    size_t binLen_;
    SourceMesh out_;
    uint64_t instances_{0};

    GlbSceneLoader(const Json& root, const uint8_t* bin, size_t binLen) : root_(root), bin_(bin), binLen_(binLen) {}

    /** Array index from JSON: `def` when absent, GlbFormatError when negative (out-of-range indices read as null). */
    static size_t index(const Json& v, int64_t def = -1) {
        int64_t i = v.asInt(def);
        if (i < 0) throw GlbFormatError("glTF index must be a non-negative integer");
        return static_cast<size_t>(i);
    }

    void walk() {
        const Json& scenes = root_["scenes"];
        const Json& nodes = root_["nodes"];
        if (scenes.size() > 0) {
            const Json& scene = scenes[index(root_["scene"], 0)];
            const Json& roots = scene["nodes"];
            for (size_t i = 0; i < roots.size(); ++i) visitNode(index(roots[i]), mat4Identity(), 0);
        } else if (nodes.size() > 0) {
            std::vector<uint8_t> isChild(nodes.size(), 0);
            for (size_t n = 0; n < nodes.size(); ++n) {
                const Json& ch = nodes[n]["children"];
                for (size_t c = 0; c < ch.size(); ++c) {
                    size_t ci = index(ch[c]);
                    if (ci < isChild.size()) isChild[ci] = 1;
                }
            }
            for (size_t n = 0; n < nodes.size(); ++n) if (!isChild[n]) visitNode(n, mat4Identity(), 0);
        } else {
            const Json& meshes = root_["meshes"];
            for (size_t m = 0; m < meshes.size(); ++m) appendMesh(meshes[m], mat4Identity());
        }
    }

    void visitNode(size_t nodeIndex, const Mat4& parent, int depth) {
        if (depth > 256) throw GlbFormatError("glTF node hierarchy too deep (cycle?)");
        // Children shared by several parents are instanced once per path; a small DAG can name
        // exponentially many paths, so the expansion is bounded as well as the depth.
        if (++instances_ > kMaxNodeInstances) {
            throw GlbFormatError("glTF scene graph expands to more than " + std::to_string(kMaxNodeInstances) +
                                 " node instances (shared children reached along too many paths)");
        }
        const Json& node = root_["nodes"][nodeIndex];
        if (node.isNull()) return;
        Mat4 world = mat4Mul(parent, nodeLocalMatrix(node));
        const Json& meshIdx = node["mesh"];
        if (!meshIdx.isNull()) appendMesh(root_["meshes"][index(meshIdx)], world);
        const Json& children = node["children"];
        for (size_t c = 0; c < children.size(); ++c) visitNode(index(children[c]), world, depth + 1);
    }

    /** Non-negative integer field, `def` when absent. */
    static uint64_t field(const Json& obj, const char* name, int64_t def) {
        int64_t v = obj[name].asInt(def);
        if (v < 0) throw GlbFormatError(std::string("glTF ") + name + " must not be negative");
        return static_cast<uint64_t>(v);
    }

    /**
     * Element `count` x `elemSize` bytes at `stride` from an accessor, checked against its
     * bufferView and the BIN chunk. All arithmetic is 64-bit with every term bounded first, so no
     * check can wrap.
     */
    const uint8_t* accessorData(const Json& acc, size_t elemSize, size_t& stride, size_t& count) {
        if (!acc["sparse"].isNull()) throw GlbFormatError("sparse glTF accessors are not supported");
        if (acc.type != Json::Object) throw GlbFormatError("glTF accessor index out of range");
        const Json& bvIdx = acc["bufferView"];
        if (bvIdx.isNull()) throw GlbFormatError("glTF accessor without bufferView is not supported");
        const Json& bv = root_["bufferViews"][index(bvIdx)];
        if (bv.type != Json::Object) throw GlbFormatError("glTF bufferView index out of range");
        if (field(bv, "buffer", 0) != 0 || !bin_) throw GlbFormatError("glTF buffer outside the GLB BIN chunk is not supported");
        if (bv["byteLength"].isNull()) throw GlbFormatError("glTF bufferView without byteLength");

        const uint64_t binLen = binLen_;
        const uint64_t viewOffset = field(bv, "byteOffset", 0);
        const uint64_t viewLength = field(bv, "byteLength", 0);
        if (viewOffset > binLen || viewLength > binLen - viewOffset) throw GlbFormatError("glTF bufferView out of BIN bounds");
        const uint64_t accOffset = field(acc, "byteOffset", 0);
        const uint64_t n = field(acc, "count", 0);
        uint64_t s = field(bv, "byteStride", 0);
        if (s == 0) s = elemSize;
        if (s < elemSize || s > 252) throw GlbFormatError("glTF byteStride must be between the element size and 252");
        if (accOffset > viewLength) throw GlbFormatError("glTF accessor byteOffset beyond its bufferView");
        if (n > 0) {
            // n <= viewLength / s + 1 bounds n before it is multiplied.
            const uint64_t room = viewLength - accOffset;
            if (room < elemSize || (n - 1) > (room - elemSize) / s) throw GlbFormatError("glTF accessor runs past the end of its bufferView");
        }
        stride = static_cast<size_t>(s);
        count = static_cast<size_t>(n);
        return bin_ + viewOffset + accOffset;
    }

    void appendMesh(const Json& mesh, const Mat4& world) {
        const Json& prims = mesh["primitives"];
        bool flip = mat4Det3(world) < 0;
        for (size_t p = 0; p < prims.size(); ++p) {
            const Json& prim = prims[p];
            int64_t mode = prim["mode"].asInt(4);
            // 4 triangles, 5 triangle strip, 6 triangle fan; points and lines have no surface.
            if (mode < 4 || mode > 6) { out_.skippedPrimitives++; continue; }
            const Json& posIdx = prim["attributes"]["POSITION"];
            if (posIdx.isNull()) { out_.skippedPrimitives++; continue; }
            const Json& posAcc = root_["accessors"][index(posIdx)];
            if (posAcc["componentType"].asInt(0) != 5126 || posAcc["type"].str != "VEC3") {
                throw GlbFormatError("glTF POSITION must be float32 VEC3");
            }
            size_t stride = 0, count = 0;
            const uint8_t* src = accessorData(posAcc, 12, stride, count);
            if (uint64_t(out_.positions.size()) + count > kMaxSourceVertices) {
                throw GlbFormatError("GLB scene has more than " + std::to_string(kMaxSourceVertices) + " vertices after instancing");
            }
            uint32_t base = static_cast<uint32_t>(out_.positions.size());
            for (size_t i = 0; i < count; ++i) {
                float v[3];
                std::memcpy(v, src + i * stride, 12);
                double x = world[0] * v[0] + world[4] * v[1] + world[8] * v[2] + world[12];
                double y = world[1] * v[0] + world[5] * v[1] + world[9] * v[2] + world[13];
                double z = world[2] * v[0] + world[6] * v[1] + world[10] * v[2] + world[14];
                out_.positions.emplace_back(static_cast<float>(x), static_cast<float>(y), static_cast<float>(z));
            }

            // Vertex sequence the primitive mode is applied to.
            std::vector<uint32_t> seq;
            const Json& idx = prim["indices"];
            if (idx.isNull()) {
                seq.resize(count);
                for (size_t i = 0; i < count; ++i) seq[i] = static_cast<uint32_t>(i);
            } else {
                const Json& ia = root_["accessors"][index(idx)];
                int64_t ct = ia["componentType"].asInt(0);
                size_t es = ct == 5121 ? 1 : ct == 5123 ? 2 : ct == 5125 ? 4 : 0;
                if (es == 0) throw GlbFormatError("glTF index componentType must be u8, u16 or u32");
                size_t istride = 0, icount = 0;
                const uint8_t* isrc = accessorData(ia, es, istride, icount);
                seq.resize(icount);
                for (size_t i = 0; i < icount; ++i) {
                    const uint8_t* e = isrc + i * istride;
                    uint32_t v = 0;
                    if (es == 1) v = e[0];
                    else if (es == 2) v = static_cast<uint32_t>(e[0]) | (static_cast<uint32_t>(e[1]) << 8);
                    else std::memcpy(&v, e, 4);
                    if (v >= count) throw GlbFormatError("glTF index out of range");
                    seq[i] = v;
                }
            }

            std::vector<uint32_t> tri;
            auto emit = [&](uint32_t a, uint32_t b, uint32_t c) {
                if (flip) std::swap(b, c);
                tri.push_back(base + a);
                tri.push_back(base + b);
                tri.push_back(base + c);
            };
            if (mode == 4) {
                tri.reserve(seq.size() / 3 * 3);
                for (size_t i = 0; i + 2 < seq.size(); i += 3) emit(seq[i], seq[i + 1], seq[i + 2]);
            } else if (mode == 5) {
                // glTF strip winding: odd triangles swap their first two vertices.
                for (size_t i = 0; i + 2 < seq.size(); ++i) {
                    if (i % 2 == 0) emit(seq[i], seq[i + 1], seq[i + 2]);
                    else emit(seq[i + 1], seq[i], seq[i + 2]);
                }
            } else {
                for (size_t i = 1; i + 1 < seq.size(); ++i) emit(seq[i], seq[i + 1], seq[0]);
            }
            if (uint64_t(out_.indices.size() + tri.size()) / 3 > kMaxSourceTriangles) {
                throw GlbFormatError("GLB scene has more than " + std::to_string(kMaxSourceTriangles) + " triangles after instancing");
            }
            out_.indices.insert(out_.indices.end(), tri.begin(), tri.end());
        }
    }
};

// ============================================================================
// Welded mesh
// ============================================================================

struct WeldedMesh {
    std::vector<F3> positions;   // relative to origin
    std::vector<F3> normals;
    std::vector<uint32_t> indices;
    std::array<double, 3> origin{0, 0, 0};
    F3 aabbMin, aabbMax;         // relative to origin
    uint32_t sourceTriangles{0};
    uint32_t droppedDegenerate{0};
};

inline WeldedMesh weld(const SourceMesh& src) {
    WeldedMesh out;
    out.sourceTriangles = static_cast<uint32_t>(src.indices.size() / 3);
    if (src.positions.empty() || src.indices.empty()) throw std::runtime_error("GLB contains no triangles");

    struct Key {
        uint32_t x, y, z;
        bool operator==(const Key& o) const { return x == o.x && y == o.y && z == o.z; }
    };
    struct KeyHash {
        size_t operator()(const Key& k) const {
            uint64_t h = k.x * 0x9E3779B97F4A7C15ull;
            h ^= (k.y + 0x7F4A7C15ull + (h << 6) + (h >> 2)) * 0xBF58476D1CE4E5B9ull;
            h ^= (k.z + 0x94D049BBull + (h << 6) + (h >> 2)) * 0x94D049BB133111EBull;
            return static_cast<size_t>(h ^ (h >> 31));
        }
    };
    auto bits = [](float f) {
        if (f == 0.0f) f = 0.0f; // fold -0 into +0
        uint32_t u;
        std::memcpy(&u, &f, 4);
        return u;
    };

    std::unordered_map<Key, uint32_t, KeyHash> map;
    map.reserve(src.positions.size());
    std::vector<uint32_t> remap(src.positions.size());
    std::vector<F3> welded;
    welded.reserve(src.positions.size());
    for (size_t i = 0; i < src.positions.size(); ++i) {
        const F3& p = src.positions[i];
        if (!std::isfinite(p.x) || !std::isfinite(p.y) || !std::isfinite(p.z)) throw std::runtime_error("GLB has non-finite vertex positions");
        Key k{bits(p.x), bits(p.y), bits(p.z)};
        auto it = map.find(k);
        if (it == map.end()) {
            uint32_t id = static_cast<uint32_t>(welded.size());
            map.emplace(k, id);
            welded.push_back(p);
            remap[i] = id;
        } else {
            remap[i] = it->second;
        }
    }

    F3 mn(std::numeric_limits<float>::max(), std::numeric_limits<float>::max(), std::numeric_limits<float>::max());
    F3 mx(-std::numeric_limits<float>::max(), -std::numeric_limits<float>::max(), -std::numeric_limits<float>::max());
    for (const F3& p : welded) { mn = fmin3(mn, p); mx = fmax3(mx, p); }
    out.origin = {0.5 * (double(mn.x) + mx.x), 0.5 * (double(mn.y) + mx.y), 0.5 * (double(mn.z) + mx.z)};

    out.positions.resize(welded.size());
    for (size_t i = 0; i < welded.size(); ++i) {
        out.positions[i] = F3(static_cast<float>(welded[i].x - out.origin[0]),
                              static_cast<float>(welded[i].y - out.origin[1]),
                              static_cast<float>(welded[i].z - out.origin[2]));
    }
    out.aabbMin = F3(static_cast<float>(mn.x - out.origin[0]), static_cast<float>(mn.y - out.origin[1]), static_cast<float>(mn.z - out.origin[2]));
    out.aabbMax = F3(static_cast<float>(mx.x - out.origin[0]), static_cast<float>(mx.y - out.origin[1]), static_cast<float>(mx.z - out.origin[2]));

    out.normals.assign(welded.size(), F3(0, 0, 0));
    out.indices.reserve(src.indices.size());
    for (size_t t = 0; t + 2 < src.indices.size(); t += 3) {
        uint32_t a = remap[src.indices[t]], b = remap[src.indices[t + 1]], c = remap[src.indices[t + 2]];
        if (a == b || b == c || a == c) { out.droppedDegenerate++; continue; }
        F3 n = cross(out.positions[b] - out.positions[a], out.positions[c] - out.positions[a]);
        if (dot(n, n) <= 0.0f) { out.droppedDegenerate++; continue; }
        out.indices.push_back(a);
        out.indices.push_back(b);
        out.indices.push_back(c);
        out.normals[a] += n;
        out.normals[b] += n;
        out.normals[c] += n;
    }
    for (F3& n : out.normals) {
        n = normalize(n);
        if (dot(n, n) == 0.0f) n = F3(0, 1, 0);
    }
    if (out.indices.empty()) throw std::runtime_error("GLB contains only degenerate triangles");
    return out;
}

// ============================================================================
// Uniform grid for nearest-unused-point queries
// ============================================================================

class PointGrid {
public:
    PointGrid(const std::vector<F3>& points, uint32_t targetPerCell = 4) : points_(points), alive_(points.size(), 1), aliveCount_(points.size()) {
        F3 mn(std::numeric_limits<float>::max(), std::numeric_limits<float>::max(), std::numeric_limits<float>::max());
        F3 mx = mn * -1.0f;
        for (const F3& p : points) { mn = fmin3(mn, p); mx = fmax3(mx, p); }
        min_ = mn;
        F3 ext = mx - mn;
        float vol = std::max(ext.x, 1e-6f) * std::max(ext.y, 1e-6f) * std::max(ext.z, 1e-6f);
        float cells = std::max(1.0f, static_cast<float>(points.size()) / targetPerCell);
        cell_ = std::max(std::cbrt(vol / cells), 1e-6f);
        for (int a = 0; a < 3; ++a) {
            float e = a == 0 ? ext.x : a == 1 ? ext.y : ext.z;
            dims_[a] = std::max(1, std::min(1024, static_cast<int>(std::floor(e / cell_)) + 1));
        }
        cells_.resize(static_cast<size_t>(dims_[0]) * static_cast<size_t>(dims_[1]) * static_cast<size_t>(dims_[2]));
        for (uint32_t i = 0; i < points.size(); ++i) cells_[cellIndex(points[i])].push_back(i);
    }

    void remove(uint32_t i) {
        if (alive_[i]) { alive_[i] = 0; aliveCount_--; }
    }
    size_t aliveCount() const { return aliveCount_; }

    // Nearest alive point to q within maxDist (infinite when maxDist < 0). Returns UINT32_MAX if none.
    uint32_t nearest(const F3& q, float maxDist = -1.0f) {
        if (aliveCount_ == 0) return UINT32_MAX;
        int c[3];
        coords(q, c);
        uint32_t best = UINT32_MAX;
        float bestD2 = std::numeric_limits<float>::max();
        int maxRing = std::max({dims_[0], dims_[1], dims_[2]});
        if (maxDist >= 0) maxRing = std::min(maxRing, static_cast<int>(std::ceil(maxDist / cell_)) + 1);
        for (int r = 0; r <= maxRing; ++r) {
            for (int x = c[0] - r; x <= c[0] + r; ++x) {
                if (x < 0 || x >= dims_[0]) continue;
                for (int y = c[1] - r; y <= c[1] + r; ++y) {
                    if (y < 0 || y >= dims_[1]) continue;
                    for (int z = c[2] - r; z <= c[2] + r; ++z) {
                        if (z < 0 || z >= dims_[2]) continue;
                        if (std::max({std::abs(x - c[0]), std::abs(y - c[1]), std::abs(z - c[2])}) != r) continue;
                        auto& list = cells_[(static_cast<size_t>(x) * static_cast<size_t>(dims_[1]) + static_cast<size_t>(y)) * static_cast<size_t>(dims_[2]) + static_cast<size_t>(z)];
                        for (size_t k = 0; k < list.size();) {
                            uint32_t idx = list[k];
                            if (!alive_[idx]) { list[k] = list.back(); list.pop_back(); continue; }
                            F3 d = points_[idx] - q;
                            float d2 = dot(d, d);
                            // Ties go to the lower index, so the answer does not depend on cell layout or list order.
                            if (d2 < bestD2 || (d2 == bestD2 && idx < best)) { bestD2 = d2; best = idx; }
                            ++k;
                        }
                    }
                }
            }
            // Any point in a ring beyond r is at least r * cell_ away (strict, so an equally near point
            // with a lower index further out is still found).
            if (best != UINT32_MAX && std::sqrt(bestD2) < static_cast<float>(r) * cell_) break;
        }
        if (best != UINT32_MAX && maxDist >= 0 && bestD2 > maxDist * maxDist) return UINT32_MAX;
        return best;
    }

private:
    const std::vector<F3>& points_;
    std::vector<uint8_t> alive_;
    size_t aliveCount_;
    F3 min_;
    float cell_{1};
    int dims_[3]{1, 1, 1};
    std::vector<std::vector<uint32_t>> cells_;

    void coords(const F3& p, int c[3]) const {
        F3 r = p - min_;
        float v[3] = {r.x, r.y, r.z};
        for (int a = 0; a < 3; ++a) c[a] = std::clamp(static_cast<int>(std::floor(v[a] / cell_)), 0, dims_[a] - 1);
    }
    size_t cellIndex(const F3& p) const {
        int c[3];
        coords(p, c);
        return (static_cast<size_t>(c[0]) * static_cast<size_t>(dims_[1]) + static_cast<size_t>(c[1])) * static_cast<size_t>(dims_[2]) + static_cast<size_t>(c[2]);
    }
};

// ============================================================================
// Clusters
// ============================================================================

struct Cluster {
    std::vector<uint32_t> vertices;     // global vertex ids
    std::vector<uint8_t> localTris;     // 3 local indices per triangle
    Sphere bounds;                      // culling sphere
    F3 coneAxis{0, 0, 1};
    float coneCutoff{1.0f};             // 1 = never cone-culled
    Sphere selfLod;
    float selfError{0};
    Sphere parentLod;
    float parentError{kRootParentError};
    uint32_t level{0};
    uint32_t group{0};

    uint32_t triangleCount() const { return static_cast<uint32_t>(localTris.size() / 3); }
    uint32_t globalIndex(size_t corner) const { return vertices[localTris[corner]]; }
};

inline void computeClusterBounds(Cluster& c, const WeldedMesh& mesh) {
    F3 mn(std::numeric_limits<float>::max(), std::numeric_limits<float>::max(), std::numeric_limits<float>::max());
    F3 mx = mn * -1.0f;
    for (uint32_t v : c.vertices) { mn = fmin3(mn, mesh.positions[v]); mx = fmax3(mx, mesh.positions[v]); }
    F3 center = (mn + mx) * 0.5f;
    float r = 0;
    for (uint32_t v : c.vertices) r = std::max(r, length(mesh.positions[v] - center));
    c.bounds = {center, r};

    // Normal cone (meshoptimizer convention): back-facing when
    //   dot(center - eye, axis) >= cutoff * |center - eye| + radius
    std::vector<F3> normals;
    normals.reserve(c.triangleCount());
    F3 sum;
    for (uint32_t t = 0; t < c.triangleCount(); ++t) {
        const F3& a = mesh.positions[c.globalIndex(t * 3)];
        const F3& b = mesh.positions[c.globalIndex(t * 3 + 1)];
        const F3& d = mesh.positions[c.globalIndex(t * 3 + 2)];
        F3 n = normalize(cross(b - a, d - a));
        normals.push_back(n);
        sum += n;
    }
    F3 axis = normalize(sum);
    float minDot = 1.0f;
    for (const F3& n : normals) minDot = std::min(minDot, dot(n, axis));
    c.coneAxis = dot(axis, axis) > 0 ? axis : F3(0, 0, 1);
    c.coneCutoff = (dot(axis, axis) == 0 || minDot <= 0.1f) ? 1.0f : std::sqrt(1.0f - minDot * minDot);
}

/**
 * Greedy spatially coherent clusterizer: grows each cluster across shared vertices, preferring
 * triangles that add the fewest new vertices and stay closest to the cluster centroid; when a
 * piece runs out of neighbours it absorbs the nearest unused triangle if it lies within the
 * cluster's own extent (so small disconnected pieces share clusters instead of making slivers).
 */
inline std::vector<Cluster> buildClusters(const std::vector<uint32_t>& tris, const WeldedMesh& mesh,
                                          uint32_t maxVerts = kMaxClusterVertices, uint32_t maxTris = kMaxClusterTriangles) {
    std::vector<Cluster> clusters;
    const uint32_t triCount = static_cast<uint32_t>(tris.size() / 3);
    if (triCount == 0) return clusters;

    // Compact vertex ids for this triangle set.
    std::unordered_map<uint32_t, uint32_t> toLocal;
    toLocal.reserve(tris.size());
    std::vector<uint32_t> localTri(tris.size());
    std::vector<uint32_t> localToGlobal;
    for (size_t i = 0; i < tris.size(); ++i) {
        auto it = toLocal.find(tris[i]);
        if (it == toLocal.end()) {
            uint32_t id = static_cast<uint32_t>(localToGlobal.size());
            toLocal.emplace(tris[i], id);
            localToGlobal.push_back(tris[i]);
            localTri[i] = id;
        } else {
            localTri[i] = it->second;
        }
    }
    const uint32_t vcount = static_cast<uint32_t>(localToGlobal.size());

    // vertex -> triangles (CSR)
    std::vector<uint32_t> start(vcount + 1, 0);
    for (uint32_t v : localTri) start[v + 1]++;
    for (uint32_t v = 0; v < vcount; ++v) start[v + 1] += start[v];
    std::vector<uint32_t> adj(localTri.size());
    {
        std::vector<uint32_t> fill(start.begin(), start.end() - 1);
        for (uint32_t t = 0; t < triCount; ++t) for (uint32_t k = 0; k < 3; ++k) adj[fill[localTri[t * 3 + k]]++] = t;
    }

    std::vector<F3> centroids(triCount);
    double edgeSum = 0;
    for (uint32_t t = 0; t < triCount; ++t) {
        const F3& a = mesh.positions[tris[t * 3]];
        const F3& b = mesh.positions[tris[t * 3 + 1]];
        const F3& c = mesh.positions[tris[t * 3 + 2]];
        centroids[t] = (a + b + c) * (1.0f / 3.0f);
        edgeSum += length(b - a) + length(c - b) + length(a - c);
    }
    const float meanEdge = static_cast<float>(edgeSum / (3.0 * triCount));

    PointGrid grid(centroids);
    std::vector<uint8_t> used(triCount, 0);
    std::vector<int32_t> slot(vcount, -1); // local vertex -> index in current cluster
    F3 lastCentroid = centroids[0];

    while (grid.aliveCount() > 0) {
        uint32_t seed = grid.nearest(lastCentroid);
        if (seed == UINT32_MAX) break;

        Cluster c;
        std::vector<uint32_t> clusterLocalVerts;
        std::vector<uint32_t> candidates;
        F3 centroidSum;
        uint32_t members = 0;
        F3 cmin(std::numeric_limits<float>::max(), std::numeric_limits<float>::max(), std::numeric_limits<float>::max());
        F3 cmax = cmin * -1.0f;

        auto addTri = [&](uint32_t t) {
            used[t] = 1;
            grid.remove(t);
            for (uint32_t k = 0; k < 3; ++k) {
                uint32_t v = localTri[t * 3 + k];
                if (slot[v] < 0) {
                    slot[v] = static_cast<int32_t>(clusterLocalVerts.size());
                    clusterLocalVerts.push_back(v);
                    for (uint32_t e = start[v]; e < start[v + 1]; ++e) if (!used[adj[e]]) candidates.push_back(adj[e]);
                }
                c.localTris.push_back(static_cast<uint8_t>(slot[v]));
            }
            centroidSum += centroids[t];
            members++;
            cmin = fmin3(cmin, centroids[t]);
            cmax = fmax3(cmax, centroids[t]);
        };
        auto newVerts = [&](uint32_t t) {
            uint32_t n = 0;
            for (uint32_t k = 0; k < 3; ++k) if (slot[localTri[t * 3 + k]] < 0) n++;
            return n;
        };

        addTri(seed);
        while (members < maxTris) {
            F3 centroid = centroidSum * (1.0f / members);
            float extent = std::max(length(cmax - cmin) * 0.5f, meanEdge);
            uint32_t best = UINT32_MAX;
            float bestScore = std::numeric_limits<float>::max();
            for (size_t k = 0; k < candidates.size();) {
                uint32_t t = candidates[k];
                if (used[t]) { candidates[k] = candidates.back(); candidates.pop_back(); continue; }
                uint32_t nv = newVerts(t);
                if (clusterLocalVerts.size() + nv <= maxVerts) {
                    float score = static_cast<float>(nv) + length(centroids[t] - centroid) / (extent + meanEdge);
                    if (score < bestScore) { bestScore = score; best = t; }
                }
                ++k;
            }
            if (best == UINT32_MAX) {
                if (clusterLocalVerts.size() + 3 > maxVerts) break;
                best = grid.nearest(centroid, std::max(extent, meanEdge * 2.0f));
                if (best == UINT32_MAX) break;
            }
            addTri(best);
        }

        for (uint32_t v : clusterLocalVerts) {
            c.vertices.push_back(localToGlobal[v]);
            slot[v] = -1;
        }
        computeClusterBounds(c, mesh);
        lastCentroid = centroidSum * (1.0f / members);
        clusters.push_back(std::move(c));
    }
    return clusters;
}

// ============================================================================
// Border-locked quadric edge-collapse simplifier (endpoint placement)
// ============================================================================

struct SimplifyResult {
    std::vector<uint32_t> tris;  // global vertex ids
    float error{0};              // max RMS plane distance (sqrt of normalized quadric cost) over performed collapses
};

class LockedSimplifier {
public:
    /**
     * Simplifies `tris` (global ids into mesh.positions) toward targetTris. Vertices with
     * locked(global) == true never move. Collapses only move a vertex onto an existing neighbour,
     * so output vertices are a subset of the input vertices.
     */
    template <typename LockedFn>
    static SimplifyResult simplify(const std::vector<uint32_t>& tris, const WeldedMesh& mesh, uint32_t targetTris, LockedFn locked) {
        LockedSimplifier s(tris, mesh);
        for (uint32_t v = 0; v < s.globalOf_.size(); ++v) s.locked_[v] = locked(s.globalOf_[v]) ? 1 : 0;
        s.run(targetTris);
        return s.result();
    }

private:
    struct Quadric {
        double a2{0}, ab{0}, ac{0}, ad{0}, b2{0}, bc{0}, bd{0}, c2{0}, cd{0}, d2{0}, w{0};
        void addPlane(double a, double b, double c, double d, double weight) {
            a2 += weight * a * a; ab += weight * a * b; ac += weight * a * c; ad += weight * a * d;
            b2 += weight * b * b; bc += weight * b * c; bd += weight * b * d;
            c2 += weight * c * c; cd += weight * c * d; d2 += weight * d * d;
            w += weight;
        }
        void add(const Quadric& q) {
            a2 += q.a2; ab += q.ab; ac += q.ac; ad += q.ad; b2 += q.b2; bc += q.bc; bd += q.bd; c2 += q.c2; cd += q.cd; d2 += q.d2;
            w += q.w;
        }
        // Weighted mean squared distance to the accumulated planes (area-weighted).
        double eval(const F3& p) const {
            double x = p.x, y = p.y, z = p.z;
            double r = a2 * x * x + 2 * ab * x * y + 2 * ac * x * z + 2 * ad * x
                     + b2 * y * y + 2 * bc * y * z + 2 * bd * y
                     + c2 * z * z + 2 * cd * z + d2;
            return r > 0 && w > 0 ? r / w : 0;
        }
    };
    struct Candidate {
        double cost;
        uint32_t from, to;      // local ids: `from` collapses onto `to`
        uint32_t vFrom, vTo;    // versions at push time
        // Total order: equal costs are broken by vertex ids, so the collapse sequence is the same with
        // every standard library's heap (libc++ and libstdc++ pop equal keys in different orders).
        bool operator>(const Candidate& o) const {
            if (cost != o.cost) return cost > o.cost;
            if (from != o.from) return from > o.from;
            if (to != o.to) return to > o.to;
            if (vFrom != o.vFrom) return vFrom > o.vFrom;
            return vTo > o.vTo;
        }
    };

    const WeldedMesh& mesh_;
    std::vector<uint32_t> globalOf_;
    std::vector<std::array<uint32_t, 3>> tri_;
    std::vector<uint8_t> triAlive_;
    std::vector<std::vector<uint32_t>> vtris_;
    std::vector<Quadric> q_;
    std::vector<uint8_t> locked_;
    std::vector<uint8_t> alive_;
    std::vector<uint32_t> version_;
    std::priority_queue<Candidate, std::vector<Candidate>, std::greater<Candidate>> heap_;
    uint32_t liveTris_{0};
    double maxCost_{0};

    LockedSimplifier(const std::vector<uint32_t>& tris, const WeldedMesh& mesh) : mesh_(mesh) {
        std::unordered_map<uint32_t, uint32_t> toLocal;
        toLocal.reserve(tris.size());
        auto local = [&](uint32_t g) {
            auto it = toLocal.find(g);
            if (it != toLocal.end()) return it->second;
            uint32_t id = static_cast<uint32_t>(globalOf_.size());
            toLocal.emplace(g, id);
            globalOf_.push_back(g);
            return id;
        };
        for (size_t i = 0; i + 2 < tris.size(); i += 3) tri_.push_back({local(tris[i]), local(tris[i + 1]), local(tris[i + 2])});
        size_t n = globalOf_.size();
        vtris_.resize(n);
        q_.resize(n);
        locked_.assign(n, 0);
        alive_.assign(n, 1);
        version_.assign(n, 0);
        triAlive_.assign(tri_.size(), 1);
        liveTris_ = static_cast<uint32_t>(tri_.size());

        // Edge use counts to find open borders inside the triangle set.
        std::unordered_map<uint64_t, uint32_t> edgeUse;
        edgeUse.reserve(tri_.size() * 3);
        auto key = [](uint32_t a, uint32_t b) { return a < b ? (uint64_t(a) << 32 | b) : (uint64_t(b) << 32 | a); };
        for (uint32_t t = 0; t < tri_.size(); ++t) {
            const auto& tr = tri_[t];
            for (uint32_t k = 0; k < 3; ++k) {
                vtris_[tr[k]].push_back(t);
                edgeUse[key(tr[k], tr[(k + 1) % 3])]++;
            }
            F3 p0 = pos(tr[0]), p1 = pos(tr[1]), p2 = pos(tr[2]);
            F3 cr = cross(p1 - p0, p2 - p0);
            double area = 0.5 * length(cr);
            F3 nrm = normalize(cr);
            double d = -dot(nrm, p0);
            for (uint32_t k = 0; k < 3; ++k) q_[tr[k]].addPlane(nrm.x, nrm.y, nrm.z, d, area);
        }
        // Open borders get a perpendicular constraint plane so they keep their outline.
        for (uint32_t t = 0; t < tri_.size(); ++t) {
            const auto& tr = tri_[t];
            F3 p0 = pos(tr[0]), p1 = pos(tr[1]), p2 = pos(tr[2]);
            F3 nrm = normalize(cross(p1 - p0, p2 - p0));
            for (uint32_t k = 0; k < 3; ++k) {
                uint32_t a = tr[k], b = tr[(k + 1) % 3];
                if (edgeUse[key(a, b)] != 1) continue;
                F3 e = pos(b) - pos(a);
                F3 bn = normalize(cross(e, nrm));
                double d = -dot(bn, pos(a));
                double w = 2.0 * dot(e, e);
                q_[a].addPlane(bn.x, bn.y, bn.z, d, w);
                q_[b].addPlane(bn.x, bn.y, bn.z, d, w);
            }
        }
    }

    F3 pos(uint32_t v) const { return mesh_.positions[globalOf_[v]]; }

    void pushEdge(uint32_t a, uint32_t b) {
        Quadric sum = q_[a];
        sum.add(q_[b]);
        if (!locked_[a]) heap_.push({sum.eval(pos(b)), a, b, version_[a], version_[b]});
        if (!locked_[b]) heap_.push({sum.eval(pos(a)), b, a, version_[b], version_[a]});
    }

    void neighbours(uint32_t v, std::vector<uint32_t>& out) {
        out.clear();
        auto& list = vtris_[v];
        for (size_t i = 0; i < list.size();) {
            uint32_t t = list[i];
            if (!triAlive_[t]) { list[i] = list.back(); list.pop_back(); continue; }
            for (uint32_t w : tri_[t]) if (w != v && std::find(out.begin(), out.end(), w) == out.end()) out.push_back(w);
            ++i;
        }
    }

    bool collapseIsValid(uint32_t from, uint32_t to) {
        // Link condition: common neighbours must be exactly the apexes of the triangles on the edge.
        std::vector<uint32_t> nf, nt;
        neighbours(from, nf);
        neighbours(to, nt);
        uint32_t common = 0;
        for (uint32_t w : nf) if (std::find(nt.begin(), nt.end(), w) != nt.end()) common++;
        uint32_t shared = 0;
        for (uint32_t t : vtris_[from]) {
            if (!triAlive_[t]) continue;
            const auto& tr = tri_[t];
            if (tr[0] == to || tr[1] == to || tr[2] == to) shared++;
        }
        if (shared == 0 || common != shared) return false;

        // No triangle around `from` may flip or collapse to a sliver.
        F3 target = pos(to);
        for (uint32_t t : vtris_[from]) {
            if (!triAlive_[t]) continue;
            const auto& tr = tri_[t];
            if (tr[0] == to || tr[1] == to || tr[2] == to) continue;
            F3 p[3], q[3];
            for (uint32_t k = 0; k < 3; ++k) { p[k] = pos(tr[k]); q[k] = tr[k] == from ? target : p[k]; }
            F3 n0 = cross(p[1] - p[0], p[2] - p[0]);
            F3 n1 = cross(q[1] - q[0], q[2] - q[0]);
            float l0 = length(n0), l1 = length(n1);
            if (l1 <= 1e-12f * std::max(l0, 1e-12f)) return false;
            if (dot(n0, n1) < 0.25f * l0 * l1) return false;
        }
        return true;
    }

    void run(uint32_t targetTris) {
        for (uint32_t t = 0; t < tri_.size(); ++t) {
            const auto& tr = tri_[t];
            for (uint32_t k = 0; k < 3; ++k) {
                pushEdge(tr[k], tr[(k + 1) % 3]);
            }
        }
        std::vector<uint32_t> nb;
        while (liveTris_ > targetTris && !heap_.empty()) {
            Candidate c = heap_.top();
            heap_.pop();
            if (!alive_[c.from] || !alive_[c.to]) continue;
            if (version_[c.from] != c.vFrom || version_[c.to] != c.vTo) continue;
            if (!collapseIsValid(c.from, c.to)) continue;

            for (uint32_t t : vtris_[c.from]) {
                if (!triAlive_[t]) continue;
                auto& tr = tri_[t];
                if (tr[0] == c.to || tr[1] == c.to || tr[2] == c.to) {
                    triAlive_[t] = 0;
                    liveTris_--;
                } else {
                    for (auto& w : tr) if (w == c.from) w = c.to;
                    vtris_[c.to].push_back(t);
                }
            }
            vtris_[c.from].clear();
            alive_[c.from] = 0;
            q_[c.to].add(q_[c.from]);
            version_[c.to]++;
            maxCost_ = std::max(maxCost_, c.cost);

            neighbours(c.to, nb);
            for (uint32_t w : nb) {
                version_[w]++;
            }
            for (uint32_t w : nb) {
                pushEdge(c.to, w);
                // Edges between neighbours changed cost too (their versions bumped): requeue them.
                std::vector<uint32_t> nw;
                neighbours(w, nw);
                for (uint32_t x : nw) if (x != c.to) pushEdge(w, x);
            }
        }
    }

    SimplifyResult result() const {
        SimplifyResult r;
        for (uint32_t t = 0; t < tri_.size(); ++t) {
            if (!triAlive_[t]) continue;
            for (uint32_t v : tri_[t]) r.tris.push_back(globalOf_[v]);
        }
        r.error = static_cast<float>(std::sqrt(maxCost_));
        return r;
    }
};

// ============================================================================
// Cluster LOD DAG
// ============================================================================

struct LevelStats {
    uint32_t level;
    uint32_t clusters;
    uint32_t triangles;
    uint32_t groups;
    uint32_t stuckGroups;
    float maxError;
};

struct ClusterDag {
    WeldedMesh mesh;
    std::vector<Cluster> clusters;
    std::vector<LevelStats> levels;
    uint32_t levelCount{0};
};

inline Sphere mergeSpheres(const std::vector<Sphere>& spheres) {
    F3 mn(std::numeric_limits<float>::max(), std::numeric_limits<float>::max(), std::numeric_limits<float>::max());
    F3 mx = mn * -1.0f;
    for (const Sphere& s : spheres) {
        F3 r(s.radius, s.radius, s.radius);
        mn = fmin3(mn, s.center - r);
        mx = fmax3(mx, s.center + r);
    }
    Sphere out{(mn + mx) * 0.5f, 0};
    for (const Sphere& s : spheres) out.radius = std::max(out.radius, length(s.center - out.center) + s.radius);
    return out;
}

/**
 * Partition cluster ids into groups of up to kGroupSize, growing each group across the clusters
 * it shares the most vertices with, falling back to the nearest ungrouped cluster in space.
 */
inline std::vector<std::vector<uint32_t>> partitionGroups(const std::vector<uint32_t>& ids, const std::vector<Cluster>& clusters) {
    std::unordered_map<uint32_t, std::vector<uint32_t>> vertexUsers; // global vertex -> positions in ids
    for (uint32_t i = 0; i < ids.size(); ++i) {
        for (uint32_t v : clusters[ids[i]].vertices) vertexUsers[v].push_back(i);
    }
    std::vector<std::vector<std::pair<uint32_t, uint32_t>>> neighbours(ids.size()); // (other, shared count)
    {
        std::vector<std::unordered_map<uint32_t, uint32_t>> counts(ids.size());
        for (const auto& kv : vertexUsers) {
            const auto& users = kv.second;
            if (users.size() < 2) continue;
            for (size_t a = 0; a < users.size(); ++a)
                for (size_t b = 0; b < users.size(); ++b)
                    if (a != b) counts[users[a]][users[b]]++;
        }
        for (size_t i = 0; i < ids.size(); ++i) neighbours[i].assign(counts[i].begin(), counts[i].end());
    }

    std::vector<F3> centers(ids.size());
    for (size_t i = 0; i < ids.size(); ++i) centers[i] = clusters[ids[i]].bounds.center;
    PointGrid grid(centers, 2);
    std::vector<uint8_t> grouped(ids.size(), 0);
    std::vector<std::vector<uint32_t>> groups;

    for (uint32_t seed = 0; seed < ids.size(); ++seed) {
        if (grouped[seed]) continue;
        std::vector<uint32_t> group{seed};
        grouped[seed] = 1;
        grid.remove(seed);
        std::unordered_map<uint32_t, uint32_t> frontier;
        auto absorb = [&](uint32_t m) { for (auto [o, w] : neighbours[m]) if (!grouped[o]) frontier[o] += w; };
        absorb(seed);
        while (group.size() < kGroupSize) {
            uint32_t best = UINT32_MAX, bestW = 0;
            for (auto [o, w] : frontier) {
                if (grouped[o]) continue;
                if (w > bestW || (w == bestW && o < best)) { best = o; bestW = w; }
            }
            if (best == UINT32_MAX) {
                F3 c;
                float r = 0;
                for (uint32_t m : group) c += centers[m];
                c = c * (1.0f / group.size());
                for (uint32_t m : group) r = std::max(r, length(centers[m] - c) + clusters[ids[m]].bounds.radius);
                best = grid.nearest(c, r * 2.0f);
                if (best == UINT32_MAX) break;
            }
            group.push_back(best);
            grouped[best] = 1;
            grid.remove(best);
            frontier.erase(best);
            absorb(best);
        }
        std::vector<uint32_t> out;
        for (uint32_t m : group) out.push_back(ids[m]);
        groups.push_back(std::move(out));
    }
    return groups;
}

inline ClusterDag buildClusterDag(WeldedMesh mesh, uint32_t maxLevels = 24) {
    ClusterDag dag;
    dag.mesh = std::move(mesh);
    const WeldedMesh& m = dag.mesh;

    dag.clusters = buildClusters(m.indices, m);
    std::vector<uint32_t> current(dag.clusters.size());
    for (uint32_t i = 0; i < current.size(); ++i) {
        Cluster& c = dag.clusters[i];
        c.level = 0;
        c.selfLod = c.bounds;
        c.selfError = 0;
        current[i] = i;
    }
    uint32_t level = 0;
    uint32_t nextGroupId = 0;

    auto levelTriangles = [&](const std::vector<uint32_t>& ids) {
        uint64_t n = 0;
        for (uint32_t id : ids) n += dag.clusters[id].triangleCount();
        return n;
    };

    while (current.size() > 1 && level + 1 < maxLevels) {
        auto groups = partitionGroups(current, dag.clusters);

        // A vertex is locked when clusters of more than one group use it.
        std::unordered_map<uint32_t, uint32_t> vertexGroup;
        std::unordered_map<uint32_t, uint8_t> shared;
        for (uint32_t g = 0; g < groups.size(); ++g) {
            for (uint32_t id : groups[g]) {
                for (uint32_t v : dag.clusters[id].vertices) {
                    auto it = vertexGroup.find(v);
                    if (it == vertexGroup.end()) vertexGroup.emplace(v, g);
                    else if (it->second != g) shared[v] = 1;
                }
            }
        }

        struct GroupResult {
            std::vector<uint32_t> members;
            Sphere sphere;
            float error;
            std::vector<Cluster> parents;
        };
        std::vector<GroupResult> results;
        LevelStats stats{level + 1, 0, 0, static_cast<uint32_t>(groups.size()), 0, 0};
        uint64_t nextTriangles = 0;
        for (const auto& group : groups) {
            std::vector<uint32_t> tris;
            std::vector<Sphere> spheres;
            float childError = 0;
            for (uint32_t id : group) {
                const Cluster& c = dag.clusters[id];
                for (size_t k = 0; k < c.localTris.size(); ++k) tris.push_back(c.globalIndex(k));
                spheres.push_back(c.selfLod);
                childError = std::max(childError, c.selfError);
            }
            const uint64_t groupTris = tris.size() / 3;
            SimplifyResult simp = LockedSimplifier::simplify(tris, m, static_cast<uint32_t>(groupTris / 2), [&](uint32_t v) { return shared.count(v) > 0; });

            std::vector<uint32_t> parentTris;
            float groupError = childError;
            if (uint64_t(simp.tris.size() / 3) > groupTris * 85 / 100) {
                // Locked borders left too little to remove: carry the group up unchanged so every
                // level still covers the whole surface (the next level groups it differently).
                parentTris = std::move(tris);
                stats.stuckGroups++;
            } else {
                parentTris = std::move(simp.tris);
                groupError = childError + simp.error;
            }
            GroupResult r{group, mergeSpheres(spheres), groupError, buildClusters(parentTris, m)};
            for (const auto& p : r.parents) nextTriangles += p.triangleCount();
            results.push_back(std::move(r));
        }

        // A level that removes almost nothing would only duplicate the one below: stop instead.
        if (!levelReducesEnough(nextTriangles, levelTriangles(current))) break;
        stats.triangles = static_cast<uint32_t>(nextTriangles);

        std::vector<uint32_t> next;
        for (auto& r : results) {
            uint32_t gid = nextGroupId++;
            for (uint32_t id : r.members) {
                dag.clusters[id].parentLod = r.sphere;
                dag.clusters[id].parentError = r.error;
                dag.clusters[id].group = gid;
            }
            for (auto& p : r.parents) {
                p.level = level + 1;
                p.selfLod = r.sphere;
                p.selfError = r.error;
                stats.maxError = std::max(stats.maxError, r.error);
                next.push_back(static_cast<uint32_t>(dag.clusters.size()));
                dag.clusters.push_back(std::move(p));
            }
        }
        stats.clusters = static_cast<uint32_t>(next.size());
        level++;
        dag.levels.push_back(stats);
        current = std::move(next);
    }
    for (uint32_t id : current) {
        dag.clusters[id].parentError = kRootParentError;
        dag.clusters[id].parentLod = dag.clusters[id].selfLod;
    }
    dag.levelCount = level + 1;
    return dag;
}

// ============================================================================
// .sbvg writer
// ============================================================================

struct SbvgSummary {
    uint32_t vertexCount{0};
    uint32_t clusterCount{0};
    uint64_t triangleCount{0};
    uint64_t leafTriangleCount{0};
    uint32_t levelCount{0};
    uint64_t fileBytes{0};
};

/** Element count or index stored in a 32-bit field; throws instead of wrapping. */
inline uint32_t sbvgU32(uint64_t v, const char* what) {
    if (v > UINT32_MAX) throw std::runtime_error(std::string("virtual geometry too large for the .sbvg format: ") + what + " exceeds 2^32");
    return static_cast<uint32_t>(v);
}

inline void putU64(uint32_t* w, uint64_t v) {
    w[0] = static_cast<uint32_t>(v & 0xFFFFFFFFull);
    w[1] = static_cast<uint32_t>(v >> 32);
}

inline SbvgSummary writeSbvg(const ClusterDag& dag, const std::string& path, uint32_t skippedPrimitives = 0) {
    const WeldedMesh& m = dag.mesh;
    std::vector<std::vector<uint32_t>> byLevel(dag.levelCount);
    for (uint32_t i = 0; i < dag.clusters.size(); ++i) byLevel[dag.clusters[i].level].push_back(i);

    std::vector<uint32_t> newIndex(m.positions.size(), UINT32_MAX);
    std::vector<uint32_t> words(kSbvgHeaderBytes / 4 + dag.levelCount * kSbvgLevelWords, 0);
    auto putF = [](std::vector<uint32_t>& w, size_t at, float f) { std::memcpy(&w[at], &f, 4); };

    SbvgSummary sum;
    uint64_t clusterBase = 0, vertexBase = 0, refBase = 0, triBase = 0;
    std::vector<uint32_t> body;
    size_t levelRow = 0;
    for (int lvl = static_cast<int>(dag.levelCount) - 1; lvl >= 0; --lvl, ++levelRow) {
        const auto& ids = byLevel[static_cast<size_t>(lvl)];
        while ((words.size() + body.size()) % 4) body.push_back(0); // 16-byte alignment
        size_t blockStart = words.size() + body.size();

        std::vector<uint32_t> clusterWords(ids.size() * kSbvgClusterWords, 0);
        std::vector<uint32_t> newVerts, refs, tris;
        for (size_t i = 0; i < ids.size(); ++i) {
            const Cluster& c = dag.clusters[ids[i]];
            uint32_t* w = &clusterWords[i * kSbvgClusterWords];
            w[0] = sbvgU32(refBase + refs.size(), "vertex reference count");
            w[1] = static_cast<uint32_t>(c.vertices.size());
            w[2] = sbvgU32(triBase + tris.size(), "triangle count");
            w[3] = c.triangleCount();
            w[4] = c.level;
            w[5] = c.group;
            float f[] = {c.bounds.center.x, c.bounds.center.y, c.bounds.center.z, c.bounds.radius,
                         c.coneAxis.x, c.coneAxis.y, c.coneAxis.z, c.coneCutoff,
                         c.selfLod.center.x, c.selfLod.center.y, c.selfLod.center.z, c.selfLod.radius, c.selfError};
            std::memcpy(w + 8, f, sizeof(f));
            float pf[] = {c.parentLod.center.x, c.parentLod.center.y, c.parentLod.center.z, c.parentLod.radius, c.parentError};
            std::memcpy(w + 24, pf, sizeof(pf));
            for (uint32_t v : c.vertices) {
                if (newIndex[v] == UINT32_MAX) {
                    newIndex[v] = sbvgU32(vertexBase + newVerts.size(), "vertex count");
                    newVerts.push_back(v);
                }
                refs.push_back(newIndex[v]);
            }
            for (size_t t = 0; t < c.localTris.size(); t += 3) {
                tris.push_back(uint32_t(c.localTris[t]) | (uint32_t(c.localTris[t + 1]) << 8) | (uint32_t(c.localTris[t + 2]) << 16));
            }
            sum.triangleCount += c.triangleCount();
            if (c.level == 0) sum.leafTriangleCount += c.triangleCount();
        }

        body.insert(body.end(), clusterWords.begin(), clusterWords.end());
        for (uint32_t v : newVerts) {
            const F3& p = m.positions[v];
            const F3& n = m.normals[v];
            float f[6] = {p.x, p.y, p.z, n.x, n.y, n.z};
            uint32_t u[6];
            std::memcpy(u, f, sizeof(f));
            body.insert(body.end(), u, u + 6);
        }
        body.insert(body.end(), refs.begin(), refs.end());
        body.insert(body.end(), tris.begin(), tris.end());
        size_t blockEnd = words.size() + body.size();

        uint32_t* row = &words[kSbvgHeaderBytes / 4 + levelRow * kSbvgLevelWords];
        row[0] = static_cast<uint32_t>(lvl);
        row[1] = sbvgU32(clusterBase, "cluster count");
        row[2] = sbvgU32(ids.size(), "cluster count");
        row[3] = sbvgU32(vertexBase, "vertex count");
        row[4] = sbvgU32(newVerts.size(), "vertex count");
        row[5] = sbvgU32(refBase, "vertex reference count");
        row[6] = sbvgU32(refs.size(), "vertex reference count");
        row[7] = sbvgU32(triBase, "triangle count");
        row[8] = sbvgU32(tris.size(), "triangle count");
        putU64(row + 9, uint64_t(blockStart) * 4);
        putU64(row + 11, uint64_t(blockEnd - blockStart) * 4);

        clusterBase += ids.size();
        vertexBase += newVerts.size();
        refBase += refs.size();
        triBase += tris.size();
    }

    words[0] = kSbvgMagic;
    words[1] = kSbvgVersion;
    words[2] = sbvgU32(uint64_t(words.size()) * 4, "header size");
    words[3] = dag.levelCount;
    words[4] = sbvgU32(vertexBase, "vertex count");
    words[5] = sbvgU32(clusterBase, "cluster count");
    words[6] = sbvgU32(refBase, "vertex reference count");
    words[7] = sbvgU32(triBase, "triangle count");
    words[8] = sbvgU32(sum.leafTriangleCount, "triangle count");
    words[9] = m.sourceTriangles;
    words[10] = kMaxClusterVertices;
    words[11] = kMaxClusterTriangles;
    putF(words, 12, m.aabbMin.x); putF(words, 13, m.aabbMin.y); putF(words, 14, m.aabbMin.z);
    putF(words, 15, m.aabbMax.x); putF(words, 16, m.aabbMax.y); putF(words, 17, m.aabbMax.z);
    std::memcpy(&words[18], m.origin.data(), 24);
    words[24] = skippedPrimitives;
    words[25] = m.droppedDegenerate;

    std::ofstream f(path, std::ios::binary);
    if (!f) throw std::runtime_error("cannot write " + path);
    f.write(reinterpret_cast<const char*>(words.data()), static_cast<std::streamsize>(words.size() * 4));
    f.write(reinterpret_cast<const char*>(body.data()), static_cast<std::streamsize>(body.size() * 4));
    if (!f) throw std::runtime_error("failed writing " + path);

    sum.vertexCount = static_cast<uint32_t>(vertexBase);
    sum.clusterCount = static_cast<uint32_t>(clusterBase);
    sum.levelCount = dag.levelCount;
    sum.fileBytes = (words.size() + body.size()) * 4ull;
    return sum;
}

} // namespace vgeo
} // namespace scratchbox

#endif // SCRATCHBOX_VIRTUAL_GEOMETRY_HPP
