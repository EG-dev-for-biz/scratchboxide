/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_SCAN_GEOM_HPP
#define SCRATCHBOX_SCAN_GEOM_HPP

/**
 * Geometry kernels shared by the scan fitter (scratchbox_scan_fit.hpp), the facade orthos (scratchbox_scan_ortho.hpp)
 * and the ornament builder (scratchbox_ornament.hpp): a welded scan with adjacency, deterministic area sampling, the
 * exterior (visibility) test, robust plane and circle fits, distance statistics, 2D polygons (signed area, containment,
 * ear clipping with holes through keyhole bridges, Douglas-Peucker) and a binary raster with marching-squares loops.
 *
 * Everything is generic geometry; nothing here knows what a structure is.
 */

#include "scratchbox_bvh.hpp"
#include "scratchbox_gltf_scene.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <functional>
#include <limits>
#include <map>
#include <numeric>
#include <random>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

namespace scratchbox {
namespace scan_geom {

using math::Vec2;
using math::Vec3;
using geometry::ScratchboxMesh;
using geometry::Vertex;

constexpr double kPi = 3.14159265358979323846;

/** A 2D point in a horizontal or chart plane (doubles: fits accumulate in double). */
struct P2 {
    double x{0}, y{0};
    P2() = default;
    P2(double a, double b) : x(a), y(b) {}
    P2 operator+(const P2& o) const { return {x + o.x, y + o.y}; }
    P2 operator-(const P2& o) const { return {x - o.x, y - o.y}; }
    P2 operator*(double s) const { return {x * s, y * s}; }
    double dot(const P2& o) const { return x * o.x + y * o.y; }
    double cross(const P2& o) const { return x * o.y - y * o.x; }
    double len() const { return std::hypot(x, y); }
    P2 unit() const { const double l = len(); return l > 1e-15 ? P2(x / l, y / l) : P2(1, 0); }
};

inline void parallelFor(size_t n, const std::function<void(size_t)>& f) {
    const unsigned T = std::max(1u, std::min(16u, std::thread::hardware_concurrency()));
    if (n < 64 || T == 1) { for (size_t i = 0; i < n; ++i) f(i); return; }
    std::atomic<size_t> next{0};
    std::vector<std::thread> pool;
    for (unsigned t = 0; t < T; ++t) {
        pool.emplace_back([&] {
            for (;;) {
                const size_t i = next.fetch_add(64);
                if (i >= n) break;
                for (size_t k = i; k < std::min(n, i + 64); ++k) f(k);
            }
        });
    }
    for (auto& t : pool) t.join();
}

// ============================================================================================
// The welded scan
// ============================================================================================

struct Scan {
    std::vector<Vec3> pos;           // welded positions (tile frame)
    std::vector<uint32_t> tri;       // 3 welded ids per triangle
    std::vector<Vec3> normal, centroid;
    std::vector<float> area;
    std::vector<uint32_t> adjStart, adj;  // CSR: triangles sharing a welded edge
    std::vector<uint32_t> source;    // the input triangle each one came from
    size_t triangles() const { return tri.size() / 3; }
};

/** Welds at `weldM`, drops degenerate triangles, computes normals, centroids, areas and edge adjacency. */
inline Scan weldScan(const std::vector<Vec3>& positions, const std::vector<uint32_t>& indices, double weldM) {
    Scan s;
    struct Key { int64_t a, b, c; bool operator==(const Key& o) const { return a == o.a && b == o.b && c == o.c; } };
    struct KeyHash { size_t operator()(const Key& k) const { return static_cast<size_t>((k.a * 73856093) ^ (k.b * 19349663) ^ (k.c * 83492791)); } };
    std::unordered_map<Key, uint32_t, KeyHash> map;
    map.reserve(positions.size());
    std::vector<uint32_t> weld(positions.size());
    for (size_t v = 0; v < positions.size(); ++v) {
        const Key k{std::llround(positions[v].x / weldM), std::llround(positions[v].y / weldM), std::llround(positions[v].z / weldM)};
        auto it = map.find(k);
        if (it == map.end()) {
            weld[v] = static_cast<uint32_t>(s.pos.size());
            map.emplace(k, weld[v]);
            s.pos.push_back(positions[v]);
        } else {
            weld[v] = it->second;
        }
    }
    for (size_t t = 0; t + 2 < indices.size(); t += 3) {
        const uint32_t a = weld[indices[t]], b = weld[indices[t + 1]], c = weld[indices[t + 2]];
        if (a == b || b == c || a == c) continue;
        const Vec3 n = (s.pos[b] - s.pos[a]).cross(s.pos[c] - s.pos[a]);
        const float l = n.length();
        if (l < 1e-9f) continue;
        s.tri.insert(s.tri.end(), {a, b, c});
        s.normal.push_back(n / l);
        s.area.push_back(0.5f * l);
        s.centroid.push_back((s.pos[a] + s.pos[b] + s.pos[c]) * (1.0f / 3.0f));
        s.source.push_back(static_cast<uint32_t>(t / 3));
    }
    const size_t T = s.triangles();
    std::vector<std::pair<uint64_t, uint32_t>> edges;
    edges.reserve(3 * T);
    for (uint32_t t = 0; t < T; ++t) {
        for (int j = 0; j < 3; ++j) {
            uint32_t a = s.tri[3 * t + j], b = s.tri[3 * t + (j + 1) % 3];
            if (a > b) std::swap(a, b);
            edges.push_back({(static_cast<uint64_t>(a) << 32) | b, t});
        }
    }
    std::sort(edges.begin(), edges.end());
    std::vector<std::vector<uint32_t>> nb(T);
    for (size_t i = 0; i < edges.size();) {
        size_t j = i;
        while (j < edges.size() && edges[j].first == edges[i].first) ++j;
        for (size_t a = i; a < j; ++a) for (size_t b = i; b < j; ++b) if (a != b) nb[edges[a].second].push_back(edges[b].second);
        i = j;
    }
    s.adjStart.assign(T + 1, 0);
    for (size_t t = 0; t < T; ++t) {
        std::sort(nb[t].begin(), nb[t].end());
        nb[t].erase(std::unique(nb[t].begin(), nb[t].end()), nb[t].end());
        s.adjStart[t + 1] = s.adjStart[t] + static_cast<uint32_t>(nb[t].size());
    }
    s.adj.reserve(s.adjStart[T]);
    for (size_t t = 0; t < T; ++t) s.adj.insert(s.adj.end(), nb[t].begin(), nb[t].end());
    return s;
}

/** The triangles of `s` where keep[t] (welded ids kept as they are). */
inline Scan subScan(const Scan& s, const std::vector<uint8_t>& keep) {
    std::vector<Vec3> p;
    std::vector<uint32_t> idx;
    std::vector<int64_t> remap(s.pos.size(), -1);
    std::vector<uint32_t> src;
    for (size_t t = 0; t < s.triangles(); ++t) {
        if (!keep[t]) continue;
        for (int j = 0; j < 3; ++j) {
            const uint32_t v = s.tri[3 * t + j];
            if (remap[v] < 0) { remap[v] = static_cast<int64_t>(p.size()); p.push_back(s.pos[v]); }
            idx.push_back(static_cast<uint32_t>(remap[v]));
        }
        src.push_back(s.source[t]);
    }
    Scan out = weldScan(p, idx, 1e-6);
    // weldScan renumbers the source to positions in `idx`; map back to the original input triangles
    for (auto& v : out.source) v = src[v];
    return out;
}

/** Connected components over edge adjacency: a label per triangle. */
inline std::vector<int> components(const Scan& s, int* count = nullptr) {
    const size_t T = s.triangles();
    std::vector<int> lab(T, -1);
    int n = 0;
    std::vector<uint32_t> stack;
    for (size_t t = 0; t < T; ++t) {
        if (lab[t] >= 0) continue;
        lab[t] = n;
        stack.assign(1, static_cast<uint32_t>(t));
        while (!stack.empty()) {
            const uint32_t u = stack.back();
            stack.pop_back();
            for (uint32_t e = s.adjStart[u]; e < s.adjStart[u + 1]; ++e) {
                const uint32_t w = s.adj[e];
                if (lab[w] < 0) { lab[w] = n; stack.push_back(w); }
            }
        }
        ++n;
    }
    if (count) *count = n;
    return lab;
}

inline ScratchboxMesh toMesh(const std::vector<Vec3>& pos, const std::vector<uint32_t>& tri) {
    ScratchboxMesh m("scan");
    m.vertices.reserve(pos.size());
    for (const auto& p : pos) m.vertices.push_back(Vertex(p));
    m.indices = tri;
    return m;
}

// ============================================================================================
// Sampling, visibility and distances
// ============================================================================================

struct Sample {
    Vec3 p, n;
    float w{0};          // area represented (m^2)
    uint32_t tri{0};     // source triangle (in the sampled list)
};

/** Area-uniform deterministic samples (`density` per m^2) of the listed triangles (all when `only` is null). */
inline std::vector<Sample> sampleTriangles(const std::vector<Vec3>& pos, const std::vector<uint32_t>& tri, double density, uint64_t seed,
                                           const std::vector<uint8_t>* only = nullptr) {
    std::mt19937_64 rng(seed);
    std::uniform_real_distribution<double> U(0.0, 1.0);
    std::vector<Sample> out;
    const size_t T = tri.size() / 3;
    for (size_t t = 0; t < T; ++t) {
        const Vec3 &a = pos[tri[3 * t]], &b = pos[tri[3 * t + 1]], &c = pos[tri[3 * t + 2]];
        const Vec3 nn = (b - a).cross(c - a);
        const double area = 0.5 * nn.length();
        const double r = U(rng);  // drawn for every triangle: the stream does not depend on `only`
        if (only && !(*only)[t]) continue;
        if (area <= 1e-9) continue;
        const Vec3 n = nn.normalized();
        const double expected = area * density;
        int k = static_cast<int>(expected);
        if (r < expected - k) ++k;
        k = std::max(k, 1);
        for (int i = 0; i < k; ++i) {
            const double r1 = std::sqrt(U(rng)), r2 = U(rng);
            const Vec3 p = a * static_cast<float>(1 - r1) + b * static_cast<float>(r1 * (1 - r2)) + c * static_cast<float>(r1 * r2);
            out.push_back({p, n, static_cast<float>(area / k), static_cast<uint32_t>(t)});
        }
    }
    return out;
}

/** A horizontal plane that blocks rays landing on it near a structure (its ground). */
struct GroundOccluder {
    bool on{false};
    Vec3 n{0, 1, 0};
    double d{0};          // n . p = d
    double cx{0}, cz{0}, radius{0};
};

/**
 * Exterior test: a point is exterior when at least `need` of `rays` Fibonacci-hemisphere rays around its normal escape
 * the mesh (single rays through scan cracks do not count) without landing on the ground occluder near the structure.
 */
inline std::vector<uint8_t> exterior(const bvh::BvhTree& tree, const std::vector<Vec3>& P, const std::vector<Vec3>& N, const GroundOccluder& G,
                                     int rays = 16, int need = 3) {
    std::vector<Vec3> dirs;
    const double ga = kPi * (3.0 - std::sqrt(5.0));
    for (int i = 0; i < rays; ++i) {
        const double z = 0.08 + 0.92 * (i + 0.5) / rays, r = std::sqrt(1 - z * z), a = ga * i;
        dirs.push_back(Vec3(static_cast<float>(r * std::cos(a)), static_cast<float>(r * std::sin(a)), static_cast<float>(z)));
    }
    std::vector<uint8_t> vis(P.size(), 0);
    parallelFor(P.size(), [&](size_t i) {
        const Vec3 n = N[i];
        const Vec3 t = (std::fabs(n.y) < 0.9f ? Vec3(0, 1, 0) : Vec3(1, 0, 0)).cross(n).normalized();
        const Vec3 b = n.cross(t);
        const Vec3 o = P[i] + n * 0.02f;
        int escaped = 0;
        for (const auto& d : dirs) {
            const Vec3 w = t * d.x + b * d.y + n * d.z;
            if (G.on) {
                const double dn = G.n.dot(w);
                if (dn < -1e-4) {
                    const double tt = (G.d - G.n.dot(o)) / dn;
                    const Vec3 hp = o + w * static_cast<float>(tt);
                    if (tt > 0 && std::hypot(hp.x - G.cx, hp.z - G.cz) < G.radius) continue;
                }
            }
            math::Ray ray(o, w);
            if (!tree.raycastAny(ray, 1000.0f) && ++escaped >= need) { vis[i] = 1; break; }
        }
    });
    return vis;
}

/** Unsigned distances from points to a mesh (BVH closest point). */
inline std::vector<float> distancesTo(const std::vector<Vec3>& pts, const bvh::BvhTree& tree) {
    std::vector<float> d(pts.size());
    parallelFor(pts.size(), [&](size_t i) {
        float d2 = 0;
        tree.closestPoint(pts[i], d2);
        d[i] = std::sqrt(d2);
    });
    return d;
}

/** Area-weighted distance statistics (the contract's ResidualStats). */
struct Residual {
    double rms{0}, p50{0}, p95{0}, max{0}, area{0};
    size_t samples{0};
    double inlierFraction{std::numeric_limits<double>::quiet_NaN()};
    double supportFraction{std::numeric_limits<double>::quiet_NaN()};
};

inline Residual residualOf(std::vector<std::pair<double, double>> dw, double inlierBand = -1) {
    Residual r;
    if (dw.empty()) return r;
    std::sort(dw.begin(), dw.end());
    double W = 0, S2 = 0, Win = 0;
    for (const auto& [d, w] : dw) { W += w; S2 += w * d * d; if (inlierBand >= 0 && d <= inlierBand) Win += w; }
    r.area = W;
    r.samples = dw.size();
    r.rms = W > 0 ? std::sqrt(S2 / W) : 0;
    r.max = dw.back().first;
    double acc = 0;
    bool g50 = false, g95 = false;
    for (const auto& [d, w] : dw) {
        acc += w;
        if (!g50 && acc >= 0.5 * W) { r.p50 = d; g50 = true; }
        if (!g95 && acc >= 0.95 * W) { r.p95 = d; g95 = true; }
    }
    if (inlierBand >= 0) r.inlierFraction = W > 0 ? Win / W : 0;
    return r;
}

// ============================================================================================
// Fits
// ============================================================================================

/** Symmetric 3x3 eigen decomposition (Jacobi): eigenvalues ascending, eigenvectors as columns. */
inline void eigSym3(const double A0[3][3], double ev[3], double V[3][3]) {
    double A[3][3], E[3][3];
    for (int i = 0; i < 3; ++i) for (int j = 0; j < 3; ++j) { A[i][j] = A0[i][j]; E[i][j] = i == j; }
    for (int sweep = 0; sweep < 60; ++sweep) {
        const double off = std::fabs(A[0][1]) + std::fabs(A[0][2]) + std::fabs(A[1][2]);
        if (off < 1e-18) break;
        for (int p = 0; p < 2; ++p) for (int q = p + 1; q < 3; ++q) {
            if (std::fabs(A[p][q]) < 1e-21) continue;
            const double th = (A[q][q] - A[p][p]) / (2 * A[p][q]);
            const double t = (th >= 0 ? 1 : -1) / (std::fabs(th) + std::sqrt(th * th + 1));
            const double c = 1 / std::sqrt(t * t + 1), s = t * c;
            for (int k = 0; k < 3; ++k) { const double a = A[k][p], b = A[k][q]; A[k][p] = c * a - s * b; A[k][q] = s * a + c * b; }
            for (int k = 0; k < 3; ++k) { const double a = A[p][k], b = A[q][k]; A[p][k] = c * a - s * b; A[q][k] = s * a + c * b; }
            for (int k = 0; k < 3; ++k) { const double a = E[k][p], b = E[k][q]; E[k][p] = c * a - s * b; E[k][q] = s * a + c * b; }
        }
    }
    int idx[3] = {0, 1, 2};
    std::sort(idx, idx + 3, [&](int a, int b) { return A[a][a] < A[b][b]; });
    for (int k = 0; k < 3; ++k) { ev[k] = A[idx[k]][idx[k]]; for (int i = 0; i < 3; ++i) V[i][k] = E[i][idx[k]]; }
}

struct Plane {
    Vec3 n{0, 1, 0};
    double d{0};  // n . p = d
    double dist(const Vec3& p) const { return n.dot(p) - d; }
};

/** Weighted least-squares plane through points (PCA); its normal agrees with `hint`. */
inline Plane lsPlane(const std::vector<Vec3>& pts, const std::vector<double>& w, const Vec3& hint) {
    double W = 0, c[3] = {0, 0, 0};
    for (size_t i = 0; i < pts.size(); ++i) { W += w[i]; c[0] += w[i] * pts[i].x; c[1] += w[i] * pts[i].y; c[2] += w[i] * pts[i].z; }
    if (W <= 0) return {hint, hint.dot(pts.empty() ? Vec3(0, 0, 0) : pts[0])};
    for (double& v : c) v /= W;
    double C[3][3] = {{0, 0, 0}, {0, 0, 0}, {0, 0, 0}};
    for (size_t i = 0; i < pts.size(); ++i) {
        const double d[3] = {pts[i].x - c[0], pts[i].y - c[1], pts[i].z - c[2]};
        for (int a = 0; a < 3; ++a) for (int b = 0; b < 3; ++b) C[a][b] += w[i] * d[a] * d[b];
    }
    double ev[3], V[3][3];
    eigSym3(C, ev, V);
    Vec3 n(static_cast<float>(V[0][0]), static_cast<float>(V[1][0]), static_cast<float>(V[2][0]));
    if (n.dot(hint) < 0) n = n * -1.0f;
    n = n.normalized();
    return {n, n.x * c[0] + n.y * c[1] + n.z * c[2]};
}

struct Circle { double cx{0}, cy{0}, r{0}; };

/** Algebraic (Kasa) circle through weighted 2D points (x, y, w). */
inline bool circleKasa(const std::vector<std::array<double, 3>>& P, Circle& c) {
    double M[3][3] = {{0, 0, 0}, {0, 0, 0}, {0, 0, 0}}, b[3] = {0, 0, 0};
    for (const auto& q : P) {
        const double x = q[0], y = q[1], w = q[2], z = x * x + y * y, row[3] = {x, y, 1};
        for (int i = 0; i < 3; ++i) { for (int j = 0; j < 3; ++j) M[i][j] += w * row[i] * row[j]; b[i] -= w * row[i] * z; }
    }
    auto det3 = [](const double A[3][3]) {
        return A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) - A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) + A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);
    };
    const double D = det3(M);
    if (std::fabs(D) < 1e-18) return false;
    double sol[3];
    for (int k = 0; k < 3; ++k) {
        double T[3][3];
        for (int i = 0; i < 3; ++i) for (int j = 0; j < 3; ++j) T[i][j] = j == k ? b[i] : M[i][j];
        sol[k] = det3(T) / D;
    }
    c.cx = -sol[0] / 2;
    c.cy = -sol[1] / 2;
    const double r2 = c.cx * c.cx + c.cy * c.cy - sol[2];
    if (!(r2 > 0)) return false;
    c.r = std::sqrt(r2);
    return true;
}

