/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A sparse narrow-band signed distance field: the idea of a hashed tree of small dense blocks (Museth, "VDB: High-
 * resolution sparse volumes with dynamic topology", 2013), written here as our own code. Only blocks of 8^3 voxels that
 * hold a voxel within the band are stored, keyed in a hash by their block coordinate; a block wholly on one side of the
 * surface may be kept as a tile (its sign alone).
 *
 * From a triangle mesh (a scan, open or closed):
 *  - the unsigned distance of every voxel within the band to its nearest triangle, exact (closest point on triangle);
 *  - its sign from the mesh's generalised winding number (Jacobson et al. 2013, evaluated by the second-order
 *    tree WindingTree below): inside where the winding number is at least one half, so a scan with holes still gets a
 *    sensible inside. The winding number is constant along any segment no surface crosses, so it is evaluated rarely:
 *    voxels no surface can pass between (face neighbours whose distances sum to more than the voxel edge, or whose
 *    joining segment no triangle near them crosses, tested exactly) form groups,
 *    joined across blocks; a group takes the sign of a coarser field's voxel (the same build at 4x the voxel, recursively)
 *    whose exact distance proves no surface lies between them; only components no coarse voxel reaches (pockets thinner
 *    than the coarse grid) evaluate the winding number, at a few spread groups, and fall back group by group, then voxel
 *    by voxel, where those disagree.
 *
 * Morphology at a radius r (closing fills gaps and openings narrower than about 2r; opening removes parts thinner than
 * about 2r), both on the field itself:
 *  - closing: the outside distance carried out to r plus the band by closest-point propagation from the field's zero
 *    crossings (the solid's boundary; an open sheet that bounds nothing seeds nothing), each voxel keeping the surface
 *    point nearest it, handed on to its face neighbours, Danielsson-style, in parallel rounds over blocks), the field moved
 *    out by r, then the distance inside that dilated surface recomputed the same way from its own zero crossings and the
 *    surface moved back in by r;
 *  - opening: the same on the negated field.
 * A closing never ends above the original value and an opening never below it (a closing contains what it closes), so
 * a boundary the field could not measure (where the winding number crosses one half in mid-air over a hole) stays put.
 * New blocks are allocated only where the propagation reaches; blocks that end wholly outside the band become tiles.
 *
 * Values are metres, negative inside, clamped to +-band.
 */

#pragma once

#include "scratchbox_inner_core.hpp"
#include "scratchbox_thread_pool.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <limits>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

namespace scratchbox::sparse_field {

using Vec3 = inner_core::Vec3;
using inner_core::detail::Tri;

constexpr int kDim = 8;
constexpr int kVox = kDim * kDim * kDim;

inline int blockOf(int v) { return v >> 3; }  // arithmetic shift: floor division by 8, negatives included
inline int localIndex(int x, int y, int z) { return ((x & 7) << 6) | ((y & 7) << 3) | (z & 7); }
inline uint64_t blockKey(int bx, int by, int bz) {
    constexpr uint64_t m = (uint64_t(1) << 21) - 1;
    return ((uint64_t(bx + (1 << 20)) & m) << 42) | ((uint64_t(by + (1 << 20)) & m) << 21) | (uint64_t(bz + (1 << 20)) & m);
}

struct Block {
    int bx = 0, by = 0, bz = 0;
    std::array<float, kVox> v;
};

class SparseField {
public:
    double voxel = 0.05;
    /** World position of voxel (0, 0, 0)'s centre; voxel (x, y, z) sits at origin + (x, y, z) * voxel. */
    Vec3 origin{0, 0, 0};
    /** Values are clamped to +-band (metres). */
    float band = 0.15f;
    std::vector<Block> blocks;
    std::unordered_map<uint64_t, uint32_t> index;
    /** Blocks not stored whose sign is known: -1 inside, +1 outside. */
    std::unordered_map<uint64_t, int8_t> tiles;

    int find(int bx, int by, int bz) const {
        auto it = index.find(blockKey(bx, by, bz));
        return it == index.end() ? -1 : static_cast<int>(it->second);
    }
    /** The block, allocated (every voxel `fill`) when it is not stored yet. */
    uint32_t touch(int bx, int by, int bz, float fill) {
        const uint64_t k = blockKey(bx, by, bz);
        auto it = index.find(k);
        if (it != index.end()) return it->second;
        const uint32_t id = static_cast<uint32_t>(blocks.size());
        blocks.emplace_back();
        Block& b = blocks.back();
        b.bx = bx; b.by = by; b.bz = bz;
        b.v.fill(fill);
        index.emplace(k, id);
        tiles.erase(k);
        return id;
    }
    /** -1 or +1 for a tile, 0 when the block's sign is unknown (not stored, no tile). */
    int tileSign(int bx, int by, int bz) const {
        auto it = tiles.find(blockKey(bx, by, bz));
        return it == tiles.end() ? 0 : it->second;
    }
    /** The value at an integer voxel; `known` false where neither a block nor a tile covers it (then +band). */
    float at(int x, int y, int z, bool* known = nullptr) const {
        const int b = find(blockOf(x), blockOf(y), blockOf(z));
        if (b >= 0) { if (known) *known = true; return blocks[b].v[localIndex(x, y, z)]; }
        const int s = tileSign(blockOf(x), blockOf(y), blockOf(z));
        if (known) *known = s != 0;
        return s < 0 ? -band : band;
    }
    Vec3 centre(int x, int y, int z) const { return {origin[0] + x * voxel, origin[1] + y * voxel, origin[2] + z * voxel}; }
    /** Trilinear value at a world point; `known` false when any of its eight voxels is unknown. */
    float sample(const Vec3& p, bool* known = nullptr) const {
        const double fx = (p[0] - origin[0]) / voxel, fy = (p[1] - origin[1]) / voxel, fz = (p[2] - origin[2]) / voxel;
        const int x0 = static_cast<int>(std::floor(fx)), y0 = static_cast<int>(std::floor(fy)), z0 = static_cast<int>(std::floor(fz));
        const double tx = fx - x0, ty = fy - y0, tz = fz - z0;
        double s = 0;
        bool all = true;
        for (int c = 0; c < 8; ++c) {
            const int dx = c & 1, dy = (c >> 1) & 1, dz = (c >> 2) & 1;
            bool k = true;
            const float v = at(x0 + dx, y0 + dy, z0 + dz, &k);
            all = all && k;
            s += v * (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty) * (dz ? tz : 1 - tz);
        }
        if (known) *known = all;
        return static_cast<float>(s);
    }
    size_t memoryBytes() const {
        return blocks.capacity() * sizeof(Block) + index.size() * (sizeof(uint64_t) + sizeof(uint32_t) + 2 * sizeof(void*)) +
               tiles.size() * (sizeof(uint64_t) + 1 + 2 * sizeof(void*));
    }
    /** Voxels strictly inside the band. */
    size_t activeVoxels() const {
        size_t n = 0;
        for (const Block& b : blocks) for (float v : b.v) n += std::fabs(v) < band;
        return n;
    }
    void negate() {
        for (Block& b : blocks) for (float& v : b.v) v = -v;
        for (auto& t : tiles) t.second = static_cast<int8_t>(-t.second);
    }
    /** Blocks with no voxel inside the band become tiles of their sign. */
    size_t prune() {
        std::vector<Block> kept;
        kept.reserve(blocks.size());
        std::unordered_map<uint64_t, uint32_t> idx;
        idx.reserve(blocks.size());
        size_t dropped = 0;
        for (Block& b : blocks) {
            bool any = false;
            for (float v : b.v) if (std::fabs(v) < band) { any = true; break; }
            const uint64_t k = blockKey(b.bx, b.by, b.bz);
            if (!any) { tiles[k] = b.v[0] < 0 ? -1 : 1; ++dropped; continue; }
            idx.emplace(k, static_cast<uint32_t>(kept.size()));
            kept.push_back(std::move(b));
        }
        blocks.swap(kept);
        blocks.shrink_to_fit();
        index.swap(idx);
        return dropped;
    }

