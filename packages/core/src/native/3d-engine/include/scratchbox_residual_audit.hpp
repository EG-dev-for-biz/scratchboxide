/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_RESIDUAL_AUDIT_HPP
#define SCRATCHBOX_RESIDUAL_AUDIT_HPP

/**
 * Residual audit, the native half: scan triangles a clean solid does not explain (a staged build's "as-scanned" residual)
 * grouped into connected clusters, and every cluster measured with continuous numbers against the solid, the ground and
 * the other clusters. Nothing here names a kind of object: a cluster is triangles and numbers. The verdict (real object,
 * scan artefact, unsure) is drawn from these numbers by the caller (residual-audit.ts), with its thresholds as parameters.
 *
 * Measures per cluster (metres, square metres, cubic metres, or ratios in [0, 1]):
 *   - size: bounding box; a gravity frame (origin at the footprint centre on the cluster's lowest point, x the horizontal
 *     principal direction, y up) with the extents along it; the principal (PCA) axes with extents a >= b >= c.
 *   - shape: thinness c / a (sheets), elongation b / a (line-like), the main axis' and the sheet normal's verticality.
 *   - surface: area, the area-weighted triangle quality q = 4 sqrt(3) A / sum(l^2) (1 equilateral, 0 a needle), the area
 *     share in slivers (q < sliverQuality), the longest edge; normal coherence |sum(A n)| / sum(A) (1: one flat sheet facing
 *     one way, near 0: a closed surface); the shares facing up, down and sideways; the boundary-edge share (0: closed).
 *   - volume: the vertical envelope over a plan grid (per cell, the cluster's top minus its bottom, or minus its support where
 *     its own sides wall the space in), and its fill of the box.
 *   - copy: the area share of triangles that face the nearest solid surface squarely (normal within copyParallel of the
 *     direction to it) within copyReachM of it: the scan's own copy of a surface the solid already has. Copy triangles and
 *     the rest are clustered apart, except that a copy component whose boundary is at least copyMergeShare shared with one
 *     other component turning towards the solid at that rim joins it (a box's top whose rim meets the box's walls going
 *     down is the box's, not a copy of the roof).
 *   - attachment: the gap from the cluster to the solid (minimum, the share of the cluster within contactTol of it, and the
 *     share of 20 bins along its long axis in which it touches); the share of it inside the closed solid (cut into it); the
 *     gap to the ground; under each plan cell of the footprint, the drop from the cluster's lowest point to the first
 *     surface below (the solid, the ground plane or another cluster): the share grounded (drop <= contactTol, or the space
 *     under it walled in by the cluster's own sides, as under the top of a hollow box; that part also reported as enclosed), the share
 *     open below (drop >= openBelowM: space under it, as under a tank on legs), the share with nothing below within
 *     maxDropM (overhang); the base and the top above what supports it, and above the ground.
 *   - symmetry: horizontal slices through the cluster (triangle-plane intersections), each fitted with a circle (Kasa least
 *     squares): per slice the fit's RMS over its radius and the share of 12 angular sectors the slice fills; the radial
 *     symmetry score is the median of max(0, 1 - rms / (radialTol r)) * sectors; cross-section constancy is 1 minus the
 *     coefficient of variation of the slices' sizes; periodicity is the best normalised autocorrelation of the cluster's
 *     height profile along its frame x axis at a lag of at least two bins, with that lag in metres.
 *   - photo: the mean colour of its triangles' photo and the spread of luminance over them, when the caller gives colours.
 *
 * Input (all little-endian, written by residual-audit.ts): "SBRA" u32 version(1), u32 nSolid, nSolid * 9 f32 (solid
 * triangles), u32 nCand, nCand * 9 f32 (candidate triangles), nCand * 4 f32 (r g b in 0..255 and luminance variance, or
 * all -1 when the triangle has no photo). Output: a JSON report (schema scratchbox.residual-audit/1).
 */

#include "scratchbox_bvh.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <limits>
#include <numeric>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