/** Geometric (Gauss-Newton) refinement of a circle; `freeMask` bit 0 cx, 1 cy, 2 r. */
inline void circleGN(const std::vector<std::array<double, 3>>& P, Circle& c, int freeMask = 7, int iters = 40) {
    for (int it = 0; it < iters; ++it) {
        double JTJ[3][3] = {{0, 0, 0}, {0, 0, 0}, {0, 0, 0}}, JTr[3] = {0, 0, 0};
        for (const auto& q : P) {
            const double dx = q[0] - c.cx, dy = q[1] - c.cy, rho = std::hypot(dx, dy);
            if (rho < 1e-9) continue;
            const double r = rho - c.r, w = q[2];
            const double J[3] = {-dx / rho, -dy / rho, -1};
            for (int i = 0; i < 3; ++i) { for (int j = 0; j < 3; ++j) JTJ[i][j] += w * J[i] * J[j]; JTr[i] += w * J[i] * r; }
        }
        for (int i = 0; i < 3; ++i) {
            if (!(freeMask >> i & 1)) { for (int j = 0; j < 3; ++j) { JTJ[i][j] = JTJ[j][i] = 0; } JTJ[i][i] = 1; JTr[i] = 0; }
            JTJ[i][i] *= 1.0 + 1e-9;
        }
        double A[3][4];
        for (int i = 0; i < 3; ++i) { for (int j = 0; j < 3; ++j) A[i][j] = JTJ[i][j]; A[i][3] = -JTr[i]; }
        bool ok = true;
        for (int col = 0; col < 3 && ok; ++col) {
            int piv = col;
            for (int r = col + 1; r < 3; ++r) if (std::fabs(A[r][col]) > std::fabs(A[piv][col])) piv = r;
            std::swap(A[col], A[piv]);
            if (std::fabs(A[col][col]) < 1e-15) { ok = false; break; }
            for (int r = 0; r < 3; ++r) if (r != col) { const double f = A[r][col] / A[col][col]; for (int k = col; k < 4; ++k) A[r][k] -= f * A[col][k]; }
        }
        if (!ok) return;
        const double d0 = A[0][3] / A[0][0], d1 = A[1][3] / A[1][1], d2 = A[2][3] / A[2][2];
        c.cx += d0; c.cy += d1; c.r += d2;
        if (std::fabs(d0) + std::fabs(d1) + std::fabs(d2) < 1e-10) break;
    }
}

