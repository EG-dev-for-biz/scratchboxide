/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_VOXEL_REMESH_HPP
#define SCRATCHBOX_VOXEL_REMESH_HPP

// Watertight voxel remesh of a triangle shell: conservative rasterisation into a sparse grid of 8^3 leaf blocks and
// homogeneous tiles, morphological closing of small gaps, a flood fill of the outside, then one vertex per surface sheet
// of every crossed dual cell placed by dual contouring of Hermite data (Ju et al. 2002, "Dual Contouring of Hermite Data").
// Sheets are split per cell with a fixed face rule (inside corners on a face diagonal never join), so the result is a
// closed, oriented 2-manifold whatever the input. Only for generated content: measured scans are judged by their fit and
// are never remeshed or padded (AGENTS.md section 3.3).

#include "scratchbox_geometry.hpp"
#include "scratchbox_bvh.hpp"
#include "scratchbox_mesh_audit.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <deque>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

namespace scratchbox {
namespace voxel_remesh {

using math::Vec3;
using geometry::ScratchboxMesh;
using geometry::Vertex;

struct VoxelRemeshOptions {
    /** Voxel edge in mesh units; 0 = the bounding-box diagonal / `resolution`. */
    double voxelSize{0.0};
    /** Voxels along the bounding-box diagonal when voxelSize is 0. */
    int resolution{256};
    /** Gap closing radius in voxels: openings up to about twice this are sealed. 0 = no closing. */
    int closeRadius{2};
    /** Dual contouring (sharp features from the Hermite normals); false = the mass point (surface nets). */
    bool sharpFeatures{true};
    /** Eigenvalues of the QEF below this share of the largest are truncated (Ju et al.'s rank control). */
    double qefTruncation{0.08};
    /** Refuses grids whose dense block index would pass this many blocks (raise the voxel size instead). */
    size_t maxBlocks{size_t(1) << 26};
    unsigned threads{0};
};

struct VoxelRemeshReport {
    double voxelSize{0};
    int dims[3]{0, 0, 0};
    size_t allocatedBlocks{0};
    size_t surfaceVoxels{0};
    size_t dilatedVoxels{0};
    size_t erodedVoxels{0};
    size_t signEdges{0};
    size_t cells{0};
    size_t multiSheetCells{0};
    size_t hermiteRay{0};        // edge crossing found on the source surface
    size_t hermiteFallback{0};   // no source surface on the edge: a sealed gap, placed at the edge midpoint
    size_t clampedVertices{0};   // QEF minimiser left its cell; the mass point used
    size_t outputVertices{0};
    size_t outputQuads{0};
    double msRaster{0}, msClose{0}, msFlood{0}, msHermite{0}, msContour{0};
    std::string note;
};

struct VoxelRemeshResult {
    ScratchboxMesh mesh;                          // triangulated (each quad on its shorter diagonal)
    std::vector<std::array<uint32_t, 4>> quads;   // the dual-contouring quads, same vertices, outward winding
    VoxelRemeshReport report;
};

namespace detail {

enum : uint8_t { EMPTY = 0, SURFACE = 1, DILATED = 2, OUTSIDE = 3, INSIDE = 4 };

struct D3 { double x{0}, y{0}, z{0}; };
inline D3 d3(const Vec3& v) { return {v.x, v.y, v.z}; }
inline D3 operator+(D3 a, D3 b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
inline D3 operator-(D3 a, D3 b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
inline D3 operator*(D3 a, double s) { return {a.x * s, a.y * s, a.z * s}; }
inline double dot(D3 a, D3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
inline D3 cross(D3 a, D3 b) { return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x}; }
inline double comp(D3 a, int i) { return i == 0 ? a.x : (i == 1 ? a.y : a.z); }

/** Separating-axis test of a closed triangle against a closed box (centre c, half extent h). */
inline bool triangleBoxOverlap(D3 c, double h, D3 a, D3 b, D3 d) {
    D3 v0 = a - c, v1 = b - c, v2 = d - c;
    D3 e[3] = {v1 - v0, v2 - v1, v0 - v2};
    // the box's own axes
    for (int i = 0; i < 3; ++i) {
        double p0 = comp(v0, i), p1 = comp(v1, i), p2 = comp(v2, i);
        if (std::min({p0, p1, p2}) > h || std::max({p0, p1, p2}) < -h) return false;
    }
    // the triangle's plane
    D3 n = cross(e[0], e[1]);
    double dn = dot(n, v0);
    double r = h * (std::abs(n.x) + std::abs(n.y) + std::abs(n.z));
    if (std::abs(dn) > r) return false;
    // the nine edge cross axes
    const D3 axes[3] = {{1, 0, 0}, {0, 1, 0}, {0, 0, 1}};
    for (int i = 0; i < 3; ++i)
        for (int k = 0; k < 3; ++k) {
            D3 ax = cross(axes[i], e[k]);
            double p0 = dot(ax, v0), p1 = dot(ax, v1), p2 = dot(ax, v2);
            double rr = h * (std::abs(ax.x) + std::abs(ax.y) + std::abs(ax.z));
            if (std::min({p0, p1, p2}) > rr || std::max({p0, p1, p2}) < -rr) return false;
        }
    return true;
}

/** Symmetric 3x3 eigen decomposition by cyclic Jacobi rotations: A = V diag(w) V^T, V's columns the eigenvectors. */
inline void symmetricEigen3(const double Ain[3][3], double w[3], double V[3][3]) {
    double A[3][3];
    for (int i = 0; i < 3; ++i) for (int j = 0; j < 3; ++j) { A[i][j] = Ain[i][j]; V[i][j] = i == j ? 1.0 : 0.0; }
    for (int sweep = 0; sweep < 24; ++sweep) {
        double off = A[0][1] * A[0][1] + A[0][2] * A[0][2] + A[1][2] * A[1][2];
        if (off < 1e-30) break;
        for (int p = 0; p < 2; ++p)
            for (int q = p + 1; q < 3; ++q) {
                if (std::abs(A[p][q]) < 1e-300) continue;
                double theta = (A[q][q] - A[p][p]) / (2.0 * A[p][q]);
                double t = (theta >= 0 ? 1.0 : -1.0) / (std::abs(theta) + std::sqrt(theta * theta + 1.0));
                double c = 1.0 / std::sqrt(t * t + 1.0), s = t * c;
                for (int k = 0; k < 3; ++k) {
                    double akp = A[k][p], akq = A[k][q];
                    A[k][p] = c * akp - s * akq;
                    A[k][q] = s * akp + c * akq;
                }
                for (int k = 0; k < 3; ++k) {
                    double apk = A[p][k], aqk = A[q][k];
                    A[p][k] = c * apk - s * aqk;
                    A[q][k] = s * apk + c * aqk;
                }
                for (int k = 0; k < 3; ++k) {
                    double vkp = V[k][p], vkq = V[k][q];
                    V[k][p] = c * vkp - s * vkq;
                    V[k][q] = s * vkp + c * vkq;
                }
            }
    }
    for (int i = 0; i < 3; ++i) w[i] = A[i][i];
}

/** Minimiser of sum (n_i . (x - p_i))^2 about the mass point m, with eigenvalues under `trunc` x the largest dropped. */
inline D3 solveQef(const double ATA[3][3], D3 ATb, D3 m, double trunc) {
    double w[3], V[3][3];
    symmetricEigen3(ATA, w, V);
    double wmax = std::max({std::abs(w[0]), std::abs(w[1]), std::abs(w[2])});
    if (wmax <= 0) return m;
    // residual right-hand side about the mass point
    D3 Am{ATA[0][0] * m.x + ATA[0][1] * m.y + ATA[0][2] * m.z,
          ATA[1][0] * m.x + ATA[1][1] * m.y + ATA[1][2] * m.z,
          ATA[2][0] * m.x + ATA[2][1] * m.y + ATA[2][2] * m.z};
    D3 r = ATb - Am;
    D3 x = m;
    for (int k = 0; k < 3; ++k) {
        if (w[k] < trunc * wmax) continue;
        D3 u{V[0][k], V[1][k], V[2][k]};
        x = x + u * (dot(u, r) / w[k]);
    }
    return x;
}

// cube corners c = dx + 2 dy + 4 dz; the 12 edges and 6 faces (corners in cyclic order)
constexpr int kEdgeCorners[12][2] = {{0, 1}, {2, 3}, {4, 5}, {6, 7}, {0, 2}, {1, 3}, {4, 6}, {5, 7}, {0, 4}, {1, 5}, {2, 6}, {3, 7}};
constexpr int kEdgeAxis[12] = {0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2};
constexpr int kFaceCorners[6][4] = {{0, 2, 6, 4}, {1, 3, 7, 5}, {0, 1, 5, 4}, {2, 3, 7, 6}, {0, 1, 3, 2}, {4, 5, 7, 6}};

inline int edgeBetween(int a, int b) {
    for (int e = 0; e < 12; ++e)
        if ((kEdgeCorners[e][0] == a && kEdgeCorners[e][1] == b) || (kEdgeCorners[e][0] == b && kEdgeCorners[e][1] == a)) return e;
    return -1;
}

/** Per inside-corner mask: each crossed edge's sheet number in the cell (-1 uncrossed), and the sheet count. */
struct SheetTable {
    std::array<std::array<int8_t, 12>, 256> sheet{};
    std::array<uint8_t, 256> count{};
    SheetTable() {
        for (int cfg = 0; cfg < 256; ++cfg) {
            int parent[12];
            for (int e = 0; e < 12; ++e) parent[e] = e;
            auto find = [&](int x) { while (parent[x] != x) x = parent[x] = parent[parent[x]]; return x; };
            auto unite = [&](int a, int b) { parent[find(a)] = find(b); };
            auto in = [&](int c) { return (cfg >> c) & 1; };
            for (int f = 0; f < 6; ++f) {
                const int* q = kFaceCorners[f];
                int crossed[4], n = 0;
                for (int k = 0; k < 4; ++k) if (in(q[k]) != in(q[(k + 1) % 4])) crossed[n++] = edgeBetween(q[k], q[(k + 1) % 4]);
                if (n == 2) unite(crossed[0], crossed[1]);
                else if (n == 4) {
                    // ambiguous face: the segments cut off each inside corner, so the inside corners stay apart
                    for (int k = 0; k < 4; ++k)
                        if (in(q[k])) unite(edgeBetween(q[(k + 3) % 4], q[k]), edgeBetween(q[k], q[(k + 1) % 4]));
                }
            }
            int label[12];
            for (int e = 0; e < 12; ++e) label[e] = -1;
            int next = 0;
            for (int e = 0; e < 12; ++e) {
                if (in(kEdgeCorners[e][0]) == in(kEdgeCorners[e][1])) { sheet[cfg][e] = -1; continue; }
                int r = find(e);
                if (label[r] < 0) label[r] = next++;
                sheet[cfg][e] = static_cast<int8_t>(label[r]);
            }
            count[cfg] = static_cast<uint8_t>(next);
        }
    }
};

inline const SheetTable& sheetTable() { static const SheetTable t; return t; }

/** Dense block index over the grid's 8^3 blocks; voxels only in allocated blocks, a state per unallocated tile. */
class SparseGrid {
public:
    int nx{0}, ny{0}, nz{0};   // voxels
    int bx{0}, by{0}, bz{0};   // blocks
    std::vector<int32_t> blockOf;  // -1 = tile
    std::vector<uint8_t> tile;     // a tile's state (EMPTY until the flood decides)
    std::vector<std::array<uint8_t, 512>> blocks;
    std::vector<int32_t> blockId;  // allocated block -> its dense block index

    void init(int vx, int vy, int vz) {
        nx = vx; ny = vy; nz = vz;
        bx = (vx + 7) / 8; by = (vy + 7) / 8; bz = (vz + 7) / 8;
        size_t nb = size_t(bx) * by * bz;
        blockOf.assign(nb, -1);
        tile.assign(nb, EMPTY);
    }
    size_t blockIndex(int bi, int bj, int bk) const { return (size_t(bk) * by + bj) * bx + bi; }
    bool inGrid(int i, int j, int k) const { return i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz; }
    static int local(int i, int j, int k) { return (i & 7) | ((j & 7) << 3) | ((k & 7) << 6); }

    uint8_t get(int i, int j, int k) const {
        if (!inGrid(i, j, k)) return OUTSIDE;
        size_t b = blockIndex(i >> 3, j >> 3, k >> 3);
        int32_t id = blockOf[b];
        return id < 0 ? tile[b] : blocks[id][local(i, j, k)];
    }
    bool allocated(int i, int j, int k) const {
        return inGrid(i, j, k) && blockOf[blockIndex(i >> 3, j >> 3, k >> 3)] >= 0;
    }
    uint8_t& ref(int i, int j, int k) {
        size_t b = blockIndex(i >> 3, j >> 3, k >> 3);
        int32_t id = blockOf[b];
        if (id < 0) {
            id = static_cast<int32_t>(blocks.size());
            blocks.emplace_back();
            blocks.back().fill(tile[b]);
            blockId.push_back(static_cast<int32_t>(b));
            blockOf[b] = id;
        }
        return blocks[id][local(i, j, k)];
    }
    void blockCoords(size_t b, int& bi, int& bj, int& bk) const {
        bi = static_cast<int>(b % bx);
        bj = static_cast<int>((b / bx) % by);
        bk = static_cast<int>(b / (size_t(bx) * by));
    }
};

inline uint64_t cellKey(int i, int j, int k) {
    return (static_cast<uint64_t>(i) & 0x1FFFFF) | ((static_cast<uint64_t>(j) & 0x1FFFFF) << 21) | ((static_cast<uint64_t>(k) & 0x1FFFFF) << 42);
}

}  // namespace detail

/**
 * Remeshes a triangle shell into a closed, oriented 2-manifold. Throws when the grid would be too large, and returns an
 * empty mesh with a note when the shell encloses no volume at this voxel size (an open sheet the closing cannot seal).
 */
namespace detail {

/** Calls fn(i, j, k) for every voxel (closed box) that triangle t touches: the voxels across its dominant normal axis,
 *  only within the band of the third axis the triangle's plane crosses. */
template <typename Fn>
inline void forTriangleVoxels(const ScratchboxMesh& input, size_t t, D3 origin, double s, const int dims[3], Fn&& fn) {
    const int vx = dims[0], vy = dims[1], vz = dims[2];

        D3 a = d3(input.vertices[input.indices[t * 3]].position);
        D3 b = d3(input.vertices[input.indices[t * 3 + 1]].position);
        D3 c = d3(input.vertices[input.indices[t * 3 + 2]].position);
        D3 n = cross(b - a, c - a);
        int lo[3], hi[3];
        for (int ax = 0; ax < 3; ++ax) {
            double mn = std::min({comp(a, ax), comp(b, ax), comp(c, ax)}) - comp(origin, ax);
            double mx = std::max({comp(a, ax), comp(b, ax), comp(c, ax)}) - comp(origin, ax);
            lo[ax] = std::max(0, static_cast<int>(std::floor(mn / s)) - 1);
            hi[ax] = std::min((ax == 0 ? vx : ax == 1 ? vy : vz) - 1, static_cast<int>(std::floor(mx / s)) + 1);
        }
        // walk the two axes across the triangle's dominant normal and only the band of the third the plane crosses
        int dax = 0;
        if (std::abs(n.y) > std::abs(comp(n, dax))) dax = 1;
        if (std::abs(n.z) > std::abs(comp(n, dax))) dax = 2;
        int ua = (dax + 1) % 3, ub = (dax + 2) % 3;
        double nd = comp(n, dax), D = dot(n, a);
        int idx[3];
        for (idx[ua] = lo[ua]; idx[ua] <= hi[ua]; ++idx[ua])
            for (idx[ub] = lo[ub]; idx[ub] <= hi[ub]; ++idx[ub]) {
                int k0 = lo[dax], k1 = hi[dax];
                if (std::abs(nd) > 1e-12 * (std::abs(n.x) + std::abs(n.y) + std::abs(n.z))) {
                    double pmin = 1e300, pmax = -1e300;
                    for (int cu = 0; cu < 2; ++cu)
                        for (int cv = 0; cv < 2; ++cv) {
                            double xu = comp(origin, ua) + (idx[ua] + cu) * s, xv = comp(origin, ub) + (idx[ub] + cv) * s;
                            double xd = (D - comp(n, ua) * xu - comp(n, ub) * xv) / nd;
                            pmin = std::min(pmin, xd); pmax = std::max(pmax, xd);
                        }
                    k0 = std::max(k0, static_cast<int>(std::floor((pmin - comp(origin, dax)) / s)) - 1);
                    k1 = std::min(k1, static_cast<int>(std::floor((pmax - comp(origin, dax)) / s)) + 1);
                }
                for (idx[dax] = k0; idx[dax] <= k1; ++idx[dax]) {
                    D3 cc{origin.x + (idx[0] + 0.5) * s, origin.y + (idx[1] + 0.5) * s, origin.z + (idx[2] + 0.5) * s};
                    if (triangleBoxOverlap(cc, 0.5 * s, a, b, c)) fn(idx[0], idx[1], idx[2]);
                }
            }
    }

}  // namespace detail

/** Rasterises, closes and floods: on return every grid voxel is OUTSIDE or not (the solid). False with a note when the
 *  input has nothing to voxelise. */
inline bool classifyGrid(const ScratchboxMesh& input, const VoxelRemeshOptions& opt, VoxelRemeshReport& rep, detail::SparseGrid& g, detail::D3& originOut, double& sOut) {
    using namespace detail;
    using clock = std::chrono::steady_clock;
    auto ms = [](clock::time_point a) { return std::chrono::duration<double, std::milli>(clock::now() - a).count(); };
    const size_t T = input.indices.size() / 3;
    if (T == 0) { rep.note = "input has no triangles"; return false; }

    geometry::AABB box;
    for (const auto& v : input.vertices) box.expand(v.position);
    const double diag = box.size().length();
    const double s = opt.voxelSize > 0 ? opt.voxelSize : diag / std::max(8, opt.resolution);
    if (!(s > 0) || !std::isfinite(s)) { rep.note = "degenerate bounds"; return false; }
    rep.voxelSize = s;
    const int r = std::max(0, opt.closeRadius);
    const int margin = 8 + r + 2;  // keeps the outermost blocks empty, so the flood starts from whole tiles
    const D3 origin{box.min.x - margin * s, box.min.y - margin * s, box.min.z - margin * s};
    const Vec3 ext = box.size();
    int vx = static_cast<int>(std::ceil(ext.x / s)) + 2 * margin;
    int vy = static_cast<int>(std::ceil(ext.y / s)) + 2 * margin;
    int vz = static_cast<int>(std::ceil(ext.z / s)) + 2 * margin;
    if (vx >= (1 << 21) || vy >= (1 << 21) || vz >= (1 << 21)) throw std::runtime_error("voxel remesh: grid axis too long for this voxel size");
    size_t nblocks = size_t((vx + 7) / 8) * ((vy + 7) / 8) * ((vz + 7) / 8);
    if (nblocks > opt.maxBlocks) throw std::runtime_error("voxel remesh: " + std::to_string(nblocks) + " blocks exceed the limit; raise the voxel size");
    rep.dims[0] = vx; rep.dims[1] = vy; rep.dims[2] = vz;

    g.init(vx, vy, vz);
    originOut = origin;
    sOut = s;
    auto centre = [&](int i, int j, int k) { return D3{origin.x + (i + 0.5) * s, origin.y + (j + 0.5) * s, origin.z + (k + 0.5) * s}; };

    // 1. conservative rasterisation: every voxel a triangle touches (closed boxes, so the shell 6-separates in from out)
    auto t0 = clock::now();
    for (size_t t = 0; t < T; ++t)
        forTriangleVoxels(input, t, origin, s, rep.dims, [&](int i, int j, int k) {
            uint8_t& st = g.ref(i, j, k);
            if (st != SURFACE) { st = SURFACE; rep.surfaceVoxels++; }
        });
    rep.msRaster = ms(t0);

    // 2. closing, first half: dilate the shell by a ball of radius r
    t0 = clock::now();
    if (r > 0) {
        std::vector<std::array<int, 3>> shell;
        shell.reserve(rep.surfaceVoxels);
        for (size_t id = 0; id < g.blocks.size(); ++id) {
            int bi, bj, bk;
            g.blockCoords(g.blockId[id], bi, bj, bk);
            for (int l = 0; l < 512; ++l)
                if (g.blocks[id][l] == SURFACE) shell.push_back({bi * 8 + (l & 7), bj * 8 + ((l >> 3) & 7), bk * 8 + (l >> 6)});
        }
        std::vector<std::array<int, 3>> ball;
        for (int dz = -r; dz <= r; ++dz)
            for (int dy = -r; dy <= r; ++dy)
                for (int dx = -r; dx <= r; ++dx)
                    if (dx * dx + dy * dy + dz * dz <= r * r + r && (dx | dy | dz)) ball.push_back({dx, dy, dz});
        for (const auto& v : shell)
            for (const auto& o : ball) {
                int i = v[0] + o[0], j = v[1] + o[1], k = v[2] + o[2];
                if (!g.inGrid(i, j, k)) continue;
                uint8_t& st = g.ref(i, j, k);
                if (st == EMPTY) { st = DILATED; rep.dilatedVoxels++; }
            }
    }
    rep.msClose = ms(t0);

    // 3. flood the outside from the border tiles through empty tiles and empty voxels (6-connected)
    t0 = clock::now();
    {
        std::deque<int64_t> q;  // >= 0: voxel i + nx (j + ny k); < 0: -(tile + 1)
        auto pushTile = [&](size_t b) { if (g.blockOf[b] < 0 && g.tile[b] == EMPTY) { g.tile[b] = OUTSIDE; q.push_back(-static_cast<int64_t>(b) - 1); } };
        auto vkey = [&](int i, int j, int k) { return static_cast<int64_t>(i) + static_cast<int64_t>(g.nx) * (j + static_cast<int64_t>(g.ny) * k); };
        for (int bk = 0; bk < g.bz; ++bk)
            for (int bj = 0; bj < g.by; ++bj)
                for (int bi = 0; bi < g.bx; ++bi)
                    if (bi == 0 || bj == 0 || bk == 0 || bi == g.bx - 1 || bj == g.by - 1 || bk == g.bz - 1) pushTile(g.blockIndex(bi, bj, bk));
        const int dirs[6][3] = {{1, 0, 0}, {-1, 0, 0}, {0, 1, 0}, {0, -1, 0}, {0, 0, 1}, {0, 0, -1}};
        while (!q.empty()) {
            int64_t node = q.front();
            q.pop_front();
            if (node < 0) {
                size_t b = static_cast<size_t>(-node - 1);
                int bi, bj, bk;
                g.blockCoords(b, bi, bj, bk);
                for (const auto& d : dirs) {
                    int ni = bi + d[0], nj = bj + d[1], nk = bk + d[2];
                    if (ni < 0 || nj < 0 || nk < 0 || ni >= g.bx || nj >= g.by || nk >= g.bz) continue;
                    size_t nb = g.blockIndex(ni, nj, nk);
                    int32_t id = g.blockOf[nb];
                    if (id < 0) { pushTile(nb); continue; }
                    // the neighbour block's face that touches this tile
                    for (int u = 0; u < 8; ++u)
                        for (int v = 0; v < 8; ++v) {
                            int li, lj, lk;
                            if (d[0]) { li = d[0] > 0 ? 0 : 7; lj = u; lk = v; }
                            else if (d[1]) { li = u; lj = d[1] > 0 ? 0 : 7; lk = v; }
                            else { li = u; lj = v; lk = d[2] > 0 ? 0 : 7; }
                            uint8_t& st = g.blocks[id][li | (lj << 3) | (lk << 6)];
                            if (st == EMPTY) { st = OUTSIDE; q.push_back(vkey(ni * 8 + li, nj * 8 + lj, nk * 8 + lk)); }
                        }
                }
            } else {
                int i = static_cast<int>(node % g.nx), j = static_cast<int>((node / g.nx) % g.ny), k = static_cast<int>(node / (static_cast<int64_t>(g.nx) * g.ny));
                for (const auto& d : dirs) {
                    int a = i + d[0], b = j + d[1], c = k + d[2];
                    if (!g.inGrid(a, b, c)) continue;
                    size_t nb = g.blockIndex(a >> 3, b >> 3, c >> 3);
                    int32_t id = g.blockOf[nb];
                    if (id < 0) { pushTile(nb); continue; }
                    uint8_t& st = g.blocks[id][SparseGrid::local(a, b, c)];
                    if (st == EMPTY) { st = OUTSIDE; q.push_back(vkey(a, b, c)); }
                }
            }
        }
        // closing, second half: dilate the flooded outside by the same ball (eroding the dilation), so the surface
        // returns to the shell wherever the outside reaches it and only openings narrower than the ball stay sealed
        if (r > 0) {
            std::vector<std::array<int, 3>> ball;
            for (int dz = -r; dz <= r; ++dz)
                for (int dy = -r; dy <= r; ++dy)
                    for (int dx = -r; dx <= r; ++dx)
                        if (dx * dx + dy * dy + dz * dz <= r * r + r && (dx | dy | dz)) ball.push_back({dx, dy, dz});
            std::vector<std::array<int, 3>> frontier;
            for (size_t id = 0; id < g.blocks.size(); ++id) {
                int bi, bj, bk;
                g.blockCoords(g.blockId[id], bi, bj, bk);
                for (int l = 0; l < 512; ++l) {
                    if (g.blocks[id][l] != DILATED) continue;
                    int i = bi * 8 + (l & 7), j = bj * 8 + ((l >> 3) & 7), k = bk * 8 + (l >> 6);
                    for (const auto& d : dirs)
                        if (g.get(i + d[0], j + d[1], k + d[2]) == OUTSIDE) { frontier.push_back({i + d[0], j + d[1], k + d[2]}); }
                }
            }
            std::vector<std::array<int, 3>> peel;
            for (const auto& f : frontier)
                for (const auto& o : ball) {
                    int i = f[0] + o[0], j = f[1] + o[1], k = f[2] + o[2];
                    if (g.allocated(i, j, k) && g.get(i, j, k) == DILATED) peel.push_back({i, j, k});
                }
            for (const auto& p : peel) {
                uint8_t& st = g.ref(p[0], p[1], p[2]);
                if (st == DILATED) { st = OUTSIDE; rep.erodedVoxels++; }
            }
        }
    }
    rep.allocatedBlocks = g.blocks.size();
    rep.msFlood = ms(t0);
    return true;
}

inline VoxelRemeshResult voxelRemesh(const ScratchboxMesh& input, const VoxelRemeshOptions& opt = {}) {
    using namespace detail;
    using clock = std::chrono::steady_clock;
    auto ms = [](clock::time_point a) { return std::chrono::duration<double, std::milli>(clock::now() - a).count(); };
    VoxelRemeshResult out;
    VoxelRemeshReport& rep = out.report;
    SparseGrid g;
    D3 origin;
    double s = 0;
    if (!classifyGrid(input, opt, rep, g, origin, s)) return out;
    auto centre = [&](int i, int j, int k) { return D3{origin.x + (i + 0.5) * s, origin.y + (j + 0.5) * s, origin.z + (k + 0.5) * s}; };
    auto t0 = clock::now();
    auto inside = [&](int i, int j, int k) { return g.get(i, j, k) != OUTSIDE; };

    // 4. crossed lattice edges (between voxel centres, one inside, one outside) and their Hermite data on the source
    t0 = clock::now();
    struct SignEdge { int i, j, k; int axis; bool insideLow; D3 p; D3 n; };
    std::vector<SignEdge> edges;
    {
        const int dirs[6][3] = {{1, 0, 0}, {-1, 0, 0}, {0, 1, 0}, {0, -1, 0}, {0, 0, 1}, {0, 0, -1}};
        for (size_t id = 0; id < g.blocks.size(); ++id) {
            int bi, bj, bk;
            g.blockCoords(g.blockId[id], bi, bj, bk);
            for (int l = 0; l < 512; ++l) {
                int i = bi * 8 + (l & 7), j = bj * 8 + ((l >> 3) & 7), k = bk * 8 + (l >> 6);
                bool in = g.blocks[id][l] != OUTSIDE;
                for (int d = 0; d < 6; ++d) {
                    int a = i + dirs[d][0], b = j + dirs[d][1], c = k + dirs[d][2];
                    bool positive = (d & 1) == 0;
                    // an edge between two allocated voxels is taken from its low end; one into a tile from this side
                    if (g.allocated(a, b, c) && !positive) continue;
                    if (inside(a, b, c) == in) continue;
                    SignEdge e;
                    e.axis = d / 2;
                    if (positive) { e.i = i; e.j = j; e.k = k; e.insideLow = in; }
                    else { e.i = a; e.j = b; e.k = c; e.insideLow = !in; }
                    edges.push_back(e);
                }
            }
        }
    }
    rep.signEdges = edges.size();
    if (edges.empty()) {
        rep.note = "the shell encloses no volume at this voxel size (an open sheet the closing could not seal)";
        return out;
    }
    bvh::BvhTree bvh;
    bvh.build(input);
    std::vector<uint8_t> fromRay(edges.size(), 0);
    mesh_audit::parallelFor(edges.size(), [&](size_t a0, size_t a1) {
        for (size_t x = a0; x < a1; ++x) {
            SignEdge& e = edges[x];
            D3 lo = centre(e.i, e.j, e.k);
            D3 hi = lo; (e.axis == 0 ? hi.x : e.axis == 1 ? hi.y : hi.z) += s;
            D3 cin = e.insideLow ? lo : hi, cout = e.insideLow ? hi : lo;
            D3 dir = (cin - cout) * (1.0 / s);
            D3 outward = dir * -1.0;
            // The inside sample is a voxel the shell touches, so the shell lies within one voxel of it but not
            // necessarily between the two samples. Hermite sample: the first crossing walking inward from the outside
            // sample (up to two voxels), else the source point nearest the edge, with the normal of its triangle.
            auto castNormal = [&](D3 from, D3 d, double maxT, double& tHit, D3& fn) {
                double dl = std::sqrt(dot(d, d));
                if (dl <= 0) return false;
                d = d * (1.0 / dl);
                D3 o = from - d * (0.02 * s);
                math::Ray ray(Vec3(float(o.x), float(o.y), float(o.z)), Vec3(float(d.x), float(d.y), float(d.z)));
                bvh::RayHit hit;
                hit.t = static_cast<float>(maxT + 0.02 * s);
                if (!bvh.raycast(ray, hit)) return false;
                const auto& A = input.vertices[input.indices[hit.triangleIndex * 3]].position;
                const auto& B = input.vertices[input.indices[hit.triangleIndex * 3 + 1]].position;
                const auto& C = input.vertices[input.indices[hit.triangleIndex * 3 + 2]].position;
                fn = cross(d3(B) - d3(A), d3(C) - d3(A));
                double len = std::sqrt(dot(fn, fn));
                if (!(len > 0)) return false;
                fn = fn * (1.0 / len);
                tHit = static_cast<double>(hit.t) - 0.02 * s;
                return true;
            };
            double tHit = 0;
            D3 fn;
            if (castNormal(cout, dir, 2.0 * s, tHit, fn)) {
                if (dot(fn, outward) < 0) fn = fn * -1.0;
                e.p = cout + dir * std::clamp(tHit, 0.0, 2.0 * s);
                e.n = fn;
                fromRay[x] = 1;
                continue;
            }
            D3 mid = (cin + cout) * 0.5;
            float dsq = 0.0f;
            Vec3 qv = bvh.closestPoint(Vec3(float(mid.x), float(mid.y), float(mid.z)), dsq);
            if (std::isfinite(dsq) && std::sqrt(double(dsq)) <= 1.5 * s) {
                D3 q = d3(qv);
                D3 toward = q - cout;
                if (castNormal(cout, toward, std::sqrt(dot(toward, toward)) + 0.05 * s, tHit, fn)) {
                    if (dot(fn, outward) < 0) fn = fn * -1.0;
                    e.p = q;
                    e.n = fn;
                    fromRay[x] = 1;
                    continue;
                }
            }
            e.p = mid;
            e.n = outward;
        }
    }, opt.threads);
    for (uint8_t f : fromRay) (f ? rep.hermiteRay : rep.hermiteFallback)++;
    rep.msHermite = ms(t0);

    // 5. dual cells: every cell around a crossed edge, one vertex per surface sheet, placed by the QEF of its edges
    t0 = clock::now();
    const SheetTable& tab = sheetTable();
    struct Cell { int i, j, k; uint8_t cfg; uint32_t firstVertex; };
    std::vector<Cell> cells;
    std::unordered_map<uint64_t, uint32_t> cellIndex;
    cellIndex.reserve(edges.size() * 2);
    auto cellsAround = [&](const SignEdge& e, int out4[4][3]) {
        // counter-clockwise seen from +axis: quadrants (+,+), (-,+), (-,-), (+,-) of the two other axes
        const int ub = (e.axis + 1) % 3, uc = (e.axis + 2) % 3;
        const int off[4][2] = {{0, 0}, {-1, 0}, {-1, -1}, {0, -1}};
        for (int q = 0; q < 4; ++q) {
            int c[3] = {e.i, e.j, e.k};
            c[ub] += off[q][0];
            c[uc] += off[q][1];
            out4[q][0] = c[0]; out4[q][1] = c[1]; out4[q][2] = c[2];
        }
    };
    for (const auto& e : edges) {
        int cs[4][3];
        cellsAround(e, cs);
        for (auto& c : cs) {
            uint64_t key = cellKey(c[0], c[1], c[2]);
            if (cellIndex.count(key)) continue;
            uint8_t cfg = 0;
            for (int corner = 0; corner < 8; ++corner)
                if (inside(c[0] + (corner & 1), c[1] + ((corner >> 1) & 1), c[2] + ((corner >> 2) & 1))) cfg |= uint8_t(1u << corner);
            cellIndex.emplace(key, static_cast<uint32_t>(cells.size()));
            cells.push_back({c[0], c[1], c[2], cfg, 0});
        }
    }
    rep.cells = cells.size();
    uint32_t nverts = 0;
    for (auto& c : cells) {
        c.firstVertex = nverts;
        nverts += tab.count[c.cfg];
        if (tab.count[c.cfg] > 1) rep.multiSheetCells++;
    }
    // the cell-local edge of a global crossed edge: its low sample relative to the cell's min corner, along its axis
    auto localEdge = [&](const Cell& c, const SignEdge& e) {
        int corner = (e.i - c.i) | ((e.j - c.j) << 1) | ((e.k - c.k) << 2);
        for (int le = 0; le < 12; ++le) if (kEdgeAxis[le] == e.axis && kEdgeCorners[le][0] == corner) return le;
        return -1;
    };
    // accumulate each sheet's QEF from its crossed edges
    struct Qef { double ATA[3][3]{}; D3 ATb; D3 mass; int n{0}; };
    std::vector<Qef> qef(nverts);
    std::vector<std::array<uint32_t, 4>> quadVerts(edges.size());
    for (size_t x = 0; x < edges.size(); ++x) {
        const SignEdge& e = edges[x];
        int cs[4][3];
        cellsAround(e, cs);
        for (int q = 0; q < 4; ++q) {
            const Cell& c = cells[cellIndex.at(cellKey(cs[q][0], cs[q][1], cs[q][2]))];
            int le = localEdge(c, e);
            int sheet = le >= 0 ? tab.sheet[c.cfg][le] : -1;
            if (sheet < 0) throw std::logic_error("voxel remesh: crossed edge without a sheet in its cell");
            uint32_t vtx = c.firstVertex + static_cast<uint32_t>(sheet);
            quadVerts[x][q] = vtx;
            Qef& Q = qef[vtx];
            double nn[3] = {e.n.x, e.n.y, e.n.z};
            for (int a = 0; a < 3; ++a) for (int b = 0; b < 3; ++b) Q.ATA[a][b] += nn[a] * nn[b];
            Q.ATb = Q.ATb + e.n * dot(e.n, e.p);
            Q.mass = Q.mass + e.p;
            Q.n++;
        }
    }
    // a vertex per sheet
    std::vector<uint32_t> vertexCell(nverts);
    for (uint32_t ci = 0; ci < cells.size(); ++ci)
        for (uint32_t k = 0; k < tab.count[cells[ci].cfg]; ++k) vertexCell[cells[ci].firstVertex + k] = ci;
    out.mesh.vertices.resize(nverts);
    std::vector<D3> massOf(nverts);
    for (uint32_t v = 0; v < nverts; ++v) {
        Qef& Q = qef[v];
        D3 m = Q.n ? Q.mass * (1.0 / Q.n) : centre(cells[vertexCell[v]].i, cells[vertexCell[v]].j, cells[vertexCell[v]].k);
        D3 x = opt.sharpFeatures && Q.n ? solveQef(Q.ATA, Q.ATb, m, opt.qefTruncation) : m;
        const Cell& c = cells[vertexCell[v]];
        D3 lo = centre(c.i, c.j, c.k), hi = centre(c.i + 1, c.j + 1, c.k + 1);
        // a minimiser outside the cell (grown by a voxel: the binary sign can sit a voxel off the true surface) is
        // clamped into it, which keeps a corner as near its true place as the cell allows
        const double slack = s;
        if (!std::isfinite(x.x + x.y + x.z)) x = m;
        D3 cl{std::clamp(x.x, lo.x - slack, hi.x + slack), std::clamp(x.y, lo.y - slack, hi.y + slack), std::clamp(x.z, lo.z - slack, hi.z + slack)};
        if (cl.x != x.x || cl.y != x.y || cl.z != x.z) { x = cl; rep.clampedVertices++; }
        Vertex vert;
        vert.position = Vec3(float(x.x), float(x.y), float(x.z));
        out.mesh.vertices[v] = vert;
        massOf[v] = m;
    }
    // Several cells can solve to one point exactly: along a sharp edge, or on both sides of a sheet of no thickness
    // (an open sheet's two sides are one plane). Distinct vertices on one point read as non-manifold to anything that
    // welds by position, so every vertex of such a group moves a tenth toward its own cell's centre (cells on the two
    // sides of a sheet lie apart, so the sheet gets a little thickness) and, within one cell, toward its mass point.
    {
        std::unordered_map<uint64_t, std::vector<uint32_t>> groups;
        groups.reserve(nverts);
        for (uint32_t v = 0; v < nverts; ++v) {
            const Vec3& p = out.mesh.vertices[v].position;
            uint64_t h = 1469598103934665603ull;
            for (float f : {p.x, p.y, p.z}) { uint32_t bits; std::memcpy(&bits, &f, 4); h = (h ^ bits) * 1099511628211ull; }
            groups[h].push_back(v);
        }
        for (auto& [h, members] : groups) {
            if (members.size() < 2) continue;
            for (uint32_t v : members) {
                const Cell& c = cells[vertexCell[v]];
                D3 x = d3(out.mesh.vertices[v].position);
                D3 cc = centre(c.i, c.j, c.k) + D3{0.5 * s, 0.5 * s, 0.5 * s};
                x = x + (cc - x) * 0.1 + (massOf[v] - x) * 0.05;
                out.mesh.vertices[v].position = Vec3(float(x.x), float(x.y), float(x.z));
            }
        }
    }
    // quads, outward: counter-clockwise from +axis when the inside is on the low side
    out.quads.reserve(edges.size());
    for (size_t x = 0; x < edges.size(); ++x) {
        auto q = quadVerts[x];
        if (!edges[x].insideLow) std::swap(q[1], q[3]);
        out.quads.push_back(q);
        const Vec3& p0 = out.mesh.vertices[q[0]].position;
        const Vec3& p1 = out.mesh.vertices[q[1]].position;
        const Vec3& p2 = out.mesh.vertices[q[2]].position;
        const Vec3& p3 = out.mesh.vertices[q[3]].position;
        if ((p2 - p0).lengthSquared() <= (p3 - p1).lengthSquared()) {
            out.mesh.addTriangle(q[0], q[1], q[2]);
            out.mesh.addTriangle(q[0], q[2], q[3]);
        } else {
            out.mesh.addTriangle(q[0], q[1], q[3]);
            out.mesh.addTriangle(q[1], q[2], q[3]);
        }
    }
    out.mesh.name = input.name + "_voxel_remesh";
    out.mesh.material = input.material;
    out.mesh.recomputeNormals();
    out.mesh.recomputeBounds();
    rep.outputVertices = nverts;
    rep.outputQuads = out.quads.size();
    rep.msContour = ms(t0);
    return out;
}

}  // namespace voxel_remesh
}  // namespace scratchbox

#endif  // SCRATCHBOX_VOXEL_REMESH_HPP