    /** Writes the field: "SBSF", version 1, voxel, origin, band, blocks (coordinates then values), tiles. */
    void save(const std::string& path) const {
        std::ofstream f(path, std::ios::binary);
        if (!f) throw std::runtime_error("cannot write " + path);
        const uint32_t magic = 0x46534253u, version = 1;
        const uint64_t nb = blocks.size(), nt = tiles.size();
        f.write(reinterpret_cast<const char*>(&magic), 4);
        f.write(reinterpret_cast<const char*>(&version), 4);
        f.write(reinterpret_cast<const char*>(&voxel), 8);
        f.write(reinterpret_cast<const char*>(origin.data()), 24);
        f.write(reinterpret_cast<const char*>(&band), 4);
        f.write(reinterpret_cast<const char*>(&nb), 8);
        for (const Block& b : blocks) {
            const int32_t c[3] = {b.bx, b.by, b.bz};
            f.write(reinterpret_cast<const char*>(c), 12);
            f.write(reinterpret_cast<const char*>(b.v.data()), sizeof(float) * kVox);
        }
        f.write(reinterpret_cast<const char*>(&nt), 8);
        for (const auto& t : tiles) {
            f.write(reinterpret_cast<const char*>(&t.first), 8);
            f.write(reinterpret_cast<const char*>(&t.second), 1);
        }
        if (!f) throw std::runtime_error("short write to " + path);
    }
    static SparseField load(const std::string& path) {
        std::ifstream f(path, std::ios::binary);
        if (!f) throw std::runtime_error("cannot read " + path);
        SparseField s;
        uint32_t magic = 0, version = 0;
        uint64_t nb = 0, nt = 0;
        f.read(reinterpret_cast<char*>(&magic), 4);
        f.read(reinterpret_cast<char*>(&version), 4);
        if (magic != 0x46534253u || version != 1) throw std::runtime_error(path + " is not a sparse field (SBSF v1)");
        f.read(reinterpret_cast<char*>(&s.voxel), 8);
        f.read(reinterpret_cast<char*>(s.origin.data()), 24);
        f.read(reinterpret_cast<char*>(&s.band), 4);
        f.read(reinterpret_cast<char*>(&nb), 8);
        s.blocks.resize(nb);
        s.index.reserve(nb);
        for (uint64_t i = 0; i < nb; ++i) {
            int32_t c[3];
            f.read(reinterpret_cast<char*>(c), 12);
            Block& b = s.blocks[i];
            b.bx = c[0]; b.by = c[1]; b.bz = c[2];
            f.read(reinterpret_cast<char*>(b.v.data()), sizeof(float) * kVox);
            s.index.emplace(blockKey(b.bx, b.by, b.bz), static_cast<uint32_t>(i));
        }
        f.read(reinterpret_cast<char*>(&nt), 8);
        for (uint64_t i = 0; i < nt; ++i) {
            uint64_t k = 0;
            int8_t sg = 0;
            f.read(reinterpret_cast<char*>(&k), 8);
            f.read(reinterpret_cast<char*>(&sg), 1);
            s.tiles.emplace(k, sg);
        }
        if (!f) throw std::runtime_error(path + " is truncated");
        return s;
    }
};

struct BuildOptions {
    double voxel = 0.05;
    /** Half width of the band, in voxels (at least 2). */
    int bandVoxels = 3;
    /** Opening ratio of the winding number's tree (a node is one second-order expansion beyond this times its radius). */
    double windingFarRatio = 2.0;
    /** Also give a tile sign to every unstored block face-adjacent to a stored one (one winding number each). */
    bool shellTiles = true;
    /**
     * Signs from a coarser field first: the mesh is voxelised at voxel x signGuideRatio (recursively, while that stays at
     * most signGuideMaxVoxel), and a fine voxel takes the sign of its nearest coarse voxel whenever that voxel's exact
     * distance to the mesh exceeds the distance between them (no surface can lie between the two). A group of fine
     * voxels with one such voxel needs no winding number of its own. signGuideRatio 0: no guide.
     */
    int signGuideRatio = 4;
    double signGuideMaxVoxel = 1.0;
    unsigned threads = 0;
};

struct BuildStats {
    size_t inputTriangles = 0, usedTriangles = 0;
    size_t blocks = 0, activeVoxels = 0, tiles = 0;
    /** splitGroups: joined components whose sampled signs disagreed (decided group by group instead). */
    size_t windingEvaluations = 0, signGroups = 0, splitGroups = 0;
    /** Groups signed by the coarser guide field (no winding number of their own); guide levels built. */
    size_t guidedGroups = 0, guideLevels = 0;
    size_t memoryBytes = 0;
    double msBin = 0, msDistance = 0, msSign = 0, msTiles = 0, msGuide = 0;
};

namespace detail {

inline double now() { return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count(); }

using inner_core::add;
using inner_core::cross;
using inner_core::dot;
using inner_core::len;
using inner_core::mul;
using inner_core::sub;

/** Separating-axis test of a triangle against an axis-aligned box (centre c, half extents h). */
inline bool triBox(const Vec3& c, const Vec3& h, const Vec3& A, const Vec3& B, const Vec3& C) {
    const Vec3 v0 = sub(A, c), v1 = sub(B, c), v2 = sub(C, c);
    for (int i = 0; i < 3; ++i) {
        const double lo = std::min({v0[i], v1[i], v2[i]}), hi = std::max({v0[i], v1[i], v2[i]});
        if (lo > h[i] || hi < -h[i]) return false;
    }
    const Vec3 e[3] = {sub(v1, v0), sub(v2, v1), sub(v0, v2)};
    const Vec3 n = cross(e[0], e[1]);
    if (std::fabs(dot(n, v0)) > h[0] * std::fabs(n[0]) + h[1] * std::fabs(n[1]) + h[2] * std::fabs(n[2])) return false;
    for (int i = 0; i < 3; ++i)
        for (int k = 0; k < 3; ++k) {
            Vec3 ax{0, 0, 0};
            Vec3 u{0, 0, 0};
            u[i] = 1;
            ax = cross(u, e[k]);
            const double p0 = dot(ax, v0), p1 = dot(ax, v1), p2 = dot(ax, v2);
            const double r = h[0] * std::fabs(ax[0]) + h[1] * std::fabs(ax[1]) + h[2] * std::fabs(ax[2]);
            if (std::min({p0, p1, p2}) > r || std::max({p0, p1, p2}) < -r) return false;
        }
    return true;
}

struct UnionFind {
    std::array<int16_t, kVox> p;
    UnionFind() { for (int i = 0; i < kVox; ++i) p[i] = static_cast<int16_t>(i); }
    int root(int a) { while (p[a] != a) { p[a] = p[p[a]]; a = p[a]; } return a; }
    void join(int a, int b) { a = root(a); b = root(b); if (a != b) p[std::max(a, b)] = static_cast<int16_t>(std::min(a, b)); }
};

/** Whether the segment p + t d, t in [0, 1], meets the closed triangle (Moller and Trumbore). */
inline bool segmentHitsTriangle(const Vec3& p, const Vec3& d, const Tri& T) {
    const Vec3 e1 = sub(T.b, T.a), e2 = sub(T.c, T.a);
    const Vec3 pv = cross(d, e2);
    const double det = dot(e1, pv);
    const double scale = len(e1) * len(e2) * len(d);
    if (std::fabs(det) <= 1e-12 * scale) return false;  // parallel: a segment in the triangle's plane does not change sides
    const double inv = 1.0 / det;
    const Vec3 tv = sub(p, T.a);
    const double u = dot(tv, pv) * inv;
    if (u < -1e-9 || u > 1 + 1e-9) return false;
    const Vec3 qv = cross(tv, e1);
    const double v = dot(d, qv) * inv;
    if (v < -1e-9 || u + v > 1 + 1e-9) return false;
    const double t = dot(e2, qv) * inv;
    return t >= -1e-9 && t <= 1 + 1e-9;
}

}  // namespace detail

/** The mesh's triangles as the field takes them (degenerate ones dropped). */
inline std::vector<Tri> trianglesOf(const float* pos, size_t vertexCount, const uint32_t* idx, size_t triangleCount) {
    std::vector<Tri> tris;
    tris.reserve(triangleCount);
    for (size_t t = 0; t < triangleCount; ++t) {
        const uint32_t a = idx[3 * t], b = idx[3 * t + 1], c = idx[3 * t + 2];
        if (a >= vertexCount || b >= vertexCount || c >= vertexCount) throw std::runtime_error("triangle index out of range");
        Tri T{{pos[3 * a], pos[3 * a + 1], pos[3 * a + 2]}, {pos[3 * b], pos[3 * b + 1], pos[3 * b + 2]}, {pos[3 * c], pos[3 * c + 1], pos[3 * c + 2]}};
        if (inner_core::len(inner_core::cross(inner_core::sub(T.b, T.a), inner_core::sub(T.c, T.a))) < 1e-12) continue;
        tris.push_back(T);
    }
    return tris;
}

/**
 * The generalised winding number of a triangle soup, by a Barnes-Hut tree with a second-order far field (the idea of
 * Barill, Dickson, Schmidt, Levin and Jacobson, "Fast Winding Numbers for Soups and Clouds", 2018, written here as our
 * own code). A node far from the query (beyond farRatio times its radius) contributes its expansion about its
 * area-weighted centre P: the dipole term r . N / |r|^3 (N the summed vector area) plus the next term J(r) : M, where
 * J = I / |r|^3 - 3 r r^T / |r|^5 is the derivative of r / |r|^3 and M = sum over triangles of a_t n_t (c_t - P)^T; near
 * leaves are summed exactly (van Oosterom and Strackee's solid angle). The second-order term lets a smaller opening
 * ratio keep the same accuracy. On 4,000 points within 0.3 m of the ESB scan's surfaces (109k triangles, interior floors
 * and 18 m triangles included), at opening ratio 2 it disagrees in sign with a ratio-4 evaluation at 8 points and takes
 * 96 us a point, against 58 points and 267 us for the first-order dipole alone.
 */
class WindingTree {
public:
    explicit WindingTree(const std::vector<Tri>& tris) : tris_(tris) {
        order_.resize(tris.size());
        for (uint32_t i = 0; i < order_.size(); ++i) order_[i] = i;
        cent_.resize(tris.size());
        for (size_t i = 0; i < tris.size(); ++i) cent_[i] = inner_core::mul(inner_core::add(inner_core::add(tris[i].a, tris[i].b), tris[i].c), 1.0 / 3);
        if (!tris.empty()) build(0, static_cast<uint32_t>(tris.size()));
    }
    const std::vector<Tri>& tris() const { return tris_; }