namespace scratchbox {
namespace residual_audit {

struct D3 {
    double x{0}, y{0}, z{0};
    D3() = default;
    D3(double a, double b, double c) : x(a), y(b), z(c) {}
    D3 operator+(const D3& o) const { return {x + o.x, y + o.y, z + o.z}; }
    D3 operator-(const D3& o) const { return {x - o.x, y - o.y, z - o.z}; }
    D3 operator*(double k) const { return {x * k, y * k, z * k}; }
    double dot(const D3& o) const { return x * o.x + y * o.y + z * o.z; }
    D3 cross(const D3& o) const { return {y * o.z - z * o.y, z * o.x - x * o.z, x * o.y - y * o.x}; }
    double len() const { return std::sqrt(dot(*this)); }
    D3 unit() const { double l = len(); return l > 1e-15 ? (*this) * (1.0 / l) : D3{0, 1, 0}; }
};

/** The measuring parameters (continuous; the defaults are documented in residual-audit.ts and docs/processes). */
struct Params {
    double groundY{-1e300};
    double weldM{0.001};
    double contactTol{0.75};
    double openBelowM{0.75};
    double maxDropM{6.0};
    double sliverQuality{0.15};
    double radialTol{0.25};
    double sliceStepM{0.25};
    double copyReachM{3.0};
    double copyParallel{0.9};
    double copyMergeShare{0.5};
    double minClusterAreaM2{0};
};

struct Input {
    std::vector<D3> solid;      // 3 per triangle
    std::vector<D3> cand;       // 3 per triangle
    std::vector<std::array<float, 4>> photo;  // per candidate triangle
};

inline Input readInput(const std::string& file) {
    std::ifstream in(file, std::ios::binary);
    if (!in) throw std::runtime_error("cannot read " + file);
    char magic[4];
    in.read(magic, 4);
    if (!in || std::memcmp(magic, "SBRA", 4) != 0) throw std::runtime_error(file + ": not a residual-audit input (magic)");
    uint32_t version = 0, n = 0;
    in.read(reinterpret_cast<char*>(&version), 4);
    if (version != 1) throw std::runtime_error(file + ": unknown version " + std::to_string(version));
    Input r;
    auto tris = [&](std::vector<D3>& out) {
        in.read(reinterpret_cast<char*>(&n), 4);
        if (!in) throw std::runtime_error(file + ": truncated");
        std::vector<float> f(static_cast<size_t>(n) * 9);
        in.read(reinterpret_cast<char*>(f.data()), static_cast<std::streamsize>(f.size() * 4));
        if (!in) throw std::runtime_error(file + ": truncated triangles");
        out.reserve(static_cast<size_t>(n) * 3);
        for (size_t i = 0; i < f.size(); i += 3) out.push_back({f[i], f[i + 1], f[i + 2]});
        return n;
    };
    tris(r.solid);
    uint32_t nc = tris(r.cand);
    r.photo.resize(nc);
    if (nc) {
        in.read(reinterpret_cast<char*>(r.photo.data()), static_cast<std::streamsize>(nc) * 16);
        if (!in) throw std::runtime_error(file + ": truncated photo block");
    }
    return r;
}

struct SliceFit { double y{0}, cx{0}, cz{0}, r{0}, rmsRel{0}, sectors{0}, size{0}; size_t points{0}; };

struct Cluster {
    std::vector<uint32_t> tris;
    D3 lo{1e300, 1e300, 1e300}, hi{-1e300, -1e300, -1e300};
    double area{0};
    // gravity frame
    D3 origin, xAxis{1, 0, 0}, zAxis{0, 0, 1};
    double frameL{0}, frameW{0}, frameH{0};
    // principal frame
    std::array<D3, 3> axes;
    std::array<double, 3> extents{0, 0, 0};
    double thinness{0}, elongation{0}, mainAxisVerticality{0}, sheetNormalVerticality{0};
    double qualityMedian{0}, sliverShare{0}, maxEdgeM{0};
    double normalCoherence{0}, upShare{0}, downShare{0}, sideShare{0}, boundaryEdgeShare{0};
    double envelopeVolumeM3{0}, boxVolumeM3{0}, fill{0};
    double minGapToSolidM{0}, medianGapToSolidM{0}, contactShare{0}, contactAlongShare{0}, copyShare{0}, insideShare{0}, gapToGroundM{0};
    size_t footprintCells{0};
    double cellM{0};
    double groundedShare{0}, enclosedShare{0}, openBelowShare{0}, overhangShare{0}, medianDropM{0}, maxDropM{0};
    double supportY{0}, baseAboveSupportM{0}, topAboveSupportM{0}, baseAboveGroundM{0}, topAboveGroundM{0};
    double radialSymmetry{0}, radiusMedianM{0}, crossSectionConstancy{0};
    size_t slicesUsed{0};
    double periodicity{0}, periodM{0};
    bool photo{false};
    double photoRgb[3]{0, 0, 0};
    double photoLumaStd{0}, photoShare{0};
    std::vector<SliceFit> slices;
};

namespace detail {
/** f(i) for i in [0, n) over the machine's cores; each i writes only its own slot, everything shared is read-only. */
template <class F>
inline void parallelFor(size_t n, F&& f) {
    const unsigned workers = static_cast<unsigned>(std::min<size_t>(n, std::max(1u, std::min(std::thread::hardware_concurrency(), 32u))));
    if (workers <= 1) { for (size_t i = 0; i < n; ++i) f(i); return; }
    std::atomic<size_t> next{0};
    std::vector<std::thread> pool;
    pool.reserve(workers);
    for (unsigned w = 0; w < workers; ++w) pool.emplace_back([&] { for (size_t i; (i = next.fetch_add(1)) < n;) f(i); });
    for (auto& t : pool) t.join();
}


inline double triArea(const D3& a, const D3& b, const D3& c) { return 0.5 * (b - a).cross(c - a).len(); }

/** Points over a triangle about `step` apart (its vertices, edge midpoints and an interior lattice). */
inline void samplesOn(const D3& a, const D3& b, const D3& c, double step, std::vector<D3>& out) {
    double L = std::max({(b - a).len(), (c - b).len(), (a - c).len()});
    int n = std::max(1, std::min(40, static_cast<int>(std::ceil(L / std::max(step, 1e-3)))));
    for (int i = 0; i <= n; ++i)
        for (int j = 0; j <= n - i; ++j) {
            double u = static_cast<double>(i) / n, v = static_cast<double>(j) / n;
            out.push_back(a + (b - a) * u + (c - a) * v);
        }
}

/** Symmetric 3x3 eigen-decomposition (Jacobi); eigenvalues descending with their unit eigenvectors. */
inline void eigenSym(double m[3][3], double val[3], D3 vec[3]) {
    double v[3][3] = {{1, 0, 0}, {0, 1, 0}, {0, 0, 1}};
    double a[3][3];
    std::memcpy(a, m, sizeof(a));
    for (int sweep = 0; sweep < 60; ++sweep) {
        double off = std::abs(a[0][1]) + std::abs(a[0][2]) + std::abs(a[1][2]);
        if (off < 1e-14) break;
        for (int p = 0; p < 2; ++p)
            for (int q = p + 1; q < 3; ++q) {
                if (std::abs(a[p][q]) < 1e-18) continue;
                double th = 0.5 * std::atan2(2 * a[p][q], a[q][q] - a[p][p]);
                double c = std::cos(th), s = std::sin(th);
                for (int k = 0; k < 3; ++k) {
                    double akp = a[k][p], akq = a[k][q];
                    a[k][p] = c * akp - s * akq;
                    a[k][q] = s * akp + c * akq;
                }
                for (int k = 0; k < 3; ++k) {
                    double apk = a[p][k], aqk = a[q][k];
                    a[p][k] = c * apk - s * aqk;
                    a[q][k] = s * apk + c * aqk;
                }
                for (int k = 0; k < 3; ++k) {
                    double vkp = v[k][p], vkq = v[k][q];
                    v[k][p] = c * vkp - s * vkq;
                    v[k][q] = s * vkp + c * vkq;
                }
            }
    }
    int idx[3] = {0, 1, 2};
    std::sort(idx, idx + 3, [&](int i, int j) { return a[i][i] > a[j][j]; });
    for (int k = 0; k < 3; ++k) {
        val[k] = a[idx[k]][idx[k]];
        vec[k] = D3{v[0][idx[k]], v[1][idx[k]], v[2][idx[k]]}.unit();
    }
}

inline double median(std::vector<double> v) {
    if (v.empty()) return 0;
    size_t m = v.size() / 2;
    std::nth_element(v.begin(), v.begin() + static_cast<long>(m), v.end());
    return v[m];
}

/** Kasa circle fit in (x, z): centre, radius, RMS of the radial residual. */
inline bool fitCircle(const std::vector<std::pair<double, double>>& p, double& cx, double& cz, double& r, double& rms) {
    if (p.size() < 4) return false;
    double mx = 0, mz = 0;
    for (const auto& q : p) { mx += q.first; mz += q.second; }
    mx /= p.size(); mz /= p.size();
    double suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
    for (const auto& q : p) {
        double u = q.first - mx, v = q.second - mz;
        suu += u * u; svv += v * v; suv += u * v;
        suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u;
    }
    double det = suu * svv - suv * suv;
    if (std::abs(det) < 1e-12) return false;
    double bu = 0.5 * (suuu + suvv), bv = 0.5 * (svvv + svuu);
    double uc = (bu * svv - bv * suv) / det, vc = (svv * 0 + suu * bv - suv * bu) / det;
    cx = mx + uc; cz = mz + vc;
    r = std::sqrt(uc * uc + vc * vc + (suu + svv) / p.size());
    double e = 0;
    for (const auto& q : p) { double d = std::hypot(q.first - cx, q.second - cz) - r; e += d * d; }
    rms = std::sqrt(e / p.size());
    return std::isfinite(r) && r > 1e-6;
}

inline std::string jstr(const std::string& s) {
    std::string o = "\"";
    for (char c : s) {
        if (c == '"' || c == '\\') { o += '\\'; o += c; }
        else if (static_cast<unsigned char>(c) < 0x20) { char b[8]; std::snprintf(b, sizeof b, "\\u%04x", c); o += b; }
        else o += c;
    }
    return o + "\"";
}

inline std::string num(double v) {
    if (!std::isfinite(v)) return "null";
    std::ostringstream s;
    s.precision(6);
    s << v;
    return s.str();
}

}  // namespace detail

class ResidualAudit {
public:
    ResidualAudit(Input in, Params p) : in_(std::move(in)), p_(p) {}

