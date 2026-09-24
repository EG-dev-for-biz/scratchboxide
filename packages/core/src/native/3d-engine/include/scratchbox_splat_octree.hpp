/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

#ifndef SCRATCHBOX_SPLAT_OCTREE_HPP
#define SCRATCHBOX_SPLAT_OCTREE_HPP

/**
 * Gaussian splats -> OGC 3D Tiles octree.
 *
 *  1. Morton (Z-order) sort of splat centres inside the root AABB, so that every octree node is a
 *     contiguous index range (no per-node copies; the tree is a set of [begin, end) ranges).
 *  2. Recursive split until a node holds <= leafCapacity splats or maxDepth is reached.
 *  3. Interior nodes get a simplified LOD: voxel-merge to a budget with sigma compensation, so a
 *     coarse tile still covers its footprint without gaps (REPLACE refinement).
 *  4. Each node is packed as a GLB whose single POINTS primitive uses KHR_gaussian_splatting with
 *     the KHR_gaussian_splatting_compression_spz_2 payload (spec-exact Niantic SPZ v2, see
 *     scratchbox_spz.hpp). Accessors carry counts/min/max only; the data lives in the SPZ blob.
 *
 * Coordinates are kept in the Scratchbox/Three.js frame (X east, Y up, Z south). The 3D Tiles
 * root transform emitted by the TypeScript service performs the Y-up -> Z-up / ENU -> ECEF change.
 */

#include "scratchbox_math.hpp"
#include "scratchbox_spz.hpp"
#include <vector>
#include <string>
#include <sstream>
#include <algorithm>
#include <numeric>
#include <unordered_map>
#include <cstdint>
#include <cmath>
#include <iomanip>

namespace scratchbox {
namespace splattiles {

using math::Vec3;
using math::Quat;
using spz::GaussianSplat;

struct Aabb {
    Vec3 min{ 1e30f,  1e30f,  1e30f};
    Vec3 max{-1e30f, -1e30f, -1e30f};
    void expand(const Vec3& p) {
        min = Vec3(std::min(min.x, p.x), std::min(min.y, p.y), std::min(min.z, p.z));
        max = Vec3(std::max(max.x, p.x), std::max(max.y, p.y), std::max(max.z, p.z));
    }
    Vec3 center() const { return (min + max) * 0.5f; }
    Vec3 size() const { return max - min; }
    float maxExtent() const { Vec3 s = size(); return std::max(s.x, std::max(s.y, s.z)); }
};

struct OctreeNode {
    int level{0};
    int x{0}, y{0}, z{0};            // tile coordinates at this level
    Aabb bounds;                     // spatial cell (exact octant of the root cube)
    Aabb contentBounds;              // tight AABB of the splats actually inside
    size_t begin{0}, end{0};         // range into the Morton-sorted index array
    std::vector<int> children;       // indices into OctreeBuilder::nodes
    std::vector<GaussianSplat> lod;  // simplified content for interior nodes (empty for leaves)
    float geometricError{0.0f};
    bool isLeaf() const { return children.empty(); }
    size_t count() const { return end - begin; }
};

struct OctreeOptions {
    int maxDepth{5};
    size_t leafCapacity{65536};
    size_t interiorBudget{32768};      // max splats kept in an interior LOD tile
    float geometricErrorScale{0.25f};  // geometricError = cellExtent * scale (metres of acceptable error)
};

class OctreeBuilder {
public:
    std::vector<OctreeNode> nodes;
    std::vector<uint32_t> order;   // Morton-sorted splat indices
    Aabb rootBounds;

    explicit OctreeBuilder(const std::vector<GaussianSplat>& splats, const OctreeOptions& opts = OctreeOptions())
        : splats_(splats), opts_(opts) {}

