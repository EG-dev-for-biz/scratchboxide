/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_SHELL_FIT_HPP
#define SCRATCHBOX_SHELL_FIT_HPP

/**
 * Shell fit (prototype): one solid, closed by construction, from an isolated structure's scan.
 *
 * The scan of one structure (a welded triangle soup, open at the bottom and wherever the capture never reached) is
 * explained by planes, and the solid is the union of convex cells those planes cut out of the scan's bounding volume:
 *
 *   1. skin      the triangles a ray can reach from outside (rays that leave the scan without hitting it), each turned to
 *                face the side it was seen from; hidden inner layers take no part;
 *   2. planes    area-weighted region growing over the skin, coplanar regions merged, least-squares refit; planes within
 *                `snapDeg` of vertical or level are made exactly so, and a plane within `alignDeg` of a larger plane's
 *                direction takes it (two fits of one warped wall never cross); kept by support area (`minPlaneAreaM2`,
 *                `maxPlanes`). Every merged region is tested as a plane before the snap and reported (planeCandidates):
 *                how well its triangles agree in direction (the length of their area-weighted mean unit normal) and how
 *                far its scan lies from its least-squares plane (area-weighted RMS); `minNormalResultant` and
 *                `maxPlaneRmsM` reject a region that fails, leaving its scan to the other planes and the residual. Off by
 *                default: on the ESB, Flatiron and Dakota scans (2026-11-06) region growing's own `growDistM` already
 *                keeps curved regions small, so no region reads as curved; the mast and crown are many small facets each
 *                flat (agreement 0.97-1.0, RMS mostly under 0.15 m), and what a 0.985 / 0.14 m test rejects is rough real
 *                planes (the Dakota's 10,185 m2 roof at 0.18 m RMS, an ESB wall of 1,413 m2 at 0.175 m), with small,
 *                mixed effects on the solid;
 *   3. cells     an adaptive binary space partition of the bounding volume (its floor at the ground datum): a convex
 *                cell is split by the plane with the most support area inside it, until no plane has `minSplitAreaM2`
 *                there. A plane therefore cuts only where its own scan passes. Such a cell can still hold both solid and
 *                air (a shaft under a top no plane explains), so a cell whose sample points vote both ways is split again:
 *                by the fitted plane, continued into it, that best parts its inside samples from its outside ones, else by a
 *                plane placed between them (no scan of its own: its faces come out generated);
 *   4. labels    each cell is inside or outside: rays from points in the cell vote by the side of the skin they first
 *                meet (its back: inside; its front, or nothing: outside; nothing below: no vote, the scan is open at the
 *                bottom), then a minimum cut over the cell graph, where cutting a face costs its area less the share of
 *                it the scan supports, so the boundary follows the scan and closes gaps by the smallest unsupported area;
 *   5. shell     the faces between inside cells and everything else, welded, T-junctions closed, fanned to triangles
 *                facing out. It includes the floor at the ground datum, so it has no open edge by construction;
 *   6. residual  skin triangles farther than `residualTolM` from the shell and outside it are kept as measured scan
 *                (a mast, ornament, curved parts); those inside the shell are reported as buried.
 *   0. round     (`revolutionParts`, off by default) before the planes, the skin is searched for solids of revolution
 *                (scratchbox_revolution_fit.hpp, with `endAtNonRound`: a part ends where its sections stop being circles
 *                for more than its maxFailM, cut flat there); skin within `revolutionTolM` of a fitted profile is taken out
 *                of the planes, the votes and the residual, and each part is written as its own closed solid
 *                (`revolution_<i>`, measured, with its fit). On the ESB (2026-11-06) the shaft under the antenna is
 *                4-periodic (21% radial swing, a rounded square) and is found only with the revolution fit's
 *                maxModulationRel raised to 0.3: one part, 335-380 m, 0.29 m RMS, 84% within 25 cm, 1,627 m2 of skin,
 *                replacing the planes' slabs there; the Flatiron and the Dakota give 3 and 4 small round parts at
 *                0.06-0.14 m RMS with the default limit.
 *   topIsAir     (off by default) solid stops at the highest roof the scan shows. The ESB's tall prism is not its shaft
 *                but columns over the antenna's lattice, which the votes call inside and the solver closes at the volume's
 *                margin. After the cells are refined, every cell reaching the volume's top is cut at a roof level
 *                (`roofLevels`: heights with at least roofMinAreaM2 of up-facing measured area over the whole structure):
 *                the highest level with roof inside the cell's own footprint, else the highest no higher than the scan's
 *                top over it, else the highest it spans (`capCellsAtRoof`); the piece above is outside, the piece below
 *                keeps its votes. On the ESB (2026-11-11, with the round part) the slabs go, the antenna stays scan,
 *                generated area 20,038 -> 14,565 m2, scan within 0.5 m 0.927 -> 0.930, and on a 1.5 m grid through the
 *                tower no point inside before is outside after below the scan's top except one 1 m sliver at a setback
 *                edge (313.5 m against 319.7 m); the Flatiron and the Dakota change by under 1.5%, but on the Dakota two
 *                thin cells within 2 m of the scan's cut edge, whose roof falls in the neighbouring cell, lose their
 *                upper part (21 of 33,572 inside samples, the solid ending at 0-18.5 m against walls to 41 m). Forcing whole cells to
 *                air instead drilled a 3 m shaft from the street to the top; making the whole margin air broke the base.
 *   windingVotes (off by default) votes by the skin's generalised winding number (scratchbox_inner_core.hpp), floored at
 *                the ground datum. On the ESB it halves the time and gives the fewest non-manifold edges, but where a
 *                setback's scan has holes it calls the body outside (a 47 m slot at one column), so it stays off.
 *
 * Every shell face carries its plane, the share of its area the scan supports within `supportTolM` (continuous) and a
 * provenance label: `measured` where that share reaches `measuredShare`, else `generated` (the solver closed a gap; the
 * reason is that no scan lies within the tolerance). Nothing here names a kind of building or part: the inputs are
 * triangles and tolerances in metres, the outputs planes, cells and distances.
 *
 * Known limits of the prototype (2026-11-05, ESB and 2 Penn Plaza): tapered and round parts no plane explains become
 * a prism between placed planes or stay residual (a per-region flatness test does not prevent this: the facets are flat;
 * the round part has to be found as a whole: `revolutionParts`); the ESB's tall prism is columns over the antenna's
 * lattice closed at the margin (`topIsAir` cuts them at the roof); thin open structures (a canopy) are residual, not solid;
 * a gap with no plane beyond it is closed at the bounding volume's margin; a few edges where two cells meet only along
 * a line are non-manifold (reported, not repaired); facade relief under `growDistM` is flattened away.
 *
 * Frame: y up, metres (the tile frame).
 */

#include "scratchbox_bvh.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_math.hpp"
#include "scratchbox_revolution_fit.hpp"
#include "scratchbox_inner_core.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <functional>
#include <limits>
#include <map>
#include <memory>
#include <queue>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