    void run() {
        buildSolid();
        classifyCopies();
        cluster();
        buildIndexes();
        detail::parallelFor(clusters_.size(), [&](size_t k) { measure(k); });
    }

    const std::vector<Cluster>& clusters() const { return clusters_; }

    std::string reportJson() const {
        std::ostringstream js;
        using detail::num;
        auto v3 = [&](const D3& v) { return "[" + num(v.x) + "," + num(v.y) + "," + num(v.z) + "]"; };
        js << "{\"schema\":\"scratchbox.residual-audit/1\",\"solidTriangles\":" << in_.solid.size() / 3 << ",\"candidateTriangles\":" << in_.cand.size() / 3
           << ",\"params\":{\"groundY\":" << num(p_.groundY > -1e299 ? p_.groundY : NAN) << ",\"weldM\":" << num(p_.weldM) << ",\"contactTol\":" << num(p_.contactTol)
           << ",\"openBelowM\":" << num(p_.openBelowM) << ",\"maxDropM\":" << num(p_.maxDropM) << ",\"sliverQuality\":" << num(p_.sliverQuality)
           << ",\"radialTol\":" << num(p_.radialTol) << ",\"sliceStepM\":" << num(p_.sliceStepM) << ",\"copyReachM\":" << num(p_.copyReachM) << ",\"copyParallel\":" << num(p_.copyParallel) << ",\"copyMergeShare\":" << num(p_.copyMergeShare) << ",\"minClusterAreaM2\":" << num(p_.minClusterAreaM2) << "},\"clusters\":[";
        for (size_t k = 0; k < clusters_.size(); ++k) {
            const Cluster& c = clusters_[k];
            js << (k ? "," : "") << "{\"id\":" << k << ",\"triangles\":" << c.tris.size() << ",\"areaM2\":" << num(c.area) << ",\"lo\":" << v3(c.lo) << ",\"hi\":" << v3(c.hi)
               << ",\"frame\":{\"origin\":" << v3(c.origin) << ",\"xAxis\":" << v3(c.xAxis) << ",\"yAxis\":[0,1,0],\"zAxis\":" << v3(c.zAxis)
               << ",\"extentsM\":[" << num(c.frameL) << "," << num(c.frameH) << "," << num(c.frameW) << "]}"
               << ",\"principal\":{\"axes\":[" << v3(c.axes[0]) << "," << v3(c.axes[1]) << "," << v3(c.axes[2]) << "],\"extentsM\":[" << num(c.extents[0]) << "," << num(c.extents[1]) << "," << num(c.extents[2]) << "]}"
               << ",\"shape\":{\"thinness\":" << num(c.thinness) << ",\"elongation\":" << num(c.elongation) << ",\"mainAxisVerticality\":" << num(c.mainAxisVerticality)
               << ",\"sheetNormalVerticality\":" << num(c.sheetNormalVerticality) << "}"
               << ",\"surface\":{\"qualityMedian\":" << num(c.qualityMedian) << ",\"sliverShare\":" << num(c.sliverShare) << ",\"maxEdgeM\":" << num(c.maxEdgeM)
               << ",\"normalCoherence\":" << num(c.normalCoherence) << ",\"upShare\":" << num(c.upShare) << ",\"downShare\":" << num(c.downShare) << ",\"sideShare\":" << num(c.sideShare)
               << ",\"boundaryEdgeShare\":" << num(c.boundaryEdgeShare) << ",\"copyShare\":" << num(c.copyShare) << "}"
               << ",\"volume\":{\"envelopeM3\":" << num(c.envelopeVolumeM3) << ",\"boxM3\":" << num(c.boxVolumeM3) << ",\"fill\":" << num(c.fill) << ",\"cellM\":" << num(c.cellM) << "}"
               << ",\"attachment\":{\"minGapToSolidM\":" << num(c.minGapToSolidM) << ",\"medianGapToSolidM\":" << num(c.medianGapToSolidM) << ",\"contactShare\":" << num(c.contactShare) << ",\"contactAlongShare\":" << num(c.contactAlongShare) << ",\"insideShare\":" << num(c.insideShare)
               << ",\"gapToGroundM\":" << num(c.gapToGroundM) << ",\"footprintCells\":" << c.footprintCells << ",\"groundedShare\":" << num(c.groundedShare) << ",\"enclosedShare\":" << num(c.enclosedShare)
               << ",\"openBelowShare\":" << num(c.openBelowShare) << ",\"overhangShare\":" << num(c.overhangShare) << ",\"medianDropM\":" << num(c.medianDropM) << ",\"maxDropM\":" << num(c.maxDropM)
               << ",\"supportY\":" << num(c.supportY) << ",\"baseAboveSupportM\":" << num(c.baseAboveSupportM) << ",\"topAboveSupportM\":" << num(c.topAboveSupportM)
               << ",\"baseAboveGroundM\":" << num(c.baseAboveGroundM) << ",\"topAboveGroundM\":" << num(c.topAboveGroundM) << "}"
               << ",\"symmetry\":{\"radialSymmetry\":" << num(c.radialSymmetry) << ",\"radiusMedianM\":" << num(c.radiusMedianM) << ",\"slicesUsed\":" << c.slicesUsed
               << ",\"crossSectionConstancy\":" << num(c.crossSectionConstancy) << ",\"periodicity\":" << num(c.periodicity) << ",\"periodM\":" << num(c.periodM) << "}"
               << ",\"slices\":[";
            for (size_t i = 0; i < c.slices.size(); ++i) {
                const SliceFit& f = c.slices[i];
                js << (i ? "," : "") << "{\"y\":" << num(f.y) << ",\"cx\":" << num(f.cx) << ",\"cz\":" << num(f.cz) << ",\"r\":" << num(f.r)
                   << ",\"rmsRel\":" << num(f.rmsRel) << ",\"sectors\":" << num(f.sectors) << ",\"size\":" << num(f.size) << ",\"points\":" << f.points << "}";
            }
            js << "]"
               << ",\"photo\":" << (c.photo ? "{\"rgb\":[" + num(c.photoRgb[0]) + "," + num(c.photoRgb[1]) + "," + num(c.photoRgb[2]) + "],\"lumaStd\":" + num(c.photoLumaStd) + ",\"share\":" + num(c.photoShare) + "}" : std::string("null"))
               << ",\"triangleIds\":[";
            for (size_t i = 0; i < c.tris.size(); ++i) js << (i ? "," : "") << c.tris[i];
            js << "]}";
        }
        js << "]}";
        return js.str();
    }

private:
    Input in_;
    Params p_;
    std::vector<Cluster> clusters_;
    std::vector<int> clusterOf_;  // per candidate triangle
    geometry::ScratchboxMesh solidMesh_, allMesh_;
    bvh::BvhTree solidBvh_, allBvh_;
    std::vector<int> allOwner_;   // per triangle of allMesh_: -1 solid, else the cluster
    std::vector<uint8_t> copy_;   // per candidate triangle: a copy of the solid's surface (see classifyCopies)