    void build() {
        const size_t n = splats_.size();
        nodes.clear();
        order.resize(n);
        std::iota(order.begin(), order.end(), 0u);
        if (n == 0) return;

        Aabb tight;
        for (const auto& s : splats_) tight.expand(s.position);
        // Cubic root cell so every octant is a cube (isotropic geometric error)
        float ext = std::max(1e-3f, tight.maxExtent()) * 1.0001f;
        Vec3 c = tight.center();
        rootBounds.min = c - Vec3(ext, ext, ext) * 0.5f;
        rootBounds.max = c + Vec3(ext, ext, ext) * 0.5f;

        // Morton keys at 21 bits per axis (63-bit key)
        std::vector<uint64_t> keys(n);
        const float inv = 2097151.0f / ext; // 2^21 - 1
        for (size_t i = 0; i < n; ++i) {
            Vec3 q = (splats_[i].position - rootBounds.min) * inv;
            keys[i] = morton3(clampU21(q.x), clampU21(q.y), clampU21(q.z));
        }
        std::sort(order.begin(), order.end(), [&](uint32_t a, uint32_t b) { return keys[a] < keys[b]; });

        OctreeNode root;
        root.level = 0;
        root.bounds = rootBounds;
        root.begin = 0; root.end = n;
        nodes.push_back(root);
        subdivide(0, keys);
        computeContentBoundsAndLod(0);
    }

    const GaussianSplat& splatAt(size_t sortedIndex) const { return splats_[order[sortedIndex]]; }

    /** Splats that a tile's GLB should contain: leaves carry their exact range, interiors carry the LOD. */
    std::vector<GaussianSplat> tileContent(int nodeIndex) const {
        const OctreeNode& node = nodes[nodeIndex];
        if (node.isLeaf()) {
            std::vector<GaussianSplat> out;
            out.reserve(node.count());
            for (size_t i = node.begin; i < node.end; ++i) out.push_back(splatAt(i));
            return out;
        }
        return node.lod;
    }

    /** Node tree as JSON (for tests and for the TypeScript tileset assembler). */
    std::string toJson() const {
        std::ostringstream ss;
        ss << std::setprecision(9);
        ss << "{\"root\":";
        writeNodeJson(ss, 0);
        ss << ",\"totalSplats\":" << splats_.size() << ",\"nodeCount\":" << nodes.size() << "}";
        return ss.str();
    }

private:
    const std::vector<GaussianSplat>& splats_;
    OctreeOptions opts_;

    static uint32_t clampU21(float v) {
        return static_cast<uint32_t>(std::clamp(v, 0.0f, 2097151.0f));
    }
    static uint64_t spread3(uint64_t v) {
        v &= 0x1fffff;
        v = (v | v << 32) & 0x1f00000000ffffULL;
        v = (v | v << 16) & 0x1f0000ff0000ffULL;
        v = (v | v << 8)  & 0x100f00f00f00f00fULL;
        v = (v | v << 4)  & 0x10c30c30c30c30c3ULL;
        v = (v | v << 2)  & 0x1249249249249249ULL;
        return v;
    }
    static uint64_t morton3(uint32_t x, uint32_t y, uint32_t z) {
        return spread3(x) | (spread3(y) << 1) | (spread3(z) << 2);
    }