inline double circleRms(const std::vector<std::array<double, 3>>& P, const Circle& c, double* maxAbs = nullptr) {
    double S = 0, W = 0, m = 0;
    for (const auto& q : P) { const double r = std::hypot(q[0] - c.cx, q[1] - c.cy) - c.r; S += q[2] * r * r; W += q[2]; m = std::max(m, std::fabs(r)); }
    if (maxAbs) *maxAbs = m;
    return W > 0 ? std::sqrt(S / W) : 0;
}

/** RANSAC (Kasa on 3 points) then Gauss-Newton on the inliers; keeps only points within `tau`. Deterministic. */
inline bool circleRansac(std::vector<std::array<double, 3>>& P, Circle& C, double tau, double rMin, double rMax, uint64_t seed, int iters = 3000) {
    if (P.size() < 3) return false;
    std::mt19937_64 rng(seed);
    std::uniform_int_distribution<size_t> U(0, P.size() - 1);
    double best = -1;
    for (int it = 0; it < iters; ++it) {
        std::vector<std::array<double, 3>> three{P[U(rng)], P[U(rng)], P[U(rng)]};
        Circle c;
        if (!circleKasa(three, c) || c.r < rMin || c.r > rMax) continue;
        double w = 0;
        for (const auto& q : P) if (std::fabs(std::hypot(q[0] - c.cx, q[1] - c.cy) - c.r) < tau) w += q[2];
        if (w > best) { best = w; C = c; }
    }
    if (best < 0) return false;
    for (int r = 0; r < 3; ++r) {
        std::vector<std::array<double, 3>> in;
        for (const auto& q : P) if (std::fabs(std::hypot(q[0] - C.cx, q[1] - C.cy) - C.r) < tau * (r == 0 ? 2 : 1)) in.push_back(q);
        if (in.size() >= 3) circleGN(in, C);
    }
    std::vector<std::array<double, 3>> in;
    for (const auto& q : P) if (std::fabs(std::hypot(q[0] - C.cx, q[1] - C.cy) - C.r) < tau) in.push_back(q);
    P.swap(in);
    return P.size() >= 3 && C.r >= rMin && C.r <= rMax;
}