    double winding(const Vec3& q, double farRatio) const {
        if (nodes_.empty()) return 0;
        double sum = 0;
        uint32_t stack[256];
        int top = 0;
        stack[top++] = 0;
        while (top) {
            const Node& n = nodes_[stack[--top]];
            const double rx = n.P[0] - q[0], ry = n.P[1] - q[1], rz = n.P[2] - q[2];
            const double r2 = rx * rx + ry * ry + rz * rz;
            if (r2 > farRatio * farRatio * n.r * n.r) {
                const double rl = std::sqrt(r2), inv3 = 1.0 / (r2 * rl), inv5 = inv3 / r2;
                double s = (rx * n.N[0] + ry * n.N[1] + rz * n.N[2]) * inv3;
                // J : M with J = I / r^3 - 3 r r^T / r^5
                const double r[3] = {rx, ry, rz};
                double trM = n.M[0] + n.M[4] + n.M[8], rMr = 0;
                for (int i = 0; i < 3; ++i) for (int j = 0; j < 3; ++j) rMr += r[i] * n.M[3 * i + j] * r[j];
                s += trM * inv3 - 3 * rMr * inv5;
                sum += s;
            } else if (n.left == UINT32_MAX || top + 2 > 256) {
                for (uint32_t i = n.start; i < n.start + n.count; ++i) sum += inner_core::detail::solidAngle(q, tris_[order_[i]]);
            } else {
                stack[top++] = n.left;
                stack[top++] = n.right;
            }
        }
        return sum / (4 * M_PI);
    }

private:
    struct Node { Vec3 P, N; double M[9]; double r = 0; uint32_t left = UINT32_MAX, right = UINT32_MAX, start = 0, count = 0; };