    void subdivide(int nodeIndex, const std::vector<uint64_t>& keys) {
        // Copy scalars we need: nodes vector may reallocate while recursing
        const int level = nodes[nodeIndex].level;
        const size_t begin = nodes[nodeIndex].begin, end = nodes[nodeIndex].end;
        const Aabb bounds = nodes[nodeIndex].bounds;
        const int nx = nodes[nodeIndex].x, ny = nodes[nodeIndex].y, nz = nodes[nodeIndex].z;
        const float extent = bounds.maxExtent();

        nodes[nodeIndex].geometricError = std::max(1e-4f, extent * opts_.geometricErrorScale);

        if (end - begin <= opts_.leafCapacity || level >= opts_.maxDepth) {
            nodes[nodeIndex].geometricError = 0.0f; // leaf: content is exact
            if (level == 0) nodes[nodeIndex].geometricError = std::max(1e-4f, extent * opts_.geometricErrorScale);
            return;
        }

        // Octant of a Morton key at this level: 3 bits at position (20 - level) per axis
        const int shift = 3 * (20 - level);
        auto octantOf = [&](size_t sortedIdx) -> int {
            return static_cast<int>((keys[order[sortedIdx]] >> shift) & 0x7);
        };

        std::vector<int> childIdx;
        size_t cursor = begin;
        for (int oct = 0; oct < 8 && cursor < end; ++oct) {
            size_t runEnd = cursor;
            while (runEnd < end && octantOf(runEnd) == oct) ++runEnd;
            if (runEnd == cursor) continue;

            OctreeNode child;
            child.level = level + 1;
            child.x = nx * 2 + (oct & 1);
            child.y = ny * 2 + ((oct >> 1) & 1);
            child.z = nz * 2 + ((oct >> 2) & 1);
            Vec3 half = bounds.size() * 0.5f;
            child.bounds.min = bounds.min + Vec3(half.x * (oct & 1), half.y * ((oct >> 1) & 1), half.z * ((oct >> 2) & 1));
            child.bounds.max = child.bounds.min + half;
            child.begin = cursor; child.end = runEnd;
            nodes.push_back(child);
            childIdx.push_back(static_cast<int>(nodes.size() - 1));
            cursor = runEnd;
        }
        nodes[nodeIndex].children = childIdx;
        for (int ci : childIdx) subdivide(ci, keys);
    }

    void computeContentBoundsAndLod(int nodeIndex) {
        OctreeNode& node = nodes[nodeIndex];
        node.contentBounds = Aabb();
        for (size_t i = node.begin; i < node.end; ++i) {
            const auto& s = splatAt(i);
            float r = std::max(s.scale.x, std::max(s.scale.y, s.scale.z)) * 3.0f; // 3 sigma footprint
            node.contentBounds.expand(s.position - Vec3(r, r, r));
            node.contentBounds.expand(s.position + Vec3(r, r, r));
        }
        for (int ci : node.children) computeContentBoundsAndLod(ci);
        if (!node.isLeaf()) node.lod = simplify(node);
    }

    /**
     * Voxel-merge simplification for an interior node. The voxel size is chosen so the merged
     * count fits the budget; merged sigma is enlarged to cover the voxel (no gaps at coarse LOD).
     */
    std::vector<GaussianSplat> simplify(const OctreeNode& node) const {
        const size_t count = node.count();
        if (count <= opts_.interiorBudget) {
            std::vector<GaussianSplat> out; out.reserve(count);
            for (size_t i = node.begin; i < node.end; ++i) out.push_back(splatAt(i));
            return out;
        }
        // Target roughly one merged splat per occupied voxel, so voxel size ~ cbrt(volume / budget)
        Vec3 sz = node.contentBounds.size();
        float volume = std::max(1e-9f, sz.x * sz.y * sz.z);
        float voxel = std::cbrt(volume / static_cast<float>(opts_.interiorBudget));
        voxel = std::max(voxel, node.bounds.maxExtent() / 512.0f);

        struct Acc {
            Vec3 pos{0,0,0};
            Vec3 col{0,0,0};
            Vec3 scale{0,0,0};
            float opacity{0};
            float w{0};
            Quat rot{0,0,0,1};
            std::vector<float> sh;
        };
        std::unordered_map<uint64_t, Acc> grid;
        grid.reserve(opts_.interiorBudget * 2);
        const float inv = 1.0f / voxel;
        for (size_t i = node.begin; i < node.end; ++i) {
            const auto& s = splatAt(i);
            Vec3 q = (s.position - node.contentBounds.min) * inv;
            uint64_t key = (static_cast<uint64_t>(q.x) & 0x1fffff) | ((static_cast<uint64_t>(q.y) & 0x1fffff) << 21) | ((static_cast<uint64_t>(q.z) & 0x1fffff) << 42);
            Acc& a = grid[key];
            float w = std::max(0.01f, s.opacity);
            if (a.w == 0.0f) a.rot = s.rotation;
            a.pos = a.pos + s.position * w;
            a.col = a.col + s.color * w;
            a.scale = a.scale + s.scale * w;
            a.opacity = std::max(a.opacity, s.opacity);
            if (!s.sh.empty()) {
                if (a.sh.empty()) a.sh.resize(s.sh.size(), 0.0f);
                for (size_t k = 0; k < s.sh.size(); ++k) a.sh[k] += s.sh[k] * w;
            }
            a.w += w;
        }
        std::vector<GaussianSplat> out;
        out.reserve(grid.size());
        for (auto& [key, a] : grid) {
            float inw = 1.0f / a.w;
            GaussianSplat g;
            g.position = a.pos * inw;
            g.color = a.col * inw;
            Vec3 meanScale = a.scale * inw;
            // Cover the voxel: sigma >= voxel/3 keeps the 3-sigma footprint gap-free at this LOD
            float minSigma = voxel / 3.0f;
            g.scale = Vec3(std::max(meanScale.x, minSigma), std::max(meanScale.y, minSigma), std::max(meanScale.z * 0.5f, minSigma * 0.25f));
            g.rotation = a.rot;
            g.opacity = a.opacity;
            if (!a.sh.empty()) {
                g.sh.resize(a.sh.size());
                for (size_t k = 0; k < a.sh.size(); ++k) g.sh[k] = a.sh[k] * inw;
            }
            out.push_back(g);
        }
        return out;
    }