    void buildSolid() {
        for (const auto& q : in_.solid) {
            geometry::Vertex v;
            v.position = math::Vec3(static_cast<float>(q.x), static_cast<float>(q.y), static_cast<float>(q.z));
            solidMesh_.indices.push_back(static_cast<uint32_t>(solidMesh_.vertices.size()));
            solidMesh_.vertices.push_back(v);
        }
        if (!solidMesh_.indices.empty()) solidBvh_.build(solidMesh_);
    }

    /**
     * A candidate triangle is a copy of the solid's surface when it faces the nearest solid surface squarely (its normal
     * within copyParallel of the direction to it, or lying on it) within copyReachM. Copies and the rest are clustered
     * apart, so a roof's scanned copy poking through a roof plane is not joined to what stands on that roof.
     */
    void classifyCopies() {
        const size_t M = in_.cand.size() / 3;
        copy_.assign(M, 0);
        if (solidMesh_.indices.empty()) return;
        detail::parallelFor(M, [&](size_t t) {
            D3 a = cv(t, 0), b = cv(t, 1), d = cv(t, 2);
            D3 cr = (b - a).cross(d - a);
            if (cr.len() <= 0) return;
            D3 q = (a + b + d) * (1.0 / 3.0);
            float d2;
            math::Vec3 cp = solidBvh_.closestPoint(math::Vec3(static_cast<float>(q.x), static_cast<float>(q.y), static_cast<float>(q.z)), d2);
            double dist = std::sqrt(static_cast<double>(d2));
            if (dist > p_.copyReachM) return;
            D3 g{q.x - cp.x, q.y - cp.y, q.z - cp.z};
            copy_[t] = dist < 0.05 || std::abs(cr.unit().dot(g.unit())) >= p_.copyParallel;
        });
    }

    D3 cv(size_t t, int k) const { return in_.cand[3 * t + static_cast<size_t>(k)]; }

    /** Connected components of the candidate triangles through shared (welded) vertices. */
    void cluster() {
        const size_t M = in_.cand.size() / 3;
        const double w = std::max(1e-6, p_.weldM);
        auto key = [&](const D3& p) { return (static_cast<int64_t>(std::llround(p.x / w)) * 73856093LL) ^ (static_cast<int64_t>(std::llround(p.y / w)) * 19349663LL) ^ (static_cast<int64_t>(std::llround(p.z / w)) * 83492791LL); };
        std::unordered_map<int64_t, std::vector<uint32_t>> byVert;
        byVert.reserve(M * 3);
        for (size_t t = 0; t < M; ++t) for (int k = 0; k < 3; ++k) byVert[key(cv(t, k))].push_back(static_cast<uint32_t>(t));
        clusterOf_.assign(M, -1);
        std::vector<Cluster> found;
        for (size_t s = 0; s < M; ++s) {
            if (clusterOf_[s] >= 0) continue;
            Cluster c;
            std::vector<uint32_t> st{static_cast<uint32_t>(s)};
            clusterOf_[s] = static_cast<int>(found.size());
            while (!st.empty()) {
                uint32_t t = st.back();
                st.pop_back();
                c.tris.push_back(t);
                for (int k = 0; k < 3; ++k) for (uint32_t j : byVert[key(cv(t, k))]) if (clusterOf_[j] < 0 && copy_[j] == copy_[s]) { clusterOf_[j] = clusterOf_[s]; st.push_back(j); }
            }
            std::sort(c.tris.begin(), c.tris.end());
            for (uint32_t t : c.tris) c.area += detail::triArea(cv(t, 0), cv(t, 1), cv(t, 2));
            found.push_back(std::move(c));
        }
        // a copy component whose boundary is mostly shared with one other component (the top of a box standing on the
        // roof: its whole rim meets the box's walls) belongs to that component, not to the copies of the solid
        {
            auto ekey = [&](int64_t a, int64_t b) { return a < b ? std::make_pair(a, b) : std::make_pair(b, a); };
            struct PH { size_t operator()(const std::pair<int64_t, int64_t>& p) const { return std::hash<int64_t>()(p.first * 1000003LL ^ p.second); } };
            std::unordered_map<std::pair<int64_t, int64_t>, std::vector<uint32_t>, PH> byEdge;
            for (size_t t = 0; t < M; ++t) for (int k = 0; k < 3; ++k) byEdge[ekey(key(cv(t, k)), key(cv(t, (k + 1) % 3)))].push_back(static_cast<uint32_t>(t));
            std::vector<int> mergeInto(found.size(), -1);
            for (size_t k = 0; k < found.size(); ++k) {
                if (found[k].tris.empty() || !copy_[found[k].tris[0]]) continue;
                // a copy inside the solid (the scanned surface below a plane the massing put higher) is never a box's top
                size_t in = 0;
                for (uint32_t t : found[k].tris) if (insideSolid((cv(t, 0) + cv(t, 1) + cv(t, 2)) * (1.0 / 3.0))) ++in;
                if (2 * in >= found[k].tris.size()) continue;
                std::unordered_map<int, size_t> shared;
                size_t boundary = 0;
                for (uint32_t t : found[k].tris) for (int e = 0; e < 3; ++e) {
                    const auto& tri = byEdge[ekey(key(cv(t, e)), key(cv(t, (e + 1) % 3)))];
                    bool inner = false;
                    int other = -1;
                    // the neighbour across this rim edge counts when it turns towards the solid the copy faces (the wall of a
                    // box under its top), not away from it (clutter rising beside a scanned copy of the roof)
                    D3 a = cv(t, 0), b = cv(t, 1), d = cv(t, 2);
                    D3 nrm = (b - a).cross(d - a).unit();
                    D3 q = (a + b + d) * (1.0 / 3.0);
                    float d2;
                    math::Vec3 cp = solidBvh_.closestPoint(math::Vec3(static_cast<float>(q.x), static_cast<float>(q.y), static_cast<float>(q.z)), d2);
                    D3 toSolid = D3{cp.x - q.x, cp.y - q.y, cp.z - q.z};
                    if (nrm.dot(toSolid) > 0) nrm = nrm * -1.0;  // nrm now points away from the solid
                    for (uint32_t u : tri) {
                        if (u == t) continue;
                        if (clusterOf_[u] == static_cast<int>(k)) { inner = true; continue; }
                        D3 c3 = (cv(u, 0) + cv(u, 1) + cv(u, 2)) * (1.0 / 3.0);
                        if ((c3 - q).dot(nrm) < 0) other = clusterOf_[u];
                    }
                    if (inner) continue;
                    ++boundary;
                    if (other >= 0) ++shared[other];
                }
                int best = -1;
                size_t bestN = 0;
                for (const auto& kv : shared) if (kv.second > bestN) { bestN = kv.second; best = kv.first; }
                if (best >= 0 && boundary > 0 && static_cast<double>(bestN) / boundary >= p_.copyMergeShare && !copy_[found[static_cast<size_t>(best)].tris[0]]) mergeInto[k] = best;
            }
            for (size_t k = 0; k < found.size(); ++k) {
                if (mergeInto[k] < 0) continue;
                Cluster& dst = found[static_cast<size_t>(mergeInto[k])];
                for (uint32_t t : found[k].tris) { dst.tris.push_back(t); clusterOf_[t] = mergeInto[k]; }
                dst.area += found[k].area;
                std::sort(dst.tris.begin(), dst.tris.end());
                found[k].tris.clear();
                found[k].area = -1;  // dropped below
            }
        }
        // drop clusters under the area floor (recorded as their own count by the caller through candidateTriangles)
        clusters_.clear();
        std::vector<int> remap(found.size(), -1);
        for (size_t k = 0; k < found.size(); ++k) if (!found[k].tris.empty() && found[k].area >= p_.minClusterAreaM2) { remap[k] = static_cast<int>(clusters_.size()); clusters_.push_back(std::move(found[k])); }
        for (auto& c : clusterOf_) c = c >= 0 ? remap[static_cast<size_t>(c)] : -1;
    }

