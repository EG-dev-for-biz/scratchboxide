/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Dual contouring of a sparse narrow-band field (scratchbox_sparse_field.hpp) with sharp features: our own code after
 * Ju, Losasso, Schaefer and Warren, "Dual Contouring of Hermite Data" (2002), with the per-cell surface patches of
 * Schaefer, Ju and Warren, "Manifold Dual Contouring" (2007).
 *
 * A cell is the cube between eight voxel centres. Every cell edge whose ends differ in sign carries Hermite data: the
 * zero crossing and a normal. With the source mesh, both are exact where a triangle crosses the cell edge (the one
 * nearest the trilinear crossing when several do): its crossing point and its normal, oriented by the field's gradient.
 * That is what keeps corners sharp, since a distance field's gradient and its trilinear crossings both round them.
 * Where no triangle crosses the edge (a gap the closing filled), or without a mesh, the crossing is linear between the
 * two values and the normal is the field's gradient.
 *
 * Within a cell the crossing edges are grouped into patches by a fixed face rule: on a face with two crossing edges they
 * join; on a face with four (the ambiguous diagonal) each inside corner's two edges join, so inside corners on a face's
 * diagonal never connect. The rule depends only on the face, so neighbouring cells agree, every patch is a disk bounded
 * by one loop on the cell's surface, and each patch gets its own vertex: the result is a closed, oriented 2-manifold
 * wherever the field's sign is defined. A patch's vertex minimises its quadratic error function (the squared distances
 * to the planes of its Hermite data) through a truncated eigen-decomposition about the crossings' mass point, then is
 * clamped to its cell. Each crossing edge gives one quad joining the patch vertices of its four cells, wound so its
 * normal leaves the inside.
 *
 * Adaptive simplification (Ju et al.'s bottom-up collapse of cells whose combined error stays small, done here as vertex
 * clustering on the uniform grid so no cracks can open): a 2 x 2 x 2 group of cells, each with a single patch (or an
 * already merged group), shares one vertex when its merged QEF's mean squared residual stays under simplifyToleranceM
 * squared, its minimiser stays inside the group, and it passes Ju et al.'s topology safety test (its corner signs make
 * at most one patch, and the sign at the middle of each group edge, face and the centre agrees with a corner it lies
 * between), so each cluster's surface is one disk and contracting it to a point keeps the manifold. Recursively up to
 * the block size. Each crossing edge's quad then drops its repeated vertices: a quad with three distinct corners becomes
 * a triangle, fewer is dropped.
 */

#pragma once

#include "scratchbox_sparse_field.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <unordered_map>
#include <vector>