    void writeNodeJson(std::ostringstream& ss, int nodeIndex) const {
        const OctreeNode& n = nodes[nodeIndex];
        auto v3 = [&](const Vec3& v) { ss << "[" << v.x << "," << v.y << "," << v.z << "]"; };
        ss << "{\"level\":" << n.level << ",\"x\":" << n.x << ",\"y\":" << n.y << ",\"z\":" << n.z
           << ",\"min\":"; v3(n.bounds.min);
        ss << ",\"max\":"; v3(n.bounds.max);
        ss << ",\"contentMin\":"; v3(n.contentBounds.min);
        ss << ",\"contentMax\":"; v3(n.contentBounds.max);
        ss << ",\"geometricError\":" << n.geometricError
           << ",\"splatCount\":" << n.count()
           << ",\"leafSplatCount\":" << (n.isLeaf() ? n.count() : 0)
           << ",\"tileSplatCount\":" << (n.isLeaf() ? n.count() : n.lod.size())
           << ",\"uri\":\"tiles/" << n.level << "/" << n.x << "/" << n.y << "/" << n.z << ".glb\""
           << ",\"children\":[";
        for (size_t i = 0; i < n.children.size(); ++i) {
            if (i) ss << ",";
            writeNodeJson(ss, n.children[i]);
        }
        ss << "]}";
    }
};

// ============================================================================
// KHR_gaussian_splatting GLB tile writer (SPZ v2 compressed payload)
// ============================================================================

class SplatTileGlbWriter {
public:
    static std::vector<uint8_t> write(const std::vector<GaussianSplat>& splats, const std::string& generator = "scratchbox-splat-3dtiles", uint8_t shDegree = 0) {
        std::vector<uint8_t> spzBlob = spz::SpzCodec::encode(splats, spz::SpzCodec::DEFAULT_FRACTIONAL_BITS, shDegree);
        const size_t n = splats.size();

        Aabb pb;
        for (const auto& s : splats) pb.expand(s.position);
        if (n == 0) { pb.min = Vec3(0,0,0); pb.max = Vec3(0,0,0); }

        auto align4 = [](size_t v) { return (v + 3) & ~static_cast<size_t>(3); };
        size_t binLen = align4(spzBlob.size());
        std::vector<uint8_t> bin(binLen, 0);
        std::memcpy(bin.data(), spzBlob.data(), spzBlob.size());

        std::ostringstream js;
        js << std::setprecision(9);
        js << "{"
           << "\"asset\":{\"version\":\"2.0\",\"generator\":\"" << generator << "\"},"
           << "\"extensionsUsed\":[\"KHR_gaussian_splatting\",\"KHR_gaussian_splatting_compression_spz_2\"],"
           << "\"extensionsRequired\":[\"KHR_gaussian_splatting\",\"KHR_gaussian_splatting_compression_spz_2\"],"
           << "\"scene\":0,\"scenes\":[{\"nodes\":[0]}],"
           << "\"nodes\":[{\"mesh\":0,\"name\":\"GaussianSplats\"}],"
           << "\"meshes\":[{\"primitives\":[{"
           << "\"mode\":0,"
           << "\"attributes\":{\"POSITION\":0,\"COLOR_0\":1,\"KHR_gaussian_splatting:SCALE\":2,\"KHR_gaussian_splatting:ROTATION\":3,\"KHR_gaussian_splatting:OPACITY\":4";
        if (shDegree > 0) {
            js << ",\"KHR_gaussian_splatting:SPHERICAL_HARMONICS\":5";
        }
        js << "},"
           << "\"extensions\":{\"KHR_gaussian_splatting\":{\"kernel\":\"ellipse\",\"colorSpace\":\"srgb_rec709_display\","
           << "\"extensions\":{\"KHR_gaussian_splatting_compression_spz_2\":{\"bufferView\":0}}}}"
           << "}]}],"
           // Accessors describe the decoded data; no bufferView because it is reconstructed from SPZ
           << "\"accessors\":["
           << "{\"componentType\":5126,\"count\":" << n << ",\"type\":\"VEC3\",\"min\":[" << pb.min.x << "," << pb.min.y << "," << pb.min.z << "],\"max\":[" << pb.max.x << "," << pb.max.y << "," << pb.max.z << "]},"
           << "{\"componentType\":5121,\"normalized\":true,\"count\":" << n << ",\"type\":\"VEC4\"},"
           << "{\"componentType\":5126,\"count\":" << n << ",\"type\":\"VEC3\"},"
           << "{\"componentType\":5126,\"count\":" << n << ",\"type\":\"VEC4\"},"
           << "{\"componentType\":5126,\"count\":" << n << ",\"type\":\"SCALAR\"}";
        if (shDegree > 0) {
            size_t shDim = (shDegree == 1) ? 3 : (shDegree == 2) ? 8 : (shDegree == 3) ? 15 : 0;
            js << ",{\"componentType\":5126,\"count\":" << (n * shDim) << ",\"type\":\"VEC3\"}";
        }
        js << "],"
           << "\"bufferViews\":[{\"buffer\":0,\"byteOffset\":0,\"byteLength\":" << spzBlob.size() << "}],"
           << "\"buffers\":[{\"byteLength\":" << binLen << "}]"
           << "}";
        std::string json = js.str();
        size_t jsonLen = align4(json.size());
        json.resize(jsonLen, ' ');

        size_t total = 12 + 8 + jsonLen + 8 + binLen;
        std::vector<uint8_t> glb(total, 0);
        auto put32 = [&](size_t off, uint32_t v) { std::memcpy(glb.data() + off, &v, 4); };
        put32(0, 0x46546C67u); put32(4, 2u); put32(8, static_cast<uint32_t>(total));
        put32(12, static_cast<uint32_t>(jsonLen)); put32(16, 0x4E4F534Au);
        std::memcpy(glb.data() + 20, json.data(), jsonLen);
        put32(20 + jsonLen, static_cast<uint32_t>(binLen)); put32(24 + jsonLen, 0x004E4942u);
        std::memcpy(glb.data() + 28 + jsonLen, bin.data(), binLen);
        return glb;
    }
};

} // namespace splattiles
} // namespace scratchbox

#endif // SCRATCHBOX_SPLAT_OCTREE_HPP