    uint32_t build(uint32_t start, uint32_t count) {
        const uint32_t id = static_cast<uint32_t>(nodes_.size());
        nodes_.emplace_back();
        Node n;
        n.start = start; n.count = count;
        Vec3 lo{1e300, 1e300, 1e300}, hi{-1e300, -1e300, -1e300}, P{0, 0, 0};
        n.N = {0, 0, 0};
        double area = 0;
        for (uint32_t i = start; i < start + count; ++i) {
            const Tri& t = tris_[order_[i]];
            for (const Vec3* v : {&t.a, &t.b, &t.c}) for (int k = 0; k < 3; ++k) { lo[k] = std::min(lo[k], (*v)[k]); hi[k] = std::max(hi[k], (*v)[k]); }
            const Vec3 va = inner_core::mul(inner_core::cross(inner_core::sub(t.b, t.a), inner_core::sub(t.c, t.a)), 0.5);
            const double a = inner_core::len(va);
            n.N = inner_core::add(n.N, va);
            P = inner_core::add(P, inner_core::mul(cent_[order_[i]], a));
            area += a;
        }
        n.P = area > 0 ? inner_core::mul(P, 1.0 / area) : inner_core::mul(inner_core::add(lo, hi), 0.5);
        for (double& m : n.M) m = 0;
        for (uint32_t i = start; i < start + count; ++i) {
            const Tri& t = tris_[order_[i]];
            const Vec3 va = inner_core::mul(inner_core::cross(inner_core::sub(t.b, t.a), inner_core::sub(t.c, t.a)), 0.5);
            const Vec3 d = inner_core::sub(cent_[order_[i]], n.P);
            for (int a = 0; a < 3; ++a) for (int b = 0; b < 3; ++b) n.M[3 * a + b] += va[a] * d[b];
        }
        // radius: the farthest triangle corner from P (a bound on every expansion point's distance)
        for (int c = 0; c < 8; ++c) {
            const Vec3 corner = {(c & 1) ? hi[0] : lo[0], (c & 2) ? hi[1] : lo[1], (c & 4) ? hi[2] : lo[2]};
            n.r = std::max(n.r, inner_core::len(inner_core::sub(corner, n.P)));
        }
        if (count > 8) {
            int axis = 0;
            Vec3 clo{1e300, 1e300, 1e300}, chi{-1e300, -1e300, -1e300};
            for (uint32_t i = start; i < start + count; ++i) for (int k = 0; k < 3; ++k) { clo[k] = std::min(clo[k], cent_[order_[i]][k]); chi[k] = std::max(chi[k], cent_[order_[i]][k]); }
            for (int k = 1; k < 3; ++k) if (chi[k] - clo[k] > chi[axis] - clo[axis]) axis = k;
            const uint32_t mid = start + count / 2;
            std::nth_element(order_.begin() + start, order_.begin() + mid, order_.begin() + start + count, [&](uint32_t x, uint32_t y) { return cent_[x][axis] < cent_[y][axis]; });
            n.left = build(start, mid - start);
            n.right = build(mid, start + count - mid);
        }
        nodes_[id] = n;
        return id;
    }
    std::vector<Tri> tris_;
    std::vector<uint32_t> order_;
    std::vector<Vec3> cent_;
    std::vector<Node> nodes_;
};

/** A mesh with what the field needs from it: its triangles, their winding-number tree and a nearest-triangle search. */
struct MeshSource {
    std::vector<Tri> tris;
    std::unique_ptr<WindingTree> wtree;
    std::unique_ptr<inner_core::detail::Bvh> bvh;  // nearest-triangle queries (dual contouring's normals)
    double farRatio = 2.0;
    explicit MeshSource(std::vector<Tri> t, double far = 2.0) : tris(std::move(t)), farRatio(far) {
        wtree = std::make_unique<WindingTree>(tris);
        bvh = std::make_unique<inner_core::detail::Bvh>(tris);
    }
    double winding(const Vec3& q) const { return wtree->winding(q, farRatio); }
    bool inside(const Vec3& q) const { return winding(q) >= 0.5; }
};

/** One level of build() below: the band at o.voxel, signed with the help of `guide` (a coarser field) when given. */
inline SparseField buildLevel(const MeshSource& src, const BuildOptions& o, FixedThreadPool& pool, BuildStats* stats, const SparseField* guide) {
    using namespace detail;
    if (!(o.voxel > 0)) throw std::runtime_error("voxel size must be positive");
    const int W = std::max(2, o.bandVoxels);
    SparseField F;
    F.voxel = o.voxel;
    F.band = static_cast<float>(W * o.voxel);
    BuildStats st;
    st.usedTriangles = src.tris.size();
    const double h = o.voxel, bandM = W * h;
    const auto& tris = src.tris;

    // 1. Bin each triangle to the blocks whose box, grown by the band, it touches (large triangles split until their
    //    block range is small, so a long diagonal wall does not test its whole bounding box).
    double t0 = now();
    const unsigned nth = std::max(1u, pool.size());
    std::vector<std::vector<std::pair<uint64_t, uint32_t>>> local(nth);
    std::atomic<size_t> nextChunk{0};
    const size_t chunk = 2048, chunks = (tris.size() + chunk - 1) / chunk;
    const Vec3 halfBlock = {(kDim * 0.5 + W + 0.5) * h, (kDim * 0.5 + W + 0.5) * h, (kDim * 0.5 + W + 0.5) * h};
    pool.forEach(nth, [&](size_t w) {
        auto& out = local[w];
        struct Job { Vec3 a, b, c; int depth; };
        std::vector<Job> stack;
        for (size_t ci; (ci = nextChunk.fetch_add(1)) < chunks;) {
            for (size_t t = ci * chunk; t < std::min(tris.size(), (ci + 1) * chunk); ++t) {
                stack.push_back({tris[t].a, tris[t].b, tris[t].c, 0});
                while (!stack.empty()) {
                    const Job j = stack.back();
                    stack.pop_back();
                    int lo[3], hi[3];
                    long long count = 1;
                    for (int k = 0; k < 3; ++k) {
                        const double mn = std::min({j.a[k], j.b[k], j.c[k]}), mx = std::max({j.a[k], j.b[k], j.c[k]});
                        lo[k] = blockOf(static_cast<int>(std::floor((mn - bandM - F.origin[k]) / h)) - 1);
                        hi[k] = blockOf(static_cast<int>(std::ceil((mx + bandM - F.origin[k]) / h)) + 1);
                        count *= (hi[k] - lo[k] + 1);
                    }
                    if (count > 64 && j.depth < 14) {
                        const Vec3 ab = mul(add(j.a, j.b), 0.5), bc = mul(add(j.b, j.c), 0.5), ca = mul(add(j.c, j.a), 0.5);
                        stack.push_back({j.a, ab, ca, j.depth + 1});
                        stack.push_back({ab, j.b, bc, j.depth + 1});
                        stack.push_back({ca, bc, j.c, j.depth + 1});
                        stack.push_back({ab, bc, ca, j.depth + 1});
                        continue;
                    }
                    for (int bx = lo[0]; bx <= hi[0]; ++bx)
                        for (int by = lo[1]; by <= hi[1]; ++by)
                            for (int bz = lo[2]; bz <= hi[2]; ++bz) {
                                const Vec3 c = {F.origin[0] + (bx * kDim + 3.5) * h, F.origin[1] + (by * kDim + 3.5) * h, F.origin[2] + (bz * kDim + 3.5) * h};
                                if (triBox(c, halfBlock, j.a, j.b, j.c)) out.emplace_back(blockKey(bx, by, bz), static_cast<uint32_t>(t));
                            }
                }
            }
        }
    });
    size_t total = 0;
    for (auto& l : local) total += l.size();
    std::vector<std::pair<uint64_t, uint32_t>> pairs;
    pairs.reserve(total);
    for (auto& l : local) { pairs.insert(pairs.end(), l.begin(), l.end()); std::vector<std::pair<uint64_t, uint32_t>>().swap(l); }
    std::sort(pairs.begin(), pairs.end());
    pairs.erase(std::unique(pairs.begin(), pairs.end()), pairs.end());
    std::vector<size_t> starts;
    for (size_t i = 0; i < pairs.size(); ++i) if (i == 0 || pairs[i].first != pairs[i - 1].first) starts.push_back(i);
    starts.push_back(pairs.size());
    const size_t nb = starts.size() - 1;
    st.msBin = now() - t0;

    // 2. Exact unsigned distance of every voxel within the band, per block in parallel.
    t0 = now();
    std::vector<Block> blocks(nb);
    std::vector<uint8_t> keep(nb, 0);
    pool.forEach(nb, [&](size_t i) {
        Block& B = blocks[i];
        const uint64_t key = pairs[starts[i]].first;
        constexpr uint64_t m = (uint64_t(1) << 21) - 1;
        B.bx = static_cast<int>((key >> 42) & m) - (1 << 20);
        B.by = static_cast<int>((key >> 21) & m) - (1 << 20);
        B.bz = static_cast<int>(key & m) - (1 << 20);
        B.v.fill(F.band);
        const int X0 = B.bx * kDim, Y0 = B.by * kDim, Z0 = B.bz * kDim;
        for (size_t p = starts[i]; p < starts[i + 1]; ++p) {
            const uint32_t t = pairs[p].second;
            const Tri& T = tris[t];
            int lo[3], hi[3];
            const int base[3] = {X0, Y0, Z0};
            bool empty = false;
            for (int k = 0; k < 3; ++k) {
                const double mn = std::min({T.a[k], T.b[k], T.c[k]}), mx = std::max({T.a[k], T.b[k], T.c[k]});
                lo[k] = std::max(base[k], static_cast<int>(std::floor((mn - bandM - F.origin[k]) / h)));
                hi[k] = std::min(base[k] + kDim - 1, static_cast<int>(std::ceil((mx + bandM - F.origin[k]) / h)));
                if (lo[k] > hi[k]) empty = true;
            }
            if (empty) continue;
            for (int x = lo[0]; x <= hi[0]; ++x)
                for (int y = lo[1]; y <= hi[1]; ++y)
                    for (int z = lo[2]; z <= hi[2]; ++z) {
                        const Vec3 q = F.centre(x, y, z);
                        const Vec3 cp = inner_core::detail::closestOnTriangle(q, T);
                        const double d = len(sub(q, cp));
                        const int li = localIndex(x, y, z);
                        if (d < B.v[li]) B.v[li] = static_cast<float>(d);
                    }
        }
        for (float v : B.v) if (v < F.band) { keep[i] = 1; break; }
    });
    st.msDistance = now() - t0;

    // 3. Signs. Voxels no surface passes between (face neighbours whose distances sum to more than the voxel edge) are
    //    grouped within each block, the groups joined across block faces the same way, and each joined component's sign
    //    taken from the winding number at several of its groups spread through it. A component whose samples disagree
    //    (it leaks through a hole wider than a voxel) falls back to each group's own winding number, checked at up to
    //    three voxels, and a group whose checks disagree to every voxel's own.
    t0 = now();
    std::atomic<size_t> evals{0}, splits{0};
    std::vector<uint64_t> keys(nb);
    for (size_t i = 0; i < nb; ++i) keys[i] = pairs[starts[i]].first;
    std::vector<std::array<uint16_t, kVox>> groupOf(nb);   // a voxel's group within its block
    std::vector<uint32_t> groupBase(nb + 1, 0);            // global id of a block's first group
    std::vector<std::array<int16_t, kVox>> bestOf(nb);     // per local group: its voxel farthest from any surface
    std::vector<uint16_t> groupCount(nb, 0);
    // whether no triangle binned to block i crosses the segment p-q (the two voxels then share a winding number)
    auto clearSegment = [&](size_t i, const Vec3& p, const Vec3& q) {
        const Vec3 d = sub(q, p);
        const double lo[3] = {std::min(p[0], q[0]), std::min(p[1], q[1]), std::min(p[2], q[2])}, hi[3] = {std::max(p[0], q[0]), std::max(p[1], q[1]), std::max(p[2], q[2])};
        for (size_t k = starts[i]; k < starts[i + 1]; ++k) {
            const Tri& T = tris[pairs[k].second];
            bool apart = false;
            for (int c = 0; c < 3 && !apart; ++c) apart = std::max({T.a[c], T.b[c], T.c[c]}) < lo[c] || std::min({T.a[c], T.b[c], T.c[c]}) > hi[c];
            if (apart) continue;
            if (segmentHitsTriangle(p, d, T)) return false;
        }
        return true;
    };
    pool.forEach(nb, [&](size_t i) {
        if (!keep[i]) return;
        const Block& B = blocks[i];
        UnionFind uf;
        const int X0 = B.bx * kDim, Y0 = B.by * kDim, Z0 = B.bz * kDim;
        for (int x = 0; x < kDim; ++x)
            for (int y = 0; y < kDim; ++y)
                for (int z = 0; z < kDim; ++z) {
                    const int a = (x << 6) | (y << 3) | z;
                    const Vec3 pa = F.centre(X0 + x, Y0 + y, Z0 + z);
                    if (x + 1 < kDim && (B.v[a] + B.v[a + 64] > h * 1.0001 || clearSegment(i, pa, F.centre(X0 + x + 1, Y0 + y, Z0 + z)))) uf.join(a, a + 64);
                    if (y + 1 < kDim && (B.v[a] + B.v[a + 8] > h * 1.0001 || clearSegment(i, pa, F.centre(X0 + x, Y0 + y + 1, Z0 + z)))) uf.join(a, a + 8);
                    if (z + 1 < kDim && (B.v[a] + B.v[a + 1] > h * 1.0001 || clearSegment(i, pa, F.centre(X0 + x, Y0 + y, Z0 + z + 1)))) uf.join(a, a + 1);
                }
        std::array<int16_t, kVox> lid;
        lid.fill(-1);
        uint16_t n = 0;
        bestOf[i].fill(-1);
        for (int a = 0; a < kVox; ++a) {
            const int r = uf.root(a);
            if (lid[r] < 0) lid[r] = static_cast<int16_t>(n++);
            const int g = lid[r];
            groupOf[i][a] = static_cast<uint16_t>(g);
            if (bestOf[i][g] < 0 || B.v[a] > B.v[bestOf[i][g]]) bestOf[i][g] = static_cast<int16_t>(a);
        }
        groupCount[i] = n;
    });
    for (size_t i = 0; i < nb; ++i) groupBase[i + 1] = groupBase[i] + groupCount[i];
    const uint32_t G = groupBase[nb];
    std::vector<uint32_t> gp(G);
    for (uint32_t g = 0; g < G; ++g) gp[g] = g;
    auto groot = [&](uint32_t a) { while (gp[a] != a) { gp[a] = gp[gp[a]]; a = gp[a]; } return a; };
    auto gjoin = [&](uint32_t a, uint32_t b) { a = groot(a); b = groot(b); if (a != b) gp[std::max(a, b)] = std::min(a, b); };
    for (size_t i = 0; i < nb; ++i) {
        if (!keep[i]) continue;
        const Block& B = blocks[i];
        for (int axis = 0; axis < 3; ++axis) {
            const uint64_t nk = blockKey(B.bx + (axis == 0), B.by + (axis == 1), B.bz + (axis == 2));
            const auto it = std::lower_bound(keys.begin(), keys.end(), nk);
            if (it == keys.end() || *it != nk) continue;
            const size_t j = static_cast<size_t>(it - keys.begin());
            if (!keep[j]) continue;
            const Block& N = blocks[j];
            for (int u = 0; u < kDim; ++u)
                for (int w = 0; w < kDim; ++w) {
                    const int a = axis == 0 ? ((7 << 6) | (u << 3) | w) : axis == 1 ? ((u << 6) | (7 << 3) | w) : ((u << 6) | (w << 3) | 7);
                    const int b = axis == 0 ? ((u << 3) | w) : axis == 1 ? ((u << 6) | w) : ((u << 6) | (w << 3));
                    if (B.v[a] + N.v[b] > h * 1.0001) { gjoin(groupBase[i] + groupOf[i][a], groupBase[j] + groupOf[j][b]); continue; }
                    const int ax = B.bx * kDim + (a >> 6), ay = B.by * kDim + ((a >> 3) & 7), az = B.bz * kDim + (a & 7);
                    if (clearSegment(i, F.centre(ax, ay, az), F.centre(ax + (axis == 0), ay + (axis == 1), az + (axis == 2))))
                        gjoin(groupBase[i] + groupOf[i][a], groupBase[j] + groupOf[j][b]);
                }
        }
    }
    // members of each joined component
    std::vector<uint32_t> compOf(G), compStart, members(G);
    {
        std::vector<uint32_t> rootId(G, UINT32_MAX);
        uint32_t nc = 0;
        for (uint32_t g = 0; g < G; ++g) { const uint32_t r = groot(g); if (rootId[r] == UINT32_MAX) rootId[r] = nc++; compOf[g] = rootId[r]; }
        compStart.assign(nc + 1, 0);
        for (uint32_t g = 0; g < G; ++g) ++compStart[compOf[g] + 1];
        for (uint32_t c = 0; c < nc; ++c) compStart[c + 1] += compStart[c];
        std::vector<uint32_t> fill(compStart.begin(), compStart.end() - 1);
        for (uint32_t g = 0; g < G; ++g) members[fill[compOf[g]]++] = g;
    }
    std::vector<uint32_t> blockOfGroup(G);
    for (size_t i = 0; i < nb; ++i) for (uint32_t g = groupBase[i]; g < groupBase[i + 1]; ++g) blockOfGroup[g] = static_cast<uint32_t>(i);
    std::vector<int8_t> groupSign(G, 0);  // -1 / +1, or 2 for "per voxel"
    // signs the coarser guide field proves (see BuildOptions::signGuideRatio)
    std::vector<int8_t> guided(G, 0);
    if (guide) {
        pool.forEach(nb, [&](size_t i) {
            if (!keep[i]) return;
            const Block& B = blocks[i];
            for (int a = 0; a < kVox; ++a) {
                const uint32_t g = groupBase[i] + groupOf[i][a];
                if (guided[g]) continue;
                const Vec3 p = F.centre(B.bx * kDim + (a >> 6), B.by * kDim + ((a >> 3) & 7), B.bz * kDim + (a & 7));
                // any of the eight coarse voxels around p whose distance to the mesh exceeds its distance to p
                const int cx = static_cast<int>(std::floor((p[0] - guide->origin[0]) / guide->voxel)), cy = static_cast<int>(std::floor((p[1] - guide->origin[1]) / guide->voxel)),
                          cz = static_cast<int>(std::floor((p[2] - guide->origin[2]) / guide->voxel));
                for (int c = 0; c < 8 && !guided[g]; ++c) {
                    const int x = cx + (c & 1), y = cy + ((c >> 1) & 1), z = cz + ((c >> 2) & 1);
                    bool known = true;
                    const float v = guide->at(x, y, z, &known);
                    if (known && std::fabs(v) > len(sub(p, guide->centre(x, y, z))) + 1e-9) guided[g] = v < 0 ? -1 : 1;
                }
            }
        });
        for (int8_t gs : guided) st.guidedGroups += gs != 0;
    }
    auto voxelInside = [&](size_t i, int a) {
        evals.fetch_add(1, std::memory_order_relaxed);
        const Block& B = blocks[i];
        return src.inside(F.centre(B.bx * kDim + (a >> 6), B.by * kDim + ((a >> 3) & 7), B.bz * kDim + (a & 7)));
    };
    const size_t ncomp = compStart.size() - 1;
    pool.forEach(ncomp, [&](size_t c) {
        const uint32_t s = compStart[c], e = compStart[c + 1], n = e - s;
        if (guide) {
            int dec = 0;
            bool conflict = false;
            for (uint32_t m = s; m < e && !conflict; ++m) {
                const int d = guided[members[m]];
                if (d) { if (!dec) dec = d; else if (d != dec) conflict = true; }
            }
            if (dec && !conflict) { for (uint32_t m = s; m < e; ++m) groupSign[members[m]] = static_cast<int8_t>(dec); return; }
            if (conflict) {
                // the component leaks through a hole: its proven groups keep their sign, the rest are decided one by one
                splits.fetch_add(1, std::memory_order_relaxed);
                for (uint32_t m = s; m < e; ++m) groupSign[members[m]] = guided[members[m]] ? guided[members[m]] : 2;
                return;
            }
        }
        const uint32_t k = std::min<uint32_t>(n, 1 + static_cast<uint32_t>(std::ceil(std::log2(static_cast<double>(n) + 1))));
        int votes = 0;
        bool agree = true;
        for (uint32_t q = 0; q < k && agree; ++q) {
            const uint32_t g = members[s + static_cast<uint32_t>((static_cast<uint64_t>(q) * n) / k)];
            const size_t i = blockOfGroup[g];
            const int in = voxelInside(i, bestOf[i][g - groupBase[i]]) ? -1 : 1;
            if (votes == 0) votes = in; else if (votes != in) agree = false;
        }
        if (agree) { for (uint32_t m = s; m < e; ++m) groupSign[members[m]] = static_cast<int8_t>(votes); return; }
        splits.fetch_add(1, std::memory_order_relaxed);
        for (uint32_t m = s; m < e; ++m) groupSign[members[m]] = 2;  // decided per group below
    });
    pool.forEach(nb, [&](size_t i) {
        if (!keep[i]) return;
        Block& B = blocks[i];
        const uint32_t base = groupBase[i];
        std::array<int8_t, kVox> local{};
        bool anyFallback = false;
        for (uint16_t g = 0; g < groupCount[i]; ++g) if (groupSign[base + g] == 2) { anyFallback = true; break; }
        std::array<int16_t, kVox> first, last;
        if (anyFallback) {
            first.fill(-1); last.fill(-1);
            for (int a = 0; a < kVox; ++a) { const int g = groupOf[i][a]; if (first[g] < 0) first[g] = static_cast<int16_t>(a); last[g] = static_cast<int16_t>(a); }
            for (uint16_t g = 0; g < groupCount[i]; ++g) {
                if (groupSign[base + g] != 2) { local[g] = groupSign[base + g]; continue; }
                const bool in = voxelInside(i, bestOf[i][g]);
                bool ok = true;
                if (first[g] != bestOf[i][g] && voxelInside(i, first[g]) != in) ok = false;
                if (ok && last[g] != bestOf[i][g] && last[g] != first[g] && voxelInside(i, last[g]) != in) ok = false;
                local[g] = ok ? (in ? -1 : 1) : 0;  // 0: every voxel its own
            }
        } else {
            for (uint16_t g = 0; g < groupCount[i]; ++g) local[g] = groupSign[base + g];
        }
        for (int a = 0; a < kVox; ++a) {
            int sg = local[groupOf[i][a]];
            if (sg == 0) sg = voxelInside(i, a) ? -1 : 1;
            if (sg < 0) B.v[a] = -B.v[a];
        }
    });
    st.windingEvaluations = evals.load();
    st.signGroups = G;
    st.splitGroups = splits.load();
    st.msSign = now() - t0;

    F.blocks.reserve(std::count(keep.begin(), keep.end(), 1));
    for (size_t i = 0; i < nb; ++i) {
        if (!keep[i]) continue;
        F.index.emplace(blockKey(blocks[i].bx, blocks[i].by, blocks[i].bz), static_cast<uint32_t>(F.blocks.size()));
        F.blocks.push_back(std::move(blocks[i]));
    }

    // 4. A tile sign for each unstored block beside a stored one (the winding number at its centre).
    t0 = now();
    if (o.shellTiles) {
        std::vector<uint64_t> cand;
        std::vector<std::array<int, 3>> coords;
        for (const Block& b : F.blocks) {
            const int d[6][3] = {{1, 0, 0}, {-1, 0, 0}, {0, 1, 0}, {0, -1, 0}, {0, 0, 1}, {0, 0, -1}};
            for (auto& dd : d) {
                const int x = b.bx + dd[0], y = b.by + dd[1], z = b.bz + dd[2];
                if (F.find(x, y, z) >= 0) continue;
                cand.push_back(blockKey(x, y, z));
                coords.push_back({x, y, z});
            }
        }
        std::vector<size_t> order(cand.size());
        for (size_t i = 0; i < order.size(); ++i) order[i] = i;
        std::sort(order.begin(), order.end(), [&](size_t a, size_t b) { return cand[a] < cand[b]; });
        std::vector<std::array<int, 3>> uniq;
        for (size_t i = 0; i < order.size(); ++i) if (i == 0 || cand[order[i]] != cand[order[i - 1]]) uniq.push_back(coords[order[i]]);
        std::vector<int8_t> sg(uniq.size());
        pool.forEach(uniq.size(), [&](size_t i) {
            const auto& c = uniq[i];
            sg[i] = src.inside(F.centre(c[0] * kDim + 4, c[1] * kDim + 4, c[2] * kDim + 4)) ? -1 : 1;
        });
        st.windingEvaluations += uniq.size();
        for (size_t i = 0; i < uniq.size(); ++i) F.tiles.emplace(blockKey(uniq[i][0], uniq[i][1], uniq[i][2]), sg[i]);
    }
    st.msTiles = now() - t0;
    st.inputTriangles = src.tris.size();
    st.blocks = F.blocks.size();
    st.tiles = F.tiles.size();
    st.activeVoxels = F.activeVoxels();
    st.memoryBytes = F.memoryBytes();
    if (stats) *stats = st;
    return F;
}

/** Builds the narrow band of `src` (see the file comment), with the coarser sign guides BuildOptions asks for. */
inline SparseField build(const MeshSource& src, const BuildOptions& o, FixedThreadPool& pool, BuildStats* stats = nullptr) {
    const double t0 = detail::now();
    std::unique_ptr<SparseField> guide;
    size_t levels = 0;
    size_t guideEvals = 0;
    if (o.signGuideRatio >= 2 && o.voxel * o.signGuideRatio <= o.signGuideMaxVoxel) {
        BuildOptions g = o;
        g.voxel = o.voxel * o.signGuideRatio;
        BuildStats gs;
        guide = std::make_unique<SparseField>(build(src, g, pool, &gs));
        levels = gs.guideLevels + 1;
        guideEvals = gs.windingEvaluations;
    }
    const double msGuide = detail::now() - t0;
    BuildStats st;
    SparseField F = buildLevel(src, o, pool, &st, guide.get());
    st.guideLevels = levels;
    st.msGuide = msGuide;
    st.windingEvaluations += guideEvals;
    if (stats) *stats = st;
    return F;
}

struct MorphStats {
    size_t seeds = 0, reached = 0, blocksAdded = 0, blocksPruned = 0, peakBlocks = 0, rounds = 0;
    size_t peakMemoryBytes = 0;
    double msDilate = 0, msRedistance = 0;
};

namespace detail {

/**
 * Seeds of a closest-point propagation: a table of surface points, and per stored block the index of each voxel's
 * nearest seed so far (UINT32_MAX for none). One 32-bit index a voxel, so a neighbour read while another thread writes
 * sees either the old seed or the new one, never a torn point.
 */
struct Seeds {
    std::vector<std::array<float, 3>> points;
    std::vector<std::array<uint32_t, kVox>> id;
    void grow(size_t n) {
        while (id.size() < n) { id.emplace_back(); id.back().fill(UINT32_MAX); }
    }
    size_t bytes() const { return points.capacity() * sizeof(points[0]) + id.capacity() * sizeof(id[0]); }
    double dist(uint32_t s, const Vec3& c) const {
        const auto& p = points[s];
        const double dx = c[0] - p[0], dy = c[1] - p[1], dz = c[2] - p[2];
        return std::sqrt(dx * dx + dy * dy + dz * dz);
    }
};

inline Vec3 voxelCentre(const SparseField& F, uint32_t b, int a) {
    const Block& B = F.blocks[b];
    return F.centre(B.bx * kDim + (a >> 6), B.by * kDim + ((a >> 3) & 7), B.bz * kDim + (a & 7));
}

/** Gives each stored block's listed voxels their seed points (per block lists of (voxel, point), built in parallel). */
inline size_t addSeeds(Seeds& S, std::vector<std::vector<std::pair<uint16_t, std::array<float, 3>>>>& perBlock) {
    size_t n = 0;
    for (uint32_t b = 0; b < perBlock.size(); ++b) {
        for (const auto& [a, p] : perBlock[b]) {
            S.id[b][a] = static_cast<uint32_t>(S.points.size());
            S.points.push_back(p);
            ++n;
        }
        std::vector<std::pair<uint16_t, std::array<float, 3>>>().swap(perBlock[b]);
    }
    return n;
}

/**
 * Closest-point propagation over the voxels of one side (sign `side` of the field), out to maxDist: every voxel ends
 * holding the nearest of the seeds its face neighbours hold (Danielsson-style vector propagation). Done as parallel
 * rounds over blocks: in each round every block that changed, and its face neighbours, relax their voxels against
 * their neighbours' seeds (a few sweeps within the block); unstored blocks beside a block within reach are allocated
 * as that side between rounds (a block no surface is near lies wholly on one side; a tile of the other side is never
 * entered). Returns the voxels holding a seed.
 */
inline size_t propagate(SparseField& F, Seeds& S, int side, double maxDist, MorphStats& ms, FixedThreadPool& pool) {
    const float fill = side > 0 ? F.band : -F.band;
    S.grow(F.blocks.size());
    std::vector<uint8_t> active(F.blocks.size(), 0);
    for (uint32_t b = 0; b < F.blocks.size(); ++b)
        for (int a = 0; a < kVox; ++a) if (S.id[b][a] != UINT32_MAX) { active[b] = 1; break; }
    static const int nbr[6][3] = {{1, 0, 0}, {-1, 0, 0}, {0, 1, 0}, {0, -1, 0}, {0, 0, 1}, {0, 0, -1}};
    for (;;) {
        // 1. The working set: changed blocks and their neighbours, allocating neighbours a changed block may reach.
        std::vector<uint32_t> list;
        std::vector<uint8_t> inList(F.blocks.size(), 0);
        const size_t nActive = active.size();
        std::vector<double> minD(nActive, std::numeric_limits<double>::infinity());
        pool.forEach(nActive, [&](size_t b) {
            if (!active[b]) return;
            double m = std::numeric_limits<double>::infinity();
            for (int a = 0; a < kVox; ++a) if (S.id[b][a] != UINT32_MAX) m = std::min(m, S.dist(S.id[b][a], voxelCentre(F, static_cast<uint32_t>(b), a)));
            minD[b] = m;
        });
        const double reachBlock = maxDist + F.voxel * kDim;
        for (uint32_t b = 0; b < nActive; ++b) {
            if (!active[b]) continue;
            if (!inList[b]) { inList[b] = 1; list.push_back(b); }
            if (minD[b] > reachBlock) continue;
            const int bx = F.blocks[b].bx, by = F.blocks[b].by, bz = F.blocks[b].bz;
            for (const auto& o : nbr) {
                int nb = F.find(bx + o[0], by + o[1], bz + o[2]);
                if (nb < 0) {
                    const int ts = F.tileSign(bx + o[0], by + o[1], bz + o[2]);
                    if (ts != 0 && ts != side) continue;
                    nb = static_cast<int>(F.touch(bx + o[0], by + o[1], bz + o[2], fill));
                    S.grow(F.blocks.size());
                    inList.resize(F.blocks.size(), 0);
                    ++ms.blocksAdded;
                }
                if (!inList[nb]) { inList[nb] = 1; list.push_back(static_cast<uint32_t>(nb)); }
            }
        }
        if (list.empty()) break;
        // 2. Relax the working set in parallel (no block is allocated meanwhile, so the index is read-only).
        std::vector<uint8_t> changed(F.blocks.size(), 0);
        pool.forEach(list.size(), [&](size_t li) {
            const uint32_t b = list[li];
            const Block& B = F.blocks[b];
            int nbIdx[6];
            for (int k = 0; k < 6; ++k) nbIdx[k] = F.find(B.bx + nbr[k][0], B.by + nbr[k][1], B.bz + nbr[k][2]);
            auto& ids = S.id[b];
            bool any = false;
            for (int sweep = 0; sweep < 4; ++sweep) {
                bool moved = false;
                for (int ii = 0; ii < kVox; ++ii) {
                    const int a = (sweep & 1) ? kVox - 1 - ii : ii;
                    if ((B.v[a] < 0 ? -1 : 1) != side) continue;
                    const int lx = a >> 6, ly = (a >> 3) & 7, lz = a & 7;
                    const Vec3 c = F.centre(B.bx * kDim + lx, B.by * kDim + ly, B.bz * kDim + lz);
                    uint32_t cur = ids[a];
                    double curD = cur == UINT32_MAX ? std::numeric_limits<double>::infinity() : S.dist(cur, c);
                    for (int k = 0; k < 6; ++k) {
                        const int nx = lx + nbr[k][0], ny = ly + nbr[k][1], nz = lz + nbr[k][2];
                        uint32_t sid;
                        if (nx >= 0 && nx < kDim && ny >= 0 && ny < kDim && nz >= 0 && nz < kDim) sid = ids[(nx << 6) | (ny << 3) | nz];
                        else {
                            if (nbIdx[k] < 0) continue;
                            sid = __atomic_load_n(&S.id[nbIdx[k]][localIndex(nx, ny, nz)], __ATOMIC_RELAXED);
                        }
                        if (sid == UINT32_MAX || sid == cur) continue;
                        const double d = S.dist(sid, c);
                        if (d < curD && d <= maxDist) { cur = sid; curD = d; }
                    }
                    if (cur != ids[a]) { __atomic_store_n(&ids[a], cur, __ATOMIC_RELAXED); moved = true; }
                }
                any = any || moved;
                if (!moved) break;
            }
            changed[b] = any ? 1 : 0;
        });
        active.assign(changed.begin(), changed.end());
        ++ms.rounds;
    }
    size_t reached = 0;
    for (uint32_t b = 0; b < F.blocks.size(); ++b)
        for (int a = 0; a < kVox; ++a) reached += S.id[b][a] != UINT32_MAX;
    ms.peakBlocks = std::max(ms.peakBlocks, F.blocks.size());
    ms.peakMemoryBytes = std::max(ms.peakMemoryBytes, F.memoryBytes() + S.bytes());
    return reached;
}

/** Seeds every voxel of `side` that has a face neighbour on the other side with the nearest zero crossing between them. */
inline size_t seedFromCrossings(const SparseField& F, Seeds& S, int side, FixedThreadPool& pool) {
    S.grow(F.blocks.size());
    std::vector<std::vector<std::pair<uint16_t, std::array<float, 3>>>> perBlock(F.blocks.size());
    pool.forEach(F.blocks.size(), [&](size_t b) {
        const Block& B = F.blocks[b];
        for (int a = 0; a < kVox; ++a) {
            const float v = B.v[a];
            if ((v < 0 ? -1 : 1) != side) continue;
            const int x = B.bx * kDim + (a >> 6), y = B.by * kDim + ((a >> 3) & 7), z = B.bz * kDim + (a & 7);
            static const int nbr[6][3] = {{1, 0, 0}, {-1, 0, 0}, {0, 1, 0}, {0, -1, 0}, {0, 0, 1}, {0, 0, -1}};
            const Vec3 c = F.centre(x, y, z);
            double best = std::numeric_limits<double>::infinity();
            Vec3 bp{0, 0, 0};
            for (const auto& o : nbr) {
                bool known = true;
                const float w = F.at(x + o[0], y + o[1], z + o[2], &known);
                if (!known || (w < 0 ? -1 : 1) == side) continue;
                const double t = static_cast<double>(v) / (static_cast<double>(v) - w);
                if (t * F.voxel < best) { best = t * F.voxel; bp = {c[0] + t * o[0] * F.voxel, c[1] + t * o[1] * F.voxel, c[2] + t * o[2] * F.voxel}; }
            }
            if (std::isfinite(best)) perBlock[b].push_back({static_cast<uint16_t>(a), {static_cast<float>(bp[0]), static_cast<float>(bp[1]), static_cast<float>(bp[2])}});
        }
    });
    return addSeeds(S, perBlock);
}

}  // namespace detail

/**
 * Morphological closing at radius r (see the file comment), seeded from the field's zero crossings both ways. The field
 * keeps its band; blocks that end wholly outside it become tiles.
 */
inline MorphStats close(SparseField& F, double r, FixedThreadPool& pool) {
    using namespace detail;
    MorphStats ms;
    if (!(r > 0)) return ms;
    const double bandM = F.band, reach = r + bandM + F.voxel;
    double t0 = now();
    // The original values: a closing contains what it closes, so the result is never above them (where the winding
    // number crossed one half in mid-air, over a hole, the field jumps from -band to +band with no distance to place
    // that boundary by, and re-measuring it would move it by up to half a voxel).
    std::vector<std::array<float, kVox>> original(F.blocks.size());
    pool.forEach(F.blocks.size(), [&](size_t b) { original[b] = F.blocks[b].v; });
    // 1. Distance outward (positive side), out to r + band.
    {
        // seeded from the field's own zero crossings: the boundary of the solid. The mesh's nearest triangles would
        // also seed from open sheets that bound nothing (outside on both sides), and the closing would thicken them.
        Seeds S;
        ms.seeds = seedFromCrossings(F, S, +1, pool);
        ms.reached += propagate(F, S, +1, reach, ms, pool);
        // The dilated field: (outside distance) - r where reached; inside voxels and unreached outside ones keep theirs - r.
        pool.forEach(F.blocks.size(), [&](size_t b) {
            for (int a = 0; a < kVox; ++a) {
                float& v = F.blocks[b].v[a];
                if (v >= 0) v = S.id[b][a] != UINT32_MAX ? static_cast<float>(S.dist(S.id[b][a], voxelCentre(F, static_cast<uint32_t>(b), a))) : static_cast<float>(reach);
                v = static_cast<float>(v - r);
            }
        });
    }
    // Tiles keep their sign: outside tiles are beyond reach (positive after the shift), inside tiles stay inside.
    ms.msDilate = now() - t0;
    t0 = now();
    // 2. Distance inside the dilated surface from its zero crossings, then back out by r.
    {
        Seeds S;
        seedFromCrossings(F, S, -1, pool);
        ms.reached += propagate(F, S, -1, reach, ms, pool);
        pool.forEach(F.blocks.size(), [&](size_t b) {
            for (int a = 0; a < kVox; ++a) {
                float& v = F.blocks[b].v[a];
                if (v < 0) v = S.id[b][a] != UINT32_MAX ? static_cast<float>(r - S.dist(S.id[b][a], voxelCentre(F, static_cast<uint32_t>(b), a))) : -F.band;
                else v = static_cast<float>(v + r);
                if (b < original.size()) v = std::min(v, original[b][a]);  // blocks added since were tiles or unknown: no solid to keep
                v = std::clamp(v, -F.band, F.band);
            }
        });
    }
    ms.msRedistance = now() - t0;
    ms.blocksPruned = F.prune();
    return ms;
}

/** Morphological opening at radius r: the closing of the negated field. */
inline MorphStats open(SparseField& F, double r, FixedThreadPool& pool) {
    F.negate();
    MorphStats ms = close(F, r, pool);
    F.negate();
    return ms;
}

struct CoarseMorphStats {
    double coarseVoxel = 0;
    BuildStats coarseBuild;
    MorphStats coarse;
    size_t fineBlocksAdded = 0, fineBlocksPruned = 0, fineVoxelsChanged = 0;
    double msMerge = 0;
};

/**
 * Closing or opening at radius r computed on a coarser grid and merged into the fine field: the shape a radius r
 * changes is r wide, so the coarse grid (coarseVoxel, typically r / 8) resolves it, while the fine field keeps every
 * detail the morphology leaves alone. The mesh is voxelised again at coarseVoxel; its closing (opening) is compared
 * with its own unmorphed field, and only where the two differ by more than half a coarse voxel in the morphology's
 * direction does the fine value give way: min(fine, coarse closed) for a closing, max for an opening. Fine blocks are
 * allocated where the changed coarse surface lies; blocks left wholly outside the band become tiles.
 */
inline CoarseMorphStats morphCoarse(SparseField& fine, double r, bool opening, const MeshSource& src, double coarseVoxel, FixedThreadPool& pool) {
    using namespace detail;
    CoarseMorphStats st;
    st.coarseVoxel = coarseVoxel;
    BuildOptions bo;
    bo.voxel = coarseVoxel;
    bo.bandVoxels = 3;
    SparseField c0 = build(src, bo, pool, &st.coarseBuild);
    SparseField c = c0;
    st.coarse = opening ? open(c, r, pool) : close(c, r, pool);
    const double t0 = now();
    const double tau = 0.5 * coarseVoxel;
    const float dir = opening ? 1.f : -1.f;  // the sign a changed value moves by
    auto changed = [&](float psi, float phi0) { return dir * (psi - phi0) > tau; };
    // 1. Fine blocks over every changed coarse voxel near the morphed surface.
    std::vector<std::vector<uint64_t>> want(std::max(1u, pool.size()));
    std::atomic<size_t> next{0};
    pool.forEach(want.size(), [&](size_t w) {
        for (size_t b; (b = next.fetch_add(1)) < c.blocks.size();) {
            const Block& B = c.blocks[b];
            for (int a = 0; a < kVox; ++a) {
                const float psi = B.v[a];
                if (std::fabs(psi) >= c.band) continue;
                const int x = B.bx * kDim + (a >> 6), y = B.by * kDim + ((a >> 3) & 7), z = B.bz * kDim + (a & 7);
                bool known = true;
                const float phi0 = c0.at(x, y, z, &known);
                if (!changed(psi, phi0)) continue;
                const Vec3 p = c.centre(x, y, z);
                const double reach = 0.5 * coarseVoxel + fine.band + fine.voxel;
                int lo[3], hi[3];
                for (int k = 0; k < 3; ++k) {
                    lo[k] = blockOf(static_cast<int>(std::floor((p[k] - reach - fine.origin[k]) / fine.voxel)));
                    hi[k] = blockOf(static_cast<int>(std::ceil((p[k] + reach - fine.origin[k]) / fine.voxel)));
                }
                for (int i = lo[0]; i <= hi[0]; ++i)
                    for (int j = lo[1]; j <= hi[1]; ++j)
                        for (int k = lo[2]; k <= hi[2]; ++k) want[w].push_back(blockKey(i, j, k));
            }
            std::sort(want[w].begin(), want[w].end());
            want[w].erase(std::unique(want[w].begin(), want[w].end()), want[w].end());
        }
    });
    std::vector<uint64_t> keys;
    for (auto& w : want) { keys.insert(keys.end(), w.begin(), w.end()); std::vector<uint64_t>().swap(w); }
    std::sort(keys.begin(), keys.end());
    keys.erase(std::unique(keys.begin(), keys.end()), keys.end());
    constexpr uint64_t m = (uint64_t(1) << 21) - 1;
    std::vector<uint8_t> touched;
    for (uint64_t k : keys) {
        if (fine.index.count(k)) continue;
        const int bx = static_cast<int>((k >> 42) & m) - (1 << 20), by = static_cast<int>((k >> 21) & m) - (1 << 20), bz = static_cast<int>(k & m) - (1 << 20);
        int s = fine.tileSign(bx, by, bz);
        if (!s) {
            bool known = true;
            const float v = c0.sample(fine.centre(bx * kDim + 4, by * kDim + 4, bz * kDim + 4), &known);
            s = known ? (v < 0 ? -1 : 1) : (src.inside(fine.centre(bx * kDim + 4, by * kDim + 4, bz * kDim + 4)) ? -1 : 1);
        }
        fine.touch(bx, by, bz, s < 0 ? -fine.band : fine.band);
        ++st.fineBlocksAdded;
    }
    // 2. The fine values give way where the coarse morphology changed the shape.
    std::atomic<size_t> nchanged{0};
    pool.forEach(fine.blocks.size(), [&](size_t b) {
        Block& B = fine.blocks[b];
        size_t n = 0;
        for (int a = 0; a < kVox; ++a) {
            const Vec3 p = fine.centre(B.bx * kDim + (a >> 6), B.by * kDim + ((a >> 3) & 7), B.bz * kDim + (a & 7));
            bool k1 = true, k2 = true;
            const float psi = c.sample(p, &k1);
            if (!k1) continue;
            const float phi0 = c0.sample(p, &k2);
            if (!k2 || !changed(psi, phi0)) continue;
            const float before = B.v[a];
            const float v = opening ? std::max(before, psi) : std::min(before, psi);
            B.v[a] = std::clamp(v, -fine.band, fine.band);
            n += B.v[a] != before;
        }
        nchanged.fetch_add(n, std::memory_order_relaxed);
    });
    st.fineVoxelsChanged = nchanged.load();
    st.fineBlocksPruned = fine.prune();
    st.msMerge = now() - t0;
    return st;
}

/**
 * The sign of any point: the stored field where it is known, else the mesh's winding number (when a mesh is given),
 * else outside.
 */
inline float signedDistance(const SparseField& F, const Vec3& p, const MeshSource* src, bool* known = nullptr) {
    bool k = true;
    const float v = F.sample(p, &k);
    if (known) *known = k;
    if (k) return v;
    // part of the stencil is unknown: decide by any stored value nearby, else by the winding number
    const int x = static_cast<int>(std::lround((p[0] - F.origin[0]) / F.voxel)), y = static_cast<int>(std::lround((p[1] - F.origin[1]) / F.voxel)),
              z = static_cast<int>(std::lround((p[2] - F.origin[2]) / F.voxel));
    bool k2 = true;
    const float v2 = F.at(x, y, z, &k2);
    if (k2) return v2;
    if (src) return src->inside(p) ? -F.band : F.band;
    return F.band;
}

}  // namespace scratchbox::sparse_field