/** Weighted least-squares 2D line (PCA): unit direction and a point on it; rms of perpendicular distances. */
inline void line2(const std::vector<P2>& pts, P2& point, P2& dir, double* rms = nullptr) {
    double cx = 0, cy = 0;
    for (const auto& p : pts) { cx += p.x; cy += p.y; }
    cx /= std::max<size_t>(1, pts.size()); cy /= std::max<size_t>(1, pts.size());
    double sxx = 0, sxy = 0, syy = 0;
    for (const auto& p : pts) { const double dx = p.x - cx, dy = p.y - cy; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
    const double th = 0.5 * std::atan2(2 * sxy, sxx - syy);
    dir = P2(std::cos(th), std::sin(th));
    point = P2(cx, cy);
    if (rms) {
        double s = 0;
        for (const auto& p : pts) { const double d = (p - point).cross(dir); s += d * d; }
        *rms = pts.empty() ? 0 : std::sqrt(s / pts.size());
    }
}

// ============================================================================================
// 2D polygons
// ============================================================================================

inline double signedArea(const std::vector<P2>& p) {
    double a = 0;
    for (size_t i = 0, j = p.size() - 1; i < p.size(); j = i++) a += p[j].x * p[i].y - p[i].x * p[j].y;
    return 0.5 * a;
}

inline bool insidePolygon(const std::vector<P2>& poly, double x, double y) {
    bool in = false;
    for (size_t i = 0, j = poly.size() - 1; i < poly.size(); j = i++) {
        if ((poly[i].y > y) != (poly[j].y > y) && x < (poly[j].x - poly[i].x) * (y - poly[i].y) / (poly[j].y - poly[i].y) + poly[i].x) in = !in;
    }
    return in;
}

inline double segmentDistance(const P2& p, const P2& a, const P2& b) {
    const P2 ab = b - a;
    const double l2 = ab.dot(ab);
    const double t = l2 > 0 ? std::clamp((p - a).dot(ab) / l2, 0.0, 1.0) : 0.0;
    return (p - (a + ab * t)).len();
}

inline double polygonDistance(const std::vector<P2>& poly, const P2& p) {
    double d = std::numeric_limits<double>::infinity();
    for (size_t i = 0, j = poly.size() - 1; i < poly.size(); j = i++) d = std::min(d, segmentDistance(p, poly[j], poly[i]));
    return d;
}

/** Douglas-Peucker on a closed loop: indices of the kept points. */
inline std::vector<size_t> douglasPeuckerClosed(const std::vector<P2>& pts, double tol) {
    const size_t n = pts.size();
    if (n < 4) { std::vector<size_t> all(n); std::iota(all.begin(), all.end(), 0); return all; }
    // split at the two farthest-apart points
    size_t a = 0, b = 0;
    double far = -1;
    for (size_t i = 0; i < n; ++i) { const double d = (pts[i] - pts[0]).len(); if (d > far) { far = d; a = i; } }
    far = -1;
    for (size_t i = 0; i < n; ++i) { const double d = (pts[i] - pts[a]).len(); if (d > far) { far = d; b = i; } }
    std::vector<uint8_t> keep(n, 0);
    keep[a] = keep[b] = 1;
    std::function<void(size_t, size_t)> rec = [&](size_t i, size_t j) {  // open run from i to j (indices mod n)
        const size_t len = (j + n - i) % n;
        if (len < 2) return;
        double worst = -1;
        size_t at = i;
        for (size_t k = 1; k < len; ++k) {
            const size_t m = (i + k) % n;
            const double d = segmentDistance(pts[m], pts[i], pts[j]);
            if (d > worst) { worst = d; at = m; }
        }
        if (worst > tol) { keep[at] = 1; rec(i, at); rec(at, j); }
    };
    rec(a, b);
    rec(b, a);
    std::vector<size_t> out;
    for (size_t i = 0; i < n; ++i) if (keep[i]) out.push_back(i);
    return out;
}

/**
 * Ear clipping of a polygon with holes (outer counter-clockwise or not; holes any winding): holes are bridged into the
 * outer loop through keyholes (rightmost hole vertex to the nearest visible outer vertex), then ears are clipped. Returns
 * index triples into `verts` (outer then the holes, concatenated), wound counter-clockwise (positive area).
 */
inline std::vector<uint32_t> triangulate(const std::vector<P2>& outer, const std::vector<std::vector<P2>>& holes, std::vector<P2>& verts) {
    verts.clear();
    std::vector<uint32_t> loop;
    std::vector<P2> o = outer;
    if (signedArea(o) < 0) std::reverse(o.begin(), o.end());
    for (const auto& p : o) { loop.push_back(static_cast<uint32_t>(verts.size())); verts.push_back(p); }
    // holes, rightmost first, clockwise
    std::vector<std::vector<uint32_t>> hs;
    for (auto h : holes) {
        if (h.size() < 3) continue;
        if (signedArea(h) > 0) std::reverse(h.begin(), h.end());
        std::vector<uint32_t> ids;
        for (const auto& p : h) { ids.push_back(static_cast<uint32_t>(verts.size())); verts.push_back(p); }
        hs.push_back(ids);
    }
    std::sort(hs.begin(), hs.end(), [&](const auto& A, const auto& B) {
        double ma = -1e300, mb = -1e300;
        for (uint32_t i : A) ma = std::max(ma, verts[i].x);
        for (uint32_t i : B) mb = std::max(mb, verts[i].x);
        return ma > mb;
    });
    for (const auto& h : hs) {
        size_t hi = 0;
        for (size_t i = 1; i < h.size(); ++i) if (verts[h[i]].x > verts[h[hi]].x) hi = i;
        const P2 M = verts[h[hi]];
        // nearest outer-loop vertex to the right whose connecting segment crosses no loop edge
        long best = -1;
        double bestD = std::numeric_limits<double>::infinity();
        for (size_t i = 0; i < loop.size(); ++i) {
            const P2 V = verts[loop[i]];
            const double d = (V - M).len();
            if (d >= bestD) continue;
            bool crosses = false;
            for (size_t k = 0; k < loop.size() && !crosses; ++k) {
                const P2 a = verts[loop[k]], b = verts[loop[(k + 1) % loop.size()]];
                if (loop[k] == loop[i] || loop[(k + 1) % loop.size()] == loop[i]) continue;
                const double d1 = (b - a).cross(M - a), d2 = (b - a).cross(V - a), d3 = (V - M).cross(a - M), d4 = (V - M).cross(b - M);
                if (((d1 > 0) != (d2 > 0)) && ((d3 > 0) != (d4 > 0))) crosses = true;
            }
            for (size_t k = 0; k < h.size() && !crosses; ++k) {
                const P2 a = verts[h[k]], b = verts[h[(k + 1) % h.size()]];
                if (h[k] == h[hi] || h[(k + 1) % h.size()] == h[hi]) continue;
                const double d1 = (b - a).cross(M - a), d2 = (b - a).cross(V - a), d3 = (V - M).cross(a - M), d4 = (V - M).cross(b - M);
                if (((d1 > 0) != (d2 > 0)) && ((d3 > 0) != (d4 > 0))) crosses = true;
            }
            if (!crosses) { bestD = d; best = static_cast<long>(i); }
        }
        if (best < 0) continue;  // unbridgeable hole: left out
        std::vector<uint32_t> next(loop.begin(), loop.begin() + best + 1);
        for (size_t k = 0; k <= h.size(); ++k) next.push_back(h[(hi + k) % h.size()]);
        next.insert(next.end(), loop.begin() + best, loop.end());
        loop.swap(next);
    }
    std::vector<uint32_t> out;
    auto area2 = [&](uint32_t a, uint32_t b, uint32_t c) { return (verts[b] - verts[a]).cross(verts[c] - verts[a]); };
    size_t guard = 0;
    while (loop.size() > 3 && guard++ < 100000) {
        bool clipped = false;
        const size_t n = loop.size();
        for (size_t i = 0; i < n; ++i) {
            const uint32_t a = loop[(i + n - 1) % n], b = loop[i], c = loop[(i + 1) % n];
            if (area2(a, b, c) <= 1e-12) continue;
            bool contains = false;
            for (size_t k = 0; k < n && !contains; ++k) {
                const uint32_t q = loop[k];
                if (q == a || q == b || q == c) continue;
                const P2 Q = verts[q];
                if ((Q - verts[a]).len() < 1e-12 || (Q - verts[b]).len() < 1e-12 || (Q - verts[c]).len() < 1e-12) continue;
                const double d1 = (verts[b] - verts[a]).cross(Q - verts[a]), d2 = (verts[c] - verts[b]).cross(Q - verts[b]), d3 = (verts[a] - verts[c]).cross(Q - verts[c]);
                if (d1 >= -1e-12 && d2 >= -1e-12 && d3 >= -1e-12) contains = true;
            }
            if (contains) continue;
            out.insert(out.end(), {a, b, c});
            loop.erase(loop.begin() + static_cast<long>(i));
            clipped = true;
            break;
        }
        if (!clipped) {
            // degenerate remainder: clip the most convex vertex
            size_t pick = 0;
            double bestA = -1e300;
            for (size_t i = 0; i < n; ++i) { const double ar = area2(loop[(i + n - 1) % n], loop[i], loop[(i + 1) % n]); if (ar > bestA) { bestA = ar; pick = i; } }
            if (bestA > 1e-12) out.insert(out.end(), {loop[(pick + n - 1) % n], loop[pick], loop[(pick + 1) % n]});
            loop.erase(loop.begin() + static_cast<long>(pick));
        }
    }
    if (loop.size() == 3 && area2(loop[0], loop[1], loop[2]) > 1e-12) out.insert(out.end(), {loop[0], loop[1], loop[2]});
    return out;
}

// ============================================================================================
// Binary raster and marching squares
// ============================================================================================

struct Raster {
    double x0{0}, z0{0}, cell{0.05};  // cell (i, k) covers [x0 + i cell, x0 + (i + 1) cell) x [z0 + k cell, ...)
    int nx{0}, nz{0};
    std::vector<uint8_t> v;
    void init(double minX, double minZ, double maxX, double maxZ, double c) {
        cell = c; x0 = minX; z0 = minZ;
        nx = std::max(1, static_cast<int>(std::ceil((maxX - minX) / c)));
        nz = std::max(1, static_cast<int>(std::ceil((maxZ - minZ) / c)));
        v.assign(static_cast<size_t>(nx) * static_cast<size_t>(nz), 0);
    }
    size_t id(int i, int k) const { return static_cast<size_t>(k) * static_cast<size_t>(nx) + static_cast<size_t>(i); }
    bool in(int i, int k) const { return i >= 0 && k >= 0 && i < nx && k < nz; }
    uint8_t at(int i, int k) const { return in(i, k) ? v[id(i, k)] : 0; }
    double cx(int i) const { return x0 + (i + 0.5) * cell; }
    double cz(int k) const { return z0 + (k + 0.5) * cell; }
    int ix(double x) const { return static_cast<int>(std::floor((x - x0) / cell)); }
    int iz(double z) const { return static_cast<int>(std::floor((z - z0) / cell)); }
    size_t count() const { size_t n = 0; for (uint8_t c : v) n += c ? 1 : 0; return n; }
};

/** A raster as a grey PNG (x right, z down; 8 px per source cell at most), for diagnostics. */
inline std::vector<uint8_t> rasterPng(const Raster& R, const Raster* second = nullptr) {
    texture::ImageBuffer img(R.nx, R.nz, 3, 20);
    for (int k = 0; k < R.nz; ++k) for (int i = 0; i < R.nx; ++i) {
        const bool a = R.at(i, k) != 0, b = second && second->at(i, k) != 0;
        uint8_t* p = &img.data[img.getIndex(i, k)];
        p[0] = a ? 230 : (b ? 60 : 20); p[1] = a ? 230 : (b ? 200 : 20); p[2] = a ? 230 : (b ? 60 : 20);
    }
    return texture::encodePng(img);
}

/** Marks the cells a segment crosses (sampled at a quarter cell). */
inline void rasterSegment(Raster& R, double ax, double az, double bx, double bz) {
    const double len = std::hypot(bx - ax, bz - az);
    const int steps = std::max(1, static_cast<int>(std::ceil(len / (0.25 * R.cell))));
    for (int s = 0; s <= steps; ++s) {
        const double t = static_cast<double>(s) / steps;
        const int i = R.ix(ax + t * (bx - ax)), k = R.iz(az + t * (bz - az));
        if (R.in(i, k)) R.v[R.id(i, k)] = 1;
    }
}

inline Raster dilate(const Raster& R, int r) {
    Raster o = R;
    for (int k = 0; k < R.nz; ++k) for (int i = 0; i < R.nx; ++i) {
        if (!R.v[R.id(i, k)]) continue;
        for (int dk = -r; dk <= r; ++dk) for (int di = -r; di <= r; ++di) if (R.in(i + di, k + dk)) o.v[o.id(i + di, k + dk)] = 1;
    }
    return o;
}

inline Raster erode(const Raster& R, int r) {
    Raster o = R;
    for (int k = 0; k < R.nz; ++k) for (int i = 0; i < R.nx; ++i) {
        if (!R.v[R.id(i, k)]) continue;
        bool all = true;
        for (int dk = -r; dk <= r && all; ++dk) for (int di = -r; di <= r && all; ++di) all = R.at(i + di, k + dk) != 0;
        if (!all) o.v[o.id(i, k)] = 0;
    }
    return o;
}

/** Cells not reachable from the border through cells where `wall` is 0 (4-connected flood): enclosed or wall. */
inline Raster enclosed(const Raster& wall) {
    Raster out = wall;
    std::vector<uint8_t> outside(wall.v.size(), 0);
    std::vector<size_t> stack;
    auto push = [&](int i, int k) {
        if (!wall.in(i, k)) return;
        const size_t c = wall.id(i, k);
        if (outside[c] || wall.v[c]) return;
        outside[c] = 1;
        stack.push_back(c);
    };
    for (int i = 0; i < wall.nx; ++i) { push(i, 0); push(i, wall.nz - 1); }
    for (int k = 0; k < wall.nz; ++k) { push(0, k); push(wall.nx - 1, k); }
    while (!stack.empty()) {
        const size_t c = stack.back();
        stack.pop_back();
        const int i = static_cast<int>(c % static_cast<size_t>(wall.nx)), k = static_cast<int>(c / static_cast<size_t>(wall.nx));
        push(i + 1, k); push(i - 1, k); push(i, k + 1); push(i, k - 1);
    }
    for (size_t c = 0; c < out.v.size(); ++c) out.v[c] = outside[c] ? 0 : 1;
    return out;
}

/** 4-connected components of set cells: a label per cell (-1 unset) and the count. */
inline std::vector<int> rasterComponents(const Raster& R, int* count) {
    std::vector<int> lab(R.v.size(), -1);
    int n = 0;
    std::vector<size_t> stack;
    for (size_t c0 = 0; c0 < R.v.size(); ++c0) {
        if (!R.v[c0] || lab[c0] >= 0) continue;
        lab[c0] = n;
        stack.assign(1, c0);
        while (!stack.empty()) {
            const size_t c = stack.back();
            stack.pop_back();
            const int i = static_cast<int>(c % static_cast<size_t>(R.nx)), k = static_cast<int>(c / static_cast<size_t>(R.nx));
            const int D[4][2] = {{1, 0}, {-1, 0}, {0, 1}, {0, -1}};
            for (const auto& d : D) {
                if (!R.in(i + d[0], k + d[1])) continue;
                const size_t j = R.id(i + d[0], k + d[1]);
                if (R.v[j] && lab[j] < 0) { lab[j] = n; stack.push_back(j); }
            }
        }
        ++n;
    }
    if (count) *count = n;
    return lab;
}

/**
 * Closed boundary loops of the set cells (marching squares at the cell centres; saddles resolved as separated), as
 * points in raster coordinates (x, z). Every loop is returned; nesting decides outer and hole.
 */
inline std::vector<std::vector<P2>> rasterLoops(const Raster& R) {
    // corners (i, k) for i in [0, nx], k in [0, nz] sit at cell centres i - 1/2 ...; use a padded grid of cell values
    auto val = [&](int i, int k) { return R.at(i, k) ? 1 : 0; };
    // edges between grid samples (cell centres); an edge key identifies the crossing point
    struct Seg { uint64_t a, b; };
    std::vector<Seg> segs;
    auto key = [&](int i, int k, int dir) {  // crossing on the edge from sample (i, k) to (i + 1, k) (dir 0) or (i, k + 1) (dir 1)
        return (static_cast<uint64_t>(static_cast<uint32_t>(i + 2)) << 33) | (static_cast<uint64_t>(static_cast<uint32_t>(k + 2)) << 1) | static_cast<uint64_t>(dir);
    };
    for (int k = -1; k < R.nz; ++k) {
        for (int i = -1; i < R.nx; ++i) {
            const int a = val(i, k), b = val(i + 1, k), c = val(i + 1, k + 1), d = val(i, k + 1);
            const int code = a | (b << 1) | (c << 2) | (d << 3);
            if (code == 0 || code == 15) continue;
            const uint64_t top = key(i, k, 0), right = key(i + 1, k, 1), bottom = key(i, k + 1, 0), left = key(i, k, 1);
            // segments oriented with the set cells on their left (in x right, z down image coordinates this is clockwise)
            switch (code) {
                case 1: segs.push_back({left, top}); break;
                case 2: segs.push_back({top, right}); break;
                case 3: segs.push_back({left, right}); break;
                case 4: segs.push_back({right, bottom}); break;
                case 5: segs.push_back({left, top}); segs.push_back({right, bottom}); break;
                case 6: segs.push_back({top, bottom}); break;
                case 7: segs.push_back({left, bottom}); break;
                case 8: segs.push_back({bottom, left}); break;
                case 9: segs.push_back({bottom, top}); break;
                case 10: segs.push_back({top, right}); segs.push_back({bottom, left}); break;
                case 11: segs.push_back({bottom, right}); break;
                case 12: segs.push_back({right, left}); break;
                case 13: segs.push_back({right, top}); break;
                case 14: segs.push_back({top, left}); break;
                default: break;
            }
        }
    }
    auto pointOf = [&](uint64_t k) {
        const int dir = static_cast<int>(k & 1);
        const int kk = static_cast<int>((k >> 1) & 0xFFFFFFFFu) - 2;
        const int ii = static_cast<int>(k >> 33) - 2;
        const double x = R.x0 + (ii + 0.5 + (dir == 0 ? 0.5 : 0.0)) * R.cell;
        const double z = R.z0 + (kk + 0.5 + (dir == 1 ? 0.5 : 0.0)) * R.cell;
        return P2(x, z);
    };
    std::unordered_map<uint64_t, std::vector<size_t>> from;
    for (size_t s = 0; s < segs.size(); ++s) from[segs[s].a].push_back(s);
    std::vector<uint8_t> used(segs.size(), 0);
    std::vector<std::vector<P2>> loops;
    for (size_t s0 = 0; s0 < segs.size(); ++s0) {
        if (used[s0]) continue;
        std::vector<P2> loop;
        size_t s = s0;
        while (!used[s]) {
            used[s] = 1;
            loop.push_back(pointOf(segs[s].a));
            auto it = from.find(segs[s].b);
            if (it == from.end()) break;
            size_t nextSeg = s;
            for (size_t c : it->second) if (!used[c]) { nextSeg = c; break; }
            if (nextSeg == s) break;
            s = nextSeg;
        }
        if (loop.size() >= 3) loops.push_back(std::move(loop));
    }
    return loops;
}

// ============================================================================================
// Nearest triangle (uniform grid): distance and which triangle
// ============================================================================================

/** Closest point on triangle abc to p (Ericson). */
inline Vec3 closestOnTriangle(const Vec3& p, const Vec3& a, const Vec3& b, const Vec3& c) {
    const Vec3 ab = b - a, ac = c - a, ap = p - a;
    const float d1 = ab.dot(ap), d2 = ac.dot(ap);
    if (d1 <= 0 && d2 <= 0) return a;
    const Vec3 bp = p - b;
    const float d3 = ab.dot(bp), d4 = ac.dot(bp);
    if (d3 >= 0 && d4 <= d3) return b;
    const float vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) return a + ab * (d1 / (d1 - d3));
    const Vec3 cp = p - c;
    const float d5 = ab.dot(cp), d6 = ac.dot(cp);
    if (d6 >= 0 && d5 <= d6) return c;
    const float vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) return a + ac * (d2 / (d2 - d6));
    const float va = d3 * d6 - d5 * d4;
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) return b + (c - b) * ((d4 - d3) / ((d4 - d3) + (d5 - d6)));
    const float den = 1.0f / (va + vb + vc);
    return a + ab * (vb * den) + ac * (vc * den);
}