    void buildIndexes() {
        auto add = [](geometry::ScratchboxMesh& m, const D3& a) {
            geometry::Vertex v;
            v.position = math::Vec3(static_cast<float>(a.x), static_cast<float>(a.y), static_cast<float>(a.z));
            m.indices.push_back(static_cast<uint32_t>(m.vertices.size()));
            m.vertices.push_back(v);
        };
        for (const auto& q : in_.solid) add(allMesh_, q);
        for (size_t t = 0; t < in_.solid.size() / 3; ++t) allOwner_.push_back(-1);
        for (size_t t = 0; t < in_.cand.size() / 3; ++t) {
            if (clusterOf_[t] < 0) continue;
            for (int k = 0; k < 3; ++k) add(allMesh_, cv(t, k));
            allOwner_.push_back(clusterOf_[t]);
        }
        if (!allMesh_.indices.empty()) allBvh_.build(allMesh_);
    }

    double gapToSolid(const D3& q) const {
        if (solidMesh_.indices.empty()) return 1e300;
        float d2;
        solidBvh_.closestPoint(math::Vec3(static_cast<float>(q.x), static_cast<float>(q.y), static_cast<float>(q.z)), d2);
        return std::sqrt(static_cast<double>(d2));
    }

    /** Height of the first surface below q that is not cluster `own` (solid, other clusters, the ground plane), or -1e300. */
    /** Inside the closed solid: crossings of a ray straight up (and one tilted, both must agree). */
    bool insideSolid(const D3& q) const {
        if (solidMesh_.indices.empty()) return false;
        auto parity = [&](const math::Vec3& dir) {
            int n = 0;
            math::Vec3 o(static_cast<float>(q.x), static_cast<float>(q.y), static_cast<float>(q.z));
            for (int guard = 0; guard < 64; ++guard) {
                math::Ray ray(o, dir);
                bvh::RayHit hit;
                if (!solidBvh_.raycast(ray, hit) || !hit.hit) break;
                ++n;
                o = o + ray.direction * (hit.t + 1e-3f);
            }
            return n % 2 == 1;
        };
        return parity(math::Vec3(0, 1, 0)) && parity(math::Vec3(0.31f, 0.9f, 0.22f));
    }

    /** Whether q is walled in by cluster `own` (at least 7 of 8 horizontal rays hit it first within `reach`). */
    bool enclosedBy(const D3& q, int own, double reach) const {
        if (allMesh_.indices.empty()) return false;
        int hits = 0;
        for (int k = 0; k < 8; ++k) {
            double a = k * M_PI / 4 + 0.13;
            math::Ray ray(math::Vec3(static_cast<float>(q.x), static_cast<float>(q.y), static_cast<float>(q.z)), math::Vec3(static_cast<float>(std::cos(a)), 0.0f, static_cast<float>(std::sin(a))));
            bvh::RayHit hit;
            if (allBvh_.raycast(ray, hit) && hit.hit && hit.t <= reach + 1e-3 && allOwner_[hit.triangleIndex] == own) ++hits;
        }
        return hits >= 7;
    }

    double surfaceBelow(const D3& q, int own) const {
        double best = p_.groundY > -1e299 && p_.groundY <= q.y ? p_.groundY : -1e300;
        if (allMesh_.indices.empty()) return best;
        double y = q.y;
        for (int guard = 0; guard < 64; ++guard) {
            math::Ray ray(math::Vec3(static_cast<float>(q.x), static_cast<float>(y), static_cast<float>(q.z)), math::Vec3(0, -1, 0));
            bvh::RayHit hit;
            if (!allBvh_.raycast(ray, hit) || !hit.hit) break;
            double hy = y - hit.t;
            if (hy < best) break;
            if (allOwner_[hit.triangleIndex] != own) { best = std::max(best, hy); break; }
            y = hy - 1e-3;
        }
        return best;
    }