namespace scratchbox::dual_contour {

using sparse_field::Block;
using sparse_field::kDim;
using sparse_field::kVox;
using sparse_field::MeshSource;
using sparse_field::SparseField;
using sparse_field::Vec3;

struct Options {
    /** Eigenvalues of a QEF below this share of its largest are dropped (Ju et al.'s rank truncation). */
    double qefTruncation = 0.1;
    /** Exact Hermite data from mesh triangles crossing the cell edge within this distance of the trilinear crossing (metres; 0: the voxel). */
    double normalMaxM = 0;
    /** false: every patch vertex at its crossings' mass point (surface nets): no sharp features. */
    bool sharp = true;
    /** Adaptive simplification: merge cell groups whose combined QEF residual stays under this (metres; 0: off). */
    double simplifyToleranceM = 0;
};

struct Stats {
    size_t cells = 0, patches = 0, multiPatchCells = 0, crossingEdges = 0;
    size_t meshNormals = 0, fieldNormals = 0, clamped = 0;
    size_t vertices = 0, quads = 0, triangles = 0, degenerateQuads = 0;
    size_t clusters = 0, clusteredVertices = 0;
    double msCells = 0, msQuads = 0, msSimplify = 0;
};

struct Result {
    std::vector<float> positions;     // xyz per vertex
    std::vector<uint32_t> quads;      // four vertex indices per quad, outward winding (counter-clockwise from outside)
    std::vector<uint32_t> triangles;  // each quad split along its shorter diagonal
    Stats stats;
};

namespace detail {

using sparse_field::blockKey;
using sparse_field::blockOf;
using sparse_field::localIndex;

// Cube corners c = dx | dy << 1 | dz << 2. Edge e = axis * 4 + (u | v << 1), u and v its offsets along the axes
// (axis + 1) % 3 and (axis + 2) % 3.
inline int edgeCorner(int e, int end) {
    const int a = e >> 2, u = e & 1, v = (e >> 1) & 1;
    int off[3] = {0, 0, 0};
    off[a] = end;
    off[(a + 1) % 3] = u;
    off[(a + 2) % 3] = v;
    return off[0] | (off[1] << 1) | (off[2] << 2);
}

/** The four edges of face (axis a, side s), in order around the face, with the corner each pair shares. */
struct Face { int edges[4]; int corners[4]; };
inline Face faceOf(int a, int s) {
    // the face's two in-plane axes p = (a + 1) % 3, q = (a + 2) % 3; corners in order (0,0) (1,0) (1,1) (0,1) over (p, q)
    const int p = (a + 1) % 3, q = (a + 2) % 3;
    Face f{};
    const int pq[4][2] = {{0, 0}, {1, 0}, {1, 1}, {0, 1}};
    for (int i = 0; i < 4; ++i) {
        int off[3] = {0, 0, 0};
        off[a] = s; off[p] = pq[i][0]; off[q] = pq[i][1];
        f.corners[i] = off[0] | (off[1] << 1) | (off[2] << 2);
    }
    // edge between corners i and i+1
    for (int i = 0; i < 4; ++i) {
        const int c0 = f.corners[i], c1 = f.corners[(i + 1) % 4];
        const int diff = c0 ^ c1;
        const int axis = diff == 1 ? 0 : diff == 2 ? 1 : 2;
        const int base = c0 & c1;  // the end with the axis bit clear
        const int off[3] = {base & 1, (base >> 1) & 1, (base >> 2) & 1};
        f.edges[i] = axis * 4 + (off[(axis + 1) % 3] | (off[(axis + 2) % 3] << 1));
    }
    return f;
}

/** Symmetric 3x3 eigen-decomposition by cyclic Jacobi rotations: A = V diag(w) V^T. */
inline void eigenSym3(const double A0[3][3], double w[3], double V[3][3]) {
    double A[3][3];
    for (int i = 0; i < 3; ++i) for (int j = 0; j < 3; ++j) { A[i][j] = A0[i][j]; V[i][j] = i == j; }
    for (int sweep = 0; sweep < 24; ++sweep) {
        const double off = A[0][1] * A[0][1] + A[0][2] * A[0][2] + A[1][2] * A[1][2];
        if (off < 1e-30) break;
        for (int p = 0; p < 2; ++p)
            for (int q = p + 1; q < 3; ++q) {
                if (std::fabs(A[p][q]) < 1e-300) continue;
                const double theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
                const double t = (theta >= 0 ? 1 : -1) / (std::fabs(theta) + std::sqrt(theta * theta + 1));
                const double c = 1 / std::sqrt(t * t + 1), s = t * c;
                for (int k = 0; k < 3; ++k) {
                    const double akp = A[k][p], akq = A[k][q];
                    A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq;
                }
                for (int k = 0; k < 3; ++k) {
                    const double apk = A[p][k], aqk = A[q][k];
                    A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk;
                }
                for (int k = 0; k < 3; ++k) {
                    const double vkp = V[k][p], vkq = V[k][q];
                    V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq;
                }
            }
    }
    for (int i = 0; i < 3; ++i) w[i] = A[i][i];
}

/** A quadratic error function: sum over planes (n, p) of (n . (x - p))^2, kept as A^T A, A^T b, b^T b and a mass point. */
struct Qef {
    double ata[6] = {0, 0, 0, 0, 0, 0};  // xx xy xz yy yz zz
    double atb[3] = {0, 0, 0};
    double btb = 0;
    double mass[3] = {0, 0, 0};
    int n = 0;
    /** The plane through p with normal nn; `at` (default p) joins the mass point. */
    void add(const Vec3& p, const Vec3& nn) { add(p, nn, p); }
    void add(const Vec3& p, const Vec3& nn, const Vec3& at) {
        const double d = nn[0] * p[0] + nn[1] * p[1] + nn[2] * p[2];
        ata[0] += nn[0] * nn[0]; ata[1] += nn[0] * nn[1]; ata[2] += nn[0] * nn[2];
        ata[3] += nn[1] * nn[1]; ata[4] += nn[1] * nn[2]; ata[5] += nn[2] * nn[2];
        atb[0] += nn[0] * d; atb[1] += nn[1] * d; atb[2] += nn[2] * d;
        btb += d * d;
        mass[0] += at[0]; mass[1] += at[1]; mass[2] += at[2];
        ++n;
    }
    void add(const Qef& o) {
        for (int i = 0; i < 6; ++i) ata[i] += o.ata[i];
        for (int i = 0; i < 3; ++i) { atb[i] += o.atb[i]; mass[i] += o.mass[i]; }
        btb += o.btb;
        n += o.n;
    }
    Vec3 massPoint() const { return n ? Vec3{mass[0] / n, mass[1] / n, mass[2] / n} : Vec3{0, 0, 0}; }
    /** Residual sum of squares at x. */
    double error(const Vec3& x) const {
        const double Ax[3] = {ata[0] * x[0] + ata[1] * x[1] + ata[2] * x[2], ata[1] * x[0] + ata[3] * x[1] + ata[4] * x[2], ata[2] * x[0] + ata[4] * x[1] + ata[5] * x[2]};
        return std::max(0.0, x[0] * Ax[0] + x[1] * Ax[1] + x[2] * Ax[2] - 2 * (x[0] * atb[0] + x[1] * atb[1] + x[2] * atb[2]) + btb);
    }
    /** The minimiser about the mass point, eigenvalues below truncation x the largest dropped. */
    Vec3 solve(double truncation) const {
        const Vec3 m = massPoint();
        const double A[3][3] = {{ata[0], ata[1], ata[2]}, {ata[1], ata[3], ata[4]}, {ata[2], ata[4], ata[5]}};
        // r = A^T b - A^T A m
        const double r[3] = {atb[0] - (A[0][0] * m[0] + A[0][1] * m[1] + A[0][2] * m[2]), atb[1] - (A[1][0] * m[0] + A[1][1] * m[1] + A[1][2] * m[2]),
                             atb[2] - (A[2][0] * m[0] + A[2][1] * m[1] + A[2][2] * m[2])};
        double w[3], V[3][3];
        eigenSym3(A, w, V);
        const double wmax = std::max({std::fabs(w[0]), std::fabs(w[1]), std::fabs(w[2])});
        Vec3 x = m;
        if (wmax <= 0) return x;
        for (int k = 0; k < 3; ++k) {
            if (std::fabs(w[k]) < truncation * wmax) continue;
            const double proj = (V[0][k] * r[0] + V[1][k] * r[1] + V[2][k] * r[2]) / w[k];
            for (int i = 0; i < 3; ++i) x[i] += V[i][k] * proj;
        }
        return x;
    }
};

/** One cell with a sign change: its patch of each crossing edge (0xff none) and its first vertex. */
struct CellRec {
    uint32_t firstVertex = 0;
    uint8_t edgePatch[12];
    uint8_t patches = 0;
};

/** The cells of one block (owned by their minimum corner) and their patch QEFs. */
struct BlockCells {
    int bx = 0, by = 0, bz = 0;
    std::array<int32_t, kVox> cell;  // index into recs, -1 for no sign change
    std::vector<CellRec> recs;
    std::vector<Qef> qefs;           // one per patch vertex, in vertex order
    std::vector<Vec3> verts;
    std::vector<uint32_t> vertCell;  // local cell index of each vertex
};

inline Vec3 gradientAt(const SparseField& F, const Vec3& p) {
    const double e = 0.5 * F.voxel;
    Vec3 g;
    for (int k = 0; k < 3; ++k) {
        Vec3 a = p, b = p;
        a[k] += e; b[k] -= e;
        g[k] = F.sample(a) - F.sample(b);
    }
    const double l = std::sqrt(g[0] * g[0] + g[1] * g[1] + g[2] * g[2]);
    if (l > 0) for (double& c : g) c /= l;
    return g;
}


/** Patches the face rule makes from eight corner signs (bit c set: corner c inside). */
inline int patchCount(int inside, const Face* faces) {
    int parent[12];
    bool crosses[12];
    for (int e = 0; e < 12; ++e) { parent[e] = e; crosses[e] = ((inside >> edgeCorner(e, 0)) & 1) != ((inside >> edgeCorner(e, 1)) & 1); }
    auto root = [&](int e) { while (parent[e] != e) e = parent[e] = parent[parent[e]]; return e; };
    for (int fi = 0; fi < 6; ++fi) {
        const Face& f = faces[fi];
        int ce[4], n = 0;
        for (int i = 0; i < 4; ++i) if (crosses[f.edges[i]]) ce[n++] = i;
        auto join = [&](int a, int b) { a = root(a); b = root(b); if (a != b) parent[std::max(a, b)] = std::min(a, b); };
        if (n == 2) join(f.edges[ce[0]], f.edges[ce[1]]);
        else if (n == 4) for (int i = 0; i < 4; ++i) if ((inside >> f.corners[i]) & 1) join(f.edges[(i + 3) % 4], f.edges[i]);
    }
    int count = 0;
    for (int e = 0; e < 12; ++e) count += crosses[e] && root(e) == e;
    return count;
}

/**
 * Ju et al.'s safety test for collapsing a group of cells: at most one patch from its corner signs, and the middle of
 * every group edge, face and the centre agreeing in sign with at least one of the corners it lies between.
 */
template <class Neg>
inline bool safeGroup(int corners, Neg&& neg, int span, int half, const Face* faces) {
    if (patchCount(corners, faces) > 1) return false;
    auto cornerNeg = [&](int c) { return ((corners >> c) & 1) != 0; };
    // edges
    for (int e = 0; e < 12; ++e) {
        const int c0 = edgeCorner(e, 0), c1 = edgeCorner(e, 1);
        const int a = e >> 2;
        int m[3] = {(c0 & 1) * span, ((c0 >> 1) & 1) * span, ((c0 >> 2) & 1) * span};
        m[a] = half;
        const bool s = neg(m[0], m[1], m[2]);
        if (s != cornerNeg(c0) && s != cornerNeg(c1)) return false;
    }
    // faces
    for (int fi = 0; fi < 6; ++fi) {
        const int a = fi >> 1, side = fi & 1;
        int m[3] = {half, half, half};
        m[a] = side * span;
        const bool s = neg(m[0], m[1], m[2]);
        bool any = false;
        for (int i = 0; i < 4; ++i) any = any || cornerNeg(faces[fi].corners[i]) == s;
        if (!any) return false;
    }
    // centre
    const bool s = neg(half, half, half);
    for (int c = 0; c < 8; ++c) if (cornerNeg(c) == s) return true;
    return false;
}

}  // namespace detail

/** Contours the field's zero level set (see the file comment). `mesh`, when given, supplies the sharp normals. */
inline Result contour(const SparseField& F, const Options& o, FixedThreadPool& pool, const MeshSource* mesh = nullptr) {
    using namespace detail;
    using sparse_field::detail::now;
    Result R;
    Stats& st = R.stats;
    const double h = F.voxel;
    const double normalMax = o.normalMaxM > 0 ? o.normalMaxM : h;

    // The blocks whose cells may cross: every stored block, and the unstored blocks just below one (a cell is owned by
    // its minimum corner, so a cell straddling into a stored block from below belongs to that unstored neighbour).
    std::vector<std::array<int, 3>> coords;
    {
        std::vector<uint64_t> keys;
        for (const Block& b : F.blocks)
            for (int d = 0; d < 8; ++d) {
                const int x = b.bx - (d & 1), y = b.by - ((d >> 1) & 1), z = b.bz - ((d >> 2) & 1);
                keys.push_back(blockKey(x, y, z));
            }
        std::sort(keys.begin(), keys.end());
        keys.erase(std::unique(keys.begin(), keys.end()), keys.end());
        constexpr uint64_t m = (uint64_t(1) << 21) - 1;
        coords.reserve(keys.size());
        for (uint64_t k : keys) coords.push_back({static_cast<int>((k >> 42) & m) - (1 << 20), static_cast<int>((k >> 21) & m) - (1 << 20), static_cast<int>(k & m) - (1 << 20)});
    }
    const size_t NB = coords.size();
    std::vector<BlockCells> cells(NB);
    std::unordered_map<uint64_t, uint32_t> cellBlock;
    cellBlock.reserve(NB * 2);
    for (size_t i = 0; i < NB; ++i) cellBlock.emplace(blockKey(coords[i][0], coords[i][1], coords[i][2]), static_cast<uint32_t>(i));

    Face faces[6];
    for (int a = 0; a < 3; ++a) for (int s = 0; s < 2; ++s) faces[a * 2 + s] = faceOf(a, s);

    // 1. Per block: the 9^3 values its cells read, the crossing cells, their patches and patch vertices.
    double t0 = now();
    std::atomic<size_t> aCells{0}, aPatches{0}, aMulti{0}, aMeshN{0}, aFieldN{0}, aClamped{0};
    pool.forEach(NB, [&](size_t bi) {
        BlockCells& C = cells[bi];
        C.bx = coords[bi][0]; C.by = coords[bi][1]; C.bz = coords[bi][2];
        C.cell.fill(-1);
        const int X0 = C.bx * kDim, Y0 = C.by * kDim, Z0 = C.bz * kDim;
        // values on the block plus its +1 layer
        float v[9][9][9];
        bool anyNeg = false, anyPos = false;
        for (int x = 0; x < 9; ++x)
            for (int y = 0; y < 9; ++y)
                for (int z = 0; z < 9; ++z) {
                    const float val = F.at(X0 + x, Y0 + y, Z0 + z);
                    v[x][y][z] = val;
                    (val < 0 ? anyNeg : anyPos) = true;
                }
        if (!anyNeg || !anyPos) return;
        for (int x = 0; x < kDim; ++x)
            for (int y = 0; y < kDim; ++y)
                for (int z = 0; z < kDim; ++z) {
                    float cv[8];
                    int inside = 0;
                    for (int c = 0; c < 8; ++c) {
                        cv[c] = v[x + (c & 1)][y + ((c >> 1) & 1)][z + ((c >> 2) & 1)];
                        inside |= (cv[c] < 0) << c;
                    }
                    if (inside == 0 || inside == 255) continue;
                    // patches of the crossing edges by the face rule
                    int parent[12];
                    bool crosses[12];
                    for (int e = 0; e < 12; ++e) {
                        parent[e] = e;
                        crosses[e] = ((inside >> edgeCorner(e, 0)) & 1) != ((inside >> edgeCorner(e, 1)) & 1);
                    }
                    auto root = [&](int e) { while (parent[e] != e) e = parent[e] = parent[parent[e]]; return e; };
                    auto join = [&](int a, int b) { a = root(a); b = root(b); if (a != b) parent[std::max(a, b)] = std::min(a, b); };
                    for (const Face& f : faces) {
                        int ce[4], n = 0;
                        for (int i = 0; i < 4; ++i) if (crosses[f.edges[i]]) ce[n++] = i;
                        if (n == 2) join(f.edges[ce[0]], f.edges[ce[1]]);
                        else if (n == 4) {
                            // each inside corner i joins its two edges: edge i-1 (into it) and edge i (out of it)
                            for (int i = 0; i < 4; ++i)
                                if ((inside >> f.corners[i]) & 1) join(f.edges[(i + 3) % 4], f.edges[i]);
                        }
                    }
                    CellRec rec;
                    std::fill(std::begin(rec.edgePatch), std::end(rec.edgePatch), 0xff);
                    int patchOfRoot[12];
                    std::fill(std::begin(patchOfRoot), std::end(patchOfRoot), -1);
                    for (int e = 0; e < 12; ++e) {
                        if (!crosses[e]) continue;
                        const int r = root(e);
                        if (patchOfRoot[r] < 0) patchOfRoot[r] = rec.patches++;
                        rec.edgePatch[e] = static_cast<uint8_t>(patchOfRoot[r]);
                    }
                    rec.firstVertex = static_cast<uint32_t>(C.verts.size());
                    // Hermite data and one QEF per patch
                    const size_t q0 = C.qefs.size();
                    C.qefs.resize(q0 + rec.patches);
                    for (int e = 0; e < 12; ++e) {
                        if (!crosses[e]) continue;
                        const int c0 = edgeCorner(e, 0), c1 = edgeCorner(e, 1);
                        const double t = static_cast<double>(cv[c0]) / (static_cast<double>(cv[c0]) - cv[c1]);
                        const Vec3 p0 = F.centre(X0 + x + (c0 & 1), Y0 + y + ((c0 >> 1) & 1), Z0 + z + ((c0 >> 2) & 1));
                        Vec3 p = p0;
                        p[e >> 2] += t * h;
                        Vec3 g = gradientAt(F, p);
                        Vec3 nn = g, onPlane = p;
                        bool fromMesh = false;
                        if (o.sharp && mesh) {
                            // exact Hermite data: the triangle the cell edge itself crosses (nearest the trilinear
                            // crossing when several do), its crossing point and its normal
                            const Vec3 dir = {e >> 2 == 0 ? h : 0.0, e >> 2 == 1 ? h : 0.0, e >> 2 == 2 ? h : 0.0};
                            const auto& wt = mesh->bvh->tris();
                            const int tri = mesh->bvh->nearestAccepted(p, normalMax, [&](uint32_t t) { return sparse_field::detail::segmentHitsTriangle(p0, dir, wt[t]); });
                            if (tri >= 0) {
                                const auto& T = wt[static_cast<size_t>(tri)];
                                Vec3 tn = inner_core::cross(inner_core::sub(T.b, T.a), inner_core::sub(T.c, T.a));
                                const double l = inner_core::len(tn);
                                const double den = l > 0 ? inner_core::dot(tn, dir) : 0;
                                if (std::fabs(den) > 1e-12 * l * h) {
                                    const double s = inner_core::dot(tn, inner_core::sub(T.a, p0)) / den;
                                    tn = inner_core::mul(tn, 1.0 / l);
                                    if (inner_core::dot(tn, g) < 0) tn = inner_core::mul(tn, -1);
                                    nn = tn;
                                    onPlane = inner_core::add(p0, inner_core::mul(dir, std::clamp(s, 0.0, 1.0)));
                                    p = onPlane;
                                    fromMesh = true;
                                }
                            }
                        }
                        (fromMesh ? aMeshN : aFieldN).fetch_add(1, std::memory_order_relaxed);
                        C.qefs[q0 + rec.edgePatch[e]].add(onPlane, nn);
                    }
                    const Vec3 lo = F.centre(X0 + x, Y0 + y, Z0 + z);
                    for (int pi = 0; pi < rec.patches; ++pi) {
                        const Qef& q = C.qefs[q0 + pi];
                        Vec3 xv = o.sharp ? q.solve(o.qefTruncation) : q.massPoint();
                        bool clamped = false;
                        for (int k = 0; k < 3; ++k) {
                            const double a = lo[k], b = lo[k] + h;
                            if (xv[k] < a) { xv[k] = a; clamped = true; }
                            if (xv[k] > b) { xv[k] = b; clamped = true; }
                        }
                        if (clamped) aClamped.fetch_add(1, std::memory_order_relaxed);
                        C.verts.push_back(xv);
                        C.vertCell.push_back(static_cast<uint32_t>((x << 6) | (y << 3) | z));
                    }
                    aPatches.fetch_add(rec.patches, std::memory_order_relaxed);
                    if (rec.patches > 1) aMulti.fetch_add(1, std::memory_order_relaxed);
                    aCells.fetch_add(1, std::memory_order_relaxed);
                    C.cell[(x << 6) | (y << 3) | z] = static_cast<int32_t>(C.recs.size());
                    C.recs.push_back(rec);
                }
    });
    st.cells = aCells; st.patches = aPatches; st.multiPatchCells = aMulti; st.meshNormals = aMeshN; st.fieldNormals = aFieldN; st.clamped = aClamped;
    // global vertex numbering
    std::vector<uint32_t> vbase(NB + 1, 0);
    for (size_t i = 0; i < NB; ++i) vbase[i + 1] = vbase[i] + static_cast<uint32_t>(cells[i].verts.size());
    st.msCells = now() - t0;

    // 2. Adaptive simplification: vertex clusters over 2^k groups of single-patch cells (see the file comment).
    t0 = now();
    std::vector<uint32_t> remap(vbase[NB]);
    for (uint32_t i = 0; i < remap.size(); ++i) remap[i] = i;
    std::vector<Vec3> clusterPos;  // positions of merged vertices, appended after the cell vertices
    if (o.simplifyToleranceM > 0) {
        const double tol2 = o.simplifyToleranceM * o.simplifyToleranceM;
        std::vector<std::vector<std::pair<std::vector<uint32_t>, Vec3>>> found(NB);
        pool.forEach(NB, [&](size_t bi) {
            const BlockCells& C = cells[bi];
            if (C.recs.empty()) return;
            // level by level: a group's members are the cells (or merged groups) of the level below; -2 = not mergeable
            // level 0 state per cell: -1 empty, else its single vertex (cells with several patches block merges)
            struct G { int state; Qef q; std::vector<uint32_t> verts; };
            std::vector<G> cur(kVox);
            for (int c = 0; c < kVox; ++c) {
                const int r = C.cell[c];
                if (r < 0) { cur[c].state = -1; continue; }
                const CellRec& rec = C.recs[r];
                if (rec.patches != 1) { cur[c].state = -2; continue; }
                cur[c].state = 0;
                cur[c].q = C.qefs[rec.firstVertex];
                cur[c].verts = {vbase[bi] + rec.firstVertex};
            }
            int n = kDim;
            std::vector<G> best;
            for (int level = 1; n > 1; ++level) {
                const int m = n / 2;
                std::vector<G> nxt(static_cast<size_t>(m) * m * m);
                for (int x = 0; x < m; ++x)
                    for (int y = 0; y < m; ++y)
                        for (int z = 0; z < m; ++z) {
                            G& g = nxt[(static_cast<size_t>(x) * m + y) * m + z];
                            g.state = -1;
                            bool blocked = false;
                            int members = 0;
                            for (int c = 0; c < 8; ++c) {
                                const G& s = cur[(static_cast<size_t>(2 * x + (c & 1)) * n + 2 * y + ((c >> 1) & 1)) * n + 2 * z + ((c >> 2) & 1)];
                                if (s.state == -2) { blocked = true; break; }
                                if (s.state < 0) continue;
                                ++members;
                                g.q.add(s.q);
                                g.verts.insert(g.verts.end(), s.verts.begin(), s.verts.end());
                            }
                            if (blocked) { g.state = -2; continue; }
                            if (!members) continue;
                            // topology safety (Ju et al. 2002, section 4.1): the group's corner signs make one patch, and
                            // the sign at the middle of each of its edges, faces and its centre agrees with an end corner
                            const int span = 1 << level, half = span >> 1;
                            const int gx = C.bx * kDim + x * span, gy = C.by * kDim + y * span, gz = C.bz * kDim + z * span;
                            auto neg = [&](int i, int j, int k) { return F.at(gx + i, gy + j, gz + k) < 0; };
                            int corners = 0;
                            for (int c = 0; c < 8; ++c) corners |= neg((c & 1) * span, ((c >> 1) & 1) * span, ((c >> 2) & 1) * span) << c;
                            if (!safeGroup(corners, neg, span, half, faces)) { g.state = -2; continue; }
                            const Vec3 xv = g.q.solve(o.qefTruncation);
                            // the merged vertex must stay within the group's box and explain every member's planes
                            const double gs = h * (1 << level);
                            const Vec3 lo = F.centre(C.bx * kDim + 2 * x * (1 << (level - 1)), C.by * kDim + 2 * y * (1 << (level - 1)), C.bz * kDim + 2 * z * (1 << (level - 1)));
                            bool inBox = true;
                            for (int k = 0; k < 3; ++k) inBox = inBox && xv[k] >= lo[k] - 1e-9 && xv[k] <= lo[k] + gs + 1e-9;
                            if (!inBox || g.q.error(xv) > tol2 * g.q.n) { g.state = -2; continue; }
                            g.state = level;
                        }
                // groups that could not merge at this level freeze their members' clusters from the level below
                for (int x = 0; x < m; ++x)
                    for (int y = 0; y < m; ++y)
                        for (int z = 0; z < m; ++z) {
                            if (nxt[(static_cast<size_t>(x) * m + y) * m + z].state != -2) continue;
                            for (int c = 0; c < 8; ++c) {
                                const G& s = cur[(static_cast<size_t>(2 * x + (c & 1)) * n + 2 * y + ((c >> 1) & 1)) * n + 2 * z + ((c >> 2) & 1)];
                                if (s.state >= 1 && s.verts.size() > 1) best.push_back(s);
                            }
                        }
                cur.swap(nxt);
                n = m;
            }
            if (!cur.empty() && cur[0].state >= 1 && cur[0].verts.size() > 1) best.push_back(cur[0]);
            for (G& g : best) found[bi].emplace_back(std::move(g.verts), g.q.solve(o.qefTruncation));
        });
        for (size_t bi = 0; bi < NB; ++bi)
            for (auto& [vs, pos] : found[bi]) {
                const uint32_t id = vbase[NB] + static_cast<uint32_t>(clusterPos.size());
                clusterPos.push_back(pos);
                for (uint32_t v : vs) remap[v] = id;
                ++st.clusters;
                st.clusteredVertices += vs.size();
            }
    }
    st.msSimplify = now() - t0;

    // 3. One quad per crossing edge, owned by the block holding the edge's lower end.
    t0 = now();
    std::vector<std::vector<uint32_t>> quadsOf(NB);
    std::atomic<size_t> aEdges{0};
    auto vertexFor = [&](int cx, int cy, int cz, int edge) -> int64_t {
        const auto it = cellBlock.find(blockKey(blockOf(cx), blockOf(cy), blockOf(cz)));
        if (it == cellBlock.end()) return -1;
        const BlockCells& C = cells[it->second];
        const int r = C.cell[localIndex(cx, cy, cz)];
        if (r < 0) return -1;
        const CellRec& rec = C.recs[r];
        if (rec.edgePatch[edge] == 0xff) return -1;
        return remap[vbase[it->second] + rec.firstVertex + rec.edgePatch[edge]];
    };
    pool.forEach(NB, [&](size_t bi) {
        const BlockCells& C = cells[bi];
        if (C.recs.empty()) return;
        const int X0 = C.bx * kDim, Y0 = C.by * kDim, Z0 = C.bz * kDim;
        for (int a = 0; a < kVox; ++a) {
            const int x = X0 + (a >> 6), y = Y0 + ((a >> 3) & 7), z = Z0 + (a & 7);
            const float v0 = F.at(x, y, z);
            for (int ax = 0; ax < 3; ++ax) {
                const float v1 = F.at(x + (ax == 0), y + (ax == 1), z + (ax == 2));
                if ((v0 < 0) == (v1 < 0)) continue;
                aEdges.fetch_add(1, std::memory_order_relaxed);
                const int p = (ax + 1) % 3, q = (ax + 2) % 3;
                // the four cells around the edge, counter-clockwise about +ax over (p, q): (-,-) (+,-) (+,+) (-,+)
                const int du[4] = {-1, 0, 0, -1}, dv[4] = {-1, -1, 0, 0};
                int64_t vq[4];
                bool ok = true;
                for (int k = 0; k < 4 && ok; ++k) {
                    int c[3] = {x, y, z};
                    c[p] += du[k]; c[q] += dv[k];
                    // the edge within that cell: offsets along p and q are 0 where the cell starts at the edge, 1 where before it
                    const int eu = du[k] < 0 ? 1 : 0, ev = dv[k] < 0 ? 1 : 0;
                    vq[k] = vertexFor(c[0], c[1], c[2], ax * 4 + (eu | (ev << 1)));
                    ok = vq[k] >= 0;
                }
                if (!ok) continue;  // a cell beyond every block (cannot happen inside a band of two or more voxels)
                auto& out = quadsOf[bi];
                if (v0 < 0) out.insert(out.end(), {uint32_t(vq[0]), uint32_t(vq[1]), uint32_t(vq[2]), uint32_t(vq[3])});
                else out.insert(out.end(), {uint32_t(vq[3]), uint32_t(vq[2]), uint32_t(vq[1]), uint32_t(vq[0])});
            }
        }
    });
    st.crossingEdges = aEdges;
    // gather, compact the vertices the quads use
    const uint32_t totalV = vbase[NB] + static_cast<uint32_t>(clusterPos.size());
    std::vector<uint32_t> used(totalV, UINT32_MAX);
    auto posOf = [&](uint32_t id) -> Vec3 {
        if (id >= vbase[NB]) return clusterPos[id - vbase[NB]];
        const size_t bi = static_cast<size_t>(std::upper_bound(vbase.begin(), vbase.end(), id) - vbase.begin()) - 1;
        return cells[bi].verts[id - vbase[bi]];
    };
    for (auto& qs : quadsOf)
        for (size_t i = 0; i + 3 < qs.size(); i += 4) {
            uint32_t q[4] = {qs[i], qs[i + 1], qs[i + 2], qs[i + 3]};
            // merged vertices may repeat: drop repeats; fewer than three distinct corners leave nothing
            uint32_t d[4];
            int nd = 0;
            for (int k = 0; k < 4; ++k) if (nd == 0 || (q[k] != d[nd - 1] && !(k == 3 && q[k] == d[0]))) d[nd++] = q[k];
            if (nd < 3) { ++st.degenerateQuads; continue; }
            for (int k = 0; k < nd; ++k) {
                if (used[d[k]] == UINT32_MAX) {
                    used[d[k]] = static_cast<uint32_t>(R.positions.size() / 3);
                    const Vec3 p = posOf(d[k]);
                    R.positions.push_back(static_cast<float>(p[0])); R.positions.push_back(static_cast<float>(p[1])); R.positions.push_back(static_cast<float>(p[2]));
                }
                d[k] = used[d[k]];
            }
            if (nd == 3) { R.triangles.insert(R.triangles.end(), {d[0], d[1], d[2]}); continue; }
            R.quads.insert(R.quads.end(), {d[0], d[1], d[2], d[3]});
            auto P = [&](uint32_t i) { return Vec3{R.positions[3 * i], R.positions[3 * i + 1], R.positions[3 * i + 2]}; };
            const double d02 = inner_core::len(inner_core::sub(P(d[0]), P(d[2]))), d13 = inner_core::len(inner_core::sub(P(d[1]), P(d[3])));
            if (d02 <= d13) R.triangles.insert(R.triangles.end(), {d[0], d[1], d[2], d[0], d[2], d[3]});
            else R.triangles.insert(R.triangles.end(), {d[0], d[1], d[3], d[1], d[2], d[3]});
        }
    st.vertices = R.positions.size() / 3;
    st.quads = R.quads.size() / 4;
    st.triangles = R.triangles.size() / 3;
    st.msQuads = now() - t0;
    return R;
}

}  // namespace scratchbox::dual_contour