namespace scratchbox {
namespace shell_fit {

struct V3 {
    double x{0}, y{0}, z{0};
    V3() = default;
    V3(double a, double b, double c) : x(a), y(b), z(c) {}
    V3 operator+(const V3& o) const { return {x + o.x, y + o.y, z + o.z}; }
    V3 operator-(const V3& o) const { return {x - o.x, y - o.y, z - o.z}; }
    V3 operator*(double s) const { return {x * s, y * s, z * s}; }
    V3& operator+=(const V3& o) { x += o.x; y += o.y; z += o.z; return *this; }
    double dot(const V3& o) const { return x * o.x + y * o.y + z * o.z; }
    V3 cross(const V3& o) const { return {y * o.z - z * o.y, z * o.x - x * o.z, x * o.y - y * o.x}; }
    double length() const { return std::sqrt(dot(*this)); }
    V3 normalized() const { const double l = length(); return l > 1e-300 ? (*this) * (1.0 / l) : V3(0, 1, 0); }
};

/** n . x + d = 0, n unit. */
struct Plane {
    V3 n{0, 1, 0};
    double d{0};
    double supportAreaM2{0};
    bool bounding{false};
    double dist(const V3& p) const { return n.dot(p) + d; }
};

struct Params {
    double groundY{std::numeric_limits<double>::quiet_NaN()};  // the ground datum; NaN: the median height of the scan's lowest up-facing skin
    double groundBandM{1.0};       // up-facing scan within this of the datum is ground apron: no plane, no residual
    double growAngleDeg{30.0};     // region growing: a triangle joins a plane within this angle ...
    double growDistM{0.35};        // ... and this distance of it
    double mergeAngleDeg{4.0};     // two fitted regions are one plane within this angle ...
    double mergeDistM{0.3};        // ... and this offset
    double snapDeg{3.0};           // planes this close to vertical or level are made exactly so
    double alignDeg{5.0};          // a plane this close to a larger plane's direction takes that direction
    double minNormalResultant{0.0};// a plane's scan must agree in direction: the area-weighted mean of its triangles' unit normals at least this long
    double maxPlaneRmsM{1e9};      // ... and lie this close to it (area-weighted RMS distance of its scan from its least-squares plane)
    double minPlaneAreaM2{12.0};   // a plane needs this much supporting scan
    int maxPlanes{600};            // the planes kept, largest support first
    double minSplitAreaM2{4.0};    // a plane splits a cell only with this much of its support inside the cell
    size_t maxCells{400000};
    int refineRounds{14};          // rounds of vote-driven refinement: a cell whose sample points disagree is split again
    double refineMinorityShare{0.0625};   // a cell is mixed when more than this share of its samples disagree with the rest
    double refineMinVolumeM3{2.0};        // cells smaller than this are not refined
    double marginM{2.0};           // the bounding volume stands this far outside the scan (sides and top)
    bool topIsAir{false};          // solid stops at the highest roof the scan shows: cells reaching the volume's top are capped there (capCellsAtRoof) and their part above is outside
    double roofMinAreaM2{20.0};    // ... a roof level is a height with at least this much up-facing measured area (roofLevels)
    bool windingVotes{false};      // a point is inside by the skin's generalised winding number (scratchbox_inner_core.hpp), floored at the ground datum, not by which side of the skin its rays first meet
    double windingFarRatio{2.0};   // ... its Barnes-Hut opening ratio
    double supportTolM{0.5};       // a face point is supported when scan lies within this along the face normal
    double measuredShare{0.5};     // a face is `measured` from this support share up
    double residualTolM{1.0};      // skin farther than this from the shell is kept as residual scan
    int voteDirs{48};              // ray directions per sample point
    double unaryWeight{0.25};      // weight of a cell's ray votes, per square metre of its surface
    double unsupportedCutCost{1.0};// cost per square metre of cutting where no scan lies
    double supportedCutCost{0.05}; // cost per square metre of cutting along the scan
    double minComponentM3{20.0};   // inside components smaller than this (and not the largest) are dropped
    bool skinOnly{true};           // false: every triangle counts as skin, as wound
    bool revolutionParts{false};   // find solids of revolution in the skin first (scratchbox_revolution_fit.hpp) ...
    double revolutionTolM{0.35};   // ... and take the skin within this of a fitted profile out of the planes, the votes and the residual
    revolution_fit::Params revolution = [] { revolution_fit::Params r; r.endAtNonRound = 1; return r; }();
    int threads{0};                // 0: hardware concurrency
};

struct Input {
    std::vector<V3> positions;
    std::vector<uint32_t> indices;
};

/** One shell face: every shell triangle on one plane, facing one way, with one label. */
struct ShellFace {
    int plane{-1};
    V3 normal;             // outward
    double d{0};           // normal . x + d = 0
    double areaM2{0};
    double supportShare{0};// area-weighted share of the face the scan supports within supportTolM
    bool measured{false};
    bool groundClosure{false};
    uint32_t firstTriangle{0}, triangleCount{0};   // in Result::shellIndices, which is sorted by face
};

struct Metrics {
    size_t inputTriangles{0}, skinTriangles{0}, hiddenTriangles{0}, apronTriangles{0};
    double skinAreaM2{0}, hiddenAreaM2{0}, apronAreaM2{0};
    double groundY{0};
    size_t planesFitted{0}, planesKept{0};
    size_t revolutionParts{0}, revolutionTriangles{0};   // skin a fitted solid of revolution explains (not in the planes, votes or residual)
    double revolutionAreaM2{0}, revolutionAreaShare{0};
    size_t planesRejected{0};           // fitted regions whose scan does not agree in direction or lies too far from its plane
    double rejectedAreaM2{0};
    double planeAssignedAreaShare{0};   // skin area lying on a kept plane
    size_t cells{0}, insideCells{0}, interfaces{0};
    size_t supportCells{0};            // cells after the support-driven partition, before the refinement
    size_t refineSplits{0};            // mixed cells split again, by a fitted plane continued into them ...
    size_t separatorPlanes{0};         // ... or by a plane placed between their inside and outside samples (no scan of its own)
    size_t pocketsFilled{0}, componentsDropped{0};
    size_t roofCaps{0}, roofLevels{0};  // cells reaching the top split at the highest roof level they span (topIsAir); the levels found
    size_t shellTriangles{0}, shellVertices{0}, shellFaces{0};
    size_t boundaryEdges{0}, nonManifoldEdges{0}, degenerateTriangles{0};
    size_t tJunctionsClosed{0};
    double shellAreaM2{0}, shellVolumeM3{0};
    double generatedAreaM2{0}, generatedAreaShare{0};        // by label
    double unsupportedAreaM2{0}, unsupportedAreaShare{0};    // continuous: sum of area x (1 - supportShare)
    double groundClosureAreaM2{0};
    double scanWithin05Share{0}, scanWithin15Share{0};       // skin area within 0.5 m / 1.5 m of the shell
    double scanRmsM{0}, scanP95M{0}, scanMaxM{0};            // skin-to-shell distance, area-weighted
    double explainedRmsM{0}, explainedAreaShare{0};          // the same over the skin the shell stands for (neither residual nor buried)
    double residualAreaM2{0}, residualAreaShare{0};          // skin kept beside the shell
    size_t residualTriangles{0};
    double buriedAreaM2{0}, buriedAreaShare{0};              // skin farther than the tolerance and inside the shell
    double msSkin{0}, msPlanes{0}, msCells{0}, msLabels{0}, msShell{0}, msResidual{0}, msTotal{0};
};

struct Result {
    std::vector<Plane> planes;                 // the 6 bounding planes first, then the fitted ones
    /** Every fitted region tested as a plane: its direction agreement and its spread, and whether it was kept as a candidate. */
    struct PlaneCandidate { V3 n, o; double areaM2{0}, normalResultant{0}, rmsM{0}; bool rejected{false}; };
    std::vector<PlaneCandidate> planeCandidates;
    /** A solid of revolution found in the skin: its closed outward mesh (the revolution fit's), its axis and extent, how
     *  well it fits the scan it explains, and that scan's area. */
    struct RevolutionPart {
        double cx{0}, cz{0}, yBottom{0}, yTop{0}, topCutY{std::numeric_limits<double>::quiet_NaN()};
        double fitRmsM{0}, fitWithin25{0};          // the revolution fit's own, over every point it sampled
        double explainedRmsM{0}, areaM2{0};         // over the skin triangles within revolutionTolM of its profile
        size_t triangles{0};
        std::vector<float> pos, nrm;
        std::vector<uint32_t> idx;
        std::string reason;
    };
    std::vector<RevolutionPart> revolutions;
    std::vector<V3> shellPositions;            // welded: the shell is a closed indexed mesh
    std::vector<uint32_t> shellIndices;        // sorted by face
    std::vector<ShellFace> faces;
    std::vector<uint32_t> residualTriangles;   // input triangle indices kept as measured scan
    std::vector<uint8_t> residualFlipped;      // per residual triangle: seen from its back, so written reversed
    std::vector<uint32_t> skinTriangles;       // input triangle indices of the skin (ground apron left out): what the fit is judged on
    struct CellInfo { V3 centroid, lo, hi; double volume{0}, surface{0}, pIn{0}; bool inside{false}; };
    std::vector<CellInfo> cells;               // every cell of the partition, for inspection
    Metrics metrics;
};

namespace detail {

inline double msSince(std::chrono::steady_clock::time_point t) {
    return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t).count();
}

template <class F>
inline void parallelFor(size_t n, int threads, F&& f) {
    const size_t nt = std::max<size_t>(1, std::min<size_t>(static_cast<size_t>(threads), n));
    if (nt <= 1) { for (size_t i = 0; i < n; ++i) f(i); return; }
    std::atomic<size_t> next{0};
    const size_t chunk = std::max<size_t>(1, n / (nt * 16));
    std::vector<std::thread> pool;
    for (size_t t = 0; t < nt; ++t) {
        pool.emplace_back([&]() {
            for (;;) {
                const size_t a = next.fetch_add(chunk);
                if (a >= n) return;
                const size_t b = std::min(n, a + chunk);
                for (size_t i = a; i < b; ++i) f(i);
            }
        });
    }
    for (auto& th : pool) th.join();
}

inline math::Vec3 f3(const V3& v) { return math::Vec3(static_cast<float>(v.x), static_cast<float>(v.y), static_cast<float>(v.z)); }
inline V3 d3(const math::Vec3& v) { return V3(v.x, v.y, v.z); }

/** Evenly spread unit directions (Fibonacci sphere). */
inline std::vector<V3> sphereDirs(int n) {
    std::vector<V3> out;
    const double g = M_PI * (3.0 - std::sqrt(5.0));
    for (int i = 0; i < n; ++i) {
        const double y = 1.0 - 2.0 * (i + 0.5) / n;
        const double r = std::sqrt(std::max(0.0, 1.0 - y * y));
        out.emplace_back(std::cos(g * i) * r, y, std::sin(g * i) * r);
    }
    return out;
}

/** Smallest-eigenvalue eigenvector of a symmetric 3x3 (Jacobi). */
inline V3 smallestEigenvector(double a[3][3]) {
    double v[3][3] = {{1, 0, 0}, {0, 1, 0}, {0, 0, 1}};
    for (int sweep = 0; sweep < 60; ++sweep) {
        double off = std::abs(a[0][1]) + std::abs(a[0][2]) + std::abs(a[1][2]);
        if (off < 1e-18) break;
        for (int p = 0; p < 2; ++p) for (int q = p + 1; q < 3; ++q) {
            if (std::abs(a[p][q]) < 1e-300) continue;
            const double theta = (a[q][q] - a[p][p]) / (2.0 * a[p][q]);
            const double t = (theta >= 0 ? 1.0 : -1.0) / (std::abs(theta) + std::sqrt(theta * theta + 1.0));
            const double c = 1.0 / std::sqrt(t * t + 1.0), s = t * c;
            for (int k = 0; k < 3; ++k) { const double akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
            for (int k = 0; k < 3; ++k) { const double apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
            for (int k = 0; k < 3; ++k) { const double vkp = v[k][p], vkq = v[k][q]; v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq; }
        }
    }
    int m = 0;
    if (a[1][1] < a[m][m]) m = 1;
    if (a[2][2] < a[m][m]) m = 2;
    return V3(v[0][m], v[1][m], v[2][m]).normalized();
}

/**
 * Keeps the part of a closed polygon where dist >= -eps. `tags[i]` belongs to the edge leaving point i; the edge made
 * along the cut is tagged `cutTag`.
 */
template <class P, class DistF, class LerpF, class SameF>
inline void clipTagged(const std::vector<P>& pts, const std::vector<int>& tags, DistF dist, LerpF lerp, SameF same, int cutTag, double eps,
                       std::vector<P>& outP, std::vector<int>& outT) {
    outP.clear(); outT.clear();
    const size_t n = pts.size();
    if (n < 3) return;
    std::vector<double> dv(n);
    bool anyOut = false, anyIn = false;
    for (size_t i = 0; i < n; ++i) { dv[i] = dist(pts[i]); if (dv[i] < -eps) anyOut = true; if (dv[i] > eps) anyIn = true; }
    if (!anyOut) { outP = pts; outT = tags; return; }
    if (!anyIn) return;
    for (size_t i = 0; i < n; ++i) {
        const size_t j = (i + 1) % n;
        const bool ina = dv[i] >= -eps, inb = dv[j] >= -eps;
        if (ina) {
            outP.push_back(pts[i]); outT.push_back(tags[i]);
            if (!inb) { outP.push_back(lerp(pts[i], pts[j], std::clamp(dv[i] / (dv[i] - dv[j]), 0.0, 1.0))); outT.push_back(cutTag); }
        } else if (inb) {
            outP.push_back(lerp(pts[i], pts[j], std::clamp(dv[i] / (dv[i] - dv[j]), 0.0, 1.0))); outT.push_back(tags[i]);
        }
    }
    // a zero-length edge: drop its start point (and with it the edge's tag)
    std::vector<P> p2; std::vector<int> t2;
    const size_t m = outP.size();
    for (size_t i = 0; i < m; ++i) {
        if (same(outP[i], outP[(i + 1) % m])) continue;
        p2.push_back(outP[i]); t2.push_back(outT[i]);
    }
    if (p2.size() < 3) { outP.clear(); outT.clear(); return; }
    outP.swap(p2); outT.swap(t2);
}

struct P2 { double x{0}, y{0}; };

struct Face {
    int plane{-1};
    int side{0};                 // +1: the cell lies where plane.dist > 0
    std::vector<V3> pts;
    std::vector<int> tags;       // per edge leaving pts[i]: the plane of the cell's other face along it
};

struct Cell {
    std::vector<Face> faces;
    std::vector<uint32_t> tris;  // plane-assigned skin triangles whose centroid lies in the cell
    V3 centroid;
    double volume{0}, surface{0};
};

inline void measureCell(Cell& c) {
    V3 c0; size_t n = 0;
    for (const auto& f : c.faces) for (const auto& p : f.pts) { c0 += p; ++n; }
    if (!n) { c.volume = 0; return; }
    c0 = c0 * (1.0 / static_cast<double>(n));
    double vol = 0, surf = 0; V3 cw;
    for (const auto& f : c.faces) {
        for (size_t i = 1; i + 1 < f.pts.size(); ++i) {
            const V3 a = f.pts[0] - c0, b = f.pts[i] - c0, d = f.pts[i + 1] - c0;
            const double v = std::abs(a.dot(b.cross(d))) / 6.0;
            vol += v;
            cw += (c0 + (a + b + d) * 0.25) * v;
            surf += 0.5 * (f.pts[i] - f.pts[0]).cross(f.pts[i + 1] - f.pts[0]).length();
        }
    }
    c.volume = vol; c.surface = surf;
    c.centroid = vol > 1e-12 ? cw * (1.0 / vol) : c0;
}

/** Splits a convex cell by a plane. False (and nothing changed) when the plane does not cut it into two real cells. */
inline bool splitCell(const Cell& cell, const Plane& pl, int planeId, Cell& pos, Cell& neg) {
    const double eps = 1e-7;
    pos.faces.clear(); neg.faces.clear();
    struct Seg { V3 a, b; int tag; };
    std::vector<Seg> segs;
    auto lerp = [](const V3& a, const V3& b, double t) { return a + (b - a) * t; };
    auto same = [](const V3& a, const V3& b) { return (a - b).length() < 1e-9; };
    std::vector<V3> op; std::vector<int> ot;
    for (const auto& f : cell.faces) {
        clipTagged(f.pts, f.tags, [&](const V3& p) { return pl.dist(p); }, lerp, same, planeId, eps, op, ot);
        if (op.size() >= 3) {
            Face nf; nf.plane = f.plane; nf.side = f.side; nf.pts = op; nf.tags = ot;
            for (size_t i = 0; i < op.size(); ++i) if (ot[i] == planeId && f.plane != planeId) segs.push_back({op[i], op[(i + 1) % op.size()], f.plane});
            pos.faces.push_back(std::move(nf));
        }
        clipTagged(f.pts, f.tags, [&](const V3& p) { return -pl.dist(p); }, lerp, same, planeId, eps, op, ot);
        if (op.size() >= 3) {
            Face nf; nf.plane = f.plane; nf.side = f.side; nf.pts = op; nf.tags = ot;
            neg.faces.push_back(std::move(nf));
        }
    }
    if (segs.size() < 3 || pos.faces.size() < 3 || neg.faces.size() < 3) return false;
    // the cap: the cut segments in order around their centre
    V3 c; for (const auto& s : segs) c += s.a + s.b;
    c = c * (1.0 / (2.0 * static_cast<double>(segs.size())));
    const V3 n = pl.n;
    const V3 u = (std::abs(n.x) < 0.9 ? V3(1, 0, 0) : V3(0, 1, 0)).cross(n).normalized();
    const V3 v = n.cross(u);
    std::vector<std::pair<double, size_t>> order;
    for (size_t i = 0; i < segs.size(); ++i) {
        auto& s = segs[i];
        const V3 m = (s.a + s.b) * 0.5 - c;
        if (m.cross(s.b - s.a).dot(n) < 0) std::swap(s.a, s.b);
        order.emplace_back(std::atan2(m.dot(v), m.dot(u)), i);
    }
    std::sort(order.begin(), order.end());
    Face cap; cap.plane = planeId;
    for (const auto& [ang, i] : order) {
        (void)ang;
        if (!cap.pts.empty() && same(cap.pts.back(), segs[i].a)) { cap.tags.back() = segs[i].tag; continue; }
        cap.pts.push_back(segs[i].a); cap.tags.push_back(segs[i].tag);
    }
    if (cap.pts.size() < 3) return false;
    Face capPos = cap; capPos.side = +1;
    Face capNeg = cap; capNeg.side = -1;
    pos.faces.push_back(std::move(capPos));
    neg.faces.push_back(std::move(capNeg));
    measureCell(pos); measureCell(neg);
    return pos.volume > 1e-4 && neg.volume > 1e-4;
}

/** True when p lies inside the convex cell: on the cell's side of every face's plane (within eps). */
inline bool insideCell(const Cell& c, const std::vector<Plane>& planes, const V3& p, double eps = 1e-6) {
    for (const auto& f : c.faces) if (static_cast<double>(f.side) * planes[static_cast<size_t>(f.plane)].dist(p) < -eps) return false;
    return true;
}

/**
 * Roof levels: the heights at which the scan shows a real roof, read from the whole structure, not from one cell: every
 * `binM` height band whose up-facing measured area, summed over `windowBins` neighbouring bands, reaches `minAreaM2`, the
 * highest band of each run kept. A platform or collar on a mast is a few square metres and makes no level; the roof a
 * mast stands on does. `roofY` / `roofArea` are the up-facing surfaces' heights and areas. Returned high to low.
 */
inline std::vector<double> roofLevels(const std::vector<double>& roofY, const std::vector<double>& roofArea, double minAreaM2, double binM = 0.25, int windowBins = 3) {
    std::map<long long, double> bands;
    for (size_t i = 0; i < roofY.size(); ++i) bands[static_cast<long long>(std::floor(roofY[i] / binM))] += roofArea[i];
    std::vector<long long> hit;
    for (const auto& [b, a] : bands) {
        (void)a;
        double sum = 0;
        for (long long k = b - windowBins / 2; k <= b + windowBins / 2; ++k) { auto it = bands.find(k); if (it != bands.end()) sum += it->second; }
        if (sum >= minAreaM2) hit.push_back(b);
    }
    std::vector<double> levels;
    for (size_t i = 0; i < hit.size(); ++i) if (i + 1 == hit.size() || hit[i + 1] > hit[i] + 1) levels.push_back((static_cast<double>(hit[i]) + 1.0) * binM);
    std::sort(levels.rbegin(), levels.rend());
    return levels;
}

/**
 * Roof cap: solid stops at the highest roof the scan shows. A thin structure standing over a solid (a lattice mast, a
 * pole, a crane, rooftop plant) draws inside votes from its scan's back faces, so a cell that runs from inside the solid
 * up past it is labelled solid all the way up, and making the whole cell air instead hollows the solid below. So every
 * cell reaching `topPlane` is split by a level plane at a roof level (`roofLevels`) inside its height range, at least
 * `minRiseM` above its floor: the highest level that has roof inside the cell's own footprint (up-facing measured area
 * within `levelTolM` of it, at least max(0.1 m2, `localShare` x the cell's plan box), from `roofPts` / `roofArea`,
 * surface samples), else the highest level no higher than the scan's top over the cell's footprint (`scanPts`, every
 * measured surface's samples), else the highest level the cell spans: a cell with no roof of its own is still cut where
 * the structure's roof is, never left whole to be called air from top to bottom. The piece below keeps its votes; the piece above holds
 * nothing a roof supports. Nothing here knows what stands on the roof: the inputs are surfaces, areas and heights.
 */
inline size_t capCellsAtRoof(std::vector<Cell>& cells, std::vector<Plane>& planes, int topPlane, const std::vector<double>& levels,
                             const std::vector<V3>& roofPts, const std::vector<double>& roofArea, const std::vector<V3>& scanPts,
                             double localShare = 0.1, double levelTolM = 0.75, double minRiseM = 0.5) {
    size_t caps = 0;
    std::vector<Cell> out;
    out.reserve(cells.size());
    for (auto& cell : cells) {
        bool touchesTop = false;
        V3 lo(1e300, 1e300, 1e300), hi(-1e300, -1e300, -1e300);
        for (const auto& f : cell.faces) {
            if (f.plane == topPlane) touchesTop = true;
            for (const auto& q : f.pts) { lo = V3(std::min(lo.x, q.x), std::min(lo.y, q.y), std::min(lo.z, q.z)); hi = V3(std::max(hi.x, q.x), std::max(hi.y, q.y), std::max(hi.z, q.z)); }
        }
        double cut = std::numeric_limits<double>::quiet_NaN();
        if (touchesTop) {
            std::vector<double> span;
            for (double y : levels) if (y > lo.y + minRiseM && y < hi.y - 0.05) span.push_back(y);   // high to low
            if (!span.empty()) {
                std::vector<double> local(span.size(), 0.0);
                for (size_t i = 0; i < roofPts.size(); ++i) {
                    const V3& q = roofPts[i];
                    if (q.x < lo.x || q.x > hi.x || q.z < lo.z || q.z > hi.z) continue;
                    size_t k = 0;
                    while (k < span.size() && std::abs(q.y - span[k]) > levelTolM) ++k;
                    if (k == span.size()) continue;
                    // the roof sample's column through the cell: inside at the level's height
                    if (!insideCell(cell, planes, V3(q.x, std::clamp(span[k] - 0.5 * levelTolM, lo.y + 1e-3, hi.y - 1e-3), q.z), 1e-4)) continue;
                    local[k] += roofArea[i];
                }
                const double need = std::max(0.1, localShare * (hi.x - lo.x) * (hi.z - lo.z));
                for (size_t k = 0; k < span.size(); ++k) if (local[k] >= need) { cut = span[k]; break; }
                if (!std::isfinite(cut)) {
                    // no roof of its own: cut at the highest level no higher than the scan's top over the cell's footprint
                    // (a column beside a part stops where the scan beside it stops), else the highest level it spans
                    double top = -std::numeric_limits<double>::infinity();
                    for (const V3& q : scanPts) {
                        if (q.x < lo.x || q.x > hi.x || q.z < lo.z || q.z > hi.z || q.y <= top) continue;
                        if (!insideCell(cell, planes, V3(q.x, std::clamp(q.y, lo.y + 1e-3, hi.y - 1e-3), q.z), 1e-4)) continue;
                        top = q.y;
                    }
                    for (double y : span) if (y <= top + levelTolM) { cut = y; break; }
                    if (!std::isfinite(cut)) cut = span.front();
                }
            }
        }
        if (!std::isfinite(cut)) { out.push_back(std::move(cell)); continue; }
        Plane pl; pl.n = V3(0, 1, 0); pl.d = -cut;
        const int id = static_cast<int>(planes.size());
        Cell above, below;
        if (!splitCell(cell, pl, id, above, below)) { out.push_back(std::move(cell)); continue; }
        planes.push_back(pl);
        out.push_back(std::move(below)); out.push_back(std::move(above));
        ++caps;
    }
    cells.swap(out);
    return caps;
}

/** Dinic maximum flow on doubles. */
class MaxFlow {
public:
    explicit MaxFlow(int n) : head_(static_cast<size_t>(n), -1), level_(static_cast<size_t>(n)), it_(static_cast<size_t>(n)) {}
    void add(int u, int v, double cuv, double cvu) {
        to_.push_back(v); cap_.push_back(cuv); nxt_.push_back(head_[static_cast<size_t>(u)]); head_[static_cast<size_t>(u)] = static_cast<int>(to_.size()) - 1;
        to_.push_back(u); cap_.push_back(cvu); nxt_.push_back(head_[static_cast<size_t>(v)]); head_[static_cast<size_t>(v)] = static_cast<int>(to_.size()) - 1;
    }
    double run(int s, int t) {
        double flow = 0;
        while (bfs(s, t)) {
            it_ = head_;
            for (;;) { const double f = dfs(s, t, std::numeric_limits<double>::infinity()); if (f <= kEps) break; flow += f; }
        }
        return flow;
    }
    /** After run: the nodes still reachable from s. */
    std::vector<char> sourceSide(int s) const {
        std::vector<char> seen(head_.size(), 0);
        std::vector<int> st{s}; seen[static_cast<size_t>(s)] = 1;
        while (!st.empty()) {
            const int u = st.back(); st.pop_back();
            for (int e = head_[static_cast<size_t>(u)]; e >= 0; e = nxt_[static_cast<size_t>(e)]) {
                const int v = to_[static_cast<size_t>(e)];
                if (cap_[static_cast<size_t>(e)] > kEps && !seen[static_cast<size_t>(v)]) { seen[static_cast<size_t>(v)] = 1; st.push_back(v); }
            }
        }
        return seen;
    }
private:
    static constexpr double kEps = 1e-9;
    bool bfs(int s, int t) {
        std::fill(level_.begin(), level_.end(), -1);
        std::vector<int> q{s}; level_[static_cast<size_t>(s)] = 0;
        for (size_t h = 0; h < q.size(); ++h) {
            const int u = q[h];
            for (int e = head_[static_cast<size_t>(u)]; e >= 0; e = nxt_[static_cast<size_t>(e)]) {
                const int v = to_[static_cast<size_t>(e)];
                if (cap_[static_cast<size_t>(e)] > kEps && level_[static_cast<size_t>(v)] < 0) { level_[static_cast<size_t>(v)] = level_[static_cast<size_t>(u)] + 1; q.push_back(v); }
            }
        }
        return level_[static_cast<size_t>(t)] >= 0;
    }
    double dfs(int u, int t, double f) {
        if (u == t) return f;
        for (int& e = it_[static_cast<size_t>(u)]; e >= 0; e = nxt_[static_cast<size_t>(e)]) {
            const int v = to_[static_cast<size_t>(e)];
            if (cap_[static_cast<size_t>(e)] > kEps && level_[static_cast<size_t>(v)] == level_[static_cast<size_t>(u)] + 1) {
                const double d = dfs(v, t, std::min(f, cap_[static_cast<size_t>(e)]));
                if (d > kEps) { cap_[static_cast<size_t>(e)] -= d; cap_[static_cast<size_t>(e ^ 1)] += d; return d; }
            }
        }
        return 0;
    }
    std::vector<int> head_, level_, it_, to_, nxt_;
    std::vector<double> cap_;
};

/** Welds points closer than `tol` (grid hash, neighbouring cells searched). */
class Welder {
public:
    explicit Welder(double tol) : tol_(tol), inv_(1.0 / (tol * 4.0)) {}
    uint32_t add(const V3& p) {
        const long long ix = static_cast<long long>(std::floor(p.x * inv_)), iy = static_cast<long long>(std::floor(p.y * inv_)), iz = static_cast<long long>(std::floor(p.z * inv_));
        for (long long dx = -1; dx <= 1; ++dx) for (long long dy = -1; dy <= 1; ++dy) for (long long dz = -1; dz <= 1; ++dz) {
            auto it = grid_.find(key(ix + dx, iy + dy, iz + dz));
            if (it == grid_.end()) continue;
            for (uint32_t id : it->second) if ((pts[id] - p).length() <= tol_) return id;
        }
        const uint32_t id = static_cast<uint32_t>(pts.size());
        pts.push_back(p);
        grid_[key(ix, iy, iz)].push_back(id);
        return id;
    }
    std::vector<V3> pts;
private:
    static uint64_t key(long long x, long long y, long long z) {
        return (static_cast<uint64_t>(x) * 0x9E3779B97F4A7C15ull) ^ (static_cast<uint64_t>(y) * 0xC2B2AE3D27D4EB4Full) ^ (static_cast<uint64_t>(z) * 0x165667B19E3779F9ull);
    }
    double tol_, inv_;
    std::unordered_map<uint64_t, std::vector<uint32_t>> grid_;
};

inline uint64_t edgeKey(uint32_t a, uint32_t b) { return a < b ? (static_cast<uint64_t>(a) << 32) | b : (static_cast<uint64_t>(b) << 32) | a; }

struct Interface {
    int neg{-1}, pos{-1};        // the cells on the two sides of the plane (-1: outside the bounding volume)
    int plane{-1};
    std::vector<V3> pts;         // counter-clockwise seen from the plane's positive side
    std::vector<int> tags;
    double area{0}, support{0};
};

/** Sample points of a convex polygon on a grid of spacing h in its plane (its centroid when the grid misses it). */
inline std::vector<V3> samplePolygon(const std::vector<V3>& pts, const V3& n, double h) {
    std::vector<V3> out;
    const V3 o = pts[0];
    const V3 u = (std::abs(n.x) < 0.9 ? V3(1, 0, 0) : V3(0, 1, 0)).cross(n).normalized();
    const V3 v = n.cross(u);
    std::vector<P2> q;
    double x0 = 1e300, x1 = -1e300, y0 = 1e300, y1 = -1e300;
    for (const auto& p : pts) { const V3 r = p - o; q.push_back({r.dot(u), r.dot(v)}); x0 = std::min(x0, q.back().x); x1 = std::max(x1, q.back().x); y0 = std::min(y0, q.back().y); y1 = std::max(y1, q.back().y); }
    double area2 = 0;
    for (size_t i = 0; i < q.size(); ++i) { const auto& a = q[i]; const auto& b = q[(i + 1) % q.size()]; area2 += a.x * b.y - b.x * a.y; }
    const double sgn = area2 >= 0 ? 1.0 : -1.0;
    auto inside = [&](double x, double y) {
        for (size_t i = 0; i < q.size(); ++i) {
            const auto& a = q[i]; const auto& b = q[(i + 1) % q.size()];
            if (sgn * ((b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x)) < 0) return false;
        }
        return true;
    };
    const int nx = std::max(1, static_cast<int>(std::ceil((x1 - x0) / h))), ny = std::max(1, static_cast<int>(std::ceil((y1 - y0) / h)));
    for (int j = 0; j < ny; ++j) for (int i = 0; i < nx; ++i) {
        const double x = x0 + (i + 0.5) * (x1 - x0) / nx, y = y0 + (j + 0.5) * (y1 - y0) / ny;
        if (inside(x, y)) out.push_back(o + u * x + v * y);
    }
    if (out.empty()) { V3 c; for (const auto& p : pts) c += p; out.push_back(c * (1.0 / static_cast<double>(pts.size()))); }
    return out;
}

inline double polygonArea(const std::vector<V3>& pts) {
    V3 s;
    for (size_t i = 1; i + 1 < pts.size(); ++i) s += (pts[i] - pts[0]).cross(pts[i + 1] - pts[0]);
    return 0.5 * s.length();
}

} // namespace detail

class ShellFit {
public:
    static Result solve(const Input& in, const Params& p) {
        using namespace detail;
        using clock = std::chrono::steady_clock;
        const auto tStart = clock::now();
        Result R;
        Metrics& M = R.metrics;
        const size_t nt = in.indices.size() / 3;
        if (nt == 0) throw std::runtime_error("shell fit: the scan has no triangles");
        const int threads = p.threads > 0 ? p.threads : static_cast<int>(std::max(1u, std::thread::hardware_concurrency()));
        M.inputTriangles = nt;

        // ---------------------------------------------------------------- triangles
        std::vector<V3> tn(nt), tc(nt);
        std::vector<double> ta(nt);
        for (size_t t = 0; t < nt; ++t) {
            const V3& a = in.positions[in.indices[t * 3]]; const V3& b = in.positions[in.indices[t * 3 + 1]]; const V3& c = in.positions[in.indices[t * 3 + 2]];
            const V3 cr = (b - a).cross(c - a);
            ta[t] = 0.5 * cr.length();
            tn[t] = cr.normalized();
            tc[t] = (a + b + c) * (1.0 / 3.0);
        }
        double groundY = p.groundY;
        V3 lo(1e300, 1e300, 1e300), hi(-1e300, -1e300, -1e300);
        {
            std::vector<double> ys;
            ys.reserve(in.positions.size());
            for (const auto& q : in.positions) {
                ys.push_back(q.y);
                lo = V3(std::min(lo.x, q.x), std::min(lo.y, q.y), std::min(lo.z, q.z));
                hi = V3(std::max(hi.x, q.x), std::max(hi.y, q.y), std::max(hi.z, q.z));
            }
            if (!std::isfinite(groundY)) {
                const size_t k = ys.size() / 100;
                std::nth_element(ys.begin(), ys.begin() + static_cast<std::ptrdiff_t>(k), ys.end());
                groundY = ys[k];
            }
        }
        M.groundY = groundY;

        // ---------------------------------------------------------------- 1. skin
        auto t0 = clock::now();
        geometry::ScratchboxMesh all("scan");
        all.vertices.reserve(in.positions.size());
        for (const auto& q : in.positions) all.vertices.emplace_back(f3(q));
        all.indices = in.indices;
        bvh::BvhTree allBvh;
        if (!allBvh.build(all)) throw std::runtime_error("shell fit: could not index the scan");
        const std::vector<V3> dirs = sphereDirs(p.voteDirs);
        // skinSide: +1 seen from its front, -1 from its back only (written reversed), 0 hidden
        std::vector<int8_t> skinSide(nt, 0);
        std::vector<uint8_t> apron(nt, 0);
        parallelFor(nt, threads, [&](size_t t) {
            if (ta[t] < 1e-10) return;
            if (!p.skinOnly) { skinSide[t] = 1; return; }
            for (int s = 1; s >= -1; s -= 2) {
                const V3 n = tn[t] * static_cast<double>(s);
                const V3 o = tc[t] + n * 0.05;
                int escaped = 0;
                for (const auto& d : dirs) {
                    if (d.dot(n) < 0.15 || d.y < -0.1) continue;
                    bvh::RayHit h;
                    if (!allBvh.raycast(math::Ray(f3(o), f3(d)), h)) { if (++escaped >= 2) break; }
                }
                if (escaped >= 2) { skinSide[t] = static_cast<int8_t>(s); return; }
            }
        });
        for (size_t t = 0; t < nt; ++t) if (skinSide[t] < 0) tn[t] = tn[t] * -1.0;
        if (!std::isfinite(p.groundY)) {
            // the ground datum: the area-weighted median height of the skin that faces up within 3 m of the scan's bottom
            std::vector<std::pair<double, double>> low;
            double total = 0;
            for (size_t t = 0; t < nt; ++t) if (skinSide[t] && tn[t].y > 0.7 && tc[t].y < groundY + 3.0) { low.emplace_back(tc[t].y, ta[t]); total += ta[t]; }
            if (total > 0) {
                std::sort(low.begin(), low.end());
                double acc = 0;
                for (const auto& [y, a] : low) { acc += a; if (acc >= 0.5 * total) { groundY = y; break; } }
            }
            M.groundY = groundY;
        }
        // solids of revolution first: a round part (a drum, a shaft, a dome) is not a set of planes, and cutting it into
        // cells makes a prism; the skin within revolutionTolM of a fitted profile is explained by that solid instead
        std::vector<int> revOf(nt, -1);
        if (p.revolutionParts) {
            auto isApron = [&](size_t t) { return std::abs(tc[t].y - groundY) < p.groundBandM && tn[t].y > 0.7; };
            std::vector<float> soup;
            std::vector<uint32_t> soupTri;
            for (size_t t = 0; t < nt; ++t) {
                if (!skinSide[t] || isApron(t) || ta[t] < 1e-10) continue;
                for (int k = 0; k < 3; ++k) {
                    const V3& q = in.positions[in.indices[t * 3 + static_cast<size_t>(k)]];
                    soup.push_back(static_cast<float>(q.x)); soup.push_back(static_cast<float>(q.y)); soup.push_back(static_cast<float>(q.z));
                }
                soupTri.push_back(static_cast<uint32_t>(t));
            }
            revolution_fit::RevolutionFit rf(std::move(soup), p.revolution);
            rf.run();
            for (const auto& rv : rf.revolutions()) {
                if (!rv.accepted || rv.idx.empty()) continue;
                Result::RevolutionPart part;
                part.cx = rv.cx; part.cz = rv.cz; part.topCutY = rv.topCutY;
                part.yBottom = rv.stacks.front().yBottom; part.yTop = rv.stacks.back().yTop;
                part.fitRmsM = rv.rmsM; part.fitWithin25 = rv.within25; part.reason = rv.reason;
                part.pos = rv.pos; part.nrm = rv.nrm; part.idx = rv.idx;
                std::vector<std::vector<std::array<double, 2>>> meridians;
                for (const auto& st : rv.stacks) meridians.push_back(st.meridianPolyline());
                const int id = static_cast<int>(R.revolutions.size());
                double sumD2 = 0;
                for (uint32_t t : soupTri) {
                    if (revOf[t] >= 0) continue;
                    double worst = 0;
                    for (int k = 0; k < 3 && worst <= p.revolutionTolM; ++k) {
                        const V3& q = in.positions[in.indices[t * 3 + static_cast<size_t>(k)]];
                        const double r = std::hypot(q.x - rv.cx, q.z - rv.cz);
                        double d = std::numeric_limits<double>::infinity();
                        for (const auto& m : meridians) d = std::min(d, revolution_fit::detail::polyDist(m, r, q.y));
                        worst = std::max(worst, d);
                    }
                    if (worst > p.revolutionTolM) continue;
                    revOf[t] = id; ++part.triangles; part.areaM2 += ta[t]; sumD2 += ta[t] * worst * worst;
                }
                if (part.triangles == 0) continue;
                part.explainedRmsM = std::sqrt(sumD2 / part.areaM2);   // by each triangle's farthest corner: an upper bound
                R.revolutions.push_back(std::move(part));
            }
            M.revolutionParts = R.revolutions.size();
        }
        for (size_t t = 0; t < nt; ++t) {
            if (!skinSide[t]) { ++M.hiddenTriangles; M.hiddenAreaM2 += ta[t]; continue; }
            if (revOf[t] >= 0) { ++M.revolutionTriangles; M.revolutionAreaM2 += ta[t]; continue; }
            if (std::abs(tc[t].y - groundY) < p.groundBandM && tn[t].y > 0.7) { apron[t] = 1; ++M.apronTriangles; M.apronAreaM2 += ta[t]; }
            else { ++M.skinTriangles; M.skinAreaM2 += ta[t]; R.skinTriangles.push_back(static_cast<uint32_t>(t)); }
        }
        if (M.skinTriangles == 0) throw std::runtime_error("shell fit: no part of the scan can be seen from outside");
        M.revolutionAreaShare = M.revolutionAreaM2 > 0 ? M.revolutionAreaM2 / (M.revolutionAreaM2 + M.skinAreaM2) : 0;
        // the skin as its own mesh (apron included: it stops rays as the ground does), each triangle facing out
        geometry::ScratchboxMesh skin("skin");
        std::vector<uint32_t> skinTri;   // skin triangle -> input triangle
        skin.vertices = all.vertices;
        for (size_t t = 0; t < nt; ++t) {
            if (!skinSide[t] || revOf[t] >= 0) continue;   // a round part's skin neither stops nor casts votes: its solid stands for it
            const uint32_t a = in.indices[t * 3], b = in.indices[t * 3 + 1], c = in.indices[t * 3 + 2];
            skin.indices.push_back(a);
            skin.indices.push_back(skinSide[t] > 0 ? b : c);
            skin.indices.push_back(skinSide[t] > 0 ? c : b);
            skinTri.push_back(static_cast<uint32_t>(t));
        }
        bvh::BvhTree skinBvh;
        if (!skinBvh.build(skin)) throw std::runtime_error("shell fit: could not index the skin");
        M.msSkin = msSince(t0);

        // ---------------------------------------------------------------- 2. planes
        t0 = clock::now();
        std::vector<int> triPlane(nt, -1);
        std::vector<Plane> fitted;
        {
            auto fit = [&](size_t t) { return skinSide[t] != 0 && !apron[t] && revOf[t] < 0; };
            // welded vertices and edge adjacency
            std::vector<uint32_t> wid(in.positions.size());
            {
                // positions the seam weld made equal are one vertex (0.5 mm lattice)
                std::map<std::array<int64_t, 3>, uint32_t> grid;
                for (size_t i = 0; i < in.positions.size(); ++i) {
                    const auto& v = in.positions[i];
                    const std::array<int64_t, 3> k{std::llround(v.x * 2000.0), std::llround(v.y * 2000.0), std::llround(v.z * 2000.0)};
                    wid[i] = grid.emplace(k, static_cast<uint32_t>(grid.size())).first->second;
                }
            }
            std::unordered_map<uint64_t, std::vector<uint32_t>> edgeTris;
            for (size_t t = 0; t < nt; ++t) {
                if (!fit(t)) continue;
                for (int k = 0; k < 3; ++k) {
                    const uint32_t a = wid[in.indices[t * 3 + static_cast<size_t>(k)]], b = wid[in.indices[t * 3 + static_cast<size_t>((k + 1) % 3)]];
                    if (a != b) edgeTris[edgeKey(a, b)].push_back(static_cast<uint32_t>(t));
                }
            }
            struct Region { V3 n, o, sumN; double area{0}, rmsM{0}, resultant{0}; std::vector<uint32_t> tris; };
            std::vector<Region> regions;
            std::vector<int> reg(nt, -1);
            std::vector<uint32_t> order;
            for (size_t t = 0; t < nt; ++t) if (fit(t)) order.push_back(static_cast<uint32_t>(t));
            std::sort(order.begin(), order.end(), [&](uint32_t a, uint32_t b) { return ta[a] > ta[b]; });
            const double cosGrow = std::cos(p.growAngleDeg * M_PI / 180.0);
            for (uint32_t seed : order) {
                if (reg[seed] >= 0) continue;
                Region r;
                const int id = static_cast<int>(regions.size());
                V3 sumC;
                auto take = [&](uint32_t t) { reg[t] = id; r.tris.push_back(t); r.sumN += tn[t] * ta[t]; sumC += tc[t] * ta[t]; r.area += ta[t]; };
                take(seed);
                std::vector<uint32_t> stack{seed};
                while (!stack.empty()) {
                    const uint32_t t = stack.back(); stack.pop_back();
                    for (int k = 0; k < 3; ++k) {
                        const uint32_t a = wid[in.indices[t * 3 + static_cast<size_t>(k)]], b = wid[in.indices[t * 3 + static_cast<size_t>((k + 1) % 3)]];
                        if (a == b) continue;
                        auto it = edgeTris.find(edgeKey(a, b));
                        if (it == edgeTris.end()) continue;
                        for (uint32_t u : it->second) {
                            if (reg[u] >= 0) continue;
                            const V3 n = r.sumN.normalized(), o = sumC * (1.0 / r.area);
                            if (tn[u].dot(n) < cosGrow) continue;
                            bool near = true;
                            for (int j = 0; j < 3 && near; ++j) near = std::abs(n.dot(in.positions[in.indices[u * 3 + static_cast<size_t>(j)]] - o)) <= p.growDistM;
                            if (!near) continue;
                            take(u); stack.push_back(u);
                        }
                    }
                }
                r.n = r.sumN.normalized(); r.o = sumC * (1.0 / r.area);
                regions.push_back(std::move(r));
            }
            // coplanar regions are one plane (largest first)
            std::vector<size_t> ro(regions.size());
            for (size_t i = 0; i < ro.size(); ++i) ro[i] = i;
            std::sort(ro.begin(), ro.end(), [&](size_t a, size_t b) { return regions[a].area > regions[b].area; });
            const double cosMerge = std::cos(p.mergeAngleDeg * M_PI / 180.0);
            std::vector<Region> merged;
            for (size_t i : ro) {
                Region& r = regions[i];
                if (r.area < 0.25) continue;
                Region* into = nullptr;
                for (auto& m : merged) {
                    if (m.n.dot(r.n) < cosMerge) continue;
                    if (std::abs(m.n.dot(r.o - m.o)) > p.mergeDistM) continue;
                    into = &m; break;
                }
                if (into) { into->tris.insert(into->tris.end(), r.tris.begin(), r.tris.end()); into->sumN += r.sumN; into->area += r.area; }
                else if (r.area >= std::min(2.0, p.minPlaneAreaM2)) merged.push_back(std::move(r));
            }
            M.planesFitted = merged.size();
            // least-squares refit, snap
            const double sinSnap = std::sin(p.snapDeg * M_PI / 180.0), cosSnap = std::cos(p.snapDeg * M_PI / 180.0);
            for (auto& m : merged) {
                V3 c; double w = 0;
                for (uint32_t t : m.tris) for (int k = 0; k < 3; ++k) { c += in.positions[in.indices[t * 3 + static_cast<size_t>(k)]] * ta[t]; w += ta[t]; }
                c = c * (1.0 / w);
                double cov[3][3] = {{0, 0, 0}, {0, 0, 0}, {0, 0, 0}};
                for (uint32_t t : m.tris) for (int k = 0; k < 3; ++k) {
                    const V3 d = in.positions[in.indices[t * 3 + static_cast<size_t>(k)]] - c;
                    const double dv[3] = {d.x, d.y, d.z};
                    for (int i = 0; i < 3; ++i) for (int j = 0; j < 3; ++j) cov[i][j] += ta[t] * dv[i] * dv[j];
                }
                double work[3][3];   // the eigen solver diagonalises its matrix in place; the scatter is read again below
                for (int i = 0; i < 3; ++i) for (int j = 0; j < 3; ++j) work[i][j] = cov[i][j];
                V3 n = smallestEigenvector(work);
                if (n.dot(m.sumN) < 0) n = n * -1.0;
                // the plane test, before the snap moves the normal: how far the scan lies from its own least-squares plane
                // (the smallest eigenvalue of the weighted scatter is the weighted mean squared distance) and how well its
                // triangles agree in direction (the length of their area-weighted mean unit normal: 1 for a flat patch, less
                // for a curved, tapered or crumpled one, which region growing at growAngleDeg can still gather into one region)
                {
                    const double nc[3] = {n.x, n.y, n.z};
                    double q = 0;
                    for (int i = 0; i < 3; ++i) for (int j = 0; j < 3; ++j) q += nc[i] * cov[i][j] * nc[j];
                    m.rmsM = std::sqrt(std::max(0.0, q) / w);
                    m.resultant = m.area > 0 ? m.sumN.length() / m.area : 0;
                }
                if (std::abs(n.y) < sinSnap) n = V3(n.x, 0, n.z).normalized();
                else if (std::abs(n.y) > cosSnap) n = V3(0, n.y > 0 ? 1 : -1, 0);
                m.n = n; m.o = c;
            }
            {
                // a region whose scan is not flat is not a plane: it is left to the other planes and, where none explains
                // it, to the residual scan (measured), never cut into the cells as a facet that stands for nothing
                std::vector<Region> flat;
                for (auto& m : merged) {
                    const bool rejected = m.resultant < p.minNormalResultant || m.rmsM > p.maxPlaneRmsM;
                    R.planeCandidates.push_back({m.n, m.o, m.area, m.resultant, m.rmsM, rejected});
                    if (rejected) { M.planesRejected++; M.rejectedAreaM2 += m.area; }
                    else flat.push_back(std::move(m));
                }
                merged.swap(flat);
            }
            std::sort(merged.begin(), merged.end(), [](const Region& a, const Region& b) { return a.area > b.area; });
            {
                // directions are shared: a plane within alignDeg of a larger plane's direction (or its opposite) takes it, so
                // two fits of one warped wall never cross at a shallow angle; planes then exactly parallel and within the
                // merge offset of each other are one plane
                const double cosAlign = std::cos(p.alignDeg * M_PI / 180.0);
                std::vector<Region> aligned;
                for (auto& m : merged) {
                    Region* into = nullptr;
                    for (auto& a : aligned) {
                        const double c = a.n.dot(m.n);
                        if (std::abs(c) < cosAlign) continue;
                        m.n = a.n * (c >= 0 ? 1.0 : -1.0);
                        if (c >= 0 && std::abs(a.n.dot(m.o - a.o)) <= p.mergeDistM) into = &a;
                        break;
                    }
                    if (into) {
                        // the offset of the merged plane: the area-weighted mean along the shared direction
                        const double off = into->n.dot(m.o - into->o) * m.area / (into->area + m.area);
                        into->o = into->o + into->n * off;
                        into->tris.insert(into->tris.end(), m.tris.begin(), m.tris.end()); into->sumN += m.sumN; into->area += m.area;
                    } else aligned.push_back(std::move(m));
                }
                merged.swap(aligned);
                std::sort(merged.begin(), merged.end(), [](const Region& a, const Region& b) { return a.area > b.area; });
            }
            // every skin triangle goes to the largest plane it lies on
            const double cosAssign = std::cos(std::min(89.0, p.growAngleDeg + 5.0) * M_PI / 180.0);
            std::vector<int> assign(nt, -1);
            parallelFor(nt, threads, [&](size_t t) {
                if (!fit(t)) return;
                for (size_t i = 0; i < merged.size(); ++i) {
                    const auto& m = merged[i];
                    if (tn[t].dot(m.n) < cosAssign) continue;
                    bool near = true;
                    for (int j = 0; j < 3 && near; ++j) near = std::abs(m.n.dot(in.positions[in.indices[t * 3 + static_cast<size_t>(j)]] - m.o)) <= p.growDistM;
                    if (near) { assign[t] = static_cast<int>(i); return; }
                }
            });
            std::vector<double> area(merged.size(), 0.0);
            for (size_t t = 0; t < nt; ++t) if (assign[t] >= 0) area[static_cast<size_t>(assign[t])] += ta[t];
            std::vector<size_t> keep;
            for (size_t i = 0; i < merged.size(); ++i) if (area[i] >= p.minPlaneAreaM2) keep.push_back(i);
            std::sort(keep.begin(), keep.end(), [&](size_t a, size_t b) { return area[a] > area[b]; });
            if (keep.size() > static_cast<size_t>(std::max(0, p.maxPlanes))) keep.resize(static_cast<size_t>(std::max(0, p.maxPlanes)));
            std::vector<int> remap(merged.size(), -1);
            for (size_t k = 0; k < keep.size(); ++k) {
                remap[keep[k]] = static_cast<int>(k);
                Plane pl; pl.n = merged[keep[k]].n; pl.d = -pl.n.dot(merged[keep[k]].o); pl.supportAreaM2 = area[keep[k]];
                fitted.push_back(pl);
            }
            double assignedArea = 0;
            for (size_t t = 0; t < nt; ++t) if (assign[t] >= 0 && remap[static_cast<size_t>(assign[t])] >= 0) { triPlane[t] = remap[static_cast<size_t>(assign[t])] + 6; assignedArea += ta[t]; }
            M.planeAssignedAreaShare = M.skinAreaM2 > 0 ? assignedArea / M.skinAreaM2 : 0;
        }
        M.planesKept = fitted.size();
        M.msPlanes = msSince(t0);

        // ---------------------------------------------------------------- 3. cells
        t0 = clock::now();
        const V3 bmin(lo.x - p.marginM, groundY, lo.z - p.marginM), bmax(hi.x + p.marginM, std::max(hi.y, groundY + 1.0) + p.marginM, hi.z + p.marginM);
        {
            // bounding planes, normals out: 0 -x, 1 +x, 2 -y (the floor at the ground datum), 3 +y, 4 -z, 5 +z
            const V3 ns[6] = {V3(-1, 0, 0), V3(1, 0, 0), V3(0, -1, 0), V3(0, 1, 0), V3(0, 0, -1), V3(0, 0, 1)};
            const double ds[6] = {bmin.x, -bmax.x, bmin.y, -bmax.y, bmin.z, -bmax.z};
            for (int i = 0; i < 6; ++i) { Plane pl; pl.n = ns[i]; pl.d = ds[i]; pl.bounding = true; R.planes.push_back(pl); }
            for (const auto& f : fitted) R.planes.push_back(f);
        }
        const std::vector<Plane>& planes = R.planes;
        std::vector<Cell> leaves;
        {
            Cell root;
            const V3 c[8] = {V3(bmin.x, bmin.y, bmin.z), V3(bmax.x, bmin.y, bmin.z), V3(bmax.x, bmax.y, bmin.z), V3(bmin.x, bmax.y, bmin.z),
                             V3(bmin.x, bmin.y, bmax.z), V3(bmax.x, bmin.y, bmax.z), V3(bmax.x, bmax.y, bmax.z), V3(bmin.x, bmax.y, bmax.z)};
            // per bounding plane: its corners in order, and the plane across each edge
            const int quad[6][4] = {{0, 3, 7, 4}, {1, 2, 6, 5}, {0, 1, 5, 4}, {3, 2, 6, 7}, {0, 1, 2, 3}, {4, 5, 6, 7}};
            const int qtag[6][4] = {{4, 3, 5, 2}, {4, 3, 5, 2}, {4, 1, 5, 0}, {4, 1, 5, 0}, {2, 1, 3, 0}, {2, 1, 3, 0}};
            for (int f = 0; f < 6; ++f) {
                Face face; face.plane = f; face.side = -1;
                for (int k = 0; k < 4; ++k) { face.pts.push_back(c[quad[f][k]]); face.tags.push_back(qtag[f][k]); }
                root.faces.push_back(std::move(face));
            }
            for (size_t t = 0; t < nt; ++t) if (triPlane[t] >= 0) root.tris.push_back(static_cast<uint32_t>(t));
            measureCell(root);
            std::vector<Cell> stack;
            stack.push_back(std::move(root));
            std::vector<double> acc(planes.size(), 0.0);
            while (!stack.empty()) {
                Cell cell = std::move(stack.back()); stack.pop_back();
                bool split = false;
                while (!cell.tris.empty() && leaves.size() + stack.size() < p.maxCells) {
                    std::vector<int> touched;
                    for (uint32_t t : cell.tris) { const int pl = triPlane[t]; if (acc[static_cast<size_t>(pl)] == 0.0) touched.push_back(pl); acc[static_cast<size_t>(pl)] += ta[t]; }
                    int best = -1;
                    for (int pl : touched) if (best < 0 || acc[static_cast<size_t>(pl)] > acc[static_cast<size_t>(best)]) best = pl;
                    const double bestArea = best >= 0 ? acc[static_cast<size_t>(best)] : 0.0;
                    for (int pl : touched) acc[static_cast<size_t>(pl)] = 0.0;
                    if (best < 0 || bestArea < p.minSplitAreaM2) break;
                    Cell pos, neg;
                    const bool ok = splitCell(cell, planes[static_cast<size_t>(best)], best, pos, neg);
                    if (!ok) {
                        // the plane does not cut this cell in two: its scan here lies along a face the cell already has
                        std::vector<uint32_t> rest;
                        for (uint32_t t : cell.tris) if (triPlane[t] != best) rest.push_back(t);
                        cell.tris.swap(rest);
                        continue;
                    }
                    for (uint32_t t : cell.tris) {
                        if (triPlane[t] == best) continue;
                        (planes[static_cast<size_t>(best)].dist(tc[t]) >= 0 ? pos : neg).tris.push_back(t);
                    }
                    stack.push_back(std::move(pos));
                    stack.push_back(std::move(neg));
                    split = true;
                    break;
                }
                if (!split) { cell.tris.clear(); cell.tris.shrink_to_fit(); leaves.push_back(std::move(cell)); }
            }
        }
        M.supportCells = leaves.size();

        // windingVotes: the skin's generalised winding number (the solid angle it subtends, over 4 pi; 1 inside a closed
        // outward-facing shell, 0 outside, falling toward 0 near a thin open structure such as a lattice, whose surfaces
        // enclose nothing), with a floor at the ground datum standing in for the bottom the scan never has
        std::unique_ptr<inner_core::detail::Bvh> gwn;
        if (p.windingVotes) {
            std::vector<inner_core::detail::Tri> wt;
            auto v3 = [](const geometry::Vertex& v) { return inner_core::Vec3{v.position.x, v.position.y, v.position.z}; };
            for (size_t k = 0; k + 2 < skin.indices.size(); k += 3) wt.push_back({v3(skin.vertices[skin.indices[k]]), v3(skin.vertices[skin.indices[k + 1]]), v3(skin.vertices[skin.indices[k + 2]])});
            const double fx0 = lo.x - 2 * p.marginM, fx1 = hi.x + 2 * p.marginM, fz0 = lo.z - 2 * p.marginM, fz1 = hi.z + 2 * p.marginM;
            const inner_core::Vec3 c00{fx0, groundY, fz0}, c10{fx1, groundY, fz0}, c11{fx1, groundY, fz1}, c01{fx0, groundY, fz1};
            wt.push_back({c00, c10, c11}); wt.push_back({c00, c11, c01});   // facing down: the solid's outside is below the ground
            gwn = std::make_unique<inner_core::detail::Bvh>(wt);
        }
        // a ray vote at a point: the side of the skin each direction first meets
        auto voteAt = [&](const V3& s, double& in, double& out) {
            if (gwn) {
                const double w = std::clamp(gwn->winding({s.x, s.y, s.z}, p.windingFarRatio), 0.0, 1.0);
                in += w * static_cast<double>(dirs.size()); out += (1.0 - w) * static_cast<double>(dirs.size());
                return;
            }
            for (const auto& d : dirs) {
                bvh::RayHit h;
                if (skinBvh.raycast(math::Ray(f3(s), f3(d)), h)) {
                    const uint32_t st = h.triangleIndex;
                    const V3 a = d3(skin.vertices[skin.indices[st * 3]].position), b = d3(skin.vertices[skin.indices[st * 3 + 1]].position), cc = d3(skin.vertices[skin.indices[st * 3 + 2]].position);
                    if ((b - a).cross(cc - a).dot(d) > 0) in += 1; else out += 1;
                } else if (d.y > -0.2) out += 1;   // nothing below: the scan is open at the bottom, no vote
            }
        };
        // points spread through a convex cell (by pyramids from its centroid), the same for the same seed
        auto sampleCell = [&](const Cell& c, uint64_t seed, int n) {
            struct T { V3 a, b, d; };
            std::vector<T> tris; std::vector<double> cum;
            double total = 0;
            for (const auto& f : c.faces) for (size_t i = 1; i + 1 < f.pts.size(); ++i) {
                const T t{f.pts[0], f.pts[i], f.pts[i + 1]};
                total += std::abs((t.a - c.centroid).dot((t.b - c.centroid).cross(t.d - c.centroid)));
                tris.push_back(t); cum.push_back(total);
            }
            std::vector<V3> out;
            uint64_t x = seed * 0x9E3779B97F4A7C15ull + 0x1234567ull;
            auto u = [&]() { x += 0x9E3779B97F4A7C15ull; uint64_t z = x; z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ull; z = (z ^ (z >> 27)) * 0x94D049BB133111EBull; z ^= z >> 31; return static_cast<double>(z >> 11) / 9007199254740992.0; };
            if (tris.empty() || !(total > 0)) { out.push_back(c.centroid); return out; }
            for (int k = 0; k < n; ++k) {
                const size_t i = static_cast<size_t>(std::lower_bound(cum.begin(), cum.end(), u() * total) - cum.begin());
                const T& t = tris[std::min(i, tris.size() - 1)];
                const double r1 = std::sqrt(u()), r2 = u();
                const V3 q = t.a * (1.0 - r1) + t.b * (r1 * (1.0 - r2)) + t.d * (r1 * r2);
                out.push_back(c.centroid + (q - c.centroid) * (0.02 + 0.96 * std::cbrt(u())));
            }
            return out;
        };
        {
            // vote-driven refinement: the support-driven cells end where their planes' scan ends, so a cell can hold both
            // the solid and the air beside it (a shaft under a top no plane explains). A cell whose sample points disagree
            // is split again: by the fitted plane, continued into the cell, that best parts its inside samples from its
            // outside ones, else by a plane placed between them (it has no scan of its own, so its faces come out generated).
            const double sinSnap = std::sin(p.snapDeg * M_PI / 180.0), cosSnap = std::cos(p.snapDeg * M_PI / 180.0);
            std::vector<Cell> done, active = std::move(leaves);
            for (int round = 0; round < p.refineRounds && !active.empty(); ++round) {
                struct Votes { std::vector<V3> pts; std::vector<char> in; };
                std::vector<Votes> votes(active.size());
                parallelFor(active.size(), threads, [&](size_t i) {
                    const Cell& c = active[i];
                    if (c.volume < p.refineMinVolumeM3) return;
                    Votes& v = votes[i];
                    v.pts = sampleCell(c, static_cast<uint64_t>(round) * 1000003ull + i, std::clamp(static_cast<int>(c.volume / 40.0), 24, 96));
                    for (const auto& q : v.pts) { double in = 0, out = 0; voteAt(q, in, out); v.in.push_back(in > out ? 1 : 0); }
                });
                std::vector<Cell> next;
                for (size_t i = 0; i < active.size(); ++i) {
                    Cell& cell = active[i];
                    const Votes& v = votes[i];
                    const int N = static_cast<int>(v.pts.size());
                    int kin = 0;
                    for (char c : v.in) kin += c;
                    const int errs0 = std::min(kin, N - kin);
                    if (N == 0 || errs0 <= p.refineMinorityShare * N || done.size() + next.size() + active.size() >= p.maxCells) { done.push_back(std::move(cell)); continue; }
                    int best = -1, bestErr = errs0;
                    for (size_t pl = 6; pl < R.planes.size(); ++pl) {
                        int ip = 0, op = 0, in_ = 0, on = 0;
                        for (int k = 0; k < N; ++k) {
                            const bool pos = R.planes[pl].dist(v.pts[static_cast<size_t>(k)]) >= 0;
                            if (v.in[static_cast<size_t>(k)]) { if (pos) ++ip; else ++in_; } else { if (pos) ++op; else ++on; }
                        }
                        if (ip + op == 0 || in_ + on == 0) continue;
                        const int e = std::min(ip, op) + std::min(in_, on);
                        if (e < bestErr) { bestErr = e; best = static_cast<int>(pl); }
                    }
                    // the plane between the inside samples and the outside ones
                    V3 mi, mo;
                    for (int k = 0; k < N; ++k) (v.in[static_cast<size_t>(k)] ? mi : mo) += v.pts[static_cast<size_t>(k)];
                    mi = mi * (1.0 / kin); mo = mo * (1.0 / (N - kin));
                    V3 sn = (mo - mi).normalized();
                    if (std::abs(sn.y) < sinSnap) sn = V3(sn.x, 0, sn.z).normalized();
                    else if (std::abs(sn.y) > cosSnap) sn = V3(0, sn.y > 0 ? 1 : -1, 0);
                    std::vector<std::pair<double, char>> proj;
                    for (int k = 0; k < N; ++k) proj.emplace_back(sn.dot(v.pts[static_cast<size_t>(k)]), v.in[static_cast<size_t>(k)]);
                    std::sort(proj.begin(), proj.end());
                    int sepErr = N, below = 0, inBelow = 0; double sepAt = 0;
                    for (int k = 0; k + 1 < N; ++k) {
                        ++below; inBelow += proj[static_cast<size_t>(k)].second;
                        // below the threshold should be inside, above it outside
                        const int e = (below - inBelow) + (kin - inBelow);
                        if (e < sepErr && proj[static_cast<size_t>(k + 1)].first - proj[static_cast<size_t>(k)].first > 1e-6) { sepErr = e; sepAt = 0.5 * (proj[static_cast<size_t>(k)].first + proj[static_cast<size_t>(k + 1)].first); }
                    }
                    bool separator = false;
                    if (sepErr + 1 < bestErr || (best < 0 && sepErr < errs0)) { separator = true; bestErr = sepErr; }
                    if ((best < 0 && !separator) || errs0 - bestErr < std::max(1, errs0 / 4)) { done.push_back(std::move(cell)); continue; }
                    Plane sp; sp.n = sn; sp.d = -sepAt;
                    Cell pos, neg;
                    if (!splitCell(cell, separator ? sp : R.planes[static_cast<size_t>(best)], separator ? static_cast<int>(R.planes.size()) : best, pos, neg)) { done.push_back(std::move(cell)); continue; }
                    if (separator) { R.planes.push_back(sp); ++M.separatorPlanes; }
                    ++M.refineSplits;
                    next.push_back(std::move(pos)); next.push_back(std::move(neg));
                }
                active = std::move(next);
            }
            leaves = std::move(done);
            for (auto& c : active) leaves.push_back(std::move(c));
        }
        if (p.topIsAir) {
            // solid stops at the highest roof the scan shows (round parts' tops count: they are measured too)
            std::vector<double> roofY, roofArea;
            std::vector<V3> roofPts, scanPts; std::vector<double> sampleArea;
            for (size_t t = 0; t < nt; ++t) {
                if (!skinSide[t] || apron[t]) continue;
                {
                    const V3& a = in.positions[in.indices[t * 3]]; const V3& b = in.positions[in.indices[t * 3 + 1]]; const V3& c = in.positions[in.indices[t * 3 + 2]];
                    scanPts.push_back(a); scanPts.push_back(b); scanPts.push_back(c); scanPts.push_back(tc[t]);
                }
                if (tn[t].y <= 0.7) continue;
                roofY.push_back(tc[t].y); roofArea.push_back(ta[t]);
                // surface samples about 0.5 m apart, each with its share of the area, so a thin cell under one large
                // roof triangle still finds its roof
                const V3& a = in.positions[in.indices[t * 3]]; const V3& b = in.positions[in.indices[t * 3 + 1]]; const V3& c = in.positions[in.indices[t * 3 + 2]];
                const int n = std::clamp(static_cast<int>(std::ceil(std::sqrt(ta[t] / 0.25))), 1, 64);
                const int count = n * (n + 1) / 2;
                for (int u = 0; u < n; ++u) for (int v = 0; u + v < n; ++v) {
                    roofPts.push_back(a + (b - a) * ((u + 1.0 / 3.0) / n) + (c - a) * ((v + 1.0 / 3.0) / n));
                    sampleArea.push_back(ta[t] / count);
                }
            }
            const std::vector<double> levels = roofLevels(roofY, roofArea, p.roofMinAreaM2);
            M.roofLevels = levels.size();
            M.roofCaps = capCellsAtRoof(leaves, R.planes, 3, levels, roofPts, sampleArea, scanPts);
        }
        const int nc = static_cast<int>(leaves.size());
        M.cells = leaves.size();

        // the faces between cells: per plane, each cell face on one side against those on the other
        std::vector<Interface> ifs;
        {
            struct Ref { int cell; int face; };
            std::vector<std::vector<Ref>> posSide(planes.size()), negSide(planes.size());
            for (int c = 0; c < nc; ++c) for (size_t f = 0; f < leaves[static_cast<size_t>(c)].faces.size(); ++f) {
                const Face& face = leaves[static_cast<size_t>(c)].faces[f];
                (face.side > 0 ? posSide : negSide)[static_cast<size_t>(face.plane)].push_back({c, static_cast<int>(f)});
            }
            std::vector<std::vector<Interface>> perPlane(planes.size());
            parallelFor(planes.size(), threads, [&](size_t pi) {
                const Plane& pl = planes[pi];
                auto& out = perPlane[pi];
                const V3 n = pl.n;
                const V3 u = (std::abs(n.x) < 0.9 ? V3(1, 0, 0) : V3(0, 1, 0)).cross(n).normalized();
                const V3 v = n.cross(u);
                const V3 o = n * (-pl.d);
                struct Poly2 { std::vector<P2> pts; std::vector<int> tags; double x0, x1, y0, y1; int cell; };
                auto to2 = [&](const Ref& r) {
                    const Face& f = leaves[static_cast<size_t>(r.cell)].faces[static_cast<size_t>(r.face)];
                    Poly2 q; q.cell = r.cell; q.tags = f.tags;
                    q.x0 = q.y0 = 1e300; q.x1 = q.y1 = -1e300;
                    for (const auto& pt : f.pts) { const V3 d = pt - o; q.pts.push_back({d.dot(u), d.dot(v)}); }
                    double a2 = 0;
                    for (size_t i = 0; i < q.pts.size(); ++i) { const auto& a = q.pts[i]; const auto& b = q.pts[(i + 1) % q.pts.size()]; a2 += a.x * b.y - b.x * a.y; }
                    if (a2 < 0) {
                        // reversed: point order flips, and the edge leaving point i is the one that used to arrive at it
                        const size_t m = q.pts.size();
                        std::vector<P2> rp(m); std::vector<int> rt(m);
                        for (size_t i = 0; i < m; ++i) { rp[i] = q.pts[m - 1 - i]; rt[i] = q.tags[(2 * m - 2 - i) % m]; }
                        q.pts.swap(rp); q.tags.swap(rt);
                    }
                    for (const auto& a : q.pts) { q.x0 = std::min(q.x0, a.x); q.x1 = std::max(q.x1, a.x); q.y0 = std::min(q.y0, a.y); q.y1 = std::max(q.y1, a.y); }
                    return q;
                };
                auto emit = [&](const std::vector<P2>& pts, const std::vector<int>& tags, int negCell, int posCell) {
                    Interface it; it.neg = negCell; it.pos = posCell; it.plane = static_cast<int>(pi); it.tags = tags;
                    for (const auto& a : pts) it.pts.push_back(o + u * a.x + v * a.y);
                    it.area = polygonArea(it.pts);
                    if (it.area > 1e-8) out.push_back(std::move(it));
                };
                std::vector<Poly2> ps, ns;
                for (const auto& r : posSide[pi]) ps.push_back(to2(r));
                for (const auto& r : negSide[pi]) ns.push_back(to2(r));
                if (pl.bounding) { for (const auto& q : ns) emit(q.pts, q.tags, q.cell, -1); return; }
                auto lerp = [](const P2& a, const P2& b, double t) { return P2{a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t}; };
                auto same = [](const P2& a, const P2& b) { return std::hypot(a.x - b.x, a.y - b.y) < 1e-9; };
                std::vector<P2> cur, nxt; std::vector<int> ct, ntg;
                for (const auto& a : ns) for (const auto& b : ps) {
                    if (a.x1 < b.x0 + 1e-7 || b.x1 < a.x0 + 1e-7 || a.y1 < b.y0 + 1e-7 || b.y1 < a.y0 + 1e-7) continue;
                    cur = a.pts; ct = a.tags;
                    for (size_t j = 0; j < b.pts.size() && cur.size() >= 3; ++j) {
                        const P2& e0 = b.pts[j]; const P2& e1 = b.pts[(j + 1) % b.pts.size()];
                        const double ex = e1.x - e0.x, ey = e1.y - e0.y, el = std::hypot(ex, ey);
                        if (el < 1e-12) continue;
                        clipTagged(cur, ct, [&](const P2& q) { return (ex * (q.y - e0.y) - ey * (q.x - e0.x)) / el; }, lerp, same, b.tags[j], 1e-7, nxt, ntg);
                        cur.swap(nxt); ct.swap(ntg);
                    }
                    if (cur.size() >= 3) emit(cur, ct, a.cell, b.cell);
                }
            });
            for (auto& v : perPlane) for (auto& it : v) ifs.push_back(std::move(it));
        }
        M.interfaces = ifs.size();
        M.msCells = msSince(t0);

        // ---------------------------------------------------------------- 4. labels
        t0 = clock::now();
        // the share of a face the scan supports: per sample, a ray along the face normal through the tolerance band
        auto supportOf = [&](const std::vector<V3>& pts, const V3& n, double h) {
            const std::vector<V3> s = samplePolygon(pts, n, h);
            size_t hit = 0;
            const float reach = static_cast<float>(2.0 * p.supportTolM);
            for (const auto& q : s) {
                bvh::RayHit hh; hh.t = reach;
                if (skinBvh.raycast(math::Ray(f3(q - n * p.supportTolM), f3(n)), hh) && hh.t <= reach && !apron[skinTri[hh.triangleIndex]]) ++hit;
            }
            return static_cast<double>(hit) / static_cast<double>(s.size());
        };
        parallelFor(ifs.size(), threads, [&](size_t i) {
            Interface& it = ifs[i];
            it.support = supportOf(it.pts, planes[static_cast<size_t>(it.plane)].n, std::max(0.5, std::sqrt(it.area / 64.0)));
        });
        std::vector<double> pIn(static_cast<size_t>(nc), 0.5);
        parallelFor(static_cast<size_t>(nc), threads, [&](size_t ci) {
            const Cell& c = leaves[ci];
            double in = 0, out = 0;
            for (const auto& q : sampleCell(c, 0xC0FFEEull + ci, 32)) voteAt(q, in, out);
            pIn[ci] = in + out > 0 ? in / (in + out) : 0.5;
        });
        std::vector<char> inside(static_cast<size_t>(nc), 0);
        {
            const int S = nc, T = nc + 1;
            MaxFlow mf(nc + 2);
            std::vector<double> toSink(static_cast<size_t>(nc), 0.0);
            for (const auto& it : ifs) {
                const double w = it.area * (p.unsupportedCutCost * (1.0 - it.support) + p.supportedCutCost * it.support);
                if (it.pos < 0 || it.neg < 0) {
                    // the bounding volume: outside, except its floor (below the ground datum is inside, the cut there is free)
                    // topIsAir: the top of the bounding volume stands marginM above the highest scanned point, so a cell
                    // reaching it holds no scanned solid: outside outright (else a thin column the votes call inside, a
                    // lattice mast's, is closed at the margin). The sides are not: the isolation's cut can run along them.
                    if (it.plane != 2) toSink[static_cast<size_t>(it.pos < 0 ? it.neg : it.pos)] += p.topIsAir && it.plane == 3 ? 1e15 : w;
                } else mf.add(it.neg, it.pos, w, w);
            }
            for (int c = 0; c < nc; ++c) {
                const double w = p.unaryWeight * leaves[static_cast<size_t>(c)].surface;
                mf.add(S, c, w * pIn[static_cast<size_t>(c)], 0.0);
                mf.add(c, T, w * (1.0 - pIn[static_cast<size_t>(c)]) + toSink[static_cast<size_t>(c)], 0.0);
            }
            mf.run(S, T);
            const auto side = mf.sourceSide(S);
            for (int c = 0; c < nc; ++c) inside[static_cast<size_t>(c)] = side[static_cast<size_t>(c)];
        }
        {
            // outside cells the outside cannot reach are pockets: inside. Small inside components are dropped.
            std::vector<std::vector<int>> adj(static_cast<size_t>(nc));
            std::vector<char> touchesOutside(static_cast<size_t>(nc), 0);
            for (const auto& it : ifs) {
                if (it.pos < 0 || it.neg < 0) { if (it.plane != 2) touchesOutside[static_cast<size_t>(it.pos < 0 ? it.neg : it.pos)] = 1; continue; }
                adj[static_cast<size_t>(it.neg)].push_back(it.pos); adj[static_cast<size_t>(it.pos)].push_back(it.neg);
            }
            std::vector<char> reached(static_cast<size_t>(nc), 0);
            std::vector<int> st;
            for (int c = 0; c < nc; ++c) if (!inside[static_cast<size_t>(c)] && touchesOutside[static_cast<size_t>(c)]) { reached[static_cast<size_t>(c)] = 1; st.push_back(c); }
            while (!st.empty()) {
                const int c = st.back(); st.pop_back();
                for (int o : adj[static_cast<size_t>(c)]) if (!inside[static_cast<size_t>(o)] && !reached[static_cast<size_t>(o)]) { reached[static_cast<size_t>(o)] = 1; st.push_back(o); }
            }
            for (int c = 0; c < nc; ++c) if (!inside[static_cast<size_t>(c)] && !reached[static_cast<size_t>(c)]) { inside[static_cast<size_t>(c)] = 1; ++M.pocketsFilled; }
            std::vector<int> comp(static_cast<size_t>(nc), -1);
            std::vector<double> compVol;
            for (int c = 0; c < nc; ++c) {
                if (!inside[static_cast<size_t>(c)] || comp[static_cast<size_t>(c)] >= 0) continue;
                const int id = static_cast<int>(compVol.size());
                compVol.push_back(0);
                comp[static_cast<size_t>(c)] = id; st.push_back(c);
                while (!st.empty()) {
                    const int x = st.back(); st.pop_back();
                    compVol[static_cast<size_t>(id)] += leaves[static_cast<size_t>(x)].volume;
                    for (int o : adj[static_cast<size_t>(x)]) if (inside[static_cast<size_t>(o)] && comp[static_cast<size_t>(o)] < 0) { comp[static_cast<size_t>(o)] = id; st.push_back(o); }
                }
            }
            if (!compVol.empty()) {
                const size_t largest = static_cast<size_t>(std::max_element(compVol.begin(), compVol.end()) - compVol.begin());
                std::vector<char> drop(compVol.size(), 0);
                for (size_t i = 0; i < compVol.size(); ++i) if (i != largest && compVol[i] < p.minComponentM3) { drop[i] = 1; ++M.componentsDropped; }
                for (int c = 0; c < nc; ++c) if (inside[static_cast<size_t>(c)] && drop[static_cast<size_t>(comp[static_cast<size_t>(c)])]) inside[static_cast<size_t>(c)] = 0;
            }
        }
        for (int c = 0; c < nc; ++c) if (inside[static_cast<size_t>(c)]) ++M.insideCells;
        for (int c = 0; c < nc; ++c) {
            const Cell& cell = leaves[static_cast<size_t>(c)];
            Result::CellInfo ci; ci.centroid = cell.centroid; ci.volume = cell.volume; ci.surface = cell.surface; ci.pIn = pIn[static_cast<size_t>(c)]; ci.inside = inside[static_cast<size_t>(c)] != 0;
            ci.lo = V3(1e300, 1e300, 1e300); ci.hi = V3(-1e300, -1e300, -1e300);
            for (const auto& f : cell.faces) for (const auto& q : f.pts) { ci.lo = V3(std::min(ci.lo.x, q.x), std::min(ci.lo.y, q.y), std::min(ci.lo.z, q.z)); ci.hi = V3(std::max(ci.hi.x, q.x), std::max(ci.hi.y, q.y), std::max(ci.hi.z, q.z)); }
            R.cells.push_back(ci);
        }
        M.msLabels = msSince(t0);
        if (M.insideCells == 0) throw std::runtime_error("shell fit: no cell was found to be inside the scan");

        // ---------------------------------------------------------------- 5. shell
        t0 = clock::now();
        struct SPoly { int plane; int outSign; std::vector<uint32_t> v; std::vector<int> tags; double area, support; bool inserted{false}; };
        std::vector<SPoly> polys;
        Welder weld(1e-5);
        {
            std::vector<const Interface*> shellIfs;
            for (const auto& it : ifs) {
                const bool a = it.neg >= 0 && inside[static_cast<size_t>(it.neg)], b = it.pos >= 0 && inside[static_cast<size_t>(it.pos)];
                if (a != b) shellIfs.push_back(&it);
            }
            std::vector<double> fine(shellIfs.size());
            parallelFor(shellIfs.size(), threads, [&](size_t i) {
                const Interface& it = *shellIfs[i];
                fine[i] = supportOf(it.pts, planes[static_cast<size_t>(it.plane)].n, std::max(0.25, std::sqrt(it.area / 4096.0)));
            });
            for (size_t i = 0; i < shellIfs.size(); ++i) {
                const Interface& it = *shellIfs[i];
                SPoly sp; sp.plane = it.plane; sp.area = it.area; sp.support = fine[i];
                sp.outSign = (it.neg >= 0 && inside[static_cast<size_t>(it.neg)]) ? +1 : -1;
                for (size_t k = 0; k < it.pts.size(); ++k) {
                    const uint32_t id = weld.add(it.pts[k]);
                    if (!sp.v.empty() && sp.v.back() == id) { sp.tags.back() = it.tags[k]; continue; }
                    sp.v.push_back(id); sp.tags.push_back(it.tags[k]);
                }
                while (sp.v.size() > 1 && sp.v.front() == sp.v.back()) { sp.v.pop_back(); sp.tags.pop_back(); }
                if (sp.v.size() >= 3) polys.push_back(std::move(sp));
            }
        }
        std::vector<V3>& sv = weld.pts;
        {
            // T-junctions: along each line where two planes meet, an edge takes every shell vertex lying inside it
            std::unordered_map<uint64_t, std::vector<uint32_t>> lineVerts;
            auto lineKey = [](int a, int b) { return a < b ? (static_cast<uint64_t>(static_cast<uint32_t>(a)) << 32) | static_cast<uint32_t>(b) : (static_cast<uint64_t>(static_cast<uint32_t>(b)) << 32) | static_cast<uint32_t>(a); };
            for (const auto& sp : polys) for (size_t i = 0; i < sp.v.size(); ++i) {
                auto& lv = lineVerts[lineKey(sp.plane, sp.tags[i])];
                lv.push_back(sp.v[i]); lv.push_back(sp.v[(i + 1) % sp.v.size()]);
            }
            for (auto& [k, lv] : lineVerts) { (void)k; std::sort(lv.begin(), lv.end()); lv.erase(std::unique(lv.begin(), lv.end()), lv.end()); }
            auto insertOn = [&](SPoly& sp, const std::function<const std::vector<uint32_t>*(int)>& candidates) {
                std::vector<uint32_t> nv; std::vector<int> ntg;
                const size_t m = sp.v.size();
                for (size_t i = 0; i < m; ++i) {
                    const uint32_t a = sp.v[i], b = sp.v[(i + 1) % m];
                    nv.push_back(a); ntg.push_back(sp.tags[i]);
                    const std::vector<uint32_t>* cand = candidates(sp.tags[i]);
                    if (!cand) continue;
                    const V3 d = sv[b] - sv[a];
                    const double l2 = d.dot(d);
                    if (l2 < 1e-18) continue;
                    std::vector<std::pair<double, uint32_t>> mid;
                    for (uint32_t c : *cand) {
                        if (c == a || c == b) continue;
                        const V3 r = sv[c] - sv[a];
                        const double t = r.dot(d) / l2;
                        if (t <= 0 || t >= 1) continue;
                        if ((r - d * t).length() > 1e-4) continue;
                        mid.emplace_back(t, c);
                    }
                    std::sort(mid.begin(), mid.end());
                    for (const auto& [t, c] : mid) { (void)t; if (nv.back() != c) { nv.push_back(c); ntg.push_back(sp.tags[i]); sp.inserted = true; ++M.tJunctionsClosed; } }
                }
                sp.v.swap(nv); sp.tags.swap(ntg);
            };
            for (auto& sp : polys) {
                const int pl = sp.plane;
                insertOn(sp, [&](int tag) -> const std::vector<uint32_t>* { auto it = lineVerts.find(lineKey(pl, tag)); return it == lineVerts.end() ? nullptr : &it->second; });
            }
            // what is left open (a line three planes share): the ends of odd edges, tried on every odd edge
            for (int round = 0; round < 4; ++round) {
                std::unordered_map<uint64_t, int> cnt;
                for (const auto& sp : polys) for (size_t i = 0; i < sp.v.size(); ++i) ++cnt[edgeKey(sp.v[i], sp.v[(i + 1) % sp.v.size()])];
                std::vector<uint32_t> odd;
                for (const auto& [k, c] : cnt) if (c % 2) { odd.push_back(static_cast<uint32_t>(k >> 32)); odd.push_back(static_cast<uint32_t>(k & 0xFFFFFFFFull)); }
                if (odd.empty()) break;
                std::sort(odd.begin(), odd.end()); odd.erase(std::unique(odd.begin(), odd.end()), odd.end());
                const size_t before = M.tJunctionsClosed;
                for (auto& sp : polys) {
                    bool has = false;
                    for (size_t i = 0; i < sp.v.size() && !has; ++i) has = (cnt[edgeKey(sp.v[i], sp.v[(i + 1) % sp.v.size()])] % 2) != 0;
                    if (has) insertOn(sp, [&](int) -> const std::vector<uint32_t>* { return &odd; });
                }
                if (M.tJunctionsClosed == before) break;
            }
        }
        // faces: one per plane, facing and label; triangles sorted by face
        struct Tri { uint32_t a, b, c; };
        std::map<std::array<int, 3>, size_t> faceIndex;
        std::vector<std::vector<Tri>> faceTris;
        std::vector<double> faceSupportArea;
        for (const auto& sp : polys) {
            const Plane& pl = planes[static_cast<size_t>(sp.plane)];
            const bool measured = sp.support >= p.measuredShare;
            const std::array<int, 3> key{sp.plane, sp.outSign, measured ? 1 : 0};
            auto it = faceIndex.find(key);
            if (it == faceIndex.end()) {
                it = faceIndex.emplace(key, R.faces.size()).first;
                ShellFace f; f.plane = sp.plane; f.normal = pl.n * static_cast<double>(sp.outSign); f.d = pl.d * sp.outSign; f.measured = measured;
                f.groundClosure = sp.plane == 2;
                R.faces.push_back(f); faceTris.emplace_back(); faceSupportArea.push_back(0);
            }
            const size_t fi = it->second;
            R.faces[fi].areaM2 += sp.area;
            faceSupportArea[fi] += sp.area * sp.support;
            const V3 out = R.faces[fi].normal;
            std::vector<uint32_t> v = sp.v;
            V3 nw;
            for (size_t i = 0; i < v.size(); ++i) { const V3& a = sv[v[i]]; const V3& b = sv[v[(i + 1) % v.size()]]; nw += V3((a.y - b.y) * (a.z + b.z), (a.z - b.z) * (a.x + b.x), (a.x - b.x) * (a.y + b.y)); }
            if (nw.dot(out) < 0) std::reverse(v.begin(), v.end());
            if (sp.inserted) {
                V3 c; for (uint32_t id : v) c += sv[id];
                const uint32_t ci = static_cast<uint32_t>(sv.size());
                sv.push_back(c * (1.0 / static_cast<double>(v.size())));
                for (size_t i = 0; i < v.size(); ++i) faceTris[fi].push_back({ci, v[i], v[(i + 1) % v.size()]});
            } else {
                for (size_t i = 1; i + 1 < v.size(); ++i) faceTris[fi].push_back({v[0], v[i], v[i + 1]});
            }
        }
        for (size_t fi = 0; fi < R.faces.size(); ++fi) {
            ShellFace& f = R.faces[fi];
            f.supportShare = f.areaM2 > 0 ? faceSupportArea[fi] / f.areaM2 : 0;
            f.firstTriangle = static_cast<uint32_t>(R.shellIndices.size() / 3);
            f.triangleCount = static_cast<uint32_t>(faceTris[fi].size());
            for (const auto& t : faceTris[fi]) { R.shellIndices.push_back(t.a); R.shellIndices.push_back(t.b); R.shellIndices.push_back(t.c); }
            M.shellAreaM2 += f.areaM2;
            M.unsupportedAreaM2 += f.areaM2 - faceSupportArea[fi];
            if (!f.measured) M.generatedAreaM2 += f.areaM2;
            if (f.groundClosure) M.groundClosureAreaM2 += f.areaM2;
        }
        R.shellPositions = sv;
        M.shellFaces = R.faces.size();
        M.shellTriangles = R.shellIndices.size() / 3;
        M.shellVertices = R.shellPositions.size();
        M.generatedAreaShare = M.shellAreaM2 > 0 ? M.generatedAreaM2 / M.shellAreaM2 : 0;
        M.unsupportedAreaShare = M.shellAreaM2 > 0 ? M.unsupportedAreaM2 / M.shellAreaM2 : 0;
        {
            std::unordered_map<uint64_t, int> cnt;
            double vol = 0;
            for (size_t t = 0; t < M.shellTriangles; ++t) {
                const uint32_t a = R.shellIndices[t * 3], b = R.shellIndices[t * 3 + 1], c = R.shellIndices[t * 3 + 2];
                if (a == b || b == c || a == c) { ++M.degenerateTriangles; continue; }
                ++cnt[edgeKey(a, b)]; ++cnt[edgeKey(b, c)]; ++cnt[edgeKey(c, a)];
                vol += sv[a].dot(sv[b].cross(sv[c])) / 6.0;
            }
            for (const auto& [k, c] : cnt) { (void)k; if (c == 1) ++M.boundaryEdges; else if (c != 2) ++M.nonManifoldEdges; }
            M.shellVolumeM3 = vol;
        }
        M.msShell = msSince(t0);

        // ---------------------------------------------------------------- 6. residual and fit
        t0 = clock::now();
        {
            geometry::ScratchboxMesh shell("shell");
            for (const auto& q : R.shellPositions) shell.vertices.emplace_back(f3(q));
            shell.indices = R.shellIndices;
            bvh::BvhTree shellBvh;
            if (!shellBvh.build(shell)) throw std::runtime_error("shell fit: could not index the shell");
            struct Row { double dist[4]; double maxDist; bool inside; };
            std::vector<Row> rows(nt);
            const V3 probe[3] = {V3(0.3713, 0.9106, 0.1812).normalized(), V3(-0.6241, 0.5127, 0.5895).normalized(), V3(0.2113, 0.4317, -0.8769).normalized()};
            parallelFor(nt, threads, [&](size_t t) {
                if (!skinSide[t] || apron[t] || revOf[t] >= 0) return;
                const V3& a = in.positions[in.indices[t * 3]]; const V3& b = in.positions[in.indices[t * 3 + 1]]; const V3& c = in.positions[in.indices[t * 3 + 2]];
                const V3 s[4] = {tc[t], (a + b) * 0.5, (b + c) * 0.5, (c + a) * 0.5};
                Row& r = rows[t]; r.maxDist = 0; r.inside = false;
                for (int k = 0; k < 4; ++k) { float d2 = 0; shellBvh.closestPoint(f3(s[k]), d2); r.dist[k] = std::sqrt(static_cast<double>(d2)); r.maxDist = std::max(r.maxDist, r.dist[k]); }
                if (r.maxDist > p.residualTolM) {
                    int odd = 0;
                    for (const auto& d : probe) {
                        V3 o = tc[t]; int crossings = 0;
                        for (int step = 0; step < 256; ++step) {
                            bvh::RayHit h;
                            if (!shellBvh.raycast(math::Ray(f3(o), f3(d)), h)) break;
                            ++crossings; o = d3(h.position) + d * 1e-3;
                        }
                        if (crossings % 2) ++odd;
                    }
                    r.inside = odd >= 2;
                }
            });
            double area = 0, w05 = 0, w15 = 0, sum2 = 0, maxD = 0, exArea = 0, exSum2 = 0;
            std::vector<std::pair<double, double>> dists;
            for (size_t t = 0; t < nt; ++t) {
                if (!skinSide[t] || apron[t] || revOf[t] >= 0) continue;
                const Row& r = rows[t];
                for (int k = 0; k < 4; ++k) {
                    const double w = ta[t] * 0.25;
                    area += w; sum2 += w * r.dist[k] * r.dist[k]; maxD = std::max(maxD, r.dist[k]);
                    if (r.dist[k] <= 0.5) w05 += w;
                    if (r.dist[k] <= 1.5) w15 += w;
                    dists.emplace_back(r.dist[k], w);
                }
                if (r.maxDist <= p.residualTolM) for (int k = 0; k < 4; ++k) { exArea += ta[t] * 0.25; exSum2 += ta[t] * 0.25 * r.dist[k] * r.dist[k]; }
                if (r.maxDist > p.residualTolM) {
                    if (r.inside) M.buriedAreaM2 += ta[t];
                    else { R.residualTriangles.push_back(static_cast<uint32_t>(t)); R.residualFlipped.push_back(skinSide[t] < 0 ? 1 : 0); M.residualAreaM2 += ta[t]; }
                }
            }
            M.residualTriangles = R.residualTriangles.size();
            if (area > 0) {
                M.scanWithin05Share = w05 / area; M.scanWithin15Share = w15 / area; M.scanRmsM = std::sqrt(sum2 / area); M.scanMaxM = maxD;
                std::sort(dists.begin(), dists.end());
                double acc = 0;
                for (const auto& [d, w] : dists) { acc += w; if (acc >= 0.95 * area) { M.scanP95M = d; break; } }
                M.residualAreaShare = M.residualAreaM2 / M.skinAreaM2;
                M.explainedAreaShare = exArea / area;
                M.explainedRmsM = exArea > 0 ? std::sqrt(exSum2 / exArea) : 0;
                M.buriedAreaShare = M.buriedAreaM2 / M.skinAreaM2;
            }
        }
        M.msResidual = msSince(t0);
        M.msTotal = msSince(tStart);
        return R;
    }
};

/** How another mesh of the same structure (same frame) compares: the skin's distance to it, and how open it is. */
struct CompareStats {
    size_t triangles{0}, boundaryEdges{0}, nonManifoldEdges{0};
    double areaM2{0};
    double scanWithin05Share{0}, scanWithin15Share{0}, scanRmsM{0}, scanP95M{0};
};

inline CompareStats compareMesh(const Input& scan, const std::vector<uint32_t>& skinTriangles, const Input& other, int threads = 0) {
    using namespace detail;
    CompareStats c;
    c.triangles = other.indices.size() / 3;
    geometry::ScratchboxMesh mesh("other");
    for (const auto& q : other.positions) mesh.vertices.emplace_back(f3(q));
    mesh.indices = other.indices;
    bvh::BvhTree tree;
    if (!tree.build(mesh)) throw std::runtime_error("shell fit: could not index the mesh to compare");
    {
        Welder weld(1e-4);
        std::vector<uint32_t> id(other.positions.size());
        for (size_t i = 0; i < other.positions.size(); ++i) id[i] = weld.add(other.positions[i]);
        std::unordered_map<uint64_t, int> cnt;
        for (size_t t = 0; t < c.triangles; ++t) {
            const V3& pa = other.positions[other.indices[t * 3]]; const V3& pb = other.positions[other.indices[t * 3 + 1]]; const V3& pc = other.positions[other.indices[t * 3 + 2]];
            c.areaM2 += 0.5 * (pb - pa).cross(pc - pa).length();
            const uint32_t a = id[other.indices[t * 3]], b = id[other.indices[t * 3 + 1]], d = id[other.indices[t * 3 + 2]];
            if (a == b || b == d || a == d) continue;
            ++cnt[edgeKey(a, b)]; ++cnt[edgeKey(b, d)]; ++cnt[edgeKey(d, a)];
        }
        for (const auto& [k, n] : cnt) { (void)k; if (n == 1) ++c.boundaryEdges; else if (n != 2) ++c.nonManifoldEdges; }
    }
    const int nth = threads > 0 ? threads : static_cast<int>(std::max(1u, std::thread::hardware_concurrency()));
    std::vector<std::array<double, 5>> rows(skinTriangles.size());
    parallelFor(skinTriangles.size(), nth, [&](size_t i) {
        const uint32_t t = skinTriangles[i];
        const V3& a = scan.positions[scan.indices[t * 3]]; const V3& b = scan.positions[scan.indices[t * 3 + 1]]; const V3& d = scan.positions[scan.indices[t * 3 + 2]];
        const V3 s[4] = {(a + b + d) * (1.0 / 3.0), (a + b) * 0.5, (b + d) * 0.5, (d + a) * 0.5};
        for (int k = 0; k < 4; ++k) { float d2 = 0; tree.closestPoint(f3(s[k]), d2); rows[i][static_cast<size_t>(k)] = std::sqrt(static_cast<double>(d2)); }
        rows[i][4] = 0.5 * (b - a).cross(d - a).length();
    });
    double area = 0, w05 = 0, w15 = 0, sum2 = 0;
    std::vector<std::pair<double, double>> dists;
    for (const auto& r : rows) for (int k = 0; k < 4; ++k) {
        const double w = r[4] * 0.25, d = r[static_cast<size_t>(k)];
        area += w; sum2 += w * d * d;
        if (d <= 0.5) w05 += w;
        if (d <= 1.5) w15 += w;
        dists.emplace_back(d, w);
    }
    if (area > 0) {
        c.scanWithin05Share = w05 / area; c.scanWithin15Share = w15 / area; c.scanRmsM = std::sqrt(sum2 / area);
        std::sort(dists.begin(), dists.end());
        double acc = 0;
        for (const auto& [d, w] : dists) { acc += w; if (acc >= 0.95 * area) { c.scanP95M = d; break; } }
    }
    return c;
}

} // namespace shell_fit
} // namespace scratchbox

#endif // SCRATCHBOX_SHELL_FIT_HPP