    void measure(size_t k) {
        Cluster& c = clusters_[k];
        const int own = static_cast<int>(k);
        // bounds, area-weighted moments, normals, quality
        double sA = 0;
        D3 mean{0, 0, 0}, nsum{0, 0, 0};
        std::vector<std::pair<double, double>> qual;  // (quality, area)
        double up = 0, down = 0, side = 0;
        std::unordered_map<uint64_t, int> edges;
        const double w = std::max(1e-6, p_.weldM);
        auto vid = [&](const D3& p) { return static_cast<uint64_t>((static_cast<int64_t>(std::llround(p.x / w)) * 73856093LL) ^ (static_cast<int64_t>(std::llround(p.y / w)) * 19349663LL) ^ (static_cast<int64_t>(std::llround(p.z / w)) * 83492791LL)); };
        for (uint32_t t : c.tris) {
            D3 a = cv(t, 0), b = cv(t, 1), d = cv(t, 2);
            for (const D3& q : {a, b, d}) { c.lo = {std::min(c.lo.x, q.x), std::min(c.lo.y, q.y), std::min(c.lo.z, q.z)}; c.hi = {std::max(c.hi.x, q.x), std::max(c.hi.y, q.y), std::max(c.hi.z, q.z)}; }
            D3 cr = (b - a).cross(d - a);
            double A = 0.5 * cr.len();
            double l2 = (b - a).dot(b - a) + (d - b).dot(d - b) + (a - d).dot(a - d);
            c.maxEdgeM = std::max({c.maxEdgeM, (b - a).len(), (d - b).len(), (a - d).len()});
            qual.push_back({l2 > 0 ? 4 * std::sqrt(3.0) * A / l2 : 0, A});
            if (A <= 0) continue;
            D3 n = cr.unit();
            nsum = nsum + n * A;
            if (n.y > 0.7) up += A; else if (n.y < -0.7) down += A; else side += A;
            mean = mean + (a + b + d) * (A / 3.0);
            sA += A;
            uint64_t ia = vid(a), ib = vid(b), id = vid(d);
            auto ek = [](uint64_t x, uint64_t y) { return x < y ? (x * 1000003ULL) ^ y : (y * 1000003ULL) ^ x; };
            ++edges[ek(ia, ib)]; ++edges[ek(ib, id)]; ++edges[ek(id, ia)];
        }
        if (sA <= 0) sA = 1e-12;
        mean = mean * (1.0 / sA);
        c.normalCoherence = nsum.len() / sA;
        c.upShare = up / sA; c.downShare = down / sA; c.sideShare = side / sA;
        size_t boundary = 0;
        for (const auto& e : edges) if (e.second == 1) ++boundary;
        c.boundaryEdgeShare = edges.empty() ? 1 : static_cast<double>(boundary) / edges.size();
        {
            std::sort(qual.begin(), qual.end());
            double acc = 0, sliver = 0;
            c.qualityMedian = qual.empty() ? 0 : qual.back().first;
            for (const auto& q : qual) { if (q.first < p_.sliverQuality) sliver += q.second; }
            for (const auto& q : qual) { acc += q.second; if (acc >= 0.5 * sA) { c.qualityMedian = q.first; break; } }
            c.sliverShare = sliver / sA;
        }
        // samples over the surface (about 0.25 m apart, coarser for big clusters)
        double diag = (c.hi - c.lo).len();
        double step = std::clamp(diag / 60.0, 0.1, 0.5);
        std::vector<D3> pts;
        for (uint32_t t : c.tris) detail::samplesOn(cv(t, 0), cv(t, 1), cv(t, 2), step, pts);
        // principal frame
        {
            double cov[3][3] = {{0, 0, 0}, {0, 0, 0}, {0, 0, 0}};
            for (const auto& q : pts) {
                D3 d = q - mean;
                double v[3] = {d.x, d.y, d.z};
                for (int i = 0; i < 3; ++i) for (int j = 0; j < 3; ++j) cov[i][j] += v[i] * v[j];
            }
            double val[3];
            D3 vec[3];
            detail::eigenSym(cov, val, vec);
            for (int i = 0; i < 3; ++i) {
                double lo = 1e300, hi = -1e300;
                for (const auto& q : pts) { double s = (q - mean).dot(vec[i]); lo = std::min(lo, s); hi = std::max(hi, s); }
                c.axes[static_cast<size_t>(i)] = vec[i];
                c.extents[static_cast<size_t>(i)] = pts.empty() ? 0 : hi - lo;
            }
            // order by extent (the eigen order is by variance; extents decide thinness)
            std::array<int, 3> o{0, 1, 2};
            std::sort(o.begin(), o.end(), [&](int i, int j) { return c.extents[static_cast<size_t>(i)] > c.extents[static_cast<size_t>(j)]; });
            auto ax = c.axes;
            auto ex = c.extents;
            for (int i = 0; i < 3; ++i) { c.axes[static_cast<size_t>(i)] = ax[static_cast<size_t>(o[static_cast<size_t>(i)])]; c.extents[static_cast<size_t>(i)] = ex[static_cast<size_t>(o[static_cast<size_t>(i)])]; }
            double a = std::max(c.extents[0], 1e-9);
            c.thinness = c.extents[2] / a;
            c.elongation = c.extents[1] / a;
            c.mainAxisVerticality = std::abs(c.axes[0].y);
            c.sheetNormalVerticality = std::abs(c.axes[2].y);
        }
        // gravity frame: x the horizontal principal direction of the samples
        {
            double sxx = 0, szz = 0, sxz = 0;
            for (const auto& q : pts) { double dx = q.x - mean.x, dz = q.z - mean.z; sxx += dx * dx; szz += dz * dz; sxz += dx * dz; }
            double th = 0.5 * std::atan2(2 * sxz, sxx - szz);
            c.xAxis = {std::cos(th), 0, std::sin(th)};
            c.zAxis = {-std::sin(th), 0, std::cos(th)};
            double x0 = 1e300, x1 = -1e300, z0 = 1e300, z1 = -1e300;
            for (const auto& q : pts) { double u = (q - mean).dot(c.xAxis), v = (q - mean).dot(c.zAxis); x0 = std::min(x0, u); x1 = std::max(x1, u); z0 = std::min(z0, v); z1 = std::max(z1, v); }
            if (pts.empty()) { x0 = x1 = z0 = z1 = 0; }
            c.frameL = x1 - x0; c.frameW = z1 - z0; c.frameH = c.hi.y - c.lo.y;
            c.origin = D3{mean.x, c.lo.y, mean.z} + c.xAxis * (0.5 * (x0 + x1)) + c.zAxis * (0.5 * (z0 + z1));
            c.origin.y = c.lo.y;
            c.boxVolumeM3 = c.frameL * c.frameW * c.frameH;
        }
        // attachment to the solid
        {
            std::vector<double> gaps;
            gaps.reserve(pts.size());
            size_t contact = 0;
            for (const auto& q : pts) { double g = gapToSolid(q); gaps.push_back(g); if (g <= p_.contactTol) ++contact; }
            // along the long axis: the share of 20 bins in which some of it touches the solid (a band fixed along a wall
            // touches all along; a shard sticking out touches at one end)
            {
                double lo = 1e300, hi = -1e300;
                for (const auto& q : pts) { double u = (q - mean).dot(c.axes[0]); lo = std::min(lo, u); hi = std::max(hi, u); }
                bool touch[20] = {false}, any[20] = {false};
                for (size_t i = 0; i < pts.size(); ++i) {
                    int b = hi > lo ? std::clamp(static_cast<int>(((pts[i] - mean).dot(c.axes[0]) - lo) / (hi - lo) * 20), 0, 19) : 0;
                    any[b] = true;
                    if (gaps[i] <= p_.contactTol) touch[b] = true;
                }
                int na = 0, nt = 0;
                for (int b = 0; b < 20; ++b) { na += any[b] ? 1 : 0; nt += touch[b] ? 1 : 0; }
                c.contactAlongShare = na ? static_cast<double>(nt) / na : 0;
            }
            // a copy of the solid's surface (classifyCopies): its area share
            {
                double copyA = 0, allA = 0;
                for (uint32_t t : c.tris) { double A = detail::triArea(cv(t, 0), cv(t, 1), cv(t, 2)); allA += A; if (copy_[t]) copyA += A; }
                c.copyShare = allA > 0 ? copyA / allA : 0;
            }
            {
                size_t inside = 0;
                for (const auto& q : pts) if (insideSolid(q)) ++inside;
                c.insideShare = pts.empty() ? 0 : static_cast<double>(inside) / pts.size();
            }
            c.minGapToSolidM = gaps.empty() ? 1e300 : *std::min_element(gaps.begin(), gaps.end());
            c.medianGapToSolidM = detail::median(gaps);
            c.contactShare = pts.empty() ? 0 : static_cast<double>(contact) / pts.size();
            c.gapToGroundM = p_.groundY > -1e299 ? c.lo.y - p_.groundY : NAN;
            c.baseAboveGroundM = p_.groundY > -1e299 ? c.lo.y - p_.groundY : NAN;
            c.topAboveGroundM = p_.groundY > -1e299 ? c.hi.y - p_.groundY : NAN;
        }
        // the plan grid: envelope volume and what lies below each cell
        {
            double cell = std::clamp(std::max(c.hi.x - c.lo.x, c.hi.z - c.lo.z) / 40.0, 0.1, 0.5);
            c.cellM = cell;
            int nx = std::max(1, static_cast<int>(std::ceil((c.hi.x - c.lo.x) / cell)) + 1), nz = std::max(1, static_cast<int>(std::ceil((c.hi.z - c.lo.z) / cell)) + 1);
            std::vector<double> ymin(static_cast<size_t>(nx) * nz, 1e300), ymax(static_cast<size_t>(nx) * nz, -1e300);
            std::vector<D3> fine;
            for (uint32_t t : c.tris) detail::samplesOn(cv(t, 0), cv(t, 1), cv(t, 2), 0.5 * cell, fine);
            for (const auto& q : fine) {
                int i = std::clamp(static_cast<int>((q.x - c.lo.x) / cell), 0, nx - 1), j = std::clamp(static_cast<int>((q.z - c.lo.z) / cell), 0, nz - 1);
                size_t id = static_cast<size_t>(j) * nx + i;
                ymin[id] = std::min(ymin[id], q.y);
                ymax[id] = std::max(ymax[id], q.y);
            }
            std::vector<double> drops, supports;
            size_t cells = 0, grounded = 0, enclosed = 0, open = 0, overhang = 0;
            for (int j = 0; j < nz; ++j) for (int i = 0; i < nx; ++i) {
                size_t id = static_cast<size_t>(j) * nx + i;
                if (ymin[id] > 1e299) continue;
                ++cells;
                D3 q{c.lo.x + (i + 0.5) * cell, ymin[id] - 1e-3, c.lo.z + (j + 0.5) * cell};
                double below = surfaceBelow(q, own);
                double drop = below > -1e299 ? ymin[id] - below : 1e300;
                double column = ymax[id] - ymin[id];
                if (drop <= p_.contactTol) ++grounded;
                else if (drop < 1e299 && enclosedBy(D3{q.x, below + 0.5 * drop, q.z}, own, std::max(c.hi.x - c.lo.x, c.hi.z - c.lo.z))) { ++enclosed; column = ymax[id] - below; }
                else if (drop >= p_.openBelowM) ++open;
                // the envelope: the cluster's own column, down to its support where its sides wall the space in
                c.envelopeVolumeM3 += cell * cell * column;
                if (drop > p_.maxDropM) ++overhang;
                drops.push_back(std::min(drop, 1e6));
                if (below > -1e299) supports.push_back(below);
            }
            c.footprintCells = cells;
            // a hollow scan of a box resting on its walls: the cells under its top are enclosed by its own sides, not open
            c.groundedShare = cells ? static_cast<double>(grounded + enclosed) / cells : 0;
            c.enclosedShare = cells ? static_cast<double>(enclosed) / cells : 0;
            c.openBelowShare = cells ? static_cast<double>(open) / cells : 0;
            c.overhangShare = cells ? static_cast<double>(overhang) / cells : 0;
            c.medianDropM = detail::median(drops);
            c.maxDropM = drops.empty() ? 0 : *std::max_element(drops.begin(), drops.end());
            c.fill = c.boxVolumeM3 > 1e-9 ? std::min(1.0, c.envelopeVolumeM3 / c.boxVolumeM3) : 0;
            // what supports it: the median surface height below its footprint (the ground when nothing else is under it)
            c.supportY = supports.empty() ? (p_.groundY > -1e299 ? p_.groundY : c.lo.y) : detail::median(supports);
            c.baseAboveSupportM = c.lo.y - c.supportY;
            c.topAboveSupportM = c.hi.y - c.supportY;
        }
        // horizontal slices: circle fits and cross-section sizes
        {
            double H = c.hi.y - c.lo.y;
            int ns = std::clamp(static_cast<int>(H / std::max(0.05, p_.sliceStepM)), 0, 60);
            std::vector<double> scores, sizes, radii;
            for (int s = 1; s <= ns; ++s) {
                double y = c.lo.y + H * s / (ns + 1.0);
                std::vector<std::pair<double, double>> sp;
                for (uint32_t t : c.tris) {
                    D3 v[3] = {cv(t, 0), cv(t, 1), cv(t, 2)};
                    std::vector<D3> hits;
                    for (int e = 0; e < 3; ++e) {
                        const D3& a = v[e];
                        const D3& b = v[(e + 1) % 3];
                        if ((a.y - y) * (b.y - y) < 0) { double u = (y - a.y) / (b.y - a.y); hits.push_back(a + (b - a) * u); }
                    }
                    if (hits.size() == 2) {
                        double L = (hits[1] - hits[0]).len();
                        int n = std::max(1, static_cast<int>(std::ceil(L / 0.1)));
                        for (int i = 0; i <= n; ++i) { D3 q = hits[0] + (hits[1] - hits[0]) * (static_cast<double>(i) / n); sp.push_back({q.x, q.z}); }
                    }
                }
                if (sp.size() < 6) continue;
                SliceFit f;
                f.y = y;
                f.points = sp.size();
                double x0 = 1e300, x1 = -1e300, z0 = 1e300, z1 = -1e300;
                for (const auto& q : sp) { x0 = std::min(x0, q.first); x1 = std::max(x1, q.first); z0 = std::min(z0, q.second); z1 = std::max(z1, q.second); }
                f.size = std::sqrt(std::max(0.0, (x1 - x0) * (z1 - z0)));
                double cx, cz, r, rms;
                if (detail::fitCircle(sp, cx, cz, r, rms)) {
                    f.cx = cx; f.cz = cz; f.r = r; f.rmsRel = rms / r;
                    bool bins[12] = {false};
                    for (const auto& q : sp) {
                        double ang = std::atan2(q.second - cz, q.first - cx);
                        int b = std::clamp(static_cast<int>((ang + M_PI) / (2 * M_PI) * 12), 0, 11);
                        bins[b] = true;
                    }
                    int filled = 0;
                    for (bool b : bins) filled += b ? 1 : 0;
                    f.sectors = filled / 12.0;
                    // a circle much larger than the slice is a fit to an arc of a near-straight line: no symmetry
                    double score = r <= 0.75 * std::hypot(x1 - x0, z1 - z0) ? std::max(0.0, 1 - f.rmsRel / std::max(1e-6, p_.radialTol)) * f.sectors : 0;
                    scores.push_back(score);
                    radii.push_back(r);
                }
                sizes.push_back(f.size);
                c.slices.push_back(f);
            }
            c.slicesUsed = scores.size();
            c.radialSymmetry = detail::median(scores);
            c.radiusMedianM = detail::median(radii);
            if (sizes.size() >= 2) {
                double m = std::accumulate(sizes.begin(), sizes.end(), 0.0) / sizes.size(), v = 0;
                for (double s : sizes) v += (s - m) * (s - m);
                double cvv = m > 1e-9 ? std::sqrt(v / sizes.size()) / m : 1;
                c.crossSectionConstancy = std::clamp(1 - cvv, 0.0, 1.0);
            } else c.crossSectionConstancy = 0;
        }
        // periodicity of the height profile along the frame's x axis
        {
            double bin = std::clamp(c.frameL / 64.0, 0.1, 0.5);
            int nb = std::max(1, static_cast<int>(std::ceil(c.frameL / bin)) + 1);
            std::vector<double> h(static_cast<size_t>(nb), NAN);
            double x0 = 1e300;
            for (const auto& q : pts) x0 = std::min(x0, (q - c.origin).dot(c.xAxis));
            for (const auto& q : pts) {
                int i = std::clamp(static_cast<int>(((q - c.origin).dot(c.xAxis) - x0) / bin), 0, nb - 1);
                h[static_cast<size_t>(i)] = std::isnan(h[static_cast<size_t>(i)]) ? q.y : std::max(h[static_cast<size_t>(i)], q.y);
            }
            double m = 0;
            int cnt = 0;
            for (double v : h) if (!std::isnan(v)) { m += v; ++cnt; }
            m = cnt ? m / cnt : 0;
            double var = 0;
            for (double v : h) if (!std::isnan(v)) var += (v - m) * (v - m);
            double best = 0, bestLag = 0;
            if (var > 1e-9 && nb >= 8) {
                for (int lag = 2; lag <= nb / 2; ++lag) {
                    double s = 0, n1 = 0, n2 = 0;
                    for (int i = 0; i + lag < nb; ++i) {
                        double a = h[static_cast<size_t>(i)], b = h[static_cast<size_t>(i + lag)];
                        if (std::isnan(a) || std::isnan(b)) continue;
                        s += (a - m) * (b - m); n1 += (a - m) * (a - m); n2 += (b - m) * (b - m);
                    }
                    double r = n1 > 0 && n2 > 0 ? s / std::sqrt(n1 * n2) : 0;
                    // only a peak counts: the correlation must rise again after falling from lag 0
                    if (r > best) {
                        bool dipped = false;
                        for (int l2 = 1; l2 < lag && !dipped; ++l2) {
                            double s2 = 0, a1 = 0, a2 = 0;
                            for (int i = 0; i + l2 < nb; ++i) {
                                double a = h[static_cast<size_t>(i)], b = h[static_cast<size_t>(i + l2)];
                                if (std::isnan(a) || std::isnan(b)) continue;
                                s2 += (a - m) * (b - m); a1 += (a - m) * (a - m); a2 += (b - m) * (b - m);
                            }
                            double r2 = a1 > 0 && a2 > 0 ? s2 / std::sqrt(a1 * a2) : 0;
                            if (r2 < r - 0.2) dipped = true;
                        }
                        if (dipped) { best = r; bestLag = lag * bin; }
                    }
                }
            }
            c.periodicity = best;
            c.periodM = bestLag;
        }
        // photo
        {
            double wsum = 0, rgb[3] = {0, 0, 0};
            std::vector<std::pair<double, double>> luma;
            for (uint32_t t : c.tris) {
                const auto& ph = in_.photo[t];
                if (ph[0] < 0) continue;
                double A = detail::triArea(cv(t, 0), cv(t, 1), cv(t, 2));
                for (int i = 0; i < 3; ++i) rgb[i] += ph[static_cast<size_t>(i)] * A;
                luma.push_back({0.2126 * ph[0] + 0.7152 * ph[1] + 0.0722 * ph[2], A});
                wsum += A;
            }
            if (wsum > 0) {
                c.photo = true;
                for (int i = 0; i < 3; ++i) c.photoRgb[i] = rgb[i] / wsum;
                double ml = 0;
                for (const auto& l : luma) ml += l.first * l.second;
                ml /= wsum;
                double v = 0;
                for (const auto& l : luma) v += (l.first - ml) * (l.first - ml) * l.second;
                c.photoLumaStd = std::sqrt(v / wsum);
                c.photoShare = wsum / std::max(1e-12, c.area);
            }
        }
    }
};

}  // namespace residual_audit
}  // namespace scratchbox

#endif