/**
 * Triangles bucketed in a uniform 3D grid: the nearest triangle to a point, searched shell by shell out to a limit
 * (exact within it). Read-only after build, so safe to query from many threads.
 */
struct TriGrid {
    const std::vector<Vec3>* pos{nullptr};
    const std::vector<uint32_t>* tri{nullptr};
    double cell{1.0};
    Vec3 lo{0, 0, 0};
    int nx{1}, ny{1}, nz{1};
    std::vector<std::vector<uint32_t>> cells;

    void build(const std::vector<Vec3>& P, const std::vector<uint32_t>& T, double cellM) {
        pos = &P; tri = &T; cell = cellM;
        Vec3 l(1e30f, 1e30f, 1e30f), h(-1e30f, -1e30f, -1e30f);
        for (const auto& p : P) { l = Vec3(std::min(l.x, p.x), std::min(l.y, p.y), std::min(l.z, p.z)); h = Vec3(std::max(h.x, p.x), std::max(h.y, p.y), std::max(h.z, p.z)); }
        if (P.empty()) { l = h = Vec3(0, 0, 0); }
        lo = l;
        nx = std::max(1, static_cast<int>(std::ceil((h.x - l.x) / cell)) + 1);
        ny = std::max(1, static_cast<int>(std::ceil((h.y - l.y) / cell)) + 1);
        nz = std::max(1, static_cast<int>(std::ceil((h.z - l.z) / cell)) + 1);
        cells.assign(static_cast<size_t>(nx) * ny * nz, {});
        for (uint32_t t = 0; t < T.size() / 3; ++t) {
            const Vec3 &a = P[T[3 * t]], &b = P[T[3 * t + 1]], &c = P[T[3 * t + 2]];
            const int i0 = ci(std::min({a.x, b.x, c.x}), 0), i1 = ci(std::max({a.x, b.x, c.x}), 0);
            const int j0 = ci(std::min({a.y, b.y, c.y}), 1), j1 = ci(std::max({a.y, b.y, c.y}), 1);
            const int k0 = ci(std::min({a.z, b.z, c.z}), 2), k1 = ci(std::max({a.z, b.z, c.z}), 2);
            for (int k = k0; k <= k1; ++k) for (int j = j0; j <= j1; ++j) for (int i = i0; i <= i1; ++i) cells[id(i, j, k)].push_back(t);
        }
    }
    int ci(double v, int axis) const {
        const double o = axis == 0 ? lo.x : axis == 1 ? lo.y : lo.z;
        const int n = axis == 0 ? nx : axis == 1 ? ny : nz;
        return std::clamp(static_cast<int>(std::floor((v - o) / cell)), 0, n - 1);
    }
    size_t id(int i, int j, int k) const { return (static_cast<size_t>(k) * ny + j) * nx + i; }

    /** Nearest triangle within maxDist: (distance, triangle), or (inf, UINT32_MAX) when none is that near. */
    std::pair<double, uint32_t> nearest(const Vec3& p, double maxDist) const {
        double best = std::numeric_limits<double>::infinity();
        uint32_t bestT = UINT32_MAX;
        if (!pos || cells.empty()) return {best, bestT};
        const int pi = static_cast<int>(std::floor((p.x - lo.x) / cell)), pj = static_cast<int>(std::floor((p.y - lo.y) / cell)), pk = static_cast<int>(std::floor((p.z - lo.z) / cell));
        const int maxRing = static_cast<int>(std::ceil(maxDist / cell)) + 1;
        for (int ring = 0; ring <= maxRing; ++ring) {
            // every cell at Chebyshev distance `ring` from the point's cell
            for (int k = pk - ring; k <= pk + ring; ++k) {
                if (k < 0 || k >= nz) continue;
                for (int j = pj - ring; j <= pj + ring; ++j) {
                    if (j < 0 || j >= ny) continue;
                    for (int i = pi - ring; i <= pi + ring; ++i) {
                        if (i < 0 || i >= nx) continue;
                        if (std::max({std::abs(i - pi), std::abs(j - pj), std::abs(k - pk)}) != ring) continue;
                        for (uint32_t t : cells[id(i, j, k)]) {
                            const Vec3 q = closestOnTriangle(p, (*pos)[(*tri)[3 * t]], (*pos)[(*tri)[3 * t + 1]], (*pos)[(*tri)[3 * t + 2]]);
                            const double d = (q - p).length();
                            if (d < best || (d == best && t < bestT)) { best = d; bestT = t; }
                        }
                    }
                }
            }
            // a triangle found within the cells searched so far is the nearest once the next ring lies beyond it
            if (bestT != UINT32_MAX && best <= ring * cell) break;
        }
        if (best > maxDist) return {std::numeric_limits<double>::infinity(), UINT32_MAX};
        return {best, bestT};
    }
};

} // namespace scan_geom
} // namespace scratchbox

#endif // SCRATCHBOX_SCAN_GEOM_HPP
