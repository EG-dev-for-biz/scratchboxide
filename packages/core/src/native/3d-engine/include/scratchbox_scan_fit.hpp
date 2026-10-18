/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_SCAN_FIT_HPP
#define SCRATCHBOX_SCAN_FIT_HPP

/**
 * The scan fitter: an isolated photogrammetric scan of one structure in, a measured rebuild out (StructureFit in
 * packages/core/src/common/spatial/staged-location-contracts.ts), every dimension traced to a fit with its residual.
 *
 * In the order the fitter builds things (its buildOrder):
 *   1. load and weld (1 mm); keep the connected component under the anchor (the probe's seed) and the components inside
 *      its plan box grown by 4 m; triangles are exterior when 3 of 16 hemisphere rays escape (the ground blocks rays);
 *   2. the ground (RANSAC, then least squares on upward faces near the bottom) and the frame: the area mode of the
 *      vertical faces' yaw modulo 90 degrees, or the plan's principal axes when that mode holds under 35 % of the area;
 *   3. planes by region growing over the exterior triangles (12 degrees, 4 cm), refined as they grow, then RANSAC on
 *      what is left; coplanar planes merged (3 degrees, 3 cm); opposed sheets under 3 cm apart are internal plates;
 *   4. bands between ledges (horizontal planes spanning at least 60 % of the plan both ways): each band's footprint is
 *      the cells occupied in most slices through its middle half (a slice's inside, closed against cracks, where the
 *      scan's top surface stands above it), traced, its runs fitted as lines snapped to the vertical planes they lie on,
 *      or as circular arcs, holes kept. Each footprint loop is operator 1: swept up the band (caps on);
 *   5. passages: cells solid at the top of a band but empty through its middle, open to the outside on two sides. The
 *      band is then its elevation polygon swept along the passage axis (operator 1): the piers and the spandrels as
 *      measured, each bay's top a circle fitted to its soffit (RANSAC, Gauss-Newton) or a flat lintel; the soffit is a
 *      cylindrical chart. The semicircle on the jambs and the fit to the soffit's scan vertices are recorded as
 *      alternatives, and rise/span is published with the scan's residual for every value in [0.25, 0.65] and the range
 *      that keeps it within the photo tolerance (correctable, by parameter index);
 *   6. columns: footprint loops (in a band or between bays) that are circles; r(z) from circles fitted per 0.25 m of
 *      their scan (operator 2, K = 0); three or more equal ones at an equal pitch are operator 3 with the measured pitch;
 *   7. what the scan has that this does not explain (exterior samples over 7 cm outside, or 25 cm inside, it), clustered
 *      and sliced at their own horizontal facets: box-like slabs are boxes (a sweep of a rectangle; each face carries its
 *      share of scan support, a face under half supported is fitted-unobserved), the rest stays as scanned
 *      (pass-through, with the box test's values);
 *   8. metrics both ways on the visible surfaces (25 samples per m^2), coverage within 7 cm, Hausdorff without the
 *      pass-through, what a remesh moved (remeshToScan), the global gates, source limits, and the slots (stable ids from
 *      their hosts) where photo-read detail may go.
 *
 * Determinism: fixed seeds and sorted inputs; the same scan, anchor and parameters give the same bytes. A refit runs the
 * same fit with parameter overrides (primitive id, parameter index): ids stay the same.
 *
 * Nothing branches on what a structure is; labels exist only in reports.
 */

#include "scratchbox_scan_geom.hpp"
#include "scratchbox_scan_ortho.hpp"
#include "scratchbox_staged_glb.hpp"

#include <array>
#include <chrono>
#include <cstdlib>
#include <fstream>
#include <cstdio>
#include <set>
#include <cstring>
#include <unordered_map>
#include <unordered_set>
#include <sstream>

namespace scratchbox {
namespace scan_fit {

namespace sg = scan_geom;
using math::Vec2;
using math::Vec3;
using sg::P2;
using sg::Residual;
namespace sj = staged_glb::json;

inline std::array<uint8_t, 4> cividis(double x);

class ScanFitError : public std::runtime_error {
public:
    ScanFitError(std::string code, const std::string& message) : std::runtime_error(message), code_(std::move(code)) {}
    const std::string& code() const { return code_; }
private:
    std::string code_;
};

struct SourceLimits {
    double leafGeometricErrorM{2.0};
    double meshEdgeP50M{0};
    double meshResolvableM{0};
    double texelM{0};
    double photoResolvableM{0};
};

struct Params {
    double weldM{0.001};
    double componentDilateM{4.0};
    int visibilityRays{16}, visibilityEscapes{3};
    double planeAngleDeg{12}, planeDistM{0.04}, planeMinAreaM2{0.4}, planeMaxRmsM{0.04};
    double wallMinAreaM2{0};     // facets and planes smaller than this do not vote for a footprint (0: every wall facet does: round columns are facets)
    double mergeAngleDeg{3}, mergeOffsetM{0.03};
    double sheetGapM{0.03};
    double ledgeMinAreaM2{1.5}, ledgeSpan{0.6};
    double cellM{0.05};
    double lineTolM{0.035};
    double snapAngleDeg{5}, snapOffsetM{0.15};
    double minLoopAreaM2{0.5};
    double minPassageAreaM2{1.0};
    double soffitMarginM{0.4};
    double columnMinR{0.12}, columnMaxR{1.5}, columnContourRmsM{0.03}, columnRmsMaxM{0.05}, columnHeightCoverage{0.7};
    double residualOutsideM{0.07}, residualInsideM{0.25}, attachMinM{0.20};
    double boxSupportMin{0.5};
    double metricDensity{25};
    double inlierBandM{0.07};
    // leftovers: scan nothing in the fit explains (not buried in a rebuilt solid, not already kept as scanned). A connected
    // fragment up to this area is kept as scanned, exactly (error 0), as long as all fragments together stay under the share of
    // the structure's visible surface; a larger unexplained region is a wrong or missing fit and stays in the Hausdorff.
    double fragmentMaxAreaM2{4.0}, fragmentMaxShare{0.05};
    double backedBandM{0.25};   // the rebuild's surface within this of the scan is backed by it
    // global gates
    double gateCoverage{0.85}, gateScanToFitM{0.06}, gateFitToScanM{0.06}, gateHausdorffM{0.6}, gatePassShare{0.35}, gateUnobservedShare{0.35};
    // the arc sweep's chord sagitta (m)
    double sagittaM{0.005};
    // refit overrides: primitive id -> parameter index -> value
    std::map<std::string, std::map<int, double>> overrides;
};

/** A right-handed orthonormal frame in the tile frame: local x = ex, y = ey (up), z = ez. */
struct Frame {
    Vec3 o{0, 0, 0}, ex{1, 0, 0}, ey{0, 1, 0}, ez{0, 0, 1};
    Vec3 toLocal(const Vec3& p) const { const Vec3 d = p - o; return {d.dot(ex), d.dot(ey), d.dot(ez)}; }
    Vec3 dirToLocal(const Vec3& d) const { return {d.dot(ex), d.dot(ey), d.dot(ez)}; }
    Vec3 toWorld(const Vec3& l) const { return o + ex * l.x + ey * l.y + ez * l.z; }
    Vec3 dirToWorld(const Vec3& l) const { return ex * l.x + ey * l.y + ez * l.z; }
};

// ============================================================================================
// Model
// ============================================================================================

/** A footprint loop in the local frame's (x, z): vertices and the bulge of each segment i -> i + 1 (0 straight). */
struct Loop {
    std::vector<P2> pts;
    std::vector<double> bulge;
};

enum class ChartKind { Plane, Cylinder };

/** A fitted surface: its chart, its triangles (tile frame), and what the scan says of it. */
struct Surface {
    std::string id;
    int prim{-1};
    ChartKind kind{ChartKind::Plane};
    // plane chart (tile frame): origin, u, v, normal; extent in (u, v) metres
    Vec3 origin, u, v, n;
    std::vector<P2> extentUv;
    // cylinder chart (tile frame)
    Vec3 axisOrigin, axisDir, thetaZeroDir;
    double radius{0}, th0{0}, th1{0}, z0{0}, z1{0};
    int normalSign{1};
    // triangles in the local frame (meshing) and the tile frame (output)
    std::vector<Vec3> lpos, lnrm;
    std::vector<uint32_t> tri;
    double area{0};
    Residual fit;
    double visibleFraction{0}, supportFraction{0};
    std::string label;  // diagnostic
};

struct Correctable {
    int param{0};
    std::string key, unit, description;
    double value{0}, min{0}, max{0}, toleranceM{0};
    std::vector<std::array<double, 2>> curve;
};

struct Alternative { std::string specJson; Residual fit; std::string why; };

struct GateRec { std::string gate; double value{0}, threshold{0}; bool le{true}; std::string unit; bool passed() const { return le ? value <= threshold : value >= threshold; } };

/** Solid containment of a primitive (local frame), for telling what lies inside the rebuild. */
struct Solid {
    int kind{0};  // 0 prism (loop + holes, y0..y1), 1 sweep of an elevation polygon along t, 2 revolve, 3 box
    std::vector<P2> outer;               // prism footprint (tessellated), or sweep elevation polygon (s, y)
    std::vector<std::vector<P2>> holes;
    double y0{0}, y1{0};
    P2 sAxis, tAxis;                     // sweep: horizontal axes (x, z); a point's s = sAxis . (x, z), t = tAxis . (x, z)
    double t0{0}, t1{0};
    P2 centre;                           // revolve axis (x, z)
    std::vector<std::array<double, 2>> profile;  // revolve [r, y]
    Vec3 lo, hi;                         // box
    bool contains(const Vec3& p) const {
        switch (kind) {
            case 0: {
                if (p.y < y0 || p.y > y1 || !sg::insidePolygon(outer, p.x, p.z)) return false;
                for (const auto& h : holes) if (sg::insidePolygon(h, p.x, p.z)) return false;
                return true;
            }
            case 1: {
                const double s = sAxis.x * p.x + sAxis.y * p.z, t = tAxis.x * p.x + tAxis.y * p.z;
                return t >= t0 && t <= t1 && sg::insidePolygon(outer, s, p.y);
            }
            case 2: {
                if (profile.size() < 2 || p.y < profile.front()[1] || p.y > profile.back()[1]) return false;
                double r = profile.front()[0];
                for (size_t i = 1; i < profile.size(); ++i) {
                    if (p.y <= profile[i][1]) { const double f = (p.y - profile[i - 1][1]) / std::max(1e-9, profile[i][1] - profile[i - 1][1]); r = profile[i - 1][0] + f * (profile[i][0] - profile[i - 1][0]); break; }
                }
                return std::hypot(p.x - centre.x, p.z - centre.y) <= r;
            }
            default: return p.x >= lo.x && p.x <= hi.x && p.y >= lo.y && p.y <= hi.y && p.z >= lo.z && p.z <= hi.z;
        }
    }
};

struct Primitive {
    std::string id;
    std::string label;  // diagnostic only
    int buildOrder{0};
    std::string specJson;  // OperatorSpec in the structure frame
    std::vector<int> surfaces;
    std::vector<std::array<std::string, 2>> fitParamMeta;  // unit, description
    std::vector<double> fitParams;
    std::vector<Correctable> correctable;
    std::vector<Alternative> alternatives;
    std::vector<GateRec> gates;
    bool accepted{true};
    bool body{false};
    std::string method;
    std::string correctionNote;   // photo-corrected: what was set
    bool corrected{false};
    Residual fit;
    Solid solid;
    std::vector<Solid> moreSolids;             // a replicated primitive: the others' solids
    std::vector<std::array<Vec3, 2>> creases;  // local frame
};

struct Slot {
    std::string id, label, primitiveId;
    bool edge{false};
    std::string surfaceId;                 // surface slot host
    std::vector<P2> regionUv;
    std::vector<Vec3> carrier;             // edge slot crease (tile frame), from t = 0 to 1
    std::vector<std::string> surfaceIds;   // edge slot's two surfaces
    std::vector<P2> envelope;              // edge slot section [u out, v up]
    double sizeU{0}, sizeV{0};
    double maxProud{0}, maxRecess{0}, minFeature{0};
};

struct PassRegion {
    std::string id;
    std::vector<uint32_t> tris;  // scan triangles (indices into the selected scan)
    double area{0};
    Vec3 lo, hi;                 // tile frame
    std::string reason;
    std::map<std::string, double> test;
};

struct FitRequest {
    double anchorX{0}, anchorZ{0};
    SourceLimits limits;
    std::string scanSha256, scanSource, texturedSha256, refitOf;
    size_t inputTriangles{0};
    const std::vector<uint8_t>* remeshGlb{nullptr};
    const gltf::GltfScene* textured{nullptr};  // for the photo texel (orthos are scan_ortho's)
    // optional multi-view mask vote of the scan's triangles (tile_refine --ownership-out, SBOV v1: per triangle its centroid in
    // the tile frame, score, weight and owner -1 / 0 / 1): a sample on a triangle decisively voted not the structure is clutter
    const std::vector<uint8_t>* ownership{nullptr};
    std::function<void(double, const std::string&)> progress;  // 0..1 and a message, after each step
};

struct FitResult {
    Frame frame;
    sg::Plane groundL;     // local frame
    double groundTiltDeg{0}, groundRms{0}, baseY{0};
    std::vector<Loop> footprint;   // the lowest band's outer loops (local)
    std::vector<std::vector<Loop>> footprintHoles;   // the holes of each outer loop, in the same order
    std::vector<P2> footprintHullTile;   // when no band traced a loop: the scan's plan hull (tile frame), measured and said so in the notes
    SourceLimits limits;
    std::vector<Primitive> prims;
    std::vector<Surface> surfaces;
    std::vector<Slot> slots;
    std::vector<PassRegion> pass;
    Residual scanToFit, fitToScan, fitToScanAll, scanToFitPlusPass, remeshToScan;
    double coverageWithPass{0}, passShare{0}, buriedScanArea{0};
    double unobservedShare{0};   // the share of the rebuild's visible surface that the scan does not back
    bool haveRemesh{false};
    double coverage{0}, hausdorff{0};
    std::vector<GateRec> gates;
    bool accepted{false};
    std::string buildingId;
    std::map<std::string, double> timings;
    // the selected scan (tile frame), for the pass-through GLB and metrics
    sg::Scan scan;
    size_t verticesOut{0}, trianglesOut{0};
    double unobservedArea{0};
    std::vector<std::string> notes;
    // the multi-view mask vote, when one was given: scan triangles matched, voted the structure / not it, and the area of
    // samples left out as not the structure
    struct Ownership { bool used{false}; size_t voted{0}, structure{0}, other{0}; double otherAreaM2{0}; } ownership;
};

// ============================================================================================
// Small helpers
// ============================================================================================

inline double deg(double r) { return r * 180.0 / sg::kPi; }
inline double rad(double d) { return d * sg::kPi / 180.0; }

inline std::string hex16(uint64_t v) { char b[17]; std::snprintf(b, sizeof b, "%016llx", static_cast<unsigned long long>(v)); return b; }

/** FNV-1a over bytes (the building id hashes quantised geometry, so it is stable across runs). */
inline uint64_t fnv1a(const std::string& s) {
    uint64_t h = 1469598103934665603ull;
    for (unsigned char c : s) { h ^= c; h *= 1099511628211ull; }
    return h;
}

inline std::string v3j(const Vec3& v) { return sj::vec3(v); }
inline std::string p2j(const P2& p) { return "[" + sj::num(p.x) + "," + sj::num(p.y) + "]"; }
inline std::string polyJ(const std::vector<P2>& p) { std::vector<std::string> o; for (const auto& q : p) o.push_back(p2j(q)); return sj::array(o); }

inline std::string residualJ(const Residual& r, bool support = false, double supportF = 0) {
    sj::Object o;
    o.n("rmsM", r.rms).n("p50M", r.p50).n("p95M", r.p95).n("maxM", r.max).i("samples", static_cast<long long>(r.samples)).n("areaM2", r.area);
    if (std::isfinite(r.inlierFraction)) o.n("inlierFraction", std::clamp(r.inlierFraction, 0.0, 1.0));
    if (support) o.n("supportFraction", std::clamp(supportF, 0.0, 1.0));
    return o.text();
}

/** Arc points from a to b (2D) with bulge (tan(theta / 4)), excluding a, including b; chord sagitta under `sag`. */
inline std::vector<P2> arcPoints(const P2& a, const P2& b, double bulge, double sag) {
    std::vector<P2> out;
    if (std::fabs(bulge) < 1e-9) { out.push_back(b); return out; }
    const double theta = 4 * std::atan(bulge);
    const P2 chord = b - a;
    const double c = chord.len();
    const double r = c / (2 * std::sin(std::fabs(theta) / 2));
    const P2 mid = (a + b) * 0.5;
    const P2 nrm(-chord.y / c, chord.x / c);  // left of a -> b
    const double h = r * std::cos(theta / 2);  // distance from the chord midpoint to the centre
    const P2 centre = mid + nrm * (theta > 0 ? h : -h) * (std::fabs(theta) > sg::kPi ? -1.0 : 1.0);
    const double a0 = std::atan2(a.y - centre.y, a.x - centre.x);
    const double step = 2 * std::acos(std::max(-1.0, 1 - sag / std::max(r, 1e-9)));
    const int n = std::max(2, static_cast<int>(std::ceil(std::fabs(theta) / std::max(step, 1e-3))));
    for (int i = 1; i <= n; ++i) {
        const double ang = a0 + theta * i / n;
        out.push_back(i == n ? b : P2(centre.x + r * std::cos(ang), centre.y + r * std::sin(ang)));
    }
    return out;
}

inline std::vector<P2> tessellate(const Loop& L, double sag) {
    std::vector<P2> out;
    for (size_t i = 0; i < L.pts.size(); ++i) {
        out.push_back(L.pts[i]);
        const size_t j = (i + 1) % L.pts.size();
        if (std::fabs(L.bulge[i]) > 1e-9) {
            auto arc = arcPoints(L.pts[i], L.pts[j], L.bulge[i], sag);
            arc.pop_back();
            out.insert(out.end(), arc.begin(), arc.end());
        }
    }
    return out;
}

// ============================================================================================
// The fitter
// ============================================================================================

/**
 * A vertex a real tile scan can hold: finite, within `kSaneRadiusM` of the centre in plan and `kSaneHeightM` of it vertically.
 * A stray spike (a mis-registered tile vertex, an Inf from a bad decode) would otherwise size the occupancy raster and the
 * hash grids from its coordinates and take gigabytes. Triangles with a vertex outside are dropped before anything is sized.
 */
constexpr double kSaneRadiusM = 600.0, kSaneHeightM = 1500.0;
inline bool saneVertex(const Vec3& p, double cx, double cy, double cz) {
    if (!std::isfinite(p.x) || !std::isfinite(p.y) || !std::isfinite(p.z)) return false;
    return std::hypot(p.x - cx, p.z - cz) <= kSaneRadiusM && std::fabs(p.y - cy) <= kSaneHeightM;
}
/** Median of the finite vertices (plan and height): the centre when no anchor is given. */
inline Vec3 saneCentre(const std::vector<Vec3>& v) {
    std::vector<float> xs, ys, zs;
    for (const auto& p : v) if (std::isfinite(p.x) && std::isfinite(p.y) && std::isfinite(p.z)) { xs.push_back(p.x); ys.push_back(p.y); zs.push_back(p.z); }
    if (xs.empty()) return Vec3(0, 0, 0);
    auto med = [](std::vector<float>& a) { std::nth_element(a.begin(), a.begin() + static_cast<long>(a.size() / 2), a.end()); return a[a.size() / 2]; };
    return Vec3(med(xs), med(ys), med(zs));
}

class Fitter {
public:
    Fitter(const Params& p, const FitRequest& r) : P(p), Q(r) {}

    FitResult run(const std::vector<uint8_t>& glb) {
        t0 = Clock::now();
        load(glb);
        lap("load_weld_select");
        groundAndFrame();
        lap("frame_ground");
        selectStructure();
        visibility();
        lap("visibility");
        planes();
        lap("planes");
        sampleScan();
        bandsAndFootprints();
        groupColumns();
        lap("bands_footprints_openings_columns");
        meshModel();
        lap("mesh");
        if (R.surfaces.empty()) throw ScanFitError("no_structure", "no surface of the scan could be fitted: nothing in it stands as a structure");
        residualsToBoxes();
        lap("attachments_passthrough");
        metrics();
        lap("metrics");
        slots();
        sourceLimits();
        gates();
        lap("slots_gates");
        return std::move(R);
    }

    /** What flattening a scan found: the planes, and where each welded vertex of `scan` goes (tile frame). */
    struct Flattened { sg::Scan scan; std::vector<Vec3> moved; std::vector<uint8_t> isMoved; int planes{0}; std::map<std::string, double> timings; };

    /**
     * Steps 1 to 3 of the fit on `scan` (welded, whole): the frame and ground, the exterior faces, the planes grown over
     * them. Every vertex within `bandM` of a plane whose triangles all belong to that plane is moved onto it; a vertex on
     * the edge between two planes, or on anything else, stays. Nothing is added or removed.
     */
    Flattened flatten(sg::Scan scan, double bandM) {
        t0 = Clock::now();
        R.scan = std::move(scan);
        groundAndFrame();
        lap("frame_ground");
        visibility();
        lap("visibility");
        // a noisy wall grows as several regions: coplanar within half a band, they are the one wall (and the band is the move's limit)
        planes(0.5 * bandM, 0.5 * bandM);
        lap("planes");
        Flattened F;
        const auto& s = R.scan;
        // The growing leaves out a triangle that noise puts past its plane gate, and splits a noisy wall into regions whose own
        // planes differ by more than the merge allows (a small region's tilt is poorly determined). Within a band, they are one wall:
        // a smaller region whose every corner lies within half a band of a larger plane with a near normal moves its triangles
        // there, and so does a triangle left out whose three corners do.
        {
            const float cosA = static_cast<float>(std::cos(rad(P.planeAngleDeg)));
            const size_t larger = std::min<size_t>(regions.size(), 96);
            const double reach = 0.5 * bandM;
            for (size_t j = 1; j < regions.size(); ++j) {
                if (regions[j].sheet) continue;
                for (size_t i = 0; i < std::min(j, larger); ++i) {
                    if (regions[i].sheet || regions[j].pl.n.dot(regions[i].pl.n) < cosA) continue;
                    bool within = true;
                    for (size_t k = 0; k < regions[j].tris.size() && within; ++k)
                        for (int c = 0; c < 3 && within; ++c) within = std::fabs(regions[i].pl.dist(lp[s.tri[3 * regions[j].tris[k] + c]])) <= reach;
                    if (!within) continue;
                    for (uint32_t t : regions[j].tris) triPlane[t] = static_cast<int>(i);
                    break;
                }
            }
            for (size_t t = 0; t < s.triangles(); ++t) {
                if (triPlane[t] >= 0 || isGround[t] || !(ext[t] || ln[t].y < -0.97f)) continue;
                for (size_t i = 0; i < larger; ++i) {
                    if (regions[i].sheet || ln[t].dot(regions[i].pl.n) < cosA) continue;
                    bool within = true;
                    for (int c = 0; c < 3 && within; ++c) within = std::fabs(regions[i].pl.dist(lp[s.tri[3 * t + c]])) <= reach;
                    if (within) { triPlane[t] = static_cast<int>(i); break; }
                }
            }
            std::set<int> used;
            for (size_t t = 0; t < s.triangles(); ++t) if (triPlane[t] >= 0) used.insert(triPlane[t]);
            F.planes = static_cast<int>(used.size());
        }
        F.moved = s.pos;
        F.isMoved.assign(s.pos.size(), 0);
        std::vector<int> owner(s.pos.size(), -2);  // the plane every triangle at a vertex belongs to, -2 none seen, -1 mixed
        for (size_t t = 0; t < s.triangles(); ++t) {
            const int r = triPlane[t] >= 0 && !regions[static_cast<size_t>(triPlane[t])].sheet ? triPlane[t] : -1;
            for (int j = 0; j < 3; ++j) { int& o = owner[s.tri[3 * t + j]]; o = o == -2 ? r : (o == r ? o : -1); }
        }
        for (size_t v = 0; v < s.pos.size(); ++v) {
            if (owner[v] < 0) continue;
            const auto& pl = regions[static_cast<size_t>(owner[v])].pl;
            const Vec3 l = R.frame.toLocal(s.pos[v]);
            const double d = pl.dist(l);
            if (std::fabs(d) > bandM) continue;
            F.moved[v] = R.frame.toWorld(l - pl.n * static_cast<float>(d));
            F.isMoved[v] = 1;
        }
        F.timings = R.timings;
        F.scan = R.scan;
        return F;
    }

private:
    using Clock = std::chrono::steady_clock;
    const Params P;
    const FitRequest Q;
    FitResult R;
    Clock::time_point t0;
    void lap(const char* n) {
        const auto now = Clock::now();
        R.timings[n] = std::chrono::duration<double, std::milli>(now - t0).count();
        t0 = now;
        if (Q.progress) { static const char* order[] = {"load_weld_select", "frame_ground", "visibility", "planes", "bands_footprints_openings_columns", "mesh", "attachments_passthrough", "metrics", "slots_gates"}; for (int i = 0; i < 9; ++i) if (std::string(n) == order[i]) Q.progress((i + 1) / 10.0, n); }
    }

    // local copy of the selected scan
    std::vector<Vec3> lp;          // local positions (welded ids)
    std::vector<Vec3> ln;          // local triangle normals
    std::vector<Vec3> lc;          // local centroids
    std::vector<uint8_t> ext;      // exterior triangle
    std::vector<uint8_t> isGround; // ground triangle
    std::vector<int> triPlane;     // plane region per triangle (-1)
    struct Region { sg::Plane pl; std::vector<uint32_t> tris; double area{0}, rms{0}; Vec3 lo, hi, c; bool sheet{false}; };
    std::vector<Region> regions;
    double structX0{0}, structX1{0}, structZ0{0}, structZ1{0}, structTop{0};
    double tipX0{0}, tipX1{0}, tipZ0{0}, tipZ1{0};   // the same box grown to the corners' tips (at most a metre)
    double frameShare{1};          // the share of the vertical faces' area along the frame's axes
    std::vector<sg::Sample> S;     // exterior structure samples (local)
    std::vector<uint8_t> sGround;  // per sample: ground or clutter

    double groundAt(double x, double z) const { return (R.groundL.d - R.groundL.n.x * x - R.groundL.n.z * z) / R.groundL.n.y; }

    // ---------------------------------------------------------------- 1. load, weld, select
    void load(const std::vector<uint8_t>& glb) {
        auto scene = gltf::GlbSceneReader::parse(glb.data(), glb.size());
        if (!scene.ok) throw ScanFitError("input_unreadable", "cannot read the scan: " + scene.error);
        // only the vertices a tile can hold, and only the triangles made of them (see saneVertex)
        const auto& mv = scene.mesh.vertices;
        std::vector<Vec3> pos;
        std::vector<uint32_t> sidx;
        {
            const Vec3 ctr = saneCentre([&] { std::vector<Vec3> q; q.reserve(mv.size()); for (const auto& v : mv) q.push_back(v.position); return q; }());
            std::vector<int64_t> remap(mv.size(), -1);
            std::vector<uint8_t> ok(mv.size());
            for (size_t v = 0; v < mv.size(); ++v) ok[v] = saneVertex(mv[v].position, Q.anchorX, ctr.y, Q.anchorZ);
            size_t dropped = 0;
            const auto& ix = scene.mesh.indices;
            for (size_t t = 0; t + 2 < ix.size(); t += 3) {
                if (ix[t] >= mv.size() || ix[t + 1] >= mv.size() || ix[t + 2] >= mv.size() || !ok[ix[t]] || !ok[ix[t + 1]] || !ok[ix[t + 2]]) { ++dropped; continue; }
                for (int j = 0; j < 3; ++j) {
                    const uint32_t v = ix[t + j];
                    if (remap[v] < 0) { remap[v] = static_cast<int64_t>(pos.size()); pos.push_back(mv[v].position); }
                    sidx.push_back(static_cast<uint32_t>(remap[v]));
                }
            }
            if (dropped) R.notes.push_back("scan_fit dropped " + std::to_string(dropped) + " triangle(s) with a non-finite vertex or one more than " + std::to_string(static_cast<int>(kSaneRadiusM)) + " m (plan) or " + std::to_string(static_cast<int>(kSaneHeightM)) + " m (height) from the anchor");
        }
        sg::Scan all = sg::weldScan(pos, sidx, P.weldM);
        if (all.triangles() == 0) throw ScanFitError("input_unreadable", "the scan has no triangles");
        int nc = 0;
        const auto lab = sg::components(all, &nc);
        // the component under the anchor: the highest triangle covering it seen from above, else the nearest
        long pick = -1;
        double bestY = -1e30, bestD = 1e30;
        for (size_t t = 0; t < all.triangles(); ++t) {
            const Vec3 &a = all.pos[all.tri[3 * t]], &b = all.pos[all.tri[3 * t + 1]], &c = all.pos[all.tri[3 * t + 2]];
            const double d = (b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z);
            if (std::fabs(d) > 1e-12) {
                const double w1 = ((Q.anchorX - a.x) * (c.z - a.z) - (c.x - a.x) * (Q.anchorZ - a.z)) / d;
                const double w2 = ((b.x - a.x) * (Q.anchorZ - a.z) - (Q.anchorX - a.x) * (b.z - a.z)) / d;
                if (w1 >= 0 && w2 >= 0 && w1 + w2 <= 1 && all.centroid[t].y > bestY) { bestY = all.centroid[t].y; pick = static_cast<long>(t); }
            }
        }
        if (pick < 0) {
            for (size_t t = 0; t < all.triangles(); ++t) {
                const double d = std::hypot(all.centroid[t].x - Q.anchorX, all.centroid[t].z - Q.anchorZ);
                if (d < bestD) { bestD = d; pick = static_cast<long>(t); }
            }
        }
        if (pick < 0 || (bestD < 1e29 && bestD > 30.0)) throw ScanFitError("no_structure", "no scan triangle stands within 30 m of the anchor");
        const int c0 = lab[static_cast<size_t>(pick)];
        double x0 = 1e30, x1 = -1e30, z0 = 1e30, z1 = -1e30, a0 = 0;
        std::vector<double> cx0(nc, 1e30), cx1(nc, -1e30), cz0(nc, 1e30), cz1(nc, -1e30);
        for (size_t t = 0; t < all.triangles(); ++t) {
            const int c = lab[t];
            if (c == c0) a0 += all.area[t];
            for (int j = 0; j < 3; ++j) {
                const Vec3& p = all.pos[all.tri[3 * t + j]];
                cx0[c] = std::min(cx0[c], (double)p.x); cx1[c] = std::max(cx1[c], (double)p.x); cz0[c] = std::min(cz0[c], (double)p.z); cz1[c] = std::max(cz1[c], (double)p.z);
            }
        }
        x0 = cx0[c0]; x1 = cx1[c0]; z0 = cz0[c0]; z1 = cz1[c0];
        if (a0 < 1.0) throw ScanFitError("no_structure", "the scan under the anchor holds under 1 m2 of surface");
        const double g = P.componentDilateM;
        // the structure is the component under the anchor and the components that lie wholly inside its plan box grown by g (a
        // detached pedestal), not the ground that runs on past it and not the neighbours beyond
        std::vector<uint8_t> keepComp(nc, 0);
        for (int c = 0; c < nc; ++c) keepComp[c] = c == c0 || (cx0[c] >= x0 - g && cx1[c] <= x1 + g && cz0[c] >= z0 - g && cz1[c] <= z1 + g);
        std::vector<uint8_t> keep(all.triangles(), 0);
        for (size_t t = 0; t < all.triangles(); ++t) keep[t] = keepComp[lab[t]];
        R.scan = sg::subScan(all, keep);
        if (R.scan.triangles() < 4) throw ScanFitError("no_structure", "the structure under the anchor has under 4 triangles");
    }

    // ---------------------------------------------------------------- 2. ground and frame
    void groundAndFrame() {
        const auto& s = R.scan;
        const size_t T = s.triangles();
        double minVert = 1e30, minY = 1e30;
        for (size_t t = 0; t < T; ++t) {
            minY = std::min(minY, (double)s.centroid[t].y);
            if (std::fabs(s.normal[t].y) < 0.3f && s.area[t] > 0.05f) minVert = std::min(minVert, (double)s.centroid[t].y);
        }
        if (minVert > 1e29) minVert = minY;
        // ground: RANSAC on upward faces below the lowest wall + 1 m, then least squares
        std::vector<size_t> cand;
        for (size_t t = 0; t < T; ++t) if (s.normal[t].y > 0.97f && s.centroid[t].y < minVert + 1.0) cand.push_back(t);
        sg::Plane gl{{0, 1, 0}, minY};
        if (cand.size() >= 3) {
            std::mt19937_64 rng(11);
            std::uniform_int_distribution<size_t> U(0, cand.size() - 1);
            double best = -1;
            for (int it = 0; it < 400; ++it) {
                const size_t t = cand[U(rng)];
                const sg::Plane h{s.normal[t], s.normal[t].dot(s.centroid[t])};
                double w = 0;
                for (size_t c : cand) if (std::fabs(h.dist(s.centroid[c])) < 0.05) w += s.area[c];
                if (w > best) { best = w; gl = h; }
            }
            for (int r = 0; r < 3; ++r) {
                std::vector<Vec3> pts;
                std::vector<double> w;
                for (size_t c : cand) if (std::fabs(gl.dist(s.centroid[c])) < 0.05) { pts.push_back(s.centroid[c]); w.push_back(s.area[c]); for (int j = 0; j < 3; ++j) { pts.push_back(s.pos[s.tri[3 * c + j]]); w.push_back(s.area[c] / 3); } }
                if (pts.size() >= 3) gl = sg::lsPlane(pts, w, Vec3(0, 1, 0));
            }
            double S2 = 0, W = 0;
            for (size_t c : cand) { const double d = gl.dist(s.centroid[c]); if (std::fabs(d) < 0.05) { S2 += s.area[c] * d * d; W += s.area[c]; } }
            R.groundRms = W > 0 ? std::sqrt(S2 / W) : 0;
        } else {
            R.notes.push_back("no upward ground faces near the bottom: the ground is the level plane through the lowest point");
        }
        if (gl.n.y < 0) { gl.n = gl.n * -1.0f; gl.d = -gl.d; }
        R.groundTiltDeg = deg(std::acos(std::min(1.0f, gl.n.y)));
        // frame: area mode of vertical-face yaw modulo 90 degrees
        const int B = 900;
        std::vector<double> h(B, 0.0);
        std::vector<std::pair<double, double>> angs;
        for (size_t t = 0; t < T; ++t) {
            const Vec3 n = s.normal[t];
            if (std::fabs(n.y) > 0.25f) continue;
            const double th = deg(std::atan2(n.x, n.z));
            const double f = std::fmod(th + 360.0, 90.0);
            angs.push_back({f, s.area[t]});
            h[static_cast<int>(f * 10) % B] += s.area[t];
        }
        std::vector<double> sm(B, 0.0);
        for (int i = 0; i < B; ++i) for (int k = -9; k <= 9; ++k) sm[i] += h[(i + k + B) % B] * std::exp(-0.5 * (k / 3.0) * (k / 3.0));
        const int best = static_cast<int>(std::max_element(sm.begin(), sm.end()) - sm.begin());
        double mode = best / 10.0, sx = 0, ws = 0, tot = 0;
        for (const auto& [f, a] : angs) {
            tot += a;
            double d = f - mode;
            while (d > 45) d -= 90;
            while (d < -45) d += 90;
            if (std::fabs(d) <= 0.6) { sx += a * d; ws += a; }
        }
        const double share = tot > 0 ? ws / tot : 0;
        frameShare = share;
        double yaw = mode + (ws > 0 ? sx / ws : 0);
        if (share < 0.35) {
            // not rectilinear: the principal axes of the plan (area-weighted centroids)
            double cx = 0, cz = 0, W = 0;
            for (size_t t = 0; t < T; ++t) { cx += s.area[t] * s.centroid[t].x; cz += s.area[t] * s.centroid[t].z; W += s.area[t]; }
            cx /= W; cz /= W;
            double sxx = 0, sxz = 0, szz = 0;
            for (size_t t = 0; t < T; ++t) { const double dx = s.centroid[t].x - cx, dz = s.centroid[t].z - cz; sxx += s.area[t] * dx * dx; sxz += s.area[t] * dx * dz; szz += s.area[t] * dz * dz; }
            yaw = deg(0.5 * std::atan2(2 * sxz, sxx - szz));
            R.notes.push_back("the plan is not rectilinear (the dominant wall orientation holds " + std::to_string(static_cast<int>(std::lround(100 * share))) + "% of the walls): the frame follows its principal axes and every plane keeps its own normal");
        }
        const double y = rad(yaw);
        const Vec3 e1(static_cast<float>(std::sin(y)), 0, static_cast<float>(std::cos(y)));
        const Vec3 e2(static_cast<float>(std::cos(y)), 0, static_cast<float>(-std::sin(y)));
        double A1 = 0, A2 = 0;
        for (size_t t = 0; t < T; ++t) { if (std::fabs(s.normal[t].dot(e1)) > 0.95f) A1 += s.area[t]; if (std::fabs(s.normal[t].dot(e2)) > 0.95f) A2 += s.area[t]; }
        Frame F;
        F.ey = Vec3(0, 1, 0);
        F.ez = A1 >= A2 ? e1 : e2;
        if (F.ez.z < 0 || (std::fabs(F.ez.z) < 1e-6f && F.ez.x < 0)) F.ez = F.ez * -1.0f;
        F.ex = F.ey.cross(F.ez);
        const double gy = (gl.d - gl.n.x * Q.anchorX - gl.n.z * Q.anchorZ) / gl.n.y;
        F.o = Vec3(static_cast<float>(Q.anchorX), static_cast<float>(gy), static_cast<float>(Q.anchorZ));
        R.frame = F;
        R.groundL.n = F.dirToLocal(gl.n);
        R.groundL.d = gl.d - gl.n.dot(F.o);
        localize();
    }

    /** The scan's vertices, normals and centroids in the local frame. */
    void localize() {
        const auto& s = R.scan;
        const size_t T = s.triangles();
        lp.resize(s.pos.size());
        for (size_t v = 0; v < s.pos.size(); ++v) lp[v] = R.frame.toLocal(s.pos[v]);
        ln.resize(T); lc.resize(T);
        for (size_t t = 0; t < T; ++t) { ln[t] = R.frame.dirToLocal(s.normal[t]); lc[t] = R.frame.toLocal(s.centroid[t]); }
    }

    /**
     * One structure out of a scan that holds several: the tall cells (3 m over the ground, on a 0.5 m grid) closed over
     * 1 m, the connected group nearest the anchor (within 30 m of it), and its surroundings to 4 m, as tile_refine's own
     * isolate chooses; whatever else stands (another building across a plaza) goes. An isolated scan loses nothing.
     */
    void selectStructure() {
        const auto& s = R.scan;
        const size_t T = s.triangles();
        const double cell = 0.5, minH = 3.0, apron = 4.0;
        double x0 = 1e30, x1 = -1e30, z0 = 1e30, z1 = -1e30;
        for (const auto& p : lp) { x0 = std::min(x0, (double)p.x); x1 = std::max(x1, (double)p.x); z0 = std::min(z0, (double)p.z); z1 = std::max(z1, (double)p.z); }
        sg::Raster tall;
        tall.init(x0 - 2, z0 - 2, x1 + 2, z1 + 2, cell);
        if (static_cast<double>(tall.nx) * tall.nz > 4e6) return;
        for (size_t t = 0; t < T; ++t) {
            const Vec3 &a = lp[s.tri[3 * t]], &b = lp[s.tri[3 * t + 1]], &c = lp[s.tri[3 * t + 2]];
            if (std::fabs(ln[t].y) > 0.97f && lc[t].y - groundAt(lc[t].x, lc[t].z) < 0.4) continue;  // ground
            const double d = (b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z);
            const int i0 = std::max(0, tall.ix(std::min({a.x, b.x, c.x}))), i1 = std::min(tall.nx - 1, tall.ix(std::max({a.x, b.x, c.x})));
            const int k0 = std::max(0, tall.iz(std::min({a.z, b.z, c.z}))), k1 = std::min(tall.nz - 1, tall.iz(std::max({a.z, b.z, c.z})));
            if (std::fabs(d) < 1e-12) {
                // a vertical face: its top edge marks the cells under it
                if (std::max({a.y, b.y, c.y}) - groundAt(a.x, a.z) >= minH) sg::rasterSegment(tall, a.x, a.z, b.x, b.z), sg::rasterSegment(tall, b.x, b.z, c.x, c.z);
                continue;
            }
            for (int k = k0; k <= k1; ++k) for (int i = i0; i <= i1; ++i) {
                const double x = tall.cx(i), z = tall.cz(k);
                const double w1 = ((x - a.x) * (c.z - a.z) - (c.x - a.x) * (z - a.z)) / d, w2 = ((b.x - a.x) * (z - a.z) - (x - a.x) * (b.z - a.z)) / d;
                if (w1 < -1e-9 || w2 < -1e-9 || w1 + w2 > 1 + 1e-9) continue;
                const double y = (1 - w1 - w2) * a.y + w1 * b.y + w2 * c.y;
                if (y - groundAt(x, z) >= minH) tall.v[tall.id(i, k)] = 1;
            }
        }
        const sg::Raster closed = sg::dilate(tall, 2);
        int ncomp = 0;
        const auto lab = sg::rasterComponents(closed, &ncomp);
        // the tall cell nearest the anchor (the frame's origin)
        double best = 1e30;
        int seed = -1;
        for (int k = 0; k < tall.nz; ++k) for (int i = 0; i < tall.nx; ++i) {
            if (!tall.v[tall.id(i, k)]) continue;
            const double d = std::hypot(tall.cx(i), tall.cz(k));
            if (d < best) { best = d; seed = lab[tall.id(i, k)]; }
        }
        if (seed < 0 || best > 30.0 || ncomp <= 1) return;
        sg::Raster region = tall;
        std::fill(region.v.begin(), region.v.end(), 0);
        for (size_t c = 0; c < region.v.size(); ++c) region.v[c] = lab[c] == seed ? 1 : 0;
        region = sg::dilate(region, static_cast<int>(std::lround(apron / cell)));
        std::vector<uint8_t> keep(T, 1);
        size_t dropped = 0;
        for (size_t t = 0; t < T; ++t) {
            const bool ground = std::fabs(ln[t].y) > 0.97f && lc[t].y - groundAt(lc[t].x, lc[t].z) < 0.4;
            const int i = tall.ix(lc[t].x), k = tall.iz(lc[t].z);
            if (!ground && !(region.in(i, k) && region.v[region.id(i, k)])) { keep[t] = 0; ++dropped; }
        }
        if (dropped == 0) return;
        R.notes.push_back("the scan holds " + std::to_string(ncomp) + " separate tall structures: the one nearest the anchor (" + sj::num(std::round(best * 10) / 10) + " m) is fitted, " + std::to_string(dropped) + " triangles of the others are left out");
        R.scan = sg::subScan(s, keep);
        localize();
    }

    // ---------------------------------------------------------------- 1b. exterior and ground triangles
    void visibility() {
        const size_t T = R.scan.triangles();
        sg::ScratchboxMesh m = sg::toMesh(lp, R.scan.tri);
        bvh::BvhTree tree;
        tree.build(m);
        double x0 = 1e30, x1 = -1e30, z0 = 1e30, z1 = -1e30;
        for (const auto& p : lp) { x0 = std::min(x0, (double)p.x); x1 = std::max(x1, (double)p.x); z0 = std::min(z0, (double)p.z); z1 = std::max(z1, (double)p.z); }
        sg::GroundOccluder G;
        G.on = true;
        G.n = R.groundL.n;
        G.d = R.groundL.d - 0.02;
        G.cx = 0.5 * (x0 + x1); G.cz = 0.5 * (z0 + z1);
        G.radius = 0.5 * std::hypot(x1 - x0, z1 - z0) + 5;
        ext = sg::exterior(tree, lc, ln, G, P.visibilityRays, P.visibilityEscapes);
        isGround.assign(T, 0);
        for (size_t t = 0; t < T; ++t) {
            const double hgt = lc[t].y - groundAt(lc[t].x, lc[t].z);
            if ((hgt < 0.40 && ln[t].y > 0.85f) || hgt < -0.25) isGround[t] = 1;
        }
        // the structure's plan extent (exterior, not ground)
        // The extent is that of the triangle centroids with the outermost 1 % on each side let go (a stray spike, a scrap of
        // apron), grown to the vertices' own extent by at most one metre: an acute corner has few triangles, and the percentile
        // of their centroids alone clips its tip, but whatever lies further out than a metre is not the corner.
        std::vector<double> xs, zs, vxs, vzs;
        structTop = -1e30;
        for (size_t t = 0; t < T; ++t) {
            if (isGround[t]) continue;
            xs.push_back(lc[t].x); zs.push_back(lc[t].z);
            for (int j = 0; j < 3; ++j) {
                const Vec3& q = lp[R.scan.tri[3 * t + j]];
                vxs.push_back(q.x); vzs.push_back(q.z);
                structTop = std::max(structTop, static_cast<double>(q.y));
            }
        }
        if (xs.empty()) throw ScanFitError("no_structure", "the scan under the anchor is all ground");
        for (auto* a : {&xs, &zs, &vxs, &vzs}) std::sort(a->begin(), a->end());
        auto pct = [](const std::vector<double>& a, double q) { return a[static_cast<size_t>(q * (a.size() - 1))]; };
        const double reach = 1.0;
        structX0 = pct(xs, 0.01); structX1 = pct(xs, 0.99);
        structZ0 = pct(zs, 0.01); structZ1 = pct(zs, 0.99);
        tipX0 = std::max(pct(vxs, 0.002), structX0 - reach); tipX1 = std::min(pct(vxs, 0.998), structX1 + reach);
        tipZ0 = std::max(pct(vzs, 0.002), structZ0 - reach); tipZ1 = std::min(pct(vzs, 0.998), structZ1 + reach);
    }

    // ---------------------------------------------------------------- 3. planes
    /** `mergeOffsetM` and `mergeMaxRmsM`: how far apart coplanar regions may lie, and how thick a merged one may be (0: the fit's own). */
    void planes(double mergeOffsetM = 0, double mergeMaxRmsM = 0) {
        const auto& s = R.scan;
        const size_t T = s.triangles();
        triPlane.assign(T, -1);
        std::vector<uint8_t> pool(T, 0);
        std::vector<uint32_t> order;
        // exterior faces, and faces that look down: an overhang's underside has the ground in the way of its rays, yet it is a ledge
        auto usable = [&](uint32_t t) { return (ext[t] || ln[t].y < -0.97f) && !isGround[t]; };
        for (uint32_t t = 0; t < T; ++t) if (usable(t)) order.push_back(t);
        std::sort(order.begin(), order.end(), [&](uint32_t a, uint32_t b) { return s.area[a] > s.area[b] || (s.area[a] == s.area[b] && a < b); });
        const float cosA = static_cast<float>(std::cos(rad(P.planeAngleDeg)));
        std::vector<uint8_t> used(T, 0);
        auto fitRegion = [&](const std::vector<uint32_t>& tris, const Vec3& hint) {
            std::vector<Vec3> pts;
            std::vector<double> w;
            for (uint32_t t : tris) {
                pts.push_back(lc[t]); w.push_back(s.area[t]);
                for (int j = 0; j < 3; ++j) { pts.push_back(lp[s.tri[3 * t + j]]); w.push_back(s.area[t] / 3); }
            }
            return sg::lsPlane(pts, w, hint);
        };
        auto stats = [&](Region& r) {
            double S2 = 0, W = 0;
            r.lo = Vec3(1e30f, 1e30f, 1e30f); r.hi = Vec3(-1e30f, -1e30f, -1e30f);
            Vec3 c(0, 0, 0);
            for (uint32_t t : r.tris) {
                for (int j = 0; j < 3; ++j) {
                    const Vec3& p = lp[s.tri[3 * t + j]];
                    const double d = r.pl.dist(p);
                    S2 += s.area[t] / 3 * d * d; W += s.area[t] / 3;
                    r.lo = Vec3(std::min(r.lo.x, p.x), std::min(r.lo.y, p.y), std::min(r.lo.z, p.z));
                    r.hi = Vec3(std::max(r.hi.x, p.x), std::max(r.hi.y, p.y), std::max(r.hi.z, p.z));
                }
                c += lc[t] * s.area[t];
            }
            r.area = W;
            r.rms = W > 0 ? std::sqrt(S2 / W) : 0;
            r.c = W > 0 ? c / static_cast<float>(W) : Vec3(0, 0, 0);
        };
        for (uint32_t seed : order) {
            if (used[seed]) continue;
            Region r;
            r.pl = {ln[seed], ln[seed].dot(lc[seed])};
            r.tris = {seed};
            used[seed] = 1;
            double area = s.area[seed], lastFit = area;
            std::vector<uint32_t> queue{seed};
            for (size_t qi = 0; qi < queue.size(); ++qi) {
                const uint32_t t = queue[qi];
                for (uint32_t e = s.adjStart[t]; e < s.adjStart[t + 1]; ++e) {
                    const uint32_t u = s.adj[e];
                    if (used[u] || !usable(u)) continue;
                    if (ln[u].dot(r.pl.n) < cosA) continue;
                    bool near = true;
                    for (int j = 0; j < 3 && near; ++j) near = std::fabs(r.pl.dist(lp[s.tri[3 * u + j]])) < P.planeDistM;
                    if (!near) continue;
                    used[u] = 1;
                    r.tris.push_back(u);
                    queue.push_back(u);
                    area += s.area[u];
                    if (area >= 1.25 * lastFit) { r.pl = fitRegion(r.tris, r.pl.n); lastFit = area; }
                }
            }
            r.pl = fitRegion(r.tris, r.pl.n);
            stats(r);
            if (r.area >= P.planeMinAreaM2 && r.rms <= P.planeMaxRmsM) regions.push_back(std::move(r));
            else for (uint32_t t : r.tris) pool[t] = 1;
        }
        // RANSAC on what is left: 1-point hypotheses (a triangle's plane), inliers within the angle and distance
        std::vector<uint32_t> left;
        for (uint32_t t = 0; t < T; ++t) if (pool[t]) left.push_back(t);
        std::mt19937_64 rng(23);
        constexpr int kHypotheses = 300;
        for (int round = 0; round < 40 && left.size() >= 3; ++round) {
            std::uniform_int_distribution<size_t> U(0, left.size() - 1);
            // The hypotheses are drawn in order from the one seeded stream, scored in parallel (each score summed in
            // `left` order), and the first with the highest score wins: the same planes as scoring them one by one.
            std::array<sg::Plane, kHypotheses> hyp;
            std::array<double, kHypotheses> score;
            for (int h = 0; h < kHypotheses; ++h) {
                const uint32_t t = left[U(rng)];
                hyp[h] = sg::Plane{ln[t], ln[t].dot(lc[t])};
            }
            auto scoreOne = [&](size_t h) {
                const sg::Plane& pl = hyp[h];
                double w = 0;
                for (uint32_t u : left) if (ln[u].dot(pl.n) >= cosA && std::fabs(pl.dist(lc[u])) < P.planeDistM) w += s.area[u];
                score[h] = w;
            };
            if (left.size() >= 2048) sg::parallelFor(kHypotheses, scoreOne, 4);
            else for (size_t h = 0; h < kHypotheses; ++h) scoreOne(h);
            double bestW = -1;
            sg::Plane best;
            for (int h = 0; h < kHypotheses; ++h) if (score[h] > bestW) { bestW = score[h]; best = hyp[h]; }
            if (bestW < P.planeMinAreaM2) break;
            Region r;
            r.pl = best;
            for (uint32_t u : left) if (ln[u].dot(best.n) >= cosA && std::fabs(best.dist(lc[u])) < P.planeDistM) r.tris.push_back(u);
            r.pl = fitRegion(r.tris, best.n);
            stats(r);
            std::vector<uint32_t> rest;
            if (r.area >= P.planeMinAreaM2 && r.rms <= P.planeMaxRmsM) {
                std::set<uint32_t> in(r.tris.begin(), r.tris.end());
                for (uint32_t u : left) if (!in.count(u)) rest.push_back(u);
                regions.push_back(std::move(r));
                left.swap(rest);
            } else {
                break;
            }
        }
        // merge coplanar planes
        const float cosM = static_cast<float>(std::cos(rad(P.mergeAngleDeg)));
        const double offM = std::max(P.mergeOffsetM, mergeOffsetM), maxRmsM = std::max(P.planeMaxRmsM, mergeMaxRmsM);
        // in index order, as comparing every pair does (see mergeCoplanarInOrder: the same merges, found from an index)
        {
            const size_t R0 = regions.size();
            const std::vector<uint8_t> alive = sg::mergeCoplanarInOrder(R0, cosM, offM,
                [&](size_t i) -> const sg::Plane& { return regions[i].pl; },
                [&](size_t i) -> const Vec3& { return regions[i].c; },
                [&](size_t a, size_t b) {
                    Region m;
                    m.tris = regions[a].tris;
                    m.tris.insert(m.tris.end(), regions[b].tris.begin(), regions[b].tris.end());
                    std::sort(m.tris.begin(), m.tris.end());
                    m.pl = fitRegion(m.tris, regions[a].pl.n);
                    stats(m);
                    if (m.rms > maxRmsM) return false;
                    regions[a] = std::move(m);
                    regions[b].tris.clear(); regions[b].tris.shrink_to_fit();
                    return true;
                });
            std::vector<Region> kept;
            kept.reserve(R0);
            for (size_t i = 0; i < R0; ++i) if (alive[i]) kept.push_back(std::move(regions[i]));
            regions.swap(kept);
        }
        // opposed sheets under sheetGapM apart that overlap: internal plates, not solids. Each pair's test only marks both, so
        // the pairs are found in parallel, from a candidate index (normal opposed within the angle, centroid within the gap of
        // the plane), and marked afterwards.
        {
            const float cosS = 0.97f;
            const double chordS = sg::PlanePointIndex::chordForDot(cosS);
            sg::PlanePointIndex sheetIndex(chordS);
            for (size_t i = 0; i < regions.size(); ++i) sheetIndex.insert(static_cast<uint32_t>(i), regions[i].pl.n, regions[i].c);
            std::vector<std::vector<uint32_t>> partners(regions.size());
            sg::parallelFor(regions.size(), [&](size_t a) {
                const auto& A = regions[a];
                const Vec3 back = A.pl.n * -1.0f;
                std::vector<uint32_t> cand;
                sheetIndex.query(back, back, -A.pl.d, P.sheetGapM, [&](uint32_t id) { if (id > a) cand.push_back(id); });
                std::sort(cand.begin(), cand.end());
                for (const uint32_t b : cand) {
                    const auto& Bq = regions[b];
                    if (A.pl.n.dot(Bq.pl.n) > -cosS) continue;
                    if (std::fabs(A.pl.dist(Bq.c)) > P.sheetGapM) continue;
                    const double ox = std::min(A.hi.x, Bq.hi.x) - std::max(A.lo.x, Bq.lo.x), oy = std::min(A.hi.y, Bq.hi.y) - std::max(A.lo.y, Bq.lo.y), oz = std::min(A.hi.z, Bq.hi.z) - std::max(A.lo.z, Bq.lo.z);
                    if (ox < -0.05 || oy < -0.05 || oz < -0.05) continue;
                    partners[a].push_back(b);
                }
            }, 256);
            for (size_t a = 0; a < regions.size(); ++a) for (const uint32_t b : partners[a]) regions[a].sheet = regions[b].sheet = true;
        }
        std::sort(regions.begin(), regions.end(), [](const Region& a, const Region& b) { return a.area > b.area || (a.area == b.area && a.c.y < b.c.y); });
        for (size_t i = 0; i < regions.size(); ++i) for (uint32_t t : regions[i].tris) triPlane[t] = static_cast<int>(i);
    }

    // ---------------------------------------------------------------- samples of the scan (local)
    std::vector<uint8_t> sheetTri;
    double density{25};            // samples per m2 used for every metric of this run
    void sampleScan() {
        const auto& s = R.scan;
        sheetTri.assign(s.triangles(), 0);
        for (size_t t = 0; t < s.triangles(); ++t) if (triPlane[t] >= 0 && regions[static_cast<size_t>(triPlane[t])].sheet) sheetTri[t] = 1;
        std::vector<uint8_t> use(s.triangles(), 0);
        for (size_t t = 0; t < s.triangles(); ++t) use[t] = ext[t] && !sheetTri[t];
        // 25 samples per m2, fewer over a very large scan (the cost is the samples: 60k keep a district's building under a few seconds)
        double extArea = 0;
        for (size_t t = 0; t < s.triangles(); ++t) if (use[t]) extArea += s.area[t];
        density = std::min(P.metricDensity, std::max(4.0, 60000.0 / std::max(1.0, extArea)));
        S = sg::sampleTriangles(lp, s.tri, density, 7, &use);
        sGround.assign(S.size(), 0);
        for (size_t i = 0; i < S.size(); ++i) {
            const auto& q = S[i];
            const double hgt = q.p.y - groundAt(q.p.x, q.p.z);
            if ((hgt < 0.40 && q.n.y > 0.85f) || hgt < -0.25) sGround[i] = 1;
            const double ox = std::max({structX0 - q.p.x, q.p.x - structX1, 0.0}), oz = std::max({structZ0 - q.p.z, q.p.z - structZ1, 0.0});
            const double out = std::max(ox, oz);
            if (!sGround[i] && ((out > 2.5 && hgt < 4.0) || (out > 0.3 && hgt < 0.5))) sGround[i] = 2;  // apron clutter
        }
        applyOwnershipVote();
    }

    // per scan triangle: the multi-view mask vote (-1 not the structure, 0 undecided or none, 1 the structure)
    std::vector<int8_t> triOwner;
    /**
     * The vote is matched to the scan's triangles by centroid (1 mm lattice: the scan is tile_refine's isolated raw scan, the
     * same triangles). A sample on a triangle voted not the structure becomes clutter (sGround 3): it is not fitted, not a
     * leftover and not measured, like the apron clutter. Undecided triangles keep the geometric rules.
     */
    void applyOwnershipVote() {
        const auto& s = R.scan;
        triOwner.assign(s.triangles(), 0);
        if (!Q.ownership || Q.ownership->size() < 12 || std::memcmp(Q.ownership->data(), "SBOV", 4) != 0) return;
        uint32_t count = 0;
        std::memcpy(&count, Q.ownership->data() + 8, 4);
        if (Q.ownership->size() < 12 + static_cast<size_t>(count) * 24) { R.notes.push_back("the multi-view mask vote file is truncated: not used"); return; }
        auto key = [](double x, double y, double z) {
            auto q = [](double v) { return static_cast<uint64_t>(std::llround(v * 1000.0) + (1LL << 20)) & 0x1FFFFFull; };
            return q(x) | (q(y) << 21) | (q(z) << 42);
        };
        std::unordered_map<uint64_t, int8_t> byCentroid;
        byCentroid.reserve(count);
        for (uint32_t k = 0; k < count; ++k) {
            const uint8_t* r = Q.ownership->data() + 12 + static_cast<size_t>(k) * 24;
            float c[3];
            std::memcpy(c, r, 12);
            byCentroid[key(c[0], c[1], c[2])] = static_cast<int8_t>(r[20]);
        }
        size_t matched = 0, target = 0, other = 0;
        for (size_t t = 0; t < s.triangles(); ++t) {
            const Vec3& a = s.pos[s.tri[3 * t]], & b = s.pos[s.tri[3 * t + 1]], & c = s.pos[s.tri[3 * t + 2]];
            // the same float arithmetic as the writer: double sums of the float coordinates, divided by 3, rounded to float
            const float cx = static_cast<float>((double(a.x) + b.x + c.x) / 3.0), cy = static_cast<float>((double(a.y) + b.y + c.y) / 3.0), cz = static_cast<float>((double(a.z) + b.z + c.z) / 3.0);
            const auto it = byCentroid.find(key(cx, cy, cz));
            if (it == byCentroid.end()) continue;
            ++matched;
            triOwner[t] = it->second;
            target += it->second > 0;
            other += it->second < 0;
        }
        double otherArea = 0;
        size_t samples = 0;
        for (size_t i = 0; i < S.size(); ++i) {
            if (triOwner[S[i].tri] >= 0 || sGround[i]) continue;
            sGround[i] = 3;
            otherArea += S[i].w;
            ++samples;
        }
        ownershipOtherArea = otherArea;
        R.ownership = {true, matched, target, other, otherArea};
        R.notes.push_back("multi-view mask vote: " + std::to_string(matched) + " of " + std::to_string(s.triangles()) + " scan triangles carry a vote (" + std::to_string(target) +
                          " the structure, " + std::to_string(other) + " not it); " + sj::num(std::round(otherArea * 100) / 100) + " m2 voted not the structure is left out of the fit as clutter");
    }
    double ownershipOtherArea{0};

    // ---------------------------------------------------------------- 4-6. bands, footprints, passages, columns
    sg::Raster gridProto;       // cell layout
    std::vector<float> dsm;     // top surface per cell (local y)
    /** The surfaces a vertical line through a cell's centre crosses, by height; up: the face looks up (it is the top of something solid). */
    struct Crossing { float y; bool up; };
    std::vector<std::vector<Crossing>> layers;

    void buildDsm() {
        const double m = 1.0;
        gridProto.init(structX0 - m - 2, structZ0 - m - 2, structX1 + m + 2, structZ1 + m + 2, P.cellM);
        dsm.assign(gridProto.v.size(), -1e30f);
        layers.assign(gridProto.v.size(), {});
        const auto& s = R.scan;
        for (size_t t = 0; t < s.triangles(); ++t) {
            if (isGround[t] || sheetTri[t]) continue;
            const Vec3 &a = lp[s.tri[3 * t]], &b = lp[s.tri[3 * t + 1]], &c = lp[s.tri[3 * t + 2]];
            const int i0 = std::max(0, gridProto.ix(std::min({a.x, b.x, c.x}))), i1 = std::min(gridProto.nx - 1, gridProto.ix(std::max({a.x, b.x, c.x})));
            const int k0 = std::max(0, gridProto.iz(std::min({a.z, b.z, c.z}))), k1 = std::min(gridProto.nz - 1, gridProto.iz(std::max({a.z, b.z, c.z})));
            const double d = (b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z);
            for (int k = k0; k <= k1; ++k) for (int i = i0; i <= i1; ++i) {
                const double x = gridProto.cx(i), z = gridProto.cz(k);
                float y;
                if (std::fabs(d) < 1e-12) { y = std::max({a.y, b.y, c.y}); if (i0 != i1 || k0 != k1) continue; }
                else {
                    const double w1 = ((x - a.x) * (c.z - a.z) - (c.x - a.x) * (z - a.z)) / d, w2 = ((b.x - a.x) * (z - a.z) - (x - a.x) * (b.z - a.z)) / d;
                    if (w1 < -1e-9 || w2 < -1e-9 || w1 + w2 > 1 + 1e-9) continue;
                    y = static_cast<float>((1 - w1 - w2) * a.y + w1 * b.y + w2 * c.y);
                }
                float& h = dsm[gridProto.id(i, k)];
                h = std::max(h, y);
                if (std::fabs(d) >= 1e-12 && std::fabs(ln[t].y) >= 0.02f) layers[gridProto.id(i, k)].push_back({y, ln[t].y > 0});
            }
        }
        // sorted by height; a face met twice on a shared edge counts once, and opposed faces within 3 cm (a sheet) cancel
        for (auto& L : layers) {
            std::sort(L.begin(), L.end(), [](const Crossing& a, const Crossing& b) { return a.y < b.y || (a.y == b.y && a.up < b.up); });
            std::vector<Crossing> out;
            for (const auto& c : L) {
                if (!out.empty() && c.y - out.back().y < 0.03f) { if (out.back().up == c.up) continue; out.pop_back(); continue; }
                out.push_back(c);
            }
            L.swap(out);
        }
    }

    /**
     * The structure occupied at height h, by what the scan's walls say about each cell, and not by whether they close.
     * A slice through the scan gives wall segments, each with the side it faces out to. From a cell, a ray along each of the
     * frame's four horizontal directions meets a wall first or none; a ray that meets one while leaving a solid (the wall
     * faces away along the ray) votes inside, one that meets a wall from its outer side votes outside. A cell is inside
     * when at least one ray leaves a solid and none enters one, and it stands under some surface of the scan (the roof, a
     * ceiling, a cap). A pier whose far walls were never scanned is thus still a pier (the two walls that were scanned
     * leave it behind them), a passage between piers is not (every wall it sees faces it), and the open sky is not.
     */
    /** Per cell: how many of the four horizontal rays leave a solid (exits) and how many enter one (enters), from the walls at height h. */
    void wallVotes(double h, std::vector<uint8_t>& exits, std::vector<uint8_t>& enters) const {
        const sg::Raster& o = gridProto;
        struct Seg { double ax, az, bx, bz, nx, nz; };
        std::vector<Seg> segs;
        const auto& s = R.scan;
        const bool aligned = frameShare >= 0.35;  // a rectilinear plan: only walls along its axes make its footprint; the rest are residual
        const float cosAlign = static_cast<float>(std::cos(rad(12.0)));
        for (size_t t = 0; t < s.triangles(); ++t) {
            if (isGround[t] || sheetTri[t] || std::fabs(ln[t].y) > 0.75f) continue;
            // a wall is a big flat face or part of a plane: curved clutter (a tree crown against the facade) is small facets that are not, and does not make a footprint
            if (s.area[t] < P.wallMinAreaM2 && (triPlane[t] < 0 || regions[static_cast<size_t>(triPlane[t])].area < P.wallMinAreaM2)) continue;
            const double nl = std::hypot(ln[t].x, ln[t].z);
            if (nl < 1e-3) continue;
            const double nx = ln[t].x / nl, nz = ln[t].z / nl;
            if (aligned && std::max(std::fabs(nx), std::fabs(nz)) < cosAlign) continue;
            const Vec3* v[3] = {&lp[s.tri[3 * t]], &lp[s.tri[3 * t + 1]], &lp[s.tri[3 * t + 2]]};
            P2 pts[2];
            int n = 0;
            for (int j = 0; j < 3 && n < 2; ++j) {
                const Vec3 &a = *v[j], &b = *v[(j + 1) % 3];
                if ((a.y - h) * (b.y - h) < 0) { const double f = (h - a.y) / (b.y - a.y); pts[n++] = P2(a.x + f * (b.x - a.x), a.z + f * (b.z - a.z)); }
            }
            if (n == 2) segs.push_back({pts[0].x, pts[0].y, pts[1].x, pts[1].y, nx, nz});
        }
        // crossings of every grid row (along +x) and column (along +z): (position, outward normal component along the line)
        std::vector<std::vector<std::pair<double, int>>> rows(static_cast<size_t>(o.nz)), cols(static_cast<size_t>(o.nx));
        for (const auto& g : segs) {
            if (std::fabs(g.bz - g.az) > 1e-9) {
                const double lo = std::min(g.az, g.bz), hi = std::max(g.az, g.bz);
                for (int k = std::max(0, o.iz(lo)); k <= std::min(o.nz - 1, o.iz(hi)); ++k) {
                    const double z = o.cz(k);
                    if (z < lo || z >= hi) continue;
                    const double x = g.ax + (z - g.az) / (g.bz - g.az) * (g.bx - g.ax);
                    if (std::fabs(g.nx) > 0.2) rows[static_cast<size_t>(k)].push_back({x, g.nx > 0 ? 1 : -1});
                }
            }
            if (std::fabs(g.bx - g.ax) > 1e-9) {
                const double lo = std::min(g.ax, g.bx), hi = std::max(g.ax, g.bx);
                for (int i = std::max(0, o.ix(lo)); i <= std::min(o.nx - 1, o.ix(hi)); ++i) {
                    const double x = o.cx(i);
                    if (x < lo || x >= hi) continue;
                    const double z = g.az + (x - g.ax) / (g.bx - g.ax) * (g.bz - g.az);
                    if (std::fabs(g.nz) > 0.2) cols[static_cast<size_t>(i)].push_back({z, g.nz > 0 ? 1 : -1});
                }
            }
        }
        for (auto& r : rows) std::sort(r.begin(), r.end());
        for (auto& c : cols) std::sort(c.begin(), c.end());
        exits.assign(o.v.size(), 0);
        enters.assign(o.v.size(), 0);
        // along a line: the nearest crossing on each side; a ray toward +: leaves a solid when the wall faces +; toward -: when it faces -
        auto sweep = [&](const std::vector<std::pair<double, int>>& xs, int n, const std::function<double(int)>& pos, const std::function<size_t(int)>& id) {
            size_t j = 0;
            for (int i = 0; i < n; ++i) {
                const double p = pos(i);
                while (j < xs.size() && xs[j].first < p) ++j;
                if (j < xs.size()) { (xs[j].second > 0 ? exits : enters)[id(i)]++; }          // the ray toward +
                if (j > 0) { (xs[j - 1].second < 0 ? exits : enters)[id(i)]++; }              // the ray toward -
            }
        };
        for (int k = 0; k < o.nz; ++k) sweep(rows[static_cast<size_t>(k)], o.nx, [&](int i) { return o.cx(i); }, [&](int i) { return o.id(i, k); });
        for (int i = 0; i < o.nx; ++i) sweep(cols[static_cast<size_t>(i)], o.nz, [&](int k) { return o.cz(k); }, [&](int k) { return o.id(i, k); });
    }

    sg::Raster occAt(double h) const {
        sg::Raster o = gridProto;
        std::fill(o.v.begin(), o.v.end(), 0);
        std::vector<uint8_t> exits, enters;
        wallVotes(h, exits, enters);
        if (std::getenv("SCAN_FIT_DEBUG_DIR")) {
            sg::Raster en = o, ex = o;
            for (size_t c = 0; c < o.v.size(); ++c) { en.v[c] = enters[c] > 0; ex.v[c] = exits[c] >= 2; }
            debugRaster("occ_enters_" + std::to_string(static_cast<int>(std::lround(h * 100))), en);
            debugRaster("occ_exits2_" + std::to_string(static_cast<int>(std::lround(h * 100))), ex);
        }
        for (size_t c = 0; c < o.v.size(); ++c) {
            if (exits[c] < 1 || enters[c] > 0) continue;
            const int i = static_cast<int>(c % static_cast<size_t>(o.nx)), k = static_cast<int>(c / static_cast<size_t>(o.nx));
            if (o.cx(i) < tipX0 || o.cx(i) > tipX1 || o.cz(k) < tipZ0 || o.cz(k) > tipZ1) continue;
            // one ray leaving a solid needs the scan to stand over the cell (a roof, a ceiling, a cap); two do not
            const auto& L = layers[c];
            if (exits[c] < 2 && (L.empty() || L.back().y < h + 0.01f)) continue;
            o.v[c] = 1;
        }
        return o;
    }

    /** Cells the walls at height h put outside: a ray enters a solid from them and none leaves one. */
    sg::Raster outsideAt(double h) const {
        sg::Raster o = gridProto;
        std::fill(o.v.begin(), o.v.end(), 0);
        std::vector<uint8_t> exits, enters;
        wallVotes(h, exits, enters);
        for (size_t c = 0; c < o.v.size(); ++c) o.v[c] = (enters[c] > 0 && exits[c] == 0) ? 1 : 0;
        return o;
    }

    /** The slice through the scan at height h: its inside (closed against cracks) where the top surface stands above h. */
    sg::Raster sliceAt(double h, int close = 1) const {
        sg::Raster wall = gridProto;
        std::fill(wall.v.begin(), wall.v.end(), 0);
        const auto& s = R.scan;
        for (size_t t = 0; t < s.triangles(); ++t) {
            if (isGround[t] || sheetTri[t]) continue;
            const Vec3* v[3] = {&lp[s.tri[3 * t]], &lp[s.tri[3 * t + 1]], &lp[s.tri[3 * t + 2]]};
            P2 pts[2];
            int n = 0;
            for (int j = 0; j < 3 && n < 2; ++j) {
                const Vec3 &a = *v[j], &b = *v[(j + 1) % 3];
                if ((a.y - h) * (b.y - h) < 0) {
                    const double f = (h - a.y) / (b.y - a.y);
                    pts[n++] = P2(a.x + f * (b.x - a.x), a.z + f * (b.z - a.z));
                } else if (a.y == h && n < 2) {
                    pts[n++] = P2(a.x, a.z);
                }
            }
            if (n == 2) sg::rasterSegment(wall, pts[0].x, pts[0].y, pts[1].x, pts[1].y);
        }
        sg::Raster thick = sg::dilate(wall, close);
        sg::Raster in = sg::erode(sg::enclosed(thick), close);
        for (size_t c = 0; c < in.v.size(); ++c) if (in.v[c] && dsm[c] < h - 0.02) in.v[c] = 0;
        return in;
    }

    struct LoopRaw { std::vector<P2> pts; double area{0}; int depth{0}; int parent{-1}; };

    /** Outer loops with their holes from a raster (areas in m^2; small ones dropped). */
    std::vector<std::pair<LoopRaw, std::vector<LoopRaw>>> loopsOf(const sg::Raster& r) const {
        auto raw = sg::rasterLoops(r);
        std::vector<LoopRaw> L;
        for (auto& pts : raw) { LoopRaw l; l.area = std::fabs(sg::signedArea(pts)); l.pts = std::move(pts); L.push_back(std::move(l)); }
        for (size_t i = 0; i < L.size(); ++i) {
            double bestA = 1e300;
            for (size_t j = 0; j < L.size(); ++j) {
                if (i == j || L[j].area <= L[i].area) continue;
                if (sg::insidePolygon(L[j].pts, L[i].pts[0].x, L[i].pts[0].y)) { ++L[i].depth; if (L[j].area < bestA) { bestA = L[j].area; L[i].parent = static_cast<int>(j); } }
            }
        }
        std::vector<std::pair<LoopRaw, std::vector<LoopRaw>>> out;
        std::vector<long> slot(L.size(), -1);
        for (size_t i = 0; i < L.size(); ++i) {
            if (L[i].depth % 2 || L[i].area < P.minLoopAreaM2) continue;
            slot[i] = static_cast<long>(out.size());
            out.push_back({L[i], {}});
        }
        for (size_t i = 0; i < L.size(); ++i) {
            if (!(L[i].depth % 2) || L[i].area < 0.5 * P.minLoopAreaM2 || L[i].parent < 0) continue;
            const long s = slot[static_cast<size_t>(L[i].parent)];
            if (s >= 0) out[static_cast<size_t>(s)].second.push_back(L[i]);
        }
        std::sort(out.begin(), out.end(), [](const auto& a, const auto& b) {
            const P2 ca = a.first.pts[0], cb = b.first.pts[0];
            return a.first.area > b.first.area || (a.first.area == b.first.area && (ca.x < cb.x || (ca.x == cb.x && ca.y < cb.y)));
        });
        return out;
    }

    /**
     * Where a wall stands, measured from the scan's own exterior samples and not from a plane that happened to be grown there:
     * the samples facing along the outward normal m (within 18 degrees, near-vertical faces), within `window` of the offset
     * `c0` (m . (x, z)), along the wall between `tLo` and `tHi` (t along the perpendicular direction) and in the heights
     * [y0, y1], binned at 1 cm by area. The wall is the outermost peak that holds at least 20 % of the area near the
     * strongest one (a pilaster or a projecting pier may be proud of the face behind it, and the sides of the cornice are
     * not the wall), refined as the area-weighted mean within 4 cm of it. Returns false with fewer than 0.5 m2 of samples.
     */
    bool measureWall(const P2& m, double c0, double tLo, double tHi, double y0, double y1, double window, double& offset, double* mass = nullptr) const {
        const P2 d(-m.y, m.x);
        const int nb = static_cast<int>(std::ceil(2 * window / 0.01)) + 1;
        std::vector<double> h(static_cast<size_t>(nb), 0.0);
        double tot = 0;
        for (size_t i = 0; i < S.size(); ++i) {
            if (sGround[i]) continue;
            const auto& q = S[i];
            if (q.p.y < y0 || q.p.y > y1 || std::fabs(q.n.y) > 0.35f) continue;
            const double hl = std::hypot(q.n.x, q.n.z);
            if (hl < 1e-6 || (q.n.x * m.x + q.n.z * m.y) / hl < std::cos(rad(18.0))) continue;
            const double t = d.x * q.p.x + d.y * q.p.z;
            if (t < tLo || t > tHi) continue;
            const double o = m.x * q.p.x + m.y * q.p.z - c0;
            if (std::fabs(o) > window) continue;
            h[static_cast<size_t>((o + window) / 0.01)] += q.w;
            tot += q.w;
        }
        if (tot < 0.5) return false;
        std::vector<double> sm(h.size(), 0.0);
        for (size_t b = 0; b < h.size(); ++b) for (int k = -4; k <= 4; ++k) { const long j = static_cast<long>(b) + k; if (j >= 0 && j < static_cast<long>(h.size())) sm[b] += h[static_cast<size_t>(j)]; }
        const size_t top = static_cast<size_t>(std::max_element(sm.begin(), sm.end()) - sm.begin());
        size_t pick = top;
        for (size_t b = h.size(); b-- > top + 1;) {
            if (sm[b] < 0.2 * sm[top]) continue;
            bool peak = true;
            for (int k = -6; k <= 6; ++k) { const long j = static_cast<long>(b) + k; if (j >= 0 && j < static_cast<long>(sm.size()) && sm[static_cast<size_t>(j)] > sm[b]) peak = false; }
            if (peak) { pick = b; break; }
        }
        double sw = 0, so = 0;
        for (int k = -4; k <= 4; ++k) { const long j = static_cast<long>(pick) + k; if (j >= 0 && j < static_cast<long>(h.size())) { sw += h[static_cast<size_t>(j)]; so += h[static_cast<size_t>(j)] * (-window + (j + 0.5) * 0.01); } }
        if (sw <= 0) return false;
        offset = c0 + so / sw;
        if (mass) *mass = sw;
        return true;
    }

    /** A vertical plane's trace in plan at height y: unit normal m (x, z) and offset c with m . (x, z) = c. */
    bool planeTrace(const Region& r, double y, P2& m, double& c) const {
        const P2 nh(r.pl.n.x, r.pl.n.z);
        const double l = nh.len();
        if (l < 0.98 || r.sheet) return false;
        m = nh * (1.0 / l);
        c = (r.pl.d - r.pl.n.y * y) / l;
        return true;
    }

    /**
     * Fits a traced loop: Douglas-Peucker corners, a line (or a circular arc) per run, each line snapped to the vertical
     * plane it lies on, consecutive collinear lines merged, vertices at the lines' intersections.
     */
    Loop fitLoop(const std::vector<P2>& ptsIn, double y0, double y1, bool hole) const {
        std::vector<P2> pts = ptsIn;
        if (sg::signedArea(pts) < 0) std::reverse(pts.begin(), pts.end());  // counter-clockwise (x right, z ... as given)
        const double yMid = 0.5 * (y0 + y1);
        auto corners = sg::douglasPeuckerClosed(pts, 2 * P.cellM);
        Loop fallback;
        for (size_t c : corners) { fallback.pts.push_back(pts[c]); fallback.bulge.push_back(0); }
        if (corners.size() < 3) return fallback;
        struct Seg { bool arc{false}; P2 point, dir; sg::Circle circ; double sweep{0}; P2 a, b; };
        std::vector<Seg> segs;
        for (size_t k = 0; k < corners.size(); ++k) {
            const size_t i = corners[k], j = corners[(k + 1) % corners.size()];
            std::vector<P2> run;
            for (size_t m = i;; m = (m + 1) % pts.size()) { run.push_back(pts[m]); if (m == j) break; }
            Seg sgm;
            sgm.a = pts[i]; sgm.b = pts[j];
            double rms = 0;
            sg::line2(run, sgm.point, sgm.dir, &rms);
            if ((sgm.b - sgm.a).dot(sgm.dir) < 0) sgm.dir = sgm.dir * -1.0;
            double runLen = 0;
            for (size_t m = 1; m < run.size(); ++m) runLen += (run[m] - run[m - 1]).len();
            if (rms > P.lineTolM && runLen > 1.0 && run.size() >= 6) {
                std::vector<std::array<double, 3>> cp;
                for (const auto& q : run) cp.push_back({q.x, q.y, 1.0});
                sg::Circle c;
                if (sg::circleKasa(cp, c)) {
                    sg::circleGN(cp, c);
                    const double crms = sg::circleRms(cp, c);
                    if (crms <= P.lineTolM && c.r < 60 && c.r > 0.1) {
                        sgm.arc = true;
                        sgm.circ = c;
                        // sweep from a to b through the run's middle
                        const double a0 = std::atan2(sgm.a.y - c.cy, sgm.a.x - c.cx), a1 = std::atan2(sgm.b.y - c.cy, sgm.b.x - c.cx);
                        const P2 mid = run[run.size() / 2];
                        const double am = std::atan2(mid.y - c.cy, mid.x - c.cx);
                        auto norm = [](double a) { while (a <= -sg::kPi) a += 2 * sg::kPi; while (a > sg::kPi) a -= 2 * sg::kPi; return a; };
                        double d1 = norm(a1 - a0);
                        const double dm = norm(am - a0);
                        if ((d1 > 0) != (dm > 0) || std::fabs(dm) > std::fabs(d1)) d1 = d1 > 0 ? d1 - 2 * sg::kPi : d1 + 2 * sg::kPi;
                        sgm.sweep = d1;
                    }
                }
            }
            if (!sgm.arc) {
                // snap to the vertical plane this run lies on
                const P2 nOut = hole ? P2(-sgm.dir.y, sgm.dir.x) : P2(sgm.dir.y, -sgm.dir.x);
                const double cOff = nOut.dot(sgm.point);
                double measured = 0;
                const P2 tDir(-nOut.y, nOut.x);
                const double ta = tDir.dot(sgm.a), tb = tDir.dot(sgm.b);
                if (!hole && measureWall(nOut, cOff, std::min(ta, tb) - 0.2, std::max(ta, tb) + 0.2, y0 + 0.1, y1 - 0.1, 0.5, measured)) {
                    sgm.point = sgm.point + nOut * (measured - cOff);
                    segs.push_back(sgm);
                    continue;
                }
                double bestArea = 0;
                for (const auto& r : regions) {
                    P2 m; double c;
                    if (!planeTrace(r, yMid, m, c)) continue;
                    if (r.hi.y < y0 + 0.05 || r.lo.y > y1 - 0.05) continue;
                    if (m.dot(nOut) < std::cos(rad(P.snapAngleDeg))) continue;
                    if (std::fabs(c - cOff) > P.snapOffsetM) continue;
                    if (r.area <= bestArea) continue;
                    bestArea = r.area;
                    sgm.dir = P2(-m.y, m.x);
                    if (hole) sgm.dir = sgm.dir * -1.0;
                    if ((sgm.b - sgm.a).dot(sgm.dir) < 0) sgm.dir = sgm.dir * -1.0;
                    sgm.point = sgm.point + m * (c - m.dot(sgm.point));
                }
            }
            segs.push_back(sgm);
        }
        // merge consecutive collinear lines
        for (size_t k = 0; segs.size() > 3 && k < segs.size();) {
            Seg& A = segs[k];
            Seg& Bq = segs[(k + 1) % segs.size()];
            if (!A.arc && !Bq.arc && A.dir.dot(Bq.dir) > std::cos(rad(3.0)) && std::fabs((Bq.point - A.point).cross(A.dir)) < 0.05) {
                std::vector<P2> both{A.a, Bq.b, A.point, Bq.point};
                A.b = Bq.b;
                segs.erase(segs.begin() + static_cast<long>((k + 1) % segs.size()));
                if ((k + 1) % (segs.size() + 1) == 0 && k > 0) --k;
                continue;
            }
            ++k;
        }
        // vertices
        Loop L;
        const size_t n = segs.size();
        auto lineX = [](const Seg& A, const Seg& Bq, const P2& corner) {
            const double den = A.dir.cross(Bq.dir);
            if (std::fabs(den) < std::sin(rad(10.0))) return corner;
            const double t = (Bq.point - A.point).cross(Bq.dir) / den;
            const P2 x = A.point + A.dir * t;
            return (x - corner).len() > 1.0 ? corner : x;
        };
        auto lineCircle = [](const Seg& line, const sg::Circle& c, const P2& corner) {
            const P2 d = line.dir, o = line.point - P2(c.cx, c.cy);
            const double b = o.dot(d), cc = o.dot(o) - c.r * c.r, disc = b * b - cc;
            if (disc < 0) return corner;
            const double s = std::sqrt(disc);
            const P2 x1 = line.point + d * (-b - s), x2 = line.point + d * (-b + s);
            const P2 best = (x1 - corner).len() < (x2 - corner).len() ? x1 : x2;
            return (best - corner).len() > 1.0 ? corner : best;
        };
        for (size_t k = 0; k < n; ++k) {
            const Seg& prev = segs[(k + n - 1) % n];
            const Seg& cur = segs[k];
            const P2 corner = cur.a;
            P2 v;
            if (!prev.arc && !cur.arc) v = lineX(prev, cur, corner);
            else if (prev.arc && !cur.arc) v = lineCircle(cur, prev.circ, corner);
            else if (!prev.arc && cur.arc) v = lineCircle(prev, cur.circ, corner);
            else v = corner;
            L.pts.push_back(v);
        }
        for (size_t k = 0; k < n; ++k) {
            if (!segs[k].arc) { L.bulge.push_back(0); continue; }
            // the arc between this segment's vertices, the way the fit swept it
            L.bulge.push_back(std::tan(segs[k].sweep / 4));
        }
        // sanity: the fitted loop keeps the traced loop's area and does not cross itself
        const auto tess = tessellate(L, P.sagittaM);
        const double a0 = std::fabs(sg::signedArea(pts)), a1 = std::fabs(sg::signedArea(tess));
        bool ok = a1 > 0.85 * a0 && a1 < 1.15 * a0;
        for (size_t i = 0; i < tess.size() && ok; ++i) {
            for (size_t j = i + 2; j < tess.size() && ok; ++j) {
                if (i == 0 && j == tess.size() - 1) continue;
                const P2 a = tess[i], b = tess[(i + 1) % tess.size()], c = tess[j], d = tess[(j + 1) % tess.size()];
                const double d1 = (b - a).cross(c - a), d2 = (b - a).cross(d - a), d3 = (d - c).cross(a - c), d4 = (d - c).cross(b - c);
                if (((d1 > 0) != (d2 > 0)) && ((d3 > 0) != (d4 > 0)) && std::fabs(d1) > 1e-9 && std::fabs(d2) > 1e-9) ok = false;
            }
        }
        return ok ? L : fallback;
    }

    /** A loop is a column when its trace is a circle (radius in range, rms within the contour tolerance). */
    bool circleLoop(const std::vector<P2>& pts, sg::Circle& c) const {
        if (pts.size() < 8) return false;
        std::vector<std::array<double, 3>> cp;
        for (const auto& q : pts) cp.push_back({q.x, q.y, 1.0});
        if (!sg::circleKasa(cp, c)) return false;
        sg::circleGN(cp, c);
        // the trace sits half a cell outside the true surface on average; compensate
        const double rms = sg::circleRms(cp, c);
        return rms <= P.columnContourRmsM + 0.5 * P.cellM && c.r >= P.columnMinR && c.r <= P.columnMaxR;
    }

    // model under construction
    struct ColumnSpec { P2 centre; double y0{0}, y1{0}; double rTrace{0}; std::vector<std::array<double, 2>> profile; double rms{0}; double heightCoverage{0}; };

    struct FootprintCandidate { double y0{0}, area{0}; Loop outer; std::vector<Loop> holes; };
    std::vector<FootprintCandidate> fpCand;

    /**
     * The footprint is the plan at the structure's foot. When the lowest band traced nothing, or only a sliver of what the
     * bands above trace (a scan whose street level is missing or hollow), it is the lowest band whose plan is at least half of
     * the largest plan traced; when no band traced a loop (columns only), the scan's own plan hull. Both are measured and named in
     * the notes; nothing is invented.
     */
    void chooseFootprint() {
        double have = 0;
        for (size_t i = 0; i < R.footprint.size(); ++i) {
            double a = std::fabs(sg::signedArea(R.footprint[i].pts));
            for (const auto& h : R.footprintHoles[i]) a -= std::fabs(sg::signedArea(h.pts));
            have = std::max(have, a);
        }
        double maxA = 0;
        for (const auto& c : fpCand) maxA = std::max(maxA, c.area);
        if (maxA > 0 && have < 0.5 * maxA) {
            const FootprintCandidate* pick = nullptr;
            for (const auto& c : fpCand) if (c.area >= 0.5 * maxA && (!pick || c.y0 < pick->y0)) pick = &c;
            if (pick) {
                R.footprint = {pick->outer};
                R.footprintHoles = {pick->holes};
                R.notes.push_back("the footprint is the plan of the band from " + sj::num(std::round(pick->y0 * 10) / 10) + " m above the base (" + sj::num(std::round(pick->area)) + " m2): the lowest band traced only " + sj::num(std::round(have)) + " m2, the scan having little structure at street level");
            }
        } else if (R.footprint.empty()) {
            std::vector<P2> pts;
            for (const auto& v : R.scan.pos) pts.push_back(P2(v.x, v.z));
            std::sort(pts.begin(), pts.end(), [](const P2& a, const P2& b) { return a.x < b.x || (a.x == b.x && a.y < b.y); });
            pts.erase(std::unique(pts.begin(), pts.end(), [](const P2& a, const P2& b) { return a.x == b.x && a.y == b.y; }), pts.end());
            if (pts.size() >= 3) {
                std::vector<P2> h(2 * pts.size());
                size_t k = 0;
                auto cross = [](const P2& o, const P2& a, const P2& b) { return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x); };
                for (size_t i = 0; i < pts.size(); ++i) { while (k >= 2 && cross(h[k - 2], h[k - 1], pts[i]) <= 0) --k; h[k++] = pts[i]; }
                for (size_t i = pts.size() - 1, t = k + 1; i > 0; --i) { while (k >= t && cross(h[k - 2], h[k - 1], pts[i - 1]) <= 0) --k; h[k++] = pts[i - 1]; }
                h.resize(k - 1);
                if (h.size() >= 3 && std::fabs(sg::signedArea(h)) > 0) {
                    R.footprintHullTile = h;
                    R.notes.push_back("no band traced a footprint loop: the footprint is the convex hull of the scan in plan (" + sj::num(std::round(std::fabs(sg::signedArea(h)))) + " m2)");
                }
            }
        }
    }

    void bandsAndFootprints() {
        buildDsm();
        // ledges: horizontal planes that span the plan
        struct Ledge { double y; double area; int region; };
        std::vector<Ledge> ledges;
        const double spanX = std::max(0.5, structX1 - structX0), spanZ = std::max(0.5, structZ1 - structZ0);
        for (size_t i = 0; i < regions.size(); ++i) {
            const auto& r = regions[i];
            if (r.sheet || std::fabs(r.pl.n.y) < 0.98f || r.area < P.ledgeMinAreaM2) continue;
            if ((r.hi.x - r.lo.x) / spanX < P.ledgeSpan || (r.hi.z - r.lo.z) / spanZ < P.ledgeSpan) continue;
            ledges.push_back({r.pl.d / r.pl.n.y - (r.pl.n.x * r.c.x + r.pl.n.z * r.c.z) / r.pl.n.y, r.area, static_cast<int>(i)});
        }
        std::sort(ledges.begin(), ledges.end(), [](const Ledge& a, const Ledge& b) { return a.y < b.y; });
        // the base: the ground under the plan's corners (its lowest)
        double yBase = std::min({groundAt(structX0, structZ0), groundAt(structX1, structZ0), groundAt(structX0, structZ1), groundAt(structX1, structZ1)});
        R.baseY = yBase;
        std::vector<double> breaks{yBase};
        for (const auto& l : ledges) if (l.y > breaks.back() + 0.1 && l.y < structTop - 0.05) breaks.push_back(l.y);
        if (structTop > breaks.back() + 0.05) breaks.push_back(structTop);
        int order = 0;
        for (size_t b = 0; b + 1 < breaks.size(); ++b) buildBand(breaks[b], breaks[b + 1], order, b == 0);
        chooseFootprint();
    }

    /** With SCAN_FIT_DEBUG_DIR set, a raster as a PNG there (the footprint of each band: white is structure). */
    void debugRaster(const std::string& name, const sg::Raster& r) const {
        const char* dir = std::getenv("SCAN_FIT_DEBUG_DIR");
        if (!dir) return;
        const auto png = sg::rasterPng(r);
        std::ofstream(std::string(dir) + "/" + name + ".png", std::ios::binary).write(reinterpret_cast<const char*>(png.data()), static_cast<std::streamsize>(png.size()));
    }

    // ---------------------------------------------------------------- one band
    void buildBand(double y0, double y1, int& order, bool lowest) {
        const double H = y1 - y0;
        const int K = std::clamp(static_cast<int>(std::ceil(H / 1.0)), 1, 8);
        std::vector<sg::Raster> mids;
        for (int k = 0; k < K; ++k) mids.push_back(occAt(y0 + H * (0.25 + 0.5 * (k + 0.5) / K)));
        sg::Raster F = gridProto;
        std::fill(F.v.begin(), F.v.end(), 0);
        for (size_t c = 0; c < F.v.size(); ++c) {
            int n = 0;
            for (const auto& m : mids) n += m.v[c];
            F.v[c] = 2 * n >= K ? 1 : 0;
        }
        // the band's top and bottom walls veto cells they put outside (a missing far wall must not let the footprint run on
        // to the next surface above it)
        {
            const sg::Raster vt = outsideAt(y1 - std::min(0.25, 0.08 * H)), vb = outsideAt(y0 + std::min(0.25, 0.08 * H) + 0.05);
            for (size_t c = 0; c < F.v.size(); ++c) if (F.v[c] && (vt.v[c] || vb.v[c])) F.v[c] = 0;
        }
        debugRaster("band_" + std::to_string(static_cast<int>(std::lround(y0 * 100))), F);
        // passages: cells solid at the band's top but empty through its middle, open to the outside on two sides
        if (H >= 2.0 && tryPassageBand(y0, y1, F, order, lowest)) return;
        for (const auto& [outerRaw, holesRaw] : loopsOf(F)) addLoopPrimitive(outerRaw, holesRaw, y0, y1, order, lowest);
    }

    void addLoopPrimitive(const LoopRaw& outerRaw, const std::vector<LoopRaw>& holesRaw, double y0, double y1, int& order, bool lowest) {
        sg::Circle circ;
        if (holesRaw.empty() && circleLoop(outerRaw.pts, circ)) {
            ColumnSpec col;
            col.centre = P2(circ.cx, circ.cy);
            col.y0 = y0; col.y1 = y1; col.rTrace = circ.r;
            addColumn(col, order);
            return;
        }
        Loop outer = fitLoop(outerRaw.pts, y0, y1, false);
        std::vector<Loop> holes;
        for (const auto& h : holesRaw) holes.push_back(fitLoop(h.pts, y0, y1, true));
        if (lowest) { R.footprint.push_back(outer); R.footprintHoles.push_back(holes); }
        {
            FootprintCandidate c;
            c.y0 = y0; c.outer = outer; c.holes = holes;
            c.area = std::fabs(sg::signedArea(outer.pts));
            for (const auto& h : holes) c.area -= std::fabs(sg::signedArea(h.pts));
            fpCand.push_back(std::move(c));
        }
        addPrism(outer, holes, y0, y1, order);
    }

    // ---------------------------------------------------------------- primitives: prism (operator 1)
    int newPrimitive(const std::string& label) {
        Primitive p;
        p.id = "p" + std::string(primSerial < 10 ? "0" : "") + std::to_string(primSerial);
        ++primSerial;
        p.label = label;
        p.buildOrder = static_cast<int>(R.prims.size());
        R.prims.push_back(std::move(p));
        return static_cast<int>(R.prims.size()) - 1;
    }

    int newSurface(int prim, const std::string& label) {
        Surface s;
        s.id = "s" + std::string(R.surfaces.size() < 10 ? "0" : "") + std::to_string(R.surfaces.size());
        s.prim = prim;
        s.label = label;
        R.surfaces.push_back(std::move(s));
        R.prims[static_cast<size_t>(prim)].surfaces.push_back(static_cast<int>(R.surfaces.size()) - 1);
        return static_cast<int>(R.surfaces.size()) - 1;
    }

    void quad(Surface& s, const Vec3& a, const Vec3& b, const Vec3& c, const Vec3& d, const Vec3& n) {
        const uint32_t base = static_cast<uint32_t>(s.lpos.size());
        for (const Vec3* p : {&a, &b, &c, &d}) { s.lpos.push_back(*p); s.lnrm.push_back(n); }
        // orient both triangles with n
        const Vec3 fn = (b - a).cross(c - a);
        if (fn.dot(n) >= 0) s.tri.insert(s.tri.end(), {base, base + 1, base + 2, base, base + 2, base + 3});
        else s.tri.insert(s.tri.end(), {base, base + 2, base + 1, base, base + 3, base + 2});
    }

    /** A horizontal cap (outer with holes) at y, facing up (n.y > 0) or down. */
    void cap(Surface& s, const std::vector<P2>& outer, const std::vector<std::vector<P2>>& holes, double y, bool up) {
        std::vector<P2> verts;
        const auto tri = sg::triangulate(outer, holes, verts);
        const uint32_t base = static_cast<uint32_t>(s.lpos.size());
        const Vec3 n(0, up ? 1.0f : -1.0f, 0);
        for (const auto& p : verts) { s.lpos.push_back(Vec3(static_cast<float>(p.x), static_cast<float>(y), static_cast<float>(p.y))); s.lnrm.push_back(n); }
        // the triangulation is counter-clockwise in (x, z): its normal (x, z) x is -y; flip for an upward cap
        for (size_t i = 0; i + 2 < tri.size(); i += 3) {
            if (up) s.tri.insert(s.tri.end(), {base + tri[i], base + tri[i + 2], base + tri[i + 1]});
            else s.tri.insert(s.tri.end(), {base + tri[i], base + tri[i + 1], base + tri[i + 2]});
        }
    }

    void planeChartFromQuad(Surface& s, const Vec3& originL, const Vec3& uL, const Vec3& vL, const Vec3& nL, const std::vector<P2>& extent) {
        const Frame& F = R.frame;
        s.kind = ChartKind::Plane;
        s.origin = F.toWorld(originL); s.u = F.dirToWorld(uL); s.v = F.dirToWorld(vL); s.n = F.dirToWorld(nL);
        s.extentUv = extent;
    }

    void addPrism(const Loop& outer, const std::vector<Loop>& holes, double y0, double y1, int& order) {
        const int pi = newPrimitive("swept footprint");
        Primitive& pr = R.prims[static_cast<size_t>(pi)];
        pr.body = true;
        pr.method = "scan_fit: band footprint traced from slices of the scan, runs fitted as lines snapped to their measured planes (or arcs), swept up the band";
        const auto oT = tessellate(outer, P.sagittaM);
        std::vector<std::vector<P2>> hT;
        for (const auto& h : holes) hT.push_back(tessellate(h, P.sagittaM));
        pr.solid.kind = 0; pr.solid.outer = oT; pr.solid.holes = hT; pr.solid.y0 = y0; pr.solid.y1 = y1;
        // spec: operator 1, the footprint (u = x, v = z of the frame) swept along the vertical carrier y0 -> y1
        {
            sj::Object prof;
            prof.raw("outer", polyJ(oT));
            if (!hT.empty()) { std::vector<std::string> hs; for (const auto& h : hT) hs.push_back(polyJ(h)); prof.raw("holes", sj::array(hs)); }
            sj::Object carrier;
            carrier.raw("points", "[" + v3j(Vec3(0, static_cast<float>(y0), 0)) + "," + v3j(Vec3(0, static_cast<float>(y1), 0)) + "]").b("closed", false).n("lengthM", y1 - y0);
            sj::Object sw;
            sw.raw("carrier", "{\"path\":" + carrier.text() + "}").raw("profile", prof.text()).raw("profileUp", "[0,0,1]").n("miterLimit", 1).b("caps", true);
            pr.specJson = "{\"operator\":\"sweep\",\"sweep\":" + sw.text() + "}";
        }
        pr.fitParams = {y0, y1, std::fabs(sg::signedArea(oT))};
        pr.fitParamMeta = {{"m", "base height of the band (local)"}, {"m", "top height of the band (local)"}, {"m2", "footprint area"}};
        auto walls = [&](const Loop& L, bool hole) {
            const size_t n = L.pts.size();
            for (size_t i = 0; i < n; ++i) {
                const P2 a = L.pts[i], b = L.pts[(i + 1) % n];
                if (std::fabs(L.bulge[i]) < 1e-9) {
                    const P2 d = (b - a);
                    const double len = d.len();
                    if (len < 1e-4) continue;
                    const P2 du = d * (1.0 / len);
                    // outward: right of travel for a counter-clockwise outer loop seen with z down... decide by the solid
                    P2 nOut(du.y, -du.x);
                    const P2 mid = (a + b) * 0.5;
                    const P2 probe = mid + nOut * 0.02;
                    const bool insideAfter = sg::insidePolygon(oT, probe.x, probe.y) && !std::any_of(hT.begin(), hT.end(), [&](const auto& h) { return sg::insidePolygon(h, probe.x, probe.y); });
                    if (insideAfter) nOut = nOut * -1.0;
                    const int si = newSurface(pi, hole ? "inner wall" : "wall");
                    Surface& s = R.surfaces[static_cast<size_t>(si)];
                    const Vec3 A(static_cast<float>(a.x), static_cast<float>(y0), static_cast<float>(a.y)), B(static_cast<float>(b.x), static_cast<float>(y0), static_cast<float>(b.y));
                    const Vec3 up(0, static_cast<float>(y1 - y0), 0);
                    const Vec3 nL(static_cast<float>(nOut.x), 0, static_cast<float>(nOut.y));
                    quad(s, A, B, B + up, A + up, nL);
                    // chart: u along the edge as seen from outside (left to right), v up
                    Vec3 uL(static_cast<float>(du.x), 0, static_cast<float>(du.y));
                    Vec3 org = A;
                    if (Vec3(0, 1, 0).cross(uL).dot(nL) > 0) { uL = uL * -1.0f; org = B; }  // u x v = n
                    planeChartFromQuad(s, org, uL, Vec3(0, 1, 0), nL, {{0, 0}, {len, 0}, {len, y1 - y0}, {0, y1 - y0}});
                    pr.creases.push_back({A + up, B + up});
                    pr.creases.push_back({A, A + up});
                } else {
                    // arc wall: a cylindrical chart
                    auto arc = arcPoints(a, b, L.bulge[i], P.sagittaM);
                    std::vector<P2> pts{a};
                    pts.insert(pts.end(), arc.begin(), arc.end());
                    const double theta = 4 * std::atan(L.bulge[i]);
                    const double c = (b - a).len();
                    const double r = c / (2 * std::sin(std::fabs(theta) / 2));
                    // centre: the circle through a, the arc's midpoint and b
                    const P2 m = pts[pts.size() / 2];
                    std::vector<std::array<double, 3>> cp{{a.x, a.y, 1}, {m.x, m.y, 1}, {b.x, b.y, 1}};
                    sg::Circle cc;
                    sg::circleKasa(cp, cc);
                    const int si = newSurface(pi, "curved wall");
                    Surface& s = R.surfaces[static_cast<size_t>(si)];
                    const P2 centre(cc.cx, cc.cy);
                    const P2 probe = m + (m - centre).unit() * 0.02;
                    const bool convex = !sg::insidePolygon(oT, probe.x, probe.y);
                    for (size_t k = 0; k + 1 < pts.size(); ++k) {
                        const P2 p0 = pts[k], p1 = pts[k + 1];
                        const Vec3 A(static_cast<float>(p0.x), static_cast<float>(y0), static_cast<float>(p0.y)), Bv(static_cast<float>(p1.x), static_cast<float>(y0), static_cast<float>(p1.y));
                        const Vec3 up(0, static_cast<float>(y1 - y0), 0);
                        const P2 mm = (p0 + p1) * 0.5;
                        P2 rd = (mm - centre).unit();
                        if (!convex) rd = rd * -1.0;
                        quad(s, A, Bv, Bv + up, A + up, Vec3(static_cast<float>(rd.x), 0, static_cast<float>(rd.y)));
                    }
                    const Frame& F = R.frame;
                    s.kind = ChartKind::Cylinder;
                    s.axisOrigin = F.toWorld(Vec3(static_cast<float>(centre.x), static_cast<float>(y0), static_cast<float>(centre.y)));
                    s.axisDir = F.dirToWorld(Vec3(0, 1, 0));
                    const P2 a0 = (a - centre).unit();
                    s.thetaZeroDir = F.dirToWorld(Vec3(static_cast<float>(a0.x), 0, static_cast<float>(a0.y)));
                    s.radius = r;
                    s.th0 = 0; s.th1 = deg(theta);
                    if (s.th1 < s.th0) std::swap(s.th0, s.th1);
                    s.z0 = 0; s.z1 = y1 - y0;
                    s.normalSign = convex ? 1 : -1;
                }
            }
        };
        walls(outer, false);
        for (const auto& h : holes) walls(h, true);
        const int top = newSurface(pi, "top");
        cap(R.surfaces[static_cast<size_t>(top)], oT, hT, y1, true);
        planeChartFromQuad(R.surfaces[static_cast<size_t>(top)], Vec3(0, static_cast<float>(y1), 0), Vec3(0, 0, 1), Vec3(1, 0, 0), Vec3(0, 1, 0), swapXZ(oT));
        const int bot = newSurface(pi, "underside");
        cap(R.surfaces[static_cast<size_t>(bot)], oT, hT, y0, false);
        planeChartFromQuad(R.surfaces[static_cast<size_t>(bot)], Vec3(0, static_cast<float>(y0), 0), Vec3(1, 0, 0), Vec3(0, 0, 1), Vec3(0, -1, 0), oT);
        ++order;
    }

    static std::vector<P2> swapXZ(const std::vector<P2>& p) { std::vector<P2> o; for (const auto& q : p) o.push_back(P2(q.y, q.x)); return o; }

    // ---------------------------------------------------------------- columns (operator 2, K = 0)
    std::vector<int> columnPrims;
    void addColumn(const ColumnSpec& in, int& order) {
        ColumnSpec col = in;
        // r(z): circles about the traced centre fitted to the column's scan per 0.25 m
        const double reach = col.rTrace + 0.2;
        std::vector<std::array<double, 2>> prof;
        double S2 = 0, W = 0;
        int bandsWith = 0, bands = 0;
        for (double y = col.y0; y < col.y1 - 1e-6; y += 0.25) {
            const double ya = y, yb = std::min(col.y1, y + 0.25);
            ++bands;
            std::vector<std::array<double, 3>> pts;
            for (size_t i = 0; i < S.size(); ++i) {
                if (sGround[i]) continue;
                const auto& q = S[i];
                if (q.p.y < ya || q.p.y >= yb || std::fabs(q.n.y) > 0.3f) continue;
                if (std::hypot(q.p.x - col.centre.x, q.p.z - col.centre.y) > reach) continue;
                pts.push_back({q.p.x, q.p.z, q.w});
            }
            if (pts.size() < 6) continue;
            ++bandsWith;
            sg::Circle c{col.centre.x, col.centre.y, col.rTrace};
            sg::circleGN(pts, c, 4);  // radius only, about the traced centre
            prof.push_back({c.r, 0.5 * (ya + yb)});
            for (const auto& q : pts) { const double r = std::hypot(q[0] - c.cx, q[1] - c.cy) - c.r; S2 += q[2] * r * r; W += q[2]; }
        }
        col.rms = W > 0 ? std::sqrt(S2 / W) : 1.0;
        col.heightCoverage = bands ? static_cast<double>(bandsWith) / bands : 0;
        if (prof.empty()) prof = {{col.rTrace, col.y0}, {col.rTrace, col.y1}};
        // the profile from base to top, its ends at the column's own ends
        std::vector<std::array<double, 2>> profile{{prof.front()[0], col.y0}};
        for (const auto& q : prof) profile.push_back(q);
        profile.push_back({prof.back()[0], col.y1});
        col.profile = profile;
        const int pi = newPrimitive("column");
        Primitive& pr = R.prims[static_cast<size_t>(pi)];
        pr.body = true;
        pr.method = "scan_fit: a circular footprint run; r(z) from circles about its axis fitted to its scan per 0.25 m (operator 2, K = 0)";
        pr.solid.kind = 2; pr.solid.centre = col.centre; pr.solid.profile = col.profile;
        pr.gates.push_back({"column radius rms", col.rms, P.columnRmsMaxM, true, "m"});
        pr.gates.push_back({"column height coverage", col.heightCoverage, P.columnHeightCoverage, false, "ratio"});
        pr.accepted = col.rms <= P.columnRmsMaxM && col.heightCoverage >= P.columnHeightCoverage;
        double rMean = 0;
        for (const auto& q : col.profile) rMean += q[0] / col.profile.size();
        pr.fitParams = {col.centre.x, col.centre.y, col.y0, col.y1, rMean};
        pr.fitParamMeta = {{"m", "axis x (local)"}, {"m", "axis z (local)"}, {"m", "base height (local)"}, {"m", "top height (local)"}, {"m", "mean radius"}};
        {
            std::vector<std::string> pj;
            for (const auto& q : col.profile) pj.push_back("[" + sj::num(q[0]) + "," + sj::num(q[1] - col.y0) + "]");
            sj::Object rv;
            rv.raw("axisOrigin", v3j(Vec3(static_cast<float>(col.centre.x), static_cast<float>(col.y0), static_cast<float>(col.centre.y)))).raw("axisDir", "[0,1,0]")
                .raw("profile", sj::array(pj)).i("lobes", 0).n("lobeAmplitude", 0).n("helixTurns", 0).n("startAngleDeg", 0).n("sweepAngleDeg", 360).i("segments", 32);
            pr.specJson = "{\"operator\":\"revolve\",\"revolve\":" + rv.text() + "}";
        }
        const int si = newSurface(pi, "column shaft");
        Surface& s = R.surfaces[static_cast<size_t>(si)];
        const int seg = 32;
        for (size_t k = 0; k + 1 < col.profile.size(); ++k) {
            const double r0 = col.profile[k][0], r1 = col.profile[k + 1][0], ya = col.profile[k][1], yb = col.profile[k + 1][1];
            if (yb - ya < 1e-6) continue;
            for (int j = 0; j < seg; ++j) {
                const double a0 = 2 * sg::kPi * j / seg, a1 = 2 * sg::kPi * (j + 1) / seg;
                const Vec3 A(static_cast<float>(col.centre.x + r0 * std::cos(a0)), static_cast<float>(ya), static_cast<float>(col.centre.y + r0 * std::sin(a0)));
                const Vec3 Bv(static_cast<float>(col.centre.x + r0 * std::cos(a1)), static_cast<float>(ya), static_cast<float>(col.centre.y + r0 * std::sin(a1)));
                const Vec3 C(static_cast<float>(col.centre.x + r1 * std::cos(a1)), static_cast<float>(yb), static_cast<float>(col.centre.y + r1 * std::sin(a1)));
                const Vec3 D(static_cast<float>(col.centre.x + r1 * std::cos(a0)), static_cast<float>(yb), static_cast<float>(col.centre.y + r1 * std::sin(a0)));
                const double am = 0.5 * (a0 + a1);
                quad(s, A, Bv, C, D, Vec3(static_cast<float>(std::cos(am)), 0, static_cast<float>(std::sin(am))));
            }
        }
        const Frame& F = R.frame;
        s.kind = ChartKind::Cylinder;
        s.axisOrigin = F.toWorld(Vec3(static_cast<float>(col.centre.x), static_cast<float>(col.y0), static_cast<float>(col.centre.y)));
        s.axisDir = F.dirToWorld(Vec3(0, 1, 0));
        s.thetaZeroDir = F.dirToWorld(Vec3(1, 0, 0));
        s.radius = rMean; s.th0 = 0; s.th1 = 360; s.z0 = 0; s.z1 = col.y1 - col.y0; s.normalSign = 1;
        columnPrims.push_back(pi);
        ++order;
    }

    // ---------------------------------------------------------------- passages (operator 1 along the passage axis)
    struct Bay { double sL{0}, sR{0}; bool arch{false}; sg::Circle circ; double yL{0}, yR{0}, yTop{0}; double rms{0}; size_t samples{0}; double coverageDeg{0};
                 sg::Circle semicircle; double semiRms{0}; sg::Circle joint; double jointRms{0}; bool haveJoint{false}; std::vector<std::array<double, 3>> soffit;
                 double rho{0}; std::string corrected; };

    bool tryPassageBand(double y0, double y1, const sg::Raster& F, int& order, bool lowest) {
        const double H = y1 - y0;
        // the band's top (just under its upper ledge)
        const sg::Raster top = occAt(y1 - std::min(0.25, 0.08 * H));
        // candidate voids: solid at the top, empty in the middle
        sg::Raster V = gridProto;
        std::fill(V.v.begin(), V.v.end(), 0);
        for (size_t c = 0; c < V.v.size(); ++c) V.v[c] = top.v[c] && !F.v[c];
        // a passage is wider than the slivers where a footprint's edge and the band top's differ by a few cells
        { const int r = std::max(1, static_cast<int>(std::lround(0.4 / P.cellM))); V = sg::dilate(sg::erode(V, r), r); }
        int nv = 0;
        const auto lab = sg::rasterComponents(V, &nv);
        std::vector<size_t> area(nv, 0);
        for (size_t c = 0; c < lab.size(); ++c) if (lab[c] >= 0) ++area[static_cast<size_t>(lab[c])];
        struct Pass { int comp; P2 axis; double weight; };
        std::vector<Pass> passes;
        for (int c = 0; c < nv; ++c) {
            if (area[static_cast<size_t>(c)] * P.cellM * P.cellM < P.minPassageAreaM2) continue;
            // where the void meets the outside of the top's occupancy, in clusters
            sg::Raster contact = gridProto;
            std::fill(contact.v.begin(), contact.v.end(), 0);
            const sg::Raster topIn = sg::enclosed(top);  // top occupancy with enclosed holes filled
            for (int k = 0; k < V.nz; ++k) for (int i = 0; i < V.nx; ++i) {
                if (lab[V.id(i, k)] != c) continue;
                const int D[4][2] = {{1, 0}, {-1, 0}, {0, 1}, {0, -1}};
                for (const auto& d : D) {
                    if (!V.in(i + d[0], k + d[1])) continue;
                    const size_t j = V.id(i + d[0], k + d[1]);
                    if (!topIn.v[j]) contact.v[V.id(i, k)] = 1;
                }
            }
            int ncl = 0;
            const auto cl = sg::rasterComponents(contact, &ncl);
            if (ncl < 2) continue;
            std::vector<double> sx(ncl, 0), sz(ncl, 0), sn(ncl, 0);
            for (size_t q = 0; q < cl.size(); ++q) if (cl[q] >= 0) { const int i = static_cast<int>(q % static_cast<size_t>(V.nx)), k = static_cast<int>(q / static_cast<size_t>(V.nx)); sx[cl[q]] += V.cx(i); sz[cl[q]] += V.cz(k); sn[cl[q]] += 1; }
            std::vector<int> idx(ncl);
            std::iota(idx.begin(), idx.end(), 0);
            std::sort(idx.begin(), idx.end(), [&](int a, int b) { return sn[a] > sn[b]; });
            const P2 a(sx[idx[0]] / sn[idx[0]], sz[idx[0]] / sn[idx[0]]), b(sx[idx[1]] / sn[idx[1]], sz[idx[1]] / sn[idx[1]]);
            if ((b - a).len() < 0.5) continue;
            P2 ax = (b - a).unit();
            if (ax.x < -1e-9 || (std::fabs(ax.x) < 1e-9 && ax.y < 0)) ax = ax * -1.0;
            passes.push_back({c, ax, static_cast<double>(area[static_cast<size_t>(c)])});
        }
        if (passes.empty()) return false;
        // one axis for the band: the largest passage's, snapped to the frame when within 5 degrees
        std::sort(passes.begin(), passes.end(), [](const Pass& a, const Pass& b) { return a.weight > b.weight; });
        P2 tAx = passes[0].axis;
        for (const P2& f : {P2(1, 0), P2(0, 1)}) if (std::fabs(tAx.dot(f)) > std::cos(rad(5.0))) tAx = f * (tAx.dot(f) > 0 ? 1.0 : -1.0);
        const P2 sAx(tAx.y, -tAx.x);  // horizontal, perpendicular
        // the band's rectangle in (s, t) from the top's occupancy, snapped to the planes facing along the axes
        std::vector<double> ss, ts;
        for (int k = 0; k < top.nz; ++k) for (int i = 0; i < top.nx; ++i) if (top.v[top.id(i, k)]) { const P2 p(top.cx(i), top.cz(k)); ss.push_back(sAx.dot(p)); ts.push_back(tAx.dot(p)); }
        if (ss.size() < 20) return false;
        std::sort(ss.begin(), ss.end());
        std::sort(ts.begin(), ts.end());
        double sMin = ss[static_cast<size_t>(0.002 * (ss.size() - 1))] - 0.5 * P.cellM, sMax = ss[static_cast<size_t>(0.998 * (ss.size() - 1))] + 0.5 * P.cellM;
        double tMin = ts[static_cast<size_t>(0.002 * (ts.size() - 1))] - 0.5 * P.cellM, tMax = ts[static_cast<size_t>(0.998 * (ts.size() - 1))] + 0.5 * P.cellM;
        auto snap = [&](double& v, const P2& outward) {
            double bestArea = 0, best = v;
            for (const auto& r : regions) {
                P2 m; double c;
                if (!planeTrace(r, 0.5 * (y0 + y1), m, c) || r.hi.y < y0 + 0.05 || r.lo.y > y1 - 0.05) continue;
                if (m.dot(outward) < std::cos(rad(P.snapAngleDeg)) || std::fabs(c - v * m.dot(outward)) > P.snapOffsetM) continue;
                if (r.area > bestArea) { bestArea = r.area; best = c * m.dot(outward); }
            }
            v = best;
        };
        {
            // each side where the scan's own samples put the wall (the outermost face holding a fifth of the side), the
            // grown plane nearest it when there are none
            auto side = [&](double& v, const P2& axis, double sign, double lo, double hi, const P2& other) {
                const P2 m = axis * sign;
                double got = 0;
                const double dir = P2(-m.y, m.x).dot(other);  // the wall's own direction against the other axis: +1 or -1
                double a = dir * lo, b = dir * hi;
                if (a > b) std::swap(a, b);
                if (measureWall(m, sign * v, a, b, y0 + 0.25, y1 - 0.25, 0.6, got)) v = sign * got;
                else snap(v, m);
            };
            side(sMin, sAx, -1.0, tMin, tMax, tAx); side(sMax, sAx, 1.0, tMin, tMax, tAx);
            side(tMin, tAx, -1.0, sMin, sMax, sAx); side(tMax, tAx, 1.0, sMin, sMax, sAx);
        }
        // rectangular enough?
        size_t inRect = 0;
        for (size_t q = 0; q < ss.size(); ++q) (void)q;
        for (int k = 0; k < top.nz; ++k) for (int i = 0; i < top.nx; ++i) {
            if (!top.v[top.id(i, k)]) continue;
            const P2 p(top.cx(i), top.cz(k));
            const double s = sAx.dot(p), t = tAx.dot(p);
            inRect += s >= sMin - 0.1 && s <= sMax + 0.1 && t >= tMin - 0.1 && t <= tMax + 0.1;
        }
        const double rectArea = (sMax - sMin) * (tMax - tMin);
        if (rectArea <= 0 || ss.size() * P.cellM * P.cellM < 0.85 * rectArea || inRect < 0.97 * ss.size()) {
            debugRaster("passage_top", top);
            R.notes.push_back("a passage through the band from " + sj::num(std::round(y0 * 100) / 100) + " m is not fitted: the band is not a rectangle along the passage axis (its top covers " +
                              sj::num(std::round(ss.size() * P.cellM * P.cellM * 10) / 10) + " m2 of the " + sj::num(std::round(rectArea * 10) / 10) + " m2 rectangle, " + std::to_string(inRect) + " of " + std::to_string(ss.size()) + " cells inside it)");
            return false;
        }
        // supports and bays along s, from the middle occupancy within the rectangle's inner t range
        const int ns = static_cast<int>(std::ceil((sMax - sMin) / P.cellM));
        std::vector<int> colCount(ns, 0);
        for (int k = 0; k < F.nz; ++k) for (int i = 0; i < F.nx; ++i) {
            if (!F.v[F.id(i, k)]) continue;
            const P2 p(F.cx(i), F.cz(k));
            const double s = sAx.dot(p), t = tAx.dot(p);
            if (t < tMin + 0.2 || t > tMax - 0.2 || s < sMin || s > sMax) continue;
            ++colCount[std::clamp(static_cast<int>((s - sMin) / P.cellM), 0, ns - 1)];
        }
        struct Run { int a, b; bool solid; };
        std::vector<Run> runs;
        for (int i = 0; i < ns;) {
            const bool solid = colCount[i] > 0;
            int j = i;
            while (j < ns && (colCount[j] > 0) == solid) ++j;
            runs.push_back({i, j, solid});
            i = j;
        }
        // void runs strictly inside (between solid runs) are bays
        std::vector<Bay> bays;
        std::vector<std::pair<double, double>> supports;
        for (size_t r = 0; r < runs.size(); ++r) {
            const double sa = sMin + runs[r].a * P.cellM, sb = sMin + runs[r].b * P.cellM;
            if (runs[r].solid) { supports.push_back({sa, sb}); continue; }
            if (r == 0 || r + 1 == runs.size()) continue;
            if (sb - sa < 0.5) continue;
            Bay b;
            b.sL = sa; b.sR = sb;
            bays.push_back(b);
        }
        if (bays.empty()) return false;
        // jambs: snap each bay side to the vertical plane facing into the bay
        for (auto& b : bays) {
            auto snapSide = [&](double& v, const P2& facing) {
                // the jamb faces into the bay: the outermost face (the one reaching furthest into the bay) holding a fifth of it
                double got = 0;
                const P2 other = tAx;
                const double dir = P2(-facing.y, facing.x).dot(other);
                double a = dir * (tMin + 0.2), b2 = dir * (tMax - 0.2);
                if (a > b2) std::swap(a, b2);
                if (measureWall(facing, facing.dot(sAx) * v, a, b2, y0 + 0.3, y0 + std::min(0.5 * (y1 - y0), 8.0), 0.5, got)) { v = facing.dot(sAx) * got; return; }
                double bestArea = 0, best = v;
                for (const auto& r : regions) {
                    P2 m; double c;
                    if (!planeTrace(r, 0.5 * (y0 + y1), m, c) || r.hi.y < y0 + 0.5 || r.lo.y > y1 - 0.5) continue;
                    if (m.dot(facing) < std::cos(rad(P.snapAngleDeg)) || std::fabs(c - v * m.dot(facing)) > 0.25) continue;
                    if (r.area > bestArea) { bestArea = r.area; best = c * m.dot(facing); }
                }
                v = best;
            };
            snapSide(b.sL, sAx); snapSide(b.sR, sAx * -1.0);
        }
        // each bay's top: the lowest slice height where its middle becomes solid, then its soffit circle or lintel
        const P2 tMidP = tAx * (0.5 * (tMin + tMax));
        for (size_t bi = 0; bi < bays.size(); ++bi) {
            Bay& b = bays[bi];
            const double sC = 0.5 * (b.sL + b.sR), w = b.sR - b.sL;
            double ySolid = y1;
            for (double h = y0 + 0.25; h < y1; h += 0.25) {
                const sg::Raster o = occAt(h);
                const P2 c = sAx * sC + tMidP;
                if (o.at(o.ix(c.x), o.iz(c.y))) { ySolid = h; break; }
            }
            // springing: where the sides stop being open (the bay's side cells become solid lower than the crown)
            double ySpring = ySolid;
            for (double h = y0 + 0.25; h < ySolid; h += 0.25) {
                const sg::Raster o = occAt(h);
                const P2 cl = sAx * (b.sL + 0.1 * w) + tMidP, cr = sAx * (b.sR - 0.1 * w) + tMidP;
                if (o.at(o.ix(cl.x), o.iz(cl.y)) || o.at(o.ix(cr.x), o.iz(cr.y))) { ySpring = h; break; }
            }
            // soffit samples (s, y): above the springing less the margin, inside the bay, facing down or into it
            std::vector<std::array<double, 3>> soff;
            for (size_t i = 0; i < S.size(); ++i) {
                if (sGround[i]) continue;
                const auto& q = S[i];
                const P2 pp(q.p.x, q.p.z);
                const double s = sAx.dot(pp), t = tAx.dot(pp);
                if (s < b.sL - 0.3 || s > b.sR + 0.3 || t < tMin + 0.15 || t > tMax - 0.15) continue;
                if (q.p.y < ySpring - P.soffitMarginM || q.p.y > y1 - 0.05) continue;
                const P2 nh(q.n.x, q.n.z);
                const double toward = (sC - s) * sAx.dot(nh);
                if (!(q.n.y < -0.15f || (std::fabs(sC - s) > 0.5 && toward > 0.5 * std::fabs(sC - s)))) continue;
                if (s > b.sL + 0.05 && s < b.sR - 0.05 && q.p.y < ySpring - 0.4) continue;
                soff.push_back({s, q.p.y, q.w});
            }
            // the arch only above the springing less the margin
            std::vector<std::array<double, 3>> arcPts;
            for (const auto& q : soff) if (q[1] > ySpring - P.soffitMarginM) arcPts.push_back(q);
            b.soffit = arcPts;
            sg::Circle c;
            std::vector<std::array<double, 3>> work = arcPts;
            const bool fitted = work.size() >= 8 && sg::circleRansac(work, c, 0.10, 0.25 * w, 3.0 * w, 1000 + bi) && sg::circleRansac(work, c, 0.06, 0.25 * w, 3.0 * w, 2000 + bi);
            double amin = 1e9, amax = -1e9;
            if (fitted) for (const auto& q : work) { const double a = deg(std::atan2(q[1] - c.cy, q[0] - c.cx)); amin = std::min(amin, a); amax = std::max(amax, a); }
            const bool isArch = fitted && amax - amin >= 30 && std::fabs(c.cx - sC) < 0.25 * w && c.cy + c.r > ySpring;
            if (isArch) {
                b.arch = true;
                b.circ = c;
                b.samples = work.size();
                b.coverageDeg = amax - amin;
                b.rms = sg::circleRms(work, c);
                // springing on each jamb: where the circle meets it
                auto meet = [&](double s) { const double d = s - c.cx; return d * d < c.r * c.r ? c.cy + std::sqrt(c.r * c.r - d * d) : c.cy; };
                b.yL = meet(b.sL); b.yR = meet(b.sR);
                b.yTop = c.cy + c.r;
                // alternatives: the semicircle on the jambs (centre at mid-span, r = half span; only its height free)
                sg::Circle semi{sC, ySpring, 0.5 * w};
                {
                    double num = 0, W2 = 0;
                    for (const auto& q : work) { const double dx = q[0] - sC; num += q[1] - std::sqrt(std::max(0.0, semi.r * semi.r - dx * dx)); W2 += 1; }
                    semi.cy = W2 > 0 ? num / W2 : ySpring;
                    sg::circleGN(work, semi, 2);
                }
                b.semicircle = semi;
                b.semiRms = sg::circleRms(work, semi);
                b.rho = (b.yTop - 0.5 * (b.yL + b.yR)) / w;
            } else {
                // a flat lintel: the downward faces over the bay
                std::vector<double> ys;
                for (const auto& q : soff) if (q[0] > b.sL + 0.1 && q[0] < b.sR - 0.1) ys.push_back(q[1]);
                std::sort(ys.begin(), ys.end());
                const double yl = ys.empty() ? ySolid : ys[ys.size() / 2];
                b.arch = false;
                b.yL = b.yR = b.yTop = std::min(yl, y1 - 0.1);
                double S2 = 0, W2 = 0;
                for (const auto& q : soff) if (q[0] > b.sL + 0.1 && q[0] < b.sR - 0.1) { S2 += q[2] * (q[1] - yl) * (q[1] - yl); W2 += q[2]; }
                b.rms = W2 > 0 ? std::sqrt(S2 / W2) : 0;
                b.samples = ys.size();
            }
        }
        // the primitive: one per band, its parameters per bay (6 + 1 each), and its corrections
        buildPassageSweep(y0, y1, sAx, tAx, sMin, sMax, tMin, tMax, bays, supports, F, order);
        if (lowest) {
            // the band's plan: its rectangle along the passage axis, less the bays (the passage is open at both ends, so it is no hole)
            Loop L;
            for (const auto& q : {std::pair<double, double>{sMin, tMin}, {sMax, tMin}, {sMax, tMax}, {sMin, tMax}}) { L.pts.push_back(sAx * q.first + tAx * q.second); L.bulge.push_back(0); }
            R.footprint.push_back(L);
            R.footprintHoles.emplace_back();
        }
        return true;
    }

    void buildPassageSweep(double y0, double y1, const P2& sAx, const P2& tAx, double sMin, double sMax, double tMin, double tMax,
                           std::vector<Bay>& bays, const std::vector<std::pair<double, double>>& supports, const sg::Raster& F, int& order) {
        const int pi = newPrimitive("elevation swept along a passage");
        const std::string pid = R.prims[static_cast<size_t>(pi)].id;
        const auto ov = P.overrides.find(pid);
        // tolerance for corrections: min(0.5 leaf error, max(3 fit rms, photo resolution)), never over 0.31 m
        for (size_t bi = 0; bi < bays.size(); ++bi) {
            Bay& b = bays[bi];
            if (!b.arch) continue;
            const int paramRho = static_cast<int>(bi) * 7 + 6;
            if (ov != P.overrides.end() && ov->second.count(paramRho)) {
                const double rho = ov->second.at(paramRho);
                const sg::Circle c = constrainedArch(b, rho);
                b.circ = c;
                auto meet = [&](double s) { const double d = s - c.cx; return d * d < c.r * c.r ? c.cy + std::sqrt(c.r * c.r - d * d) : c.cy; };
                b.yL = meet(b.sL); b.yR = meet(b.sR); b.yTop = c.cy + c.r;
                b.rms = sg::circleRms(b.soffit, c);
                b.rho = rho;
                b.corrected = "rise/span set to " + sj::num(rho);
            }
        }
        Primitive& pr = R.prims[static_cast<size_t>(pi)];
        pr.body = true;
        pr.method = "scan_fit: the band's elevation (its rectangle less each bay, bays topped by a circle fitted to the soffit or a flat lintel) swept along the passage axis";
        // elevation polygon (s, y), counter-clockwise: bottom left to right with the bays' notches, then up and back
        std::vector<P2> E{P2(sMin, y0)};
        std::vector<std::array<size_t, 2>> arcRange(bays.size(), {0, 0});
        // supports between bays that are columns (circular in plan) open the notch below their tops
        std::vector<int> colBetween(bays.size() + 1, -1);
        for (size_t bi = 0; bi + 1 < bays.size(); ++bi) {
            const double a = bays[bi].sR, c = bays[bi + 1].sL;
            // the plan between them: a circle?
            sg::Raster sub = F;
            for (int k = 0; k < sub.nz; ++k) for (int i = 0; i < sub.nx; ++i) {
                const P2 p(sub.cx(i), sub.cz(k));
                const double s = sAx.dot(p), t = tAx.dot(p);
                if (s < a - 0.1 || s > c + 0.1 || t < tMin - 0.2 || t > tMax + 0.2) sub.v[sub.id(i, k)] = 0;
            }
            const auto L = loopsOf(sub);
            sg::Circle cc;
            if (L.size() == 1 && L[0].second.empty() && circleLoop(L[0].first.pts, cc)) colBetween[bi + 1] = 1;
            if (colBetween[bi + 1] == 1) {
                ColumnSpec col;
                col.centre = P2(cc.cx, cc.cy);
                col.y0 = y0; col.y1 = std::min(bays[bi].yR, bays[bi + 1].yL);
                col.rTrace = cc.r;
                pendingColumns.push_back(col);
            }
        }
        for (size_t bi = 0; bi < bays.size(); ++bi) {
            const Bay& b = bays[bi];
            const bool openLeft = bi > 0 && colBetween[bi] == 1;
            const bool openRight = bi + 1 < bays.size() && colBetween[bi + 1] == 1;
            if (!openLeft) { E.push_back(P2(b.sL, y0)); E.push_back(P2(b.sL, b.yL)); }
            else {
                // across the column's top from the previous bay's right springing
                const double yCap = std::min(bays[bi - 1].yR, b.yL);
                E.push_back(P2(bays[bi - 1].sR, yCap));
                E.push_back(P2(b.sL, yCap));
                if (b.yL > yCap + 1e-6) E.push_back(P2(b.sL, b.yL));
            }
            const size_t a0 = E.size() - 1;
            if (b.arch) {
                const double aL = std::atan2(b.yL - b.circ.cy, b.sL - b.circ.cx), aR = std::atan2(b.yR - b.circ.cy, b.sR - b.circ.cx);
                const double step = 2 * std::acos(std::max(-1.0, 1 - P.sagittaM / b.circ.r));
                const int n = std::max(4, static_cast<int>(std::ceil(std::fabs(aL - aR) / step)));
                for (int i = 1; i < n; ++i) { const double a = aL + (aR - aL) * i / n; E.push_back(P2(b.circ.cx + b.circ.r * std::cos(a), b.circ.cy + b.circ.r * std::sin(a))); }
                E.push_back(P2(b.sR, b.yR));
            } else {
                E.push_back(P2(b.sR, b.yR));
            }
            arcRange[bi] = {a0, E.size() - 1};
            if (!openRight) { E.push_back(P2(b.sR, y0)); }
            else if (b.yR > std::min(b.yR, bays[bi + 1].yL) + 1e-6) E.push_back(P2(b.sR, std::min(b.yR, bays[bi + 1].yL)));
        }
        E.push_back(P2(sMax, y0));
        E.push_back(P2(sMax, y1));
        E.push_back(P2(sMin, y1));
        // drop repeated points
        std::vector<P2> Ec;
        for (const auto& p : E) if (Ec.empty() || (p - Ec.back()).len() > 1e-6) Ec.push_back(p);
        if (Ec.size() > 1 && (Ec.front() - Ec.back()).len() < 1e-6) Ec.pop_back();
        E = Ec;
        pr.solid.kind = 1; pr.solid.outer = E; pr.solid.sAxis = sAx; pr.solid.tAxis = tAx; pr.solid.t0 = tMin; pr.solid.t1 = tMax;
        // spec: operator 1, the elevation polygon (u = s, v = y) swept along t from tMin to tMax
        {
            sj::Object prof;
            prof.raw("outer", polyJ(E));
            sj::Object carrier;
            const Vec3 c0(static_cast<float>(tAx.x * tMin), 0, static_cast<float>(tAx.y * tMin)), c1(static_cast<float>(tAx.x * tMax), 0, static_cast<float>(tAx.y * tMax));
            carrier.raw("points", "[" + v3j(c0) + "," + v3j(c1) + "]").b("closed", false).n("lengthM", tMax - tMin);
            sj::Object sw;
            sw.raw("carrier", "{\"path\":" + carrier.text() + "}").raw("profile", prof.text()).raw("profileUp", "[0,1,0]").n("miterLimit", 1).b("caps", true);
            pr.specJson = "{\"operator\":\"sweep\",\"sweep\":" + sw.text() + "}";
        }
        // parameters per bay: span, springing height, rise, radius, depth, centre offset, rise/span
        const double tol = std::min({0.5 * Q.limits.leafGeometricErrorM, 0.31});
        for (size_t bi = 0; bi < bays.size(); ++bi) {
            const Bay& b = bays[bi];
            const double w = b.sR - b.sL, ys = 0.5 * (b.yL + b.yR);
            const std::string tag = bays.size() > 1 ? " (bay " + std::to_string(bi + 1) + ")" : "";
            pr.fitParams.insert(pr.fitParams.end(), {w, ys, b.yTop - ys, b.arch ? b.circ.r : 0.0, tMax - tMin, b.arch ? b.circ.cx - 0.5 * (b.sL + b.sR) : 0.0, b.arch ? (b.yTop - ys) / w : 0.0});
            pr.fitParamMeta.insert(pr.fitParamMeta.end(), {{"m", "span" + tag}, {"m", "springing height (local)" + tag}, {"m", "rise" + tag}, {"m", "radius" + tag}, {"m", "depth" + tag},
                                                           {"m", "centre offset from mid-span" + tag}, {"ratio", "rise / span" + tag}});
            if (!b.arch) continue;
            pr.gates.push_back({"soffit circle rms" + tag, b.rms, 0.06, true, "m"});
            if (!b.corrected.empty()) { pr.corrected = true; pr.correctionNote += (pr.correctionNote.empty() ? "" : "; ") + b.corrected + tag; }
            // the residual curve of rise/span over [0.25, 0.65], every other circle parameter re-optimised
            Correctable cr;
            cr.param = static_cast<int>(bi) * 7 + 6;
            cr.key = "riseToSpan";
            cr.unit = "ratio";
            cr.description = "rise over span of the bay's arch" + tag + ", the circle through both springings";
            cr.value = b.rho;
            const double fitRms = sg::circleRms(b.soffit, b.circ);
            cr.toleranceM = std::min(tol, std::max(3 * fitRms, Q.limits.photoResolvableM > 0 ? Q.limits.photoResolvableM : 0.31));
            cr.toleranceM = std::min(cr.toleranceM, 0.31);
            for (int k = 25; k <= 65; ++k) {
                const double rho = k / 100.0;
                const sg::Circle c = constrainedArch(b, rho);
                cr.curve.push_back({rho, sg::circleRms(b.soffit, c)});
            }
            // the admissible range: the contiguous run of values around the fitted one within the tolerance
            int at = 0;
            double bestD = 1e9;
            for (size_t k = 0; k < cr.curve.size(); ++k) if (std::fabs(cr.curve[k][0] - b.rho) < bestD) { bestD = std::fabs(cr.curve[k][0] - b.rho); at = static_cast<int>(k); }
            int lo = at, hi = at;
            while (lo > 0 && cr.curve[static_cast<size_t>(lo - 1)][1] <= cr.toleranceM) --lo;
            while (hi + 1 < static_cast<int>(cr.curve.size()) && cr.curve[static_cast<size_t>(hi + 1)][1] <= cr.toleranceM) ++hi;
            cr.min = std::min(cr.curve[static_cast<size_t>(lo)][0], b.rho);
            cr.max = std::max(cr.curve[static_cast<size_t>(hi)][0], b.rho);
            pr.correctable.push_back(cr);
            // alternatives: the semicircle on the jambs, and the circle through the soffit's own scan vertices
            {
                Alternative alt;
                alt.fit = circleResidual(b.soffit, b.semicircle);
                alt.why = "the semicircle tangent to both jambs" + tag + " (centre at mid-span, radius half the span, only its height free): " + sj::num(std::round(alt.fit.rms * 1000) / 10) + " cm rms against the soffit";
                alt.specJson = arcSpecJson(b.semicircle, b, sAx, tAx, tMin, tMax);
                pr.alternatives.push_back(alt);
            }
            {
                // vertices of soffit triangles (they lie on the measured surface; facet interiors are chords)
                std::vector<std::array<double, 3>> vv;
                std::set<uint32_t> seen;
                const auto& sc = R.scan;
                for (size_t t = 0; t < sc.triangles(); ++t) {
                    if (isGround[t] || !ext[t]) continue;
                    const P2 c(lc[t].x, lc[t].z);
                    const double s = sAx.dot(c), tt = tAx.dot(c);
                    if (s < b.sL - 0.3 || s > b.sR + 0.3 || tt < tMin + 0.15 || tt > tMax - 0.15 || lc[t].y < b.yL - P.soffitMarginM || ln[t].y > -0.15f) continue;
                    for (int j = 0; j < 3; ++j) {
                        const uint32_t v = sc.tri[3 * t + j];
                        if (!seen.insert(v).second) continue;
                        const P2 q(lp[v].x, lp[v].z);
                        vv.push_back({sAx.dot(q), lp[v].y, 1.0});
                    }
                }
                sg::Circle jc;
                if (vv.size() >= 5 && sg::circleRansac(vv, jc, 0.08, 0.25 * w, 3.0 * w, 3000 + bi)) {
                    Alternative alt;
                    alt.fit = circleResidual(b.soffit, jc);
                    alt.why = "the circle through the soffit's scan vertices" + tag + " (" + std::to_string(vv.size()) + " inliers, r " + sj::num(std::round(jc.r * 1000) / 1000) + " m): " +
                              sj::num(std::round(alt.fit.rms * 1000) / 10) + " cm rms against the soffit";
                    alt.specJson = arcSpecJson(jc, b, sAx, tAx, tMin, tMax);
                    pr.alternatives.push_back(alt);
                }
            }
        }
        // surfaces: front and back faces (the elevation), the side walls, the top, every edge of the elevation swept along t
        const Frame& F0 = R.frame;
        auto L3 = [&](double s, double y, double t) {
            const P2 p = sAx * s + tAx * t;
            return Vec3(static_cast<float>(p.x), static_cast<float>(y), static_cast<float>(p.y));
        };
        const Vec3 tL(static_cast<float>(tAx.x), 0, static_cast<float>(tAx.y)), sL3(static_cast<float>(sAx.x), 0, static_cast<float>(sAx.y));
        for (int face = 0; face < 2; ++face) {
            const double t = face ? tMax : tMin;
            const int si = newSurface(pi, face ? "face along +t" : "face along -t");
            Surface& s = R.surfaces[static_cast<size_t>(si)];
            std::vector<P2> verts;
            const auto tri = sg::triangulate(E, {}, verts);
            const Vec3 n = face ? tL : tL * -1.0f;
            const uint32_t base = static_cast<uint32_t>(s.lpos.size());
            for (const auto& p : verts) { s.lpos.push_back(L3(p.x, p.y, t)); s.lnrm.push_back(n); }
            for (size_t i = 0; i + 2 < tri.size(); i += 3) {
                const Vec3 fn = (s.lpos[base + tri[i + 1]] - s.lpos[base + tri[i]]).cross(s.lpos[base + tri[i + 2]] - s.lpos[base + tri[i]]);
                if (fn.dot(n) >= 0) s.tri.insert(s.tri.end(), {base + tri[i], base + tri[i + 1], base + tri[i + 2]});
                else s.tri.insert(s.tri.end(), {base + tri[i], base + tri[i + 2], base + tri[i + 1]});
            }
            // chart: u along s seen from outside, v up
            Vec3 u = sL3;
            Vec3 org = L3(sMin, 0, t);
            std::vector<P2> ext;
            if (Vec3(0, 1, 0).cross(u).dot(n) > 0) { u = u * -1.0f; org = L3(sMax, 0, t); for (const auto& p : E) ext.push_back(P2(sMax - p.x, p.y)); }
            else for (const auto& p : E) ext.push_back(P2(p.x - sMin, p.y));
            planeChartFromQuad(s, org, u, Vec3(0, 1, 0), n, ext);
        }
        // each edge of E swept along t; consecutive arc edges of a bay make one cylinder
        const size_t n = E.size();
        std::vector<int> edgeBay(n, -1);
        for (size_t bi = 0; bi < bays.size(); ++bi) if (bays[bi].arch) for (size_t k = arcRange[bi][0]; k < arcRange[bi][1]; ++k) edgeBay[k] = static_cast<int>(bi);
        for (size_t k = 0; k < n;) {
            const P2 a = E[k], b2 = E[(k + 1) % n];
            if (edgeBay[k] >= 0) {
                const int bi = edgeBay[k];
                const Bay& b = bays[static_cast<size_t>(bi)];
                const int si = newSurface(pi, "soffit");
                Surface& s = R.surfaces[static_cast<size_t>(si)];
                size_t k2 = k;
                while (k2 < n && edgeBay[k2] == bi) {
                    const P2 p0 = E[k2], p1 = E[(k2 + 1) % n];
                    const P2 mm = (p0 + p1) * 0.5;
                    const P2 rd = (P2(b.circ.cx, b.circ.cy) - mm).unit();  // toward the axis (the soffit faces it)
                    const Vec3 nn = sL3 * static_cast<float>(rd.x) + Vec3(0, static_cast<float>(rd.y), 0);
                    quad(s, L3(p0.x, p0.y, tMin), L3(p1.x, p1.y, tMin), L3(p1.x, p1.y, tMax), L3(p0.x, p0.y, tMax), nn);
                    pr.creases.push_back({L3(p0.x, p0.y, tMin), L3(p1.x, p1.y, tMin)});
                    pr.creases.push_back({L3(p0.x, p0.y, tMax), L3(p1.x, p1.y, tMax)});
                    ++k2;
                }
                s.kind = ChartKind::Cylinder;
                s.axisOrigin = F0.toWorld(L3(b.circ.cx, b.circ.cy, tMin));
                s.axisDir = F0.dirToWorld(tL);
                const double aL = std::atan2(b.yL - b.circ.cy, b.sL - b.circ.cx), aR = std::atan2(b.yR - b.circ.cy, b.sR - b.circ.cx);
                s.thetaZeroDir = F0.dirToWorld(sL3 * static_cast<float>(std::cos(aR)) + Vec3(0, static_cast<float>(std::sin(aR)), 0));
                s.radius = b.circ.r;
                s.th0 = 0; s.th1 = deg(aL - aR);
                if (s.th1 < 0) s.th1 += 360;
                s.z0 = 0; s.z1 = tMax - tMin;
                s.normalSign = -1;
                k = k2;
                continue;
            }
            const P2 d = b2 - a;
            const double len = d.len();
            if (len > 1e-5) {
                P2 nn(d.y / len, -d.x / len);  // right of travel for a counter-clockwise polygon: outward
                const P2 mid = (a + b2) * 0.5 + nn * 0.01;
                if (sg::insidePolygon(E, mid.x, mid.y)) nn = nn * -1.0;
                const Vec3 nL = sL3 * static_cast<float>(nn.x) + Vec3(0, static_cast<float>(nn.y), 0);
                const bool horiz = std::fabs(nn.y) > 0.99;
                const int si = newSurface(pi, horiz ? (nn.y > 0 ? "top" : "underside") : "wall");
                Surface& s = R.surfaces[static_cast<size_t>(si)];
                quad(s, L3(a.x, a.y, tMin), L3(b2.x, b2.y, tMin), L3(b2.x, b2.y, tMax), L3(a.x, a.y, tMax), nL);
                // chart: u along t (seen from outside: u x v = n), v along the edge
                const Vec3 ev = (L3(b2.x, b2.y, 0) - L3(a.x, a.y, 0)) * static_cast<float>(1.0 / len);
                Vec3 u = tL;
                Vec3 org = L3(a.x, a.y, tMin);
                if (u.cross(ev).dot(nL) < 0) { u = u * -1.0f; org = L3(a.x, a.y, tMax); }
                planeChartFromQuad(s, org, u, ev, nL, {{0, 0}, {tMax - tMin, 0}, {tMax - tMin, len}, {0, len}});
                pr.creases.push_back({L3(a.x, a.y, tMin), L3(b2.x, b2.y, tMin)});
                pr.creases.push_back({L3(a.x, a.y, tMax), L3(b2.x, b2.y, tMax)});
                pr.creases.push_back({L3(a.x, a.y, tMin), L3(a.x, a.y, tMax)});
            }
            ++k;
        }
        ++order;
        for (const auto& c : pendingColumns) addColumn(c, order);
        pendingColumns.clear();
        passageInfo.push_back({pi, sAx, tAx, sMin, sMax, tMin, tMax, y0, y1, bays});
    }

    std::vector<ColumnSpec> pendingColumns;
    struct PassageInfo { int prim; P2 sAx, tAx; double sMin, sMax, tMin, tMax, y0, y1; std::vector<Bay> bays; };
    std::vector<PassageInfo> passageInfo;
    int primSerial{0};   // primitive ids are never reused, so grouping primitives leaves the others' ids as they were


    /**
     * Operator 3: three or more columns of one radius and height at an equal pitch along a line are one replicated primitive
     * with the measured pitch and count (the seed is the first column's revolve). The others' surfaces are the primitive's.
     */
    void groupColumns() {
        std::vector<int> cols;
        for (size_t i = 0; i < R.prims.size(); ++i) if (R.prims[i].solid.kind == 2 && R.prims[i].accepted && R.prims[i].fitParams.size() >= 5) cols.push_back(static_cast<int>(i));
        std::vector<uint8_t> used(R.prims.size(), 0);
        std::vector<int> remap(R.prims.size());
        std::iota(remap.begin(), remap.end(), 0);
        std::vector<uint8_t> removed(R.prims.size(), 0);
        auto centre = [&](int i) { return P2(R.prims[static_cast<size_t>(i)].fitParams[0], R.prims[static_cast<size_t>(i)].fitParams[1]); };
        auto similar = [&](int a, int b) {
            const auto &pa = R.prims[static_cast<size_t>(a)].fitParams, &pb = R.prims[static_cast<size_t>(b)].fitParams;
            return std::fabs(pa[4] - pb[4]) <= 0.02 && std::fabs(pa[2] - pb[2]) <= 0.03 && std::fabs(pa[3] - pb[3]) <= 0.03;
        };
        for (;;) {
            std::vector<int> best;
            P2 bestDir;
            double bestPitch = 0;
            for (size_t ia = 0; ia < cols.size(); ++ia) for (size_t ib = ia + 1; ib < cols.size(); ++ib) {
                const int a = cols[ia], b = cols[ib];
                if (used[static_cast<size_t>(a)] || used[static_cast<size_t>(b)] || !similar(a, b)) continue;
                const P2 d = centre(b) - centre(a);
                const double pitch = d.len();
                if (pitch < 0.5) continue;
                const P2 u = d * (1.0 / pitch);
                std::vector<std::pair<double, int>> on;
                for (int c : cols) {
                    if (used[static_cast<size_t>(c)] || !similar(a, c)) continue;
                    const P2 q = centre(c) - centre(a);
                    const double along = q.dot(u), across = std::fabs(q.cross(u));
                    if (across > 0.03) continue;
                    const double k = along / pitch;
                    if (std::fabs(k - std::round(k)) * pitch > 0.03) continue;
                    on.push_back({along, c});
                }
                std::sort(on.begin(), on.end());
                if (on.size() > best.size()) { best.clear(); for (const auto& o : on) best.push_back(o.second); bestDir = u; bestPitch = pitch; }
            }
            if (best.size() < 3) break;
            // equal spacing: every gap within 3 cm of the median
            std::vector<double> gaps;
            for (size_t i = 1; i < best.size(); ++i) gaps.push_back((centre(best[i]) - centre(best[i - 1])).len());
            std::vector<double> sorted = gaps;
            std::sort(sorted.begin(), sorted.end());
            const double pitch = sorted[sorted.size() / 2];
            bool equal = true;
            for (double g : gaps) equal = equal && std::fabs(g - pitch) <= 0.03 + 0.0 * bestPitch;
            for (int c : best) used[static_cast<size_t>(c)] = 1;
            if (!equal) continue;
            const int keep = best.front();
            Primitive& K = R.prims[static_cast<size_t>(keep)];
            const P2 c0 = centre(best.front()), c1 = centre(best.back());
            const double span = (c1 - c0).len();
            // the replicate: the first column's revolve at the start, repeated along the line by the pitch
            const Vec3 a3(static_cast<float>(c0.x), static_cast<float>(K.fitParams[2]), static_cast<float>(c0.y)), b3(static_cast<float>(c1.x), static_cast<float>(K.fitParams[2]), static_cast<float>(c1.y));
            sj::Object car;
            car.raw("points", "[" + v3j(a3) + "," + v3j(b3) + "]").b("closed", false).n("lengthM", span);
            sj::Object along;
            along.raw("carrier", "{\"path\":" + car.text() + "}").n("pitchM", pitch).i("count", static_cast<long long>(best.size())).n("startOffsetM", 0);
            K.specJson = "{\"operator\":\"replicate\",\"replicate\":{\"seed\":" + K.specJson + ",\"domain\":{\"along\":" + along.text() + "},\"alignToSurface\":false}}";
            K.label = "columns at an equal pitch";
            K.method = "scan_fit: " + std::to_string(best.size()) + " circular footprint runs of one radius and height at an equal pitch (" + sj::num(std::round(pitch * 1000) / 1000) + " m); r(z) from circles per 0.25 m; operator 3 over operator 2";
            double rms = 0;
            std::vector<std::pair<double, double>> dw;
            for (size_t i = 1; i < best.size(); ++i) {
                Primitive& O = R.prims[static_cast<size_t>(best[i])];
                K.surfaces.insert(K.surfaces.end(), O.surfaces.begin(), O.surfaces.end());
                for (int si : O.surfaces) R.surfaces[static_cast<size_t>(si)].prim = keep;
                K.moreSolids.push_back(O.solid);
                for (const auto& g : O.gates) K.gates.push_back({g.gate + " (" + O.id + ")", g.value, g.threshold, g.le, g.unit});
                removed[static_cast<size_t>(best[i])] = 1;
                remap[static_cast<size_t>(best[i])] = keep;
            }
            (void)rms; (void)dw;
            const double rMean = K.fitParams[4], base = K.fitParams[2], top = K.fitParams[3];
            K.fitParams = {pitch, static_cast<double>(best.size()), rMean, base, top};
            K.fitParamMeta = {{"m", "pitch"}, {"count", "number of columns"}, {"m", "mean radius"}, {"m", "base height (local)"}, {"m", "top height (local)"}};
        }
        // drop the merged-away primitives, renumbering the build order, and point everything at the new indices
        std::vector<int> newIndex(R.prims.size(), -1);
        std::vector<Primitive> kept;
        for (size_t i = 0; i < R.prims.size(); ++i) {
            if (removed[i]) continue;
            newIndex[i] = static_cast<int>(kept.size());
            kept.push_back(std::move(R.prims[i]));
            kept.back().buildOrder = static_cast<int>(kept.size()) - 1;
        }
        for (size_t i = 0; i < R.prims.size(); ++i) if (removed[i]) newIndex[i] = newIndex[static_cast<size_t>(remap[i])];
        for (auto& su : R.surfaces) su.prim = newIndex[static_cast<size_t>(su.prim)];
        for (auto& pi : passageInfo) pi.prim = newIndex[static_cast<size_t>(pi.prim)];
        for (auto& c : columnPrims) c = newIndex[static_cast<size_t>(c)];
        R.prims = std::move(kept);
    }

    static Residual circleResidual(const std::vector<std::array<double, 3>>& pts, const sg::Circle& c) {
        std::vector<std::pair<double, double>> dw;
        for (const auto& q : pts) dw.push_back({std::fabs(std::hypot(q[0] - c.cx, q[1] - c.cy) - c.r), q[2]});
        return sg::residualOf(dw, 0.07);
    }

    /** The arch of rise/span rho through both jambs (centre at mid-span), its springing height re-optimised. */
    sg::Circle constrainedArch(const Bay& b, double rho) const {
        const double w = b.sR - b.sL, h = rho * w;
        const double r = (w * w / 4 + h * h) / (2 * h);
        double ys = 0.5 * (b.yL + b.yR);
        sg::Circle c{0.5 * (b.sL + b.sR), ys + h - r, r};
        for (int it = 0; it < 30; ++it) {
            double g = 0, hh = 0;
            for (const auto& q : b.soffit) {
                const double dx = q[0] - c.cx, dy = q[1] - c.cy, rr = std::hypot(dx, dy);
                if (rr < 1e-9) continue;
                const double res = rr - c.r, J = -dy / rr;
                g += q[2] * J * res; hh += q[2] * J * J;
            }
            if (hh < 1e-12) break;
            const double step = g / hh;
            c.cy -= step;
            if (std::fabs(step) < 1e-9) break;
        }
        return c;
    }

    std::string arcSpecJson(const sg::Circle& c, const Bay& b, const P2& sAx, const P2& tAx, double tMin, double tMax) const {
        // the bay's soffit as an alternative: an arc of the circle between the jambs swept along the passage
        auto meet = [&](double s) { const double d = s - c.cx; return d * d < c.r * c.r ? c.cy + std::sqrt(c.r * c.r - d * d) : c.cy; };
        const double yl = meet(b.sL), yr = meet(b.sR);
        std::vector<P2> prof{P2(b.sL, yl - 0.01)};
        const double aL = std::atan2(yl - c.cy, b.sL - c.cx), aR = std::atan2(yr - c.cy, b.sR - c.cx);
        for (int i = 0; i <= 16; ++i) { const double a = aL + (aR - aL) * i / 16.0; prof.push_back(P2(c.cx + c.r * std::cos(a), c.cy + c.r * std::sin(a))); }
        prof.push_back(P2(b.sR, yr - 0.01));
        sj::Object carrier;
        const Vec3 c0(static_cast<float>(tAx.x * tMin), 0, static_cast<float>(tAx.y * tMin)), c1(static_cast<float>(tAx.x * tMax), 0, static_cast<float>(tAx.y * tMax));
        carrier.raw("points", "[" + v3j(c0) + "," + v3j(c1) + "]").b("closed", false).n("lengthM", tMax - tMin);
        sj::Object prof2;
        prof2.raw("outer", polyJ(prof));
        sj::Object sw;
        sw.raw("carrier", "{\"path\":" + carrier.text() + "}").raw("profile", prof2.text()).raw("profileUp", "[0,1,0]").n("miterLimit", 1).b("caps", false);
        (void)sAx;
        return "{\"operator\":\"sweep\",\"sweep\":" + sw.text() + "}";
    }

    // ---------------------------------------------------------------- the fitted mesh (local) and its queries
    std::vector<Vec3> fpos;          // all fitted triangles (local)
    std::vector<uint32_t> ftri;
    std::vector<int> ftriSurface;
    sg::TriGrid fgrid;

    void meshModel() {
        fpos.clear(); ftri.clear(); ftriSurface.clear();
        for (size_t si = 0; si < R.surfaces.size(); ++si) {
            const auto& s = R.surfaces[si];
            const uint32_t base = static_cast<uint32_t>(fpos.size());
            fpos.insert(fpos.end(), s.lpos.begin(), s.lpos.end());
            for (uint32_t v : s.tri) ftri.push_back(base + v);
            for (size_t t = 0; t < s.tri.size() / 3; ++t) ftriSurface.push_back(static_cast<int>(si));
        }
        fgrid.build(fpos, ftri, 1.0);
    }

    bool insideFitted(const Vec3& p) const {
        for (const auto& pr : R.prims) {
            if (!pr.body) continue;
            if (pr.solid.contains(p)) return true;
            for (const auto& so : pr.moreSolids) if (so.contains(p)) return true;
        }
        return false;
    }

    double distToFitted(const Vec3& p, int* surface = nullptr) const {
        if (ftri.empty()) { if (surface) *surface = -1; return std::numeric_limits<double>::infinity(); }
        auto [d, t] = fgrid.nearest(p, 3.0);
        if (t == UINT32_MAX) {
            // beyond the search: the exact nearest by brute force (rare: statues, far clutter)
            double best = std::numeric_limits<double>::infinity();
            uint32_t bt = 0;
            for (uint32_t k = 0; k < ftri.size() / 3; ++k) {
                const double dd = (sg::closestOnTriangle(p, fpos[ftri[3 * k]], fpos[ftri[3 * k + 1]], fpos[ftri[3 * k + 2]]) - p).length();
                if (dd < best) { best = dd; bt = k; }
            }
            d = best; t = bt;
        }
        if (surface) *surface = ftriSurface[t];
        return d;
    }

    // ---------------------------------------------------------------- 7. attachments (boxes) and pass-through
    std::vector<float> dS;  // per sample: distance to the fitted body (before boxes)
    std::vector<uint8_t> inPass;

    /**
     * Whatever the rebuild and the attachments leave unexplained, and is small, stays as the scan has it. A sample is a
     * leftover when it is not ground or clutter, not already kept as scanned, not buried inside a rebuilt solid, and farther from
     * every fitted surface than the backed band (25 cm: the rebuild's own test of whether a fitted face has scan behind it).
     * Within that band the sample has a fitted face to be measured against, and its error is what the rms and Hausdorff gates
     * judge; beyond it nothing fitted answers for it at all.
     * Leftovers are grouped into connected fragments (a 0.25 m voxel grid, 26-connected); a fragment of at most
     * fragmentMaxAreaM2 is kept as scanned, the smallest first, while the fragments kept stay within fragmentMaxShare of the
     * structure's visible surface. Kept as scanned they are exact (they are the scan), count in the pass share and the coverage,
     * and leave the Hausdorff, which measures the fitted parts. A region larger than a fragment, or past the share, is not
     * explained by the fit: it stays in the Hausdorff and rejects the fit.
     */
    void keepLeftoverFragments(std::vector<std::vector<uint32_t>>& passSlabs, std::vector<std::string>& passWhy, std::vector<std::map<std::string, double>>& passTest) {
        if (ftri.empty()) return;
        std::vector<uint8_t> taken(S.size(), 0);
        for (const auto& sl : passSlabs) for (uint32_t k : sl) taken[k] = 1;
        std::vector<float> dd(S.size(), 0);
        sg::parallelFor(S.size(), [&](size_t i) { dd[i] = static_cast<float>(distToFitted(S[i].p)); });
        double visArea = 0;
        std::vector<uint32_t> left;
        for (size_t i = 0; i < S.size(); ++i) {
            if (sGround[i]) continue;
            visArea += S[i].w;
            if (taken[i] || dd[i] <= P.backedBandM || insideFitted(S[i].p)) continue;
            left.push_back(static_cast<uint32_t>(i));
        }
        if (left.empty()) return;
        const float vox = 0.25f;
        std::map<std::array<int, 3>, std::vector<uint32_t>> vg;
        for (uint32_t i : left) vg[{(int)std::floor(S[i].p.x / vox), (int)std::floor(S[i].p.y / vox), (int)std::floor(S[i].p.z / vox)}].push_back(i);
        std::set<std::array<int, 3>> seen;
        struct Frag { std::vector<uint32_t> idx; double area{0}, dmin{1e30}, dmax{0}; };
        std::vector<Frag> frags;
        for (const auto& [key, _] : vg) {
            if (seen.count(key)) continue;
            Frag fr;
            std::vector<std::array<int, 3>> st{key};
            seen.insert(key);
            while (!st.empty()) {
                const auto k = st.back();
                st.pop_back();
                for (uint32_t i : vg[k]) { fr.idx.push_back(i); fr.area += S[i].w; fr.dmin = std::min(fr.dmin, (double)dd[i]); fr.dmax = std::max(fr.dmax, (double)dd[i]); }
                for (int dx = -1; dx <= 1; ++dx) for (int dy = -1; dy <= 1; ++dy) for (int dz = -1; dz <= 1; ++dz) {
                    const std::array<int, 3> q{k[0] + dx, k[1] + dy, k[2] + dz};
                    if (vg.count(q) && !seen.count(q)) { seen.insert(q); st.push_back(q); }
                }
            }
            frags.push_back(std::move(fr));
        }
        std::sort(frags.begin(), frags.end(), [](const Frag& a, const Frag& b) { return a.area < b.area; });
        double kept = 0;
        for (auto& fr : frags) {
            if (fr.area > P.fragmentMaxAreaM2 || kept + fr.area > P.fragmentMaxShare * visArea) break;
            kept += fr.area;
            passSlabs.push_back(fr.idx);
            passWhy.push_back("a fragment no primitive explains (" + sj::num(std::round(fr.area * 100) / 100) + " m2, " + sj::num(std::round(fr.dmin * 100) / 100) + " to " + sj::num(std::round(fr.dmax * 100) / 100) + " m from the fit): kept as scanned");
            passTest.push_back({{"areaM2", fr.area}, {"minDistanceM", fr.dmin}, {"maxDistanceM", fr.dmax}});
        }
    }

    void residualsToBoxes() {
        dS.assign(S.size(), 0);
        sg::parallelFor(S.size(), [&](size_t i) { dS[i] = static_cast<float>(distToFitted(S[i].p)); });
        std::vector<uint32_t> res;
        for (size_t i = 0; i < S.size(); ++i) {
            if (sGround[i]) continue;
            const bool in = insideFitted(S[i].p);
            if ((!in && dS[i] > P.residualOutsideM) || (in && dS[i] > P.residualInsideM)) res.push_back(static_cast<uint32_t>(i));
        }
        // clusters on a 0.25 m voxel grid (26-connected)
        const float vox = 0.25f;
        std::map<std::array<int, 3>, std::vector<uint32_t>> vg;
        for (uint32_t i : res) vg[{(int)std::floor(S[i].p.x / vox), (int)std::floor(S[i].p.y / vox), (int)std::floor(S[i].p.z / vox)}].push_back(i);
        std::map<std::array<int, 3>, int> vlab;
        std::vector<std::vector<uint32_t>> clusters;
        for (const auto& [key, _] : vg) {
            if (vlab.count(key)) continue;
            const int id = static_cast<int>(clusters.size());
            clusters.emplace_back();
            std::vector<std::array<int, 3>> st{key};
            vlab[key] = id;
            while (!st.empty()) {
                const auto k = st.back();
                st.pop_back();
                for (uint32_t i : vg[k]) clusters[static_cast<size_t>(id)].push_back(i);
                for (int dx = -1; dx <= 1; ++dx) for (int dy = -1; dy <= 1; ++dy) for (int dz = -1; dz <= 1; ++dz) {
                    const std::array<int, 3> q{k[0] + dx, k[1] + dy, k[2] + dz};
                    if (vg.count(q) && !vlab.count(q)) { vlab[q] = id; st.push_back(q); }
                }
            }
        }
        inPass.assign(S.size(), 0);
        std::vector<std::vector<uint32_t>> passSlabs;
        std::vector<std::string> passWhy;
        std::vector<std::map<std::string, double>> passTest;
        const Vec3 ax6[6] = {{-1, 0, 0}, {1, 0, 0}, {0, -1, 0}, {0, 1, 0}, {0, 0, -1}, {0, 0, 1}};
        sg::ScratchboxMesh coreMesh = sg::toMesh(fpos, ftri);
        bvh::BvhTree coreTree;
        if (!ftri.empty()) coreTree.build(coreMesh);
        int boxOrder = 0;
        struct BoxRec { Vec3 lo, hi; double rms, inl, area; std::string faces, snapped; double support; std::array<double, 6> faceSupport; std::array<uint8_t, 6> measured; std::array<uint8_t, 6> contact; };
        std::vector<BoxRec> boxes;
        for (const auto& cl : clusters) {
            double A = 0, dmax = 0;
            for (uint32_t i : cl) { A += S[i].w; dmax = std::max(dmax, (double)dS[i]); }
            if (A < 0.25 || dmax < P.attachMinM) continue;
            std::map<int, double> hh;
            for (uint32_t i : cl) if (std::fabs(S[i].n.y) > 0.97f) hh[(int)std::lround(S[i].p.y / 0.03f)] += S[i].w;
            std::vector<float> cuts;
            for (const auto& [k, w] : hh) {
                const double w3 = w + (hh.count(k - 1) ? hh.at(k - 1) : 0) + (hh.count(k + 1) ? hh.at(k + 1) : 0);
                const bool peak = (!hh.count(k - 1) || hh.at(k - 1) <= w) && (!hh.count(k + 1) || hh.at(k + 1) < w);
                if (peak && w3 >= 0.08) cuts.push_back(k * 0.03f);
            }
            float ylo = 1e9f, yhi = -1e9f;
            for (uint32_t i : cl) { ylo = std::min(ylo, S[i].p.y); yhi = std::max(yhi, S[i].p.y); }
            std::vector<float> ys{ylo};
            for (float y : cuts) if (y > ylo + 0.06f && y < yhi - 0.06f) ys.push_back(y);
            ys.push_back(yhi);
            std::sort(ys.begin(), ys.end());
            for (size_t sIdx = 0; sIdx + 1 < ys.size(); ++sIdx) {
                const float y0 = ys[sIdx], y1 = ys[sIdx + 1];
                std::vector<uint32_t> slab;
                for (uint32_t i : cl) {
                    const float y = S[i].p.y;
                    if (std::fabs(S[i].n.y) > 0.97f) {
                        if (S[i].n.y > 0 && std::fabs(y - y1) < 0.05f) slab.push_back(i);
                        else if (S[i].n.y < 0 && std::fabs(y - y0) < 0.05f) slab.push_back(i);
                        else if (y > y0 + 0.05f && y < y1 - 0.05f) slab.push_back(i);
                    } else if (y >= y0 - 1e-3f && y <= y1 + 1e-3f) slab.push_back(i);
                }
                double SA = 0;
                for (uint32_t i : slab) SA += S[i].w;
                if (SA < 0.08) continue;
                const bool cutBelow = y0 > ylo + 0.05f, cutAbove = y1 < yhi - 0.05f;
                Vec3 lo, hi;
                std::string faces;
                std::array<uint8_t, 6> measured{};
                std::vector<uint32_t> cur = slab;
                for (int iter = 0; iter < 3; ++iter) {
                    faces.clear();
                    measured.fill(0);
                    for (int f = 0; f < 6; ++f) {
                        const int a = f / 2;
                        auto comp = [&](const Vec3& p) { return a == 0 ? p.x : a == 1 ? p.y : p.z; };
                        std::vector<std::pair<float, float>> cw;
                        for (uint32_t i : cur) if (S[i].n.dot(ax6[f]) > 0.9f) cw.push_back({comp(S[i].p), S[i].w});
                        double W = 0;
                        for (const auto& q : cw) W += q.second;
                        float v;
                        if (W >= 0.04) {
                            std::sort(cw.begin(), cw.end());
                            double acc = 0;
                            v = cw.front().first;
                            for (const auto& q : cw) { acc += q.second; if (acc >= 0.5 * W) { v = q.first; break; } }
                            faces += "xyz"[a];
                            faces += f % 2 ? '+' : '-';
                            measured[static_cast<size_t>(f)] = 1;
                        } else {
                            std::vector<float> all;
                            for (uint32_t i : cur) all.push_back(comp(S[i].p));
                            std::sort(all.begin(), all.end());
                            v = f % 2 ? all[static_cast<size_t>(0.99 * (all.size() - 1))] : all[static_cast<size_t>(0.01 * (all.size() - 1))];
                        }
                        float* dst = a == 0 ? (f % 2 ? &hi.x : &lo.x) : a == 1 ? (f % 2 ? &hi.y : &lo.y) : (f % 2 ? &hi.z : &lo.z);
                        *dst = v;
                    }
                    lo.y = std::max(lo.y, y0); hi.y = std::min(hi.y, y1);
                    if (lo.y < y0 + 0.05f) lo.y = y0;
                    if (hi.y > y1 - 0.05f) hi.y = y1;
                    if (iter == 2) break;
                    std::vector<uint32_t> keep;
                    for (uint32_t i : slab) {
                        const Vec3& p = S[i].p;
                        const Vec3 q(std::clamp(p.x, lo.x, hi.x), std::clamp(p.y, lo.y, hi.y), std::clamp(p.z, lo.z, hi.z));
                        const float d = (p - q).length() > 0 ? (p - q).length() : std::min({p.x - lo.x, hi.x - p.x, p.y - lo.y, hi.y - p.y, p.z - lo.z, hi.z - p.z});
                        if (d < 0.15f) keep.push_back(i);
                    }
                    if (keep.size() < 20 || keep.size() == cur.size()) break;
                    cur.swap(keep);
                }
                const bool valid = hi.x - lo.x > 0.05f && hi.y - lo.y > 0.05f && hi.z - lo.z > 0.05f;
                std::string snapped;
                std::array<uint8_t, 6> contact{};
                if (valid && !ftri.empty()) {
                    for (int f = 0; f < 6; ++f) {
                        if (measured[static_cast<size_t>(f)]) continue;
                        const int a = f / 2;
                        Vec3 o = (lo + hi) * 0.5f;
                        float* comp = a == 0 ? &o.x : a == 1 ? &o.y : &o.z;
                        *comp = a == 0 ? (f % 2 ? hi.x : lo.x) : a == 1 ? (f % 2 ? hi.y : lo.y) : (f % 2 ? hi.z : lo.z);
                        math::Ray ray(o - ax6[f] * 0.02f, ax6[f]);
                        bvh::RayHit hit;
                        if (coreTree.raycast(ray, hit) && hit.t < 0.37f) {
                            const float v = a == 0 ? hit.position.x : a == 1 ? hit.position.y : hit.position.z;
                            (a == 0 ? (f % 2 ? hi.x : lo.x) : a == 1 ? (f % 2 ? hi.y : lo.y) : (f % 2 ? hi.z : lo.z)) = v;
                            snapped += "xyz"[a];
                            snapped += f % 2 ? '+' : '-';
                            contact[static_cast<size_t>(f)] = 1;
                        }
                    }
                }
                double S2 = 0, W = 0, Win = 0, Wall = 0;
                std::vector<uint32_t> outliers;
                std::array<double, 6> faceHit{};
                for (uint32_t i : slab) {
                    const Vec3& p = S[i].p;
                    const Vec3 q(std::clamp(p.x, lo.x, hi.x), std::clamp(p.y, lo.y, hi.y), std::clamp(p.z, lo.z, hi.z));
                    float d;
                    if ((p - q).length() > 0) d = (p - q).length();
                    else d = std::min({p.x - lo.x, hi.x - p.x, p.y - lo.y, hi.y - p.y, p.z - lo.z, hi.z - p.z});
                    Wall += S[i].w;
                    if (d < 0.15f) { S2 += S[i].w * d * d; W += S[i].w; } else outliers.push_back(i);
                    if (d < 0.10f) {
                        Win += S[i].w;
                        // the face it supports: the nearest one
                        const float fd[6] = {std::fabs(p.x - lo.x), std::fabs(p.x - hi.x), std::fabs(p.y - lo.y), std::fabs(p.y - hi.y), std::fabs(p.z - lo.z), std::fabs(p.z - hi.z)};
                        const int f = static_cast<int>(std::min_element(fd, fd + 6) - fd);
                        faceHit[static_cast<size_t>(f)] += S[i].w;
                    }
                }
                const double rms = std::sqrt(S2 / std::max(W, 1e-9)), inl = Win / std::max(Wall, 1e-9);
                double freeArea = 0;
                std::array<double, 6> faceSupport{};
                if (valid) {
                    const Vec3 sz = hi - lo;
                    const double fa[6] = {(double)sz.y * sz.z, (double)sz.y * sz.z, (double)sz.x * sz.z, (double)sz.x * sz.z, (double)sz.x * sz.y, (double)sz.x * sz.y};
                    for (int f = 0; f < 6; ++f) {
                        faceSupport[static_cast<size_t>(f)] = std::min(1.0, faceHit[static_cast<size_t>(f)] / std::max(fa[f], 1e-9));
                        const Vec3 mid = (lo + hi) * 0.5f;
                        Vec3 fc = mid;
                        const int a = f / 2;
                        (a == 0 ? fc.x : a == 1 ? fc.y : fc.z) = a == 0 ? (f % 2 ? hi.x : lo.x) : a == 1 ? (f % 2 ? hi.y : lo.y) : (f % 2 ? hi.z : lo.z);
                        const bool onGround = f == 2 && lo.y < groundAt(fc.x, fc.z) + 0.15;
                        const bool touching = contact[static_cast<size_t>(f)] || distToFitted(fc) <= 0.10 || insideFitted(fc);
                        const bool shared = (f == 2 && cutBelow && lo.y <= y0 + 0.02f) || (f == 3 && cutAbove && hi.y >= y1 - 0.02f);
                        if (touching || onGround || shared) { contact[static_cast<size_t>(f)] = 1; continue; }
                        freeArea += fa[f];
                    }
                }
                const double support = freeArea > 0 ? Win / freeArea : 0;
                const bool boxLike = (inl >= 0.80 && rms <= 0.08) || (inl >= 0.70 && rms <= 0.05);
                std::map<std::string, double> test{{"inlierFraction", inl}, {"rmsM", rms}, {"facesMeasured", static_cast<double>(faces.size() / 2)}, {"support", support}, {"areaM2", SA}};
                if (valid && boxLike && faces.size() >= 8 && support >= P.boxSupportMin) {
                    boxes.push_back({lo, hi, rms, inl, W, faces, snapped, support, faceSupport, measured, contact});
                    double OA = 0, omax = 0;
                    for (uint32_t i : outliers) { OA += S[i].w; omax = std::max(omax, (double)dS[i]); }
                    if (OA >= 0.3 && omax > 0.15) { passSlabs.push_back(outliers); passWhy.push_back("what an accepted box did not explain"); passTest.push_back({{"areaM2", OA}, {"maxDistanceM", omax}}); }
                } else {
                    double smax = 0;
                    for (uint32_t i : slab) smax = std::max(smax, (double)dS[i]);
                    if (smax < 0.15) continue;
                    passSlabs.push_back(slab);
                    std::string why = !valid ? "not box-like: degenerate" : !boxLike ? "not box-like: " + sj::num(std::round(inl * 1000) / 10) + "% inliers at " + sj::num(std::round(rms * 1000) / 10) + " cm rms"
                                    : faces.size() < 8 ? "not box-like: " + std::to_string(faces.size() / 2) + " faces measured" : "not box-like: " + sj::num(std::round(support * 100)) + "% surface support";
                    passWhy.push_back(why);
                    passTest.push_back(test);
                }
            }
        }
        // the boxes, in height order (sweep of their rectangle up their vertical extent)
        std::sort(boxes.begin(), boxes.end(), [](const BoxRec& a, const BoxRec& b) { return a.lo.y < b.lo.y || (a.lo.y == b.lo.y && (a.lo.x < b.lo.x || (a.lo.x == b.lo.x && a.lo.z < b.lo.z))); });
        for (const auto& b : boxes) {
            const int pi = newPrimitive("measured box");
            Primitive& pr = R.prims[static_cast<size_t>(pi)];
            pr.method = "scan_fit: a residual slab of the scan, sliced at its own horizontal facets, fitted with a trimmed box; faces without samples were placed against the rebuild";
            pr.solid.kind = 3; pr.solid.lo = b.lo; pr.solid.hi = b.hi;
            pr.gates.push_back({"box inlier fraction", b.inl, 0.7, false, "ratio"});
            pr.gates.push_back({"box rms", b.rms, 0.08, true, "m"});
            pr.gates.push_back({"box surface support", b.support, P.boxSupportMin, false, "ratio"});
            pr.fitParams = {b.lo.x, b.lo.y, b.lo.z, b.hi.x, b.hi.y, b.hi.z};
            pr.fitParamMeta = {{"m", "min x (local)"}, {"m", "min y (local)"}, {"m", "min z (local)"}, {"m", "max x (local)"}, {"m", "max y (local)"}, {"m", "max z (local)"}};
            {
                const std::vector<P2> rect{P2(b.lo.x, b.lo.z), P2(b.hi.x, b.lo.z), P2(b.hi.x, b.hi.z), P2(b.lo.x, b.hi.z)};
                sj::Object prof;
                prof.raw("outer", polyJ(rect));
                sj::Object carrier;
                carrier.raw("points", "[" + v3j(Vec3(0, b.lo.y, 0)) + "," + v3j(Vec3(0, b.hi.y, 0)) + "]").b("closed", false).n("lengthM", b.hi.y - b.lo.y);
                sj::Object sw;
                sw.raw("carrier", "{\"path\":" + carrier.text() + "}").raw("profile", prof.text()).raw("profileUp", "[0,0,1]").n("miterLimit", 1).b("caps", true);
                pr.specJson = "{\"operator\":\"sweep\",\"sweep\":" + sw.text() + "}";
            }
            const Vec3 c[8] = {{b.lo.x, b.lo.y, b.lo.z}, {b.hi.x, b.lo.y, b.lo.z}, {b.hi.x, b.hi.y, b.lo.z}, {b.lo.x, b.hi.y, b.lo.z},
                               {b.lo.x, b.lo.y, b.hi.z}, {b.hi.x, b.lo.y, b.hi.z}, {b.hi.x, b.hi.y, b.hi.z}, {b.lo.x, b.hi.y, b.hi.z}};
            const int fq[6][4] = {{0, 4, 7, 3}, {1, 2, 6, 5}, {0, 1, 5, 4}, {3, 7, 6, 2}, {0, 3, 2, 1}, {4, 5, 6, 7}};
            const char* names[6] = {"face -x", "face +x", "underside", "top", "face -z", "face +z"};
            for (int f = 0; f < 6; ++f) {
                const int si = newSurface(pi, names[f]);
                Surface& s = R.surfaces[static_cast<size_t>(si)];
                const Vec3 n = ax6[f];
                quad(s, c[fq[f][0]], c[fq[f][1]], c[fq[f][2]], c[fq[f][3]], n);
                // chart: u, v along the face's edges with u x v = n
                Vec3 e1 = (c[fq[f][1]] - c[fq[f][0]]), e2 = (c[fq[f][3]] - c[fq[f][0]]);
                const double l1 = e1.length(), l2 = e2.length();
                e1 = e1 / static_cast<float>(l1); e2 = e2 / static_cast<float>(l2);
                if (e1.cross(e2).dot(n) < 0) std::swap(e1, e2);
                const double lu = e1.dot(c[fq[f][1]] - c[fq[f][0]]) != 0 ? std::fabs(e1.dot(c[fq[f][1]] - c[fq[f][0]])) + std::fabs(e1.dot(c[fq[f][3]] - c[fq[f][0]])) : l1;
                const double lv = std::fabs(e2.dot(c[fq[f][1]] - c[fq[f][0]])) + std::fabs(e2.dot(c[fq[f][3]] - c[fq[f][0]]));
                planeChartFromQuad(s, c[fq[f][0]], e1, e2, n, {{0, 0}, {lu, 0}, {lu, lv}, {0, lv}});
                s.supportFraction = b.faceSupport[static_cast<size_t>(f)];
                boxFaceContact[si] = b.contact[static_cast<size_t>(f)];
                boxFaceMeasured[si] = b.measured[static_cast<size_t>(f)];
            }
            for (int f = 0; f < 6; ++f) for (int k = 0; k < 4; ++k) pr.creases.push_back({c[fq[f][k]], c[fq[f][(k + 1) % 4]]});
            ++boxOrder;
        }
        meshModel();
        keepLeftoverFragments(passSlabs, passWhy, passTest);
        // pass-through: the scan triangles carrying the slabs' samples, kept as scanned
        for (size_t i = 0; i < passSlabs.size(); ++i) {
            PassRegion pr;
            pr.id = "x" + std::string(i < 10 ? "0" : "") + std::to_string(i);
            std::set<uint32_t> tris;
            for (uint32_t k : passSlabs[i]) { tris.insert(S[k].tri); inPass[k] = 1; pr.area += S[k].w; }
            pr.tris.assign(tris.begin(), tris.end());
            pr.lo = Vec3(1e30f, 1e30f, 1e30f); pr.hi = Vec3(-1e30f, -1e30f, -1e30f);
            for (uint32_t t : pr.tris) for (int j = 0; j < 3; ++j) {
                const Vec3& p = R.scan.pos[R.scan.tri[3 * t + j]];
                pr.lo = Vec3(std::min(pr.lo.x, p.x), std::min(pr.lo.y, p.y), std::min(pr.lo.z, p.z));
                pr.hi = Vec3(std::max(pr.hi.x, p.x), std::max(pr.hi.y, p.y), std::max(pr.hi.z, p.z));
            }
            pr.reason = passWhy[i];
            pr.test = passTest[i];
            if (!triOwner.empty() && Q.ownership) {
                // what the multi-view mask vote says about the region (area shares of its samples' triangles)
                double tgt = 0, und = 0, all = 0;
                for (uint32_t k : passSlabs[i]) { all += S[k].w; (triOwner[S[k].tri] > 0 ? tgt : und) += S[k].w; }
                if (all > 0) {
                    pr.test["voteStructureShare"] = tgt / all;
                    pr.reason += tgt / all >= 0.5 ? " (the multi-view mask vote puts it on the structure)" : " (the multi-view mask vote does not decide it: the geometric rule keeps it)";
                }
            }
            R.pass.push_back(std::move(pr));
        }
    }
    std::map<int, uint8_t> boxFaceContact, boxFaceMeasured;

    // ---------------------------------------------------------------- 8. metrics
    void metrics() {
        // scan -> fit (visible structure, not ground or clutter)
        std::vector<std::pair<double, double>> sf, sfNoPass, sfPlus;
        std::vector<double> dFit(S.size(), 0);
        std::vector<int> nearestSurface(S.size(), -1);
        sg::parallelFor(S.size(), [&](size_t i) { int s = -1; dFit[i] = distToFitted(S[i].p, &s); nearestSurface[i] = s; });
        // pass-through triangles as a mesh (local), for scan -> fit + pass-through
        std::vector<Vec3> ppos;
        std::vector<uint32_t> ptri;
        std::set<uint32_t> passTris;
        for (const auto& pr : R.pass) passTris.insert(pr.tris.begin(), pr.tris.end());
        for (uint32_t t : passTris) for (int j = 0; j < 3; ++j) { ptri.push_back(static_cast<uint32_t>(ppos.size())); ppos.push_back(lp[R.scan.tri[3 * t + j]]); }
        sg::TriGrid pgrid;
        pgrid.build(ppos, ptri, 1.0);
        double visArea = 0, covArea = 0, covPassArea = 0, passArea = 0, buriedArea = 0;
        std::vector<std::pair<double, double>> sfHausdorff;
        std::map<int, std::vector<std::pair<double, double>>> perSurface;
        for (size_t i = 0; i < S.size(); ++i) {
            if (sGround[i]) continue;
            const double w = S[i].w;
            sf.push_back({dFit[i], w});
            visArea += w;
            double dp = dFit[i];
            if (!ptri.empty()) { const auto [d2, t2] = pgrid.nearest(S[i].p, dFit[i]); if (t2 != UINT32_MAX) dp = std::min(dp, d2); }
            sfPlus.push_back({dp, w});
            if (!inPass[i]) {
                sfNoPass.push_back({dFit[i], w});
                if (dFit[i] <= P.inlierBandM) { covArea += w; covPassArea += w; }
                // scan surface standing inside the rebuilt solid, deeper than the band, is hidden by it: counted, and not part of
                // the Hausdorff (it does not show in the rebuild)
                if (dFit[i] > P.inlierBandM && insideFitted(S[i].p)) buriedArea += w; else sfHausdorff.push_back({dFit[i], w});
            } else passArea += w;
            if (dFit[i] <= P.inlierBandM && nearestSurface[i] >= 0) perSurface[nearestSurface[i]].push_back({dFit[i], w});
        }
        R.scanToFit = sg::residualOf(sf, P.inlierBandM);
        R.scanToFitPlusPass = sg::residualOf(sfPlus, P.inlierBandM);
        const Residual noPass = sg::residualOf(sfNoPass, P.inlierBandM);
        R.coverage = visArea > 0 ? covArea / visArea : 0;
        R.coverageWithPass = visArea > 0 ? (covPassArea + passArea) / visArea : 0;
        R.passShare = visArea > 0 ? passArea / visArea : 0;
        R.buriedScanArea = buriedArea;
        if (buriedArea >= 0.5) R.notes.push_back(sj::num(std::round(buriedArea * 10) / 10) + " m2 of the scan stands inside the rebuilt solid, deeper than " + sj::num(std::round(P.inlierBandM * 1000) / 10) + " cm: surfaces the rebuild hides (scan slivers, or relief the fit filled)");
        // fit -> scan on the fitted model's visible surface
        sg::ScratchboxMesh fm = sg::toMesh(fpos, ftri);
        bvh::BvhTree ftree;
        if (!ftri.empty()) ftree.build(fm);
        auto FS = sg::sampleTriangles(fpos, ftri, density, 33);
        std::vector<Vec3> FP, FN;
        for (const auto& q : FS) { FP.push_back(q.p); FN.push_back(q.n); }
        sg::GroundOccluder G;
        G.on = true; G.n = R.groundL.n; G.d = R.groundL.d - 0.02;
        G.cx = 0.5 * (structX0 + structX1); G.cz = 0.5 * (structZ0 + structZ1);
        G.radius = 0.5 * std::hypot(structX1 - structX0, structZ1 - structZ0) + 5;
        const auto fvis = ftri.empty() ? std::vector<uint8_t>() : sg::exterior(ftree, FP, FN, G, P.visibilityRays, P.visibilityEscapes);
        sg::TriGrid sgrid;
        std::vector<uint32_t> extTri;
        for (size_t t = 0; t < R.scan.triangles(); ++t) if (ext[t] && !isGround[t]) extTri.insert(extTri.end(), {R.scan.tri[3 * t], R.scan.tri[3 * t + 1], R.scan.tri[3 * t + 2]});
        sgrid.build(lp, extTri, 1.0);
        std::vector<std::pair<double, double>> fs;
        std::vector<int> fsSurface;
        std::vector<double> dScan(FS.size(), 0);
        sg::parallelFor(FS.size(), [&](size_t i) {
            auto [d, t] = sgrid.nearest(FS[i].p, 3.0);
            dScan[i] = t == UINT32_MAX ? 3.0 : d;
        });
        std::map<int, double> surfVis, surfSup, surfTot;
        for (size_t i = 0; i < FS.size(); ++i) {
            const int si = ftriSurface[FS[i].tri];
            surfTot[si] += FS[i].w;
            if (!fvis[i]) continue;
            // the base standing on the ground is not seen
            if (FS[i].n.y < -0.9f && FS[i].p.y < R.baseY + 0.1) continue;
            surfVis[si] += FS[i].w;
            fs.push_back({dScan[i], FS[i].w});
            fsSurface.push_back(si);
            if (dScan[i] <= P.inlierBandM) surfSup[si] += FS[i].w;
        }
        R.fitToScan = sg::residualOf(fs, P.inlierBandM);  // over all of the rebuild's visible surface; the backed part is measured below
        // per surface
        for (size_t si = 0; si < R.surfaces.size(); ++si) {
            Surface& s = R.surfaces[si];
            double area = 0;
            for (size_t t = 0; t < s.tri.size() / 3; ++t) area += 0.5 * (s.lpos[s.tri[3 * t + 1]] - s.lpos[s.tri[3 * t]]).cross(s.lpos[s.tri[3 * t + 2]] - s.lpos[s.tri[3 * t]]).length();
            s.area = area;
            s.fit = sg::residualOf(perSurface[static_cast<int>(si)], P.inlierBandM);
            const double tot = surfTot[static_cast<int>(si)], vis = surfVis[static_cast<int>(si)];
            s.visibleFraction = tot > 0 ? std::min(1.0, vis / tot) : 0;
            const double measuredSupport = vis > 0 ? std::min(1.0, surfSup[static_cast<int>(si)] / vis) : 0;
            // a box face keeps the support its own samples gave it
            if (boxFaceMeasured.count(static_cast<int>(si))) s.supportFraction = std::max(s.supportFraction, measuredSupport);
            else s.supportFraction = measuredSupport;
            if (s.supportFraction < 0.5 && s.visibleFraction > 0) R.unobservedArea += s.area;
        }
        // fit -> scan over the rebuild's visible surface that has scan within 25 cm of it (the part the scan backs); the rest is
        // the rebuild placing faces where the scan has no samples (a face the scan never saw): reported as unobserved, and
        // gated by its share. A wall placed far from where the scan shows it does not hide here: its scan side is uncovered.
        {
            std::vector<std::pair<double, double>> backed;
            double visTotal = 0, visUnobserved = 0;
            for (size_t i = 0; i < fs.size(); ++i) {
                visTotal += fs[i].second;
                if (fs[i].first <= P.backedBandM) backed.push_back(fs[i]); else visUnobserved += fs[i].second;
            }
            R.fitToScanAll = R.fitToScan;
            R.fitToScan = sg::residualOf(backed, P.inlierBandM);
            R.unobservedShare = visTotal > 0 ? visUnobserved / visTotal : 0;
            R.hausdorff = std::max(sg::residualOf(sfHausdorff, P.inlierBandM).max, R.fitToScan.max);
        }
        // per primitive: its surfaces' residual
        for (auto& pr : R.prims) {
            std::vector<std::pair<double, double>> dw;
            for (int si : pr.surfaces) for (size_t i = 0; i < S.size(); ++i) if (nearestSurface[i] == si && dFit[i] <= P.inlierBandM && !sGround[i]) dw.push_back({dFit[i], S[i].w});
            pr.fit = sg::residualOf(dw, P.inlierBandM);
        }
        // what a remesh moved: its visible surface against the scan
        if (Q.remeshGlb) {
            auto scene = gltf::GlbSceneReader::parse(Q.remeshGlb->data(), Q.remeshGlb->size());
            if (scene.ok && !scene.mesh.indices.empty()) {
                std::vector<Vec3> rp;
                for (const auto& v : scene.mesh.vertices) rp.push_back(R.frame.toLocal(v.position));
                std::vector<uint32_t> rt = scene.mesh.indices;
                auto RS = sg::sampleTriangles(rp, rt, density, 44);
                std::vector<std::pair<double, double>> rd;
                std::vector<double> dd(RS.size(), 0);
                sg::parallelFor(RS.size(), [&](size_t i) { auto [d, t] = sgrid.nearest(RS[i].p, 3.0); dd[i] = t == UINT32_MAX ? 3.0 : d; });
                for (size_t i = 0; i < RS.size(); ++i) {
                    const double hgt = RS[i].p.y - groundAt(RS[i].p.x, RS[i].p.z);
                    if ((hgt < 0.40 && RS[i].n.y > 0.85f) || hgt < -0.25) continue;
                    const double ox = std::max({structX0 - RS[i].p.x, RS[i].p.x - structX1, 0.0f + 0.0}), oz = std::max({structZ0 - RS[i].p.z, RS[i].p.z - structZ1, 0.0});
                    if (std::max(ox, oz) > 2.0) continue;
                    rd.push_back({dd[i], RS[i].w});
                }
                R.remeshToScan = sg::residualOf(rd, P.inlierBandM);
                R.haveRemesh = true;
            }
        }
    }

    // ---------------------------------------------------------------- slots
    void slots() {
        const Frame& F = R.frame;
        sg::ScratchboxMesh fm = sg::toMesh(fpos, ftri);
        bvh::BvhTree tree;
        if (!ftri.empty()) tree.build(fm);
        auto rayDist = [&](const Vec3& oL, const Vec3& dL, double cap) {
            math::Ray ray(oL + dL * 0.02f, dL);
            bvh::RayHit hit;
            if (!ftri.empty() && tree.raycast(ray, hit) && hit.t < cap) return static_cast<double>(hit.t);
            return cap;
        };
        const double minFeature = R.limits.photoResolvableM > 0 ? R.limits.photoResolvableM : Q.limits.photoResolvableM;
        int n = 0;
        auto nextId = [&]() { std::string s = "S" + std::string(n < 10 ? "0" : "") + std::to_string(n); ++n; return s; };
        for (size_t si = 0; si < R.surfaces.size(); ++si) {
            const Surface& s = R.surfaces[si];
            if (s.area < 1.0 || s.visibleFraction < 0.3) continue;
            Slot sl;
            sl.id = nextId();
            sl.label = s.label;
            sl.primitiveId = R.prims[static_cast<size_t>(s.prim)].id;
            sl.surfaceId = s.id;
            if (s.kind == ChartKind::Plane) {
                sl.regionUv = s.extentUv;
                double u0 = 1e30, u1 = -1e30, v0 = 1e30, v1 = -1e30;
                for (const auto& p : s.extentUv) { u0 = std::min(u0, p.x); u1 = std::max(u1, p.x); v0 = std::min(v0, p.y); v1 = std::max(v1, p.y); }
                sl.sizeU = u1 - u0; sl.sizeV = v1 - v0;
                // clearance out of the surface and the wall thickness behind it, from its middle
                const Vec3 cW = s.origin + s.u * static_cast<float>(0.5 * (u0 + u1)) + s.v * static_cast<float>(0.5 * (v0 + v1));
                const Vec3 cL = F.toLocal(cW), nL = F.dirToLocal(s.n);
                const double clear = rayDist(cL + nL * 0.01f, nL, 0.6);
                const double thick = rayDist(cL - nL * 0.03f, nL * -1.0f, 2.0);
                sl.maxProud = std::min({0.6, 0.25 * std::min(sl.sizeU, sl.sizeV), clear});
                sl.maxRecess = std::min(0.4, 0.5 * thick);
            } else {
                const double arcLen = sg::kPi / 180.0 * (s.th1 - s.th0) * s.radius;
                sl.regionUv = {{0, s.z0}, {arcLen, s.z0}, {arcLen, s.z1}, {0, s.z1}};
                sl.sizeU = arcLen; sl.sizeV = s.z1 - s.z0;
                sl.maxProud = std::min(0.6, 0.25 * std::min(sl.sizeU, sl.sizeV));
                sl.maxRecess = std::min(0.4, 0.25 * std::min(sl.sizeU, sl.sizeV));
            }
            sl.minFeature = minFeature;
            R.slots.push_back(sl);
        }
        // edge slots: the arch intrados on each face of a passage (the crease between the face and the soffit)
        for (const auto& pinfo : passageInfo) {
            for (size_t bi = 0; bi < pinfo.bays.size(); ++bi) {
                const Bay& b = pinfo.bays[bi];
                if (!b.arch) continue;
                for (int face = 0; face < 2; ++face) {
                    const double t = face ? pinfo.tMax : pinfo.tMin;
                    Slot sl;
                    sl.id = nextId();
                    sl.edge = true;
                    sl.label = "arch intrados edge";
                    sl.primitiveId = R.prims[static_cast<size_t>(pinfo.prim)].id;
                    const double aL = std::atan2(b.yL - b.circ.cy, b.sL - b.circ.cx), aR = std::atan2(b.yR - b.circ.cy, b.sR - b.circ.cx);
                    for (int i = 0; i <= 32; ++i) {
                        const double a = aL + (aR - aL) * i / 32.0;
                        const P2 p = pinfo.sAx * (b.circ.cx + b.circ.r * std::cos(a)) + pinfo.tAx * t;
                        sl.carrier.push_back(F.toWorld(Vec3(static_cast<float>(p.x), static_cast<float>(b.circ.cy + b.circ.r * std::sin(a)), static_cast<float>(p.y))));
                    }
                    // its surfaces: the face and the soffit of this bay
                    const Primitive& pr = R.prims[static_cast<size_t>(pinfo.prim)];
                    for (int si : pr.surfaces) {
                        const auto& s = R.surfaces[static_cast<size_t>(si)];
                        if (s.label == (face ? "face along +t" : "face along -t")) sl.surfaceIds.push_back(s.id);
                    }
                    for (int si : pr.surfaces) {
                        const auto& s = R.surfaces[static_cast<size_t>(si)];
                        if (s.kind == ChartKind::Cylinder && std::fabs(s.radius - b.circ.r) < 1e-6) { sl.surfaceIds.push_back(s.id); break; }
                    }
                    // the measured section a profile on this edge must stay inside, in the section frame every edge slot has: u out of
                    // the first surface (the face), v in that surface's plane across the crease toward the second (here the opening);
                    // a profile on the spandrel (the face's own side) is at negative v, up to the spandrel's least width
                    const double spandrel = std::max(0.2, std::min(b.sL - pinfo.sMin, pinfo.sMax - b.sR) * 0.5);
                    const double up = std::max(0.2, std::min(spandrel, pinfo.y1 - b.yTop));
                    sl.envelope = {{-0.05, -up}, {0.6, -up}, {0.6, 0.05}, {-0.05, 0.05}};
                    sl.sizeU = b.circ.r * std::fabs(aL - aR);
                    sl.sizeV = up;
                    sl.maxProud = 0.6; sl.maxRecess = 0.05; sl.minFeature = minFeature;
                    R.slots.push_back(sl);
                }
            }
        }
        // edge slots: a band's exposed top edges (each wall's top crease where its band is the top, or the one above is set back)
        for (const auto& pr : R.prims) {
            if (pr.solid.kind != 0) continue;
            for (int si : pr.surfaces) {
                const Surface& s = R.surfaces[static_cast<size_t>(si)];
                if (s.label != "wall" || s.kind != ChartKind::Plane || s.extentUv.size() < 3) continue;
                const double len = s.extentUv[1].x, h = s.extentUv[2].y;
                if (len < 1.0) continue;
                // the crease along the wall's top; exposed when nothing of the rebuild stands just above and outside it
                const Vec3 a = s.origin + s.v * static_cast<float>(h), b = a + s.u * static_cast<float>(len);
                const Vec3 midL = F.toLocal((a + b) * 0.5f);
                const Vec3 probe = midL + F.dirToLocal(s.n) * 0.05f + Vec3(0, 0.05f, 0);
                if (insideFitted(probe)) continue;
                Slot sl;
                sl.id = nextId();
                sl.edge = true;
                sl.label = "top edge of a band";
                sl.primitiveId = pr.id;
                for (int i = 0; i <= 8; ++i) sl.carrier.push_back(a + (b - a) * static_cast<float>(i / 8.0));
                sl.surfaceIds.push_back(s.id);
                for (int sj2 : pr.surfaces) if (R.surfaces[static_cast<size_t>(sj2)].label == "top") { sl.surfaceIds.push_back(R.surfaces[static_cast<size_t>(sj2)].id); break; }
                const double depth = std::min(1.2, std::max(0.2, 0.5 * std::sqrt(std::fabs(pr.fitParams.size() > 2 ? pr.fitParams[2] : 1.0)) * 0.2));
                sl.envelope = {{-depth, -std::min(h, 1.2)}, {0.3, -std::min(h, 1.2)}, {0.3, 0.3}, {-depth, 0.3}};
                sl.sizeU = len; sl.sizeV = std::min(h, 1.2);
                sl.maxProud = 0.3; sl.maxRecess = std::min(0.4, depth * 0.5); sl.minFeature = minFeature;
                R.slots.push_back(sl);
            }
        }
    }

    // ---------------------------------------------------------------- source limits
    void sourceLimits() {
        SourceLimits L = Q.limits;
        std::vector<double> edges;
        const auto& s = R.scan;
        for (size_t t = 0; t < s.triangles(); ++t) {
            if (!ext[t] || isGround[t]) continue;
            for (int j = 0; j < 3; ++j) edges.push_back((s.pos[s.tri[3 * t + j]] - s.pos[s.tri[3 * t + (j + 1) % 3]]).length());
        }
        if (!edges.empty()) { std::nth_element(edges.begin(), edges.begin() + static_cast<long>(edges.size() / 2), edges.end()); L.meshEdgeP50M = edges[edges.size() / 2]; }
        // the photo texel: median over the textured extraction's triangles inside the structure's plan box
        if (Q.textured) {
            const auto& m = Q.textured->mesh;
            std::vector<double> tex;
            for (size_t t = 0; t + 2 < m.indices.size(); t += 3) {
                const auto &a = m.vertices[m.indices[t]], &b = m.vertices[m.indices[t + 1]], &c = m.vertices[m.indices[t + 2]];
                const Vec3 cl = R.frame.toLocal((a.position + b.position + c.position) * (1.0f / 3.0f));
                if (cl.x < structX0 - 1 || cl.x > structX1 + 1 || cl.z < structZ0 - 1 || cl.z > structZ1 + 1 || cl.y < R.baseY + 0.5) continue;
                const size_t mi = t / 3 < Q.textured->triangleMaterial.size() ? Q.textured->triangleMaterial[t / 3] : 0;
                if (mi >= Q.textured->materials.size()) continue;
                const int img = Q.textured->materials[mi].baseColorImage;
                if (img < 0 || static_cast<size_t>(img) >= Q.textured->images.size()) continue;
                const auto& px = Q.textured->images[static_cast<size_t>(img)].pixels;
                if (px.empty()) continue;
                const double area3 = 0.5 * (b.position - a.position).cross(c.position - a.position).length();
                const double au = (b.uv.x - a.uv.x) * px.width, av = (b.uv.y - a.uv.y) * px.height, bu = (c.uv.x - a.uv.x) * px.width, bv = (c.uv.y - a.uv.y) * px.height;
                const double areaPx = 0.5 * std::fabs(au * bv - av * bu);
                if (areaPx < 1e-6 || area3 < 1e-4) continue;
                tex.push_back(std::sqrt(area3 / areaPx));
            }
            if (!tex.empty()) { std::nth_element(tex.begin(), tex.begin() + static_cast<long>(tex.size() / 2), tex.end()); L.texelM = tex[tex.size() / 2]; }
        }
        L.meshResolvableM = std::max(L.meshEdgeP50M, 0.25 * L.leafGeometricErrorM);
        if (L.texelM > 0) L.photoResolvableM = 2 * L.texelM;
        R.limits = L;
        for (auto& sl : R.slots) sl.minFeature = L.photoResolvableM;
        // the corrections' tolerance follows the photo's resolution
        for (auto& pr : R.prims) for (auto& c : pr.correctable) {
            const double fitRms = pr.fit.rms;
            c.toleranceM = std::min({0.5 * L.leafGeometricErrorM, std::max(3 * fitRms, L.photoResolvableM), 0.31});
            int at = 0;
            double bestD = 1e9;
            for (size_t k = 0; k < c.curve.size(); ++k) if (std::fabs(c.curve[k][0] - c.value) < bestD) { bestD = std::fabs(c.curve[k][0] - c.value); at = static_cast<int>(k); }
            int lo = at, hi = at;
            while (lo > 0 && c.curve[static_cast<size_t>(lo - 1)][1] <= c.toleranceM) --lo;
            while (hi + 1 < static_cast<int>(c.curve.size()) && c.curve[static_cast<size_t>(hi + 1)][1] <= c.toleranceM) ++hi;
            c.min = std::min(c.curve[static_cast<size_t>(lo)][0], c.value);
            c.max = std::max(c.curve[static_cast<size_t>(hi)][0], c.value);
        }
    }

    // ---------------------------------------------------------------- gates
    void gates() {
        bool body = false;
        for (const auto& pr : R.prims) body = body || (pr.body && pr.accepted);
        const double scanGate = std::max(P.gateScanToFitM, R.haveRemesh ? R.remeshToScan.rms : 0.0);
        R.gates.push_back({"coverage by the fit or kept as scanned", R.coverageWithPass, P.gateCoverage, false, "ratio"});
        R.gates.push_back({"share of the scan kept as scanned", R.passShare, P.gatePassShare, true, "ratio"});
        R.gates.push_back({"scan→fit rms (kept-as-scanned regions count as exact)", R.scanToFitPlusPass.rms, scanGate, true, "m"});
        R.gates.push_back({"fit→scan rms (faces the scan backs)", R.fitToScan.rms, P.gateFitToScanM, true, "m"});
        R.gates.push_back({"Hausdorff without pass-through", R.hausdorff, P.gateHausdorffM, true, "m"});
        R.gates.push_back({"unobserved share of the rebuild's visible surface", R.unobservedShare, P.gateUnobservedShare, true, "ratio"});
        R.gates.push_back({"accepted body primitives", body ? 1.0 : 0.0, 1.0, false, "count"});
        R.accepted = true;
        for (const auto& g : R.gates) R.accepted = R.accepted && g.passed();
        // the building id: the footprint quantised to 0.25 m and the seed to 1 cm
        std::string key;
        for (const auto& L : R.footprint) for (const auto& p : L.pts) {
            const Vec3 w = R.frame.toWorld(Vec3(static_cast<float>(p.x), 0, static_cast<float>(p.y)));
            key += std::to_string(std::lround(w.x / 0.25)) + "," + std::to_string(std::lround(w.z / 0.25)) + ";";
        }
        if (key.empty()) key = std::to_string(std::lround(structX0 / 0.25)) + "," + std::to_string(std::lround(structX1 / 0.25)) + "," + std::to_string(std::lround(structZ0 / 0.25)) + "," + std::to_string(std::lround(structZ1 / 0.25));
        key += "|" + std::to_string(std::lround(Q.anchorX * 100)) + "," + std::to_string(std::lround(Q.anchorZ * 100));
        R.buildingId = hex16(fnv1a(key));
        // counts and tile-frame output
        for (auto& s : R.surfaces) { R.verticesOut += s.lpos.size(); R.trianglesOut += s.tri.size() / 3; }
    }
};

// ============================================================================================
// Orthos of the fitted surfaces
// ============================================================================================

/** One ortho request per fitted surface worth showing (a square metre or more, a third of it seen), its slots drawn on it. */
inline std::vector<scan_ortho::Request> orthoRequests(const FitResult& R) {
    std::vector<scan_ortho::Request> out;
    for (const auto& s : R.surfaces) {
        if (s.area < 1.0 || s.visibleFraction < 0.3) continue;
        scan_ortho::Request rq;
        rq.surfaceId = s.id;
        auto& C = rq.chart;
        C.cylinder = s.kind == ChartKind::Cylinder;
        if (C.cylinder) {
            C.axisOrigin = s.axisOrigin; C.axisDir = s.axisDir; C.thetaZeroDir = s.thetaZeroDir; C.radius = s.radius;
            C.thetaDeg[0] = s.th0; C.thetaDeg[1] = s.th1; C.zM[0] = s.z0; C.zM[1] = s.z1; C.normalSign = s.normalSign;
        } else {
            C.origin = s.origin; C.u = s.u; C.v = s.v; C.n = s.n; C.extentUv = s.extentUv;
        }
        // chart coordinates of a tile-frame point on this surface
        const Vec3 e2 = C.cylinder ? s.axisDir.cross(s.thetaZeroDir).normalized() : Vec3(0, 0, 0);
        auto toUv = [&](const Vec3& p) {
            if (!C.cylinder) return P2((p - s.origin).dot(s.u), (p - s.origin).dot(s.v));
            const Vec3 d = p - s.axisOrigin;
            const double z = d.dot(s.axisDir), x = d.dot(s.thetaZeroDir), y = d.dot(e2);
            double th = std::atan2(y, x);
            const double lo = s.th0 * sg::kPi / 180.0;
            while (th < lo - 1e-4) th += 2 * sg::kPi;
            while (th > lo + 2 * sg::kPi - 1e-4) th -= 2 * sg::kPi;
            return P2(s.radius * th, z);
        };
        for (const auto& sl : R.slots) {
            scan_ortho::Slot os;
            os.id = sl.id;
            if (!sl.edge) {
                if (sl.surfaceId != s.id) continue;
                os.uv = sl.regionUv;
            } else {
                if (std::find(sl.surfaceIds.begin(), sl.surfaceIds.end(), s.id) == sl.surfaceIds.end()) continue;
                for (const auto& p : sl.carrier) os.uv.push_back(toUv(p));
                os.closed = false;
            }
            if (os.uv.size() >= 2) rq.slots.push_back(std::move(os));
        }
        out.push_back(std::move(rq));
    }
    return out;
}

// ============================================================================================
// Flatten: the remesh rung (a failed remesh becomes the scan with its facades flattened)
// ============================================================================================

struct FlattenOutput { std::vector<uint8_t> glb; std::string statsJson; size_t moved{0}; double maxMoveM{0}; };

/**
 * `glb` (a photo-textured or clay scan) isolated by `footprint` (tile-frame [x, z] points, empty: the whole scan), whole
 * triangles whose centroid lies within `dilateM` of it, no height cap, nothing cut; then flattened (see Fitter::flatten).
 * The result is clay with the input's UVs. Every number is measured on this run.
 */
inline FlattenOutput flattenScan(const std::vector<uint8_t>& glb, const std::vector<P2>& footprint, double bandM, double dilateM = 4.0) {
    const auto t0 = std::chrono::steady_clock::now();
    auto scene = gltf::GlbSceneReader::parse(glb.data(), glb.size());
    if (!scene.ok) throw ScanFitError("input_unreadable", "cannot read the scan: " + scene.error);
    const auto& m = scene.mesh;
    const size_t T = m.indices.size() / 3;
    if (T == 0) throw ScanFitError("input_unreadable", "the scan has no triangles");
    std::vector<uint8_t> keep(T, 1);
    double footprintArea = 0;
    size_t dropped = 0;
    {
        std::vector<Vec3> q;
        q.reserve(m.vertices.size());
        for (const auto& v : m.vertices) q.push_back(v.position);
        const Vec3 ctr = saneCentre(q);
        for (size_t t = 0; t < T; ++t) {
            bool ok = true;
            for (int j = 0; j < 3 && ok; ++j) ok = m.indices[3 * t + j] < q.size() && saneVertex(q[m.indices[3 * t + j]], ctr.x, ctr.y, ctr.z);
            if (!ok) keep[t] = 0;
        }
    }
    if (footprint.size() >= 3) {
        footprintArea = std::fabs(sg::signedArea(footprint));
        for (size_t t = 0; t < T; ++t) {
            if (!keep[t]) continue;
            const Vec3 c = (m.vertices[m.indices[3 * t]].position + m.vertices[m.indices[3 * t + 1]].position + m.vertices[m.indices[3 * t + 2]].position) * (1.0f / 3.0f);
            const P2 q(c.x, c.z);
            keep[t] = sg::insidePolygon(footprint, q.x, q.y) || sg::polygonDistance(footprint, q) <= dilateM;
            if (!keep[t]) ++dropped;
        }
    }
    std::vector<Vec3> pos;
    std::vector<uint32_t> idx;
    std::vector<int64_t> remap(m.vertices.size(), -1);
    std::vector<uint32_t> origOf;
    for (size_t t = 0; t < T; ++t) {
        if (!keep[t]) continue;
        for (int j = 0; j < 3; ++j) {
            const uint32_t v = m.indices[3 * t + j];
            if (remap[v] < 0) { remap[v] = static_cast<int64_t>(pos.size()); pos.push_back(m.vertices[v].position); origOf.push_back(v); }
            idx.push_back(static_cast<uint32_t>(remap[v]));
        }
    }
    if (idx.size() < 12) throw ScanFitError("no_structure", "no triangle of the scan lies within the footprint");
    // the welded scan, and the map from the kept vertices to its welded ids (a seam's two vertices move together)
    std::vector<uint32_t> wid;
    sg::Scan sc = sg::weldScan(pos, idx, 0.001, &wid);
    double ax = 0, az = 0;
    for (const auto& p : sc.pos) { ax += p.x; az += p.z; }
    ax /= std::max<size_t>(1, sc.pos.size()); az /= std::max<size_t>(1, sc.pos.size());
    FitRequest q;
    q.anchorX = ax; q.anchorZ = az;
    Params P;
    Fitter fitter(P, q);
    const auto F = fitter.flatten(std::move(sc), bandM);
    // the output: the kept triangles with their own vertices and UVs, moved vertices placed, normals recomputed
    geometry::ScratchboxMesh out("flattened");
    std::vector<double> moves;
    size_t moved = 0;
    for (size_t v = 0; v < pos.size(); ++v) {
        geometry::Vertex vx(pos[v]);
        vx.uv = m.vertices[origOf[v]].uv;
        if (F.isMoved[wid[v]]) { vx.position = F.moved[wid[v]]; moves.push_back((vx.position - pos[v]).length()); ++moved; }
        out.vertices.push_back(vx);
    }
    out.indices = idx;
    out.recomputeNormals();
    std::sort(moves.begin(), moves.end());
    const double maxMove = moves.empty() ? 0 : moves.back(), p95 = moves.empty() ? 0 : moves[static_cast<size_t>(0.95 * (moves.size() - 1))];
    FlattenOutput o;
    o.glb = io::GlbWriter::writeGlb(out);
    o.moved = moved;
    o.maxMoveM = maxMove;
    sj::Object st;
    st.s("schema", "scratchbox.flatten-stats/1").i("inputTriangles", static_cast<long long>(T)).i("keptTriangles", static_cast<long long>(idx.size() / 3));
    if (footprint.size() >= 3) {
        sj::Object iso;
        iso.n("footprintAreaM2", footprintArea).n("dilationM", dilateM).i("droppedTriangles", static_cast<long long>(dropped));
        st.raw("isolate", iso.text());
    }
    st.i("planes", F.planes).i("movedVertices", static_cast<long long>(moved)).n("maxMoveM", maxMove).n("p95MoveM", p95).n("bandM", bandM);
    sj::Object tm;
    for (const auto& [k, v] : F.timings) tm.n(k, v);
    tm.n("total", std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count());
    st.raw("timingsMs", tm.text());
    o.statsJson = st.text();
    return o;
}

// ============================================================================================
// Output: StructureFit JSON and the GLBs
// ============================================================================================

struct Outputs { std::string fittedGlb, outlinesGlb, passThroughGlb, reportJson; std::vector<std::string> orthoJson; };

inline std::string provenanceJson(const std::string& label, bool measured, const std::string& method, double confidence, const Residual* res, const std::string& note, double supportF = -1) {
    sj::Object o;
    o.s("label", label).b("measuredGeometry", measured).s("method", method).raw("sources", "[{\"kind\":\"stage-output\",\"id\":\"scan_fit\",\"note\":\"the isolated scan\"}]");
    if (!measured || std::isfinite(confidence)) o.n("confidence", std::clamp(std::isfinite(confidence) ? confidence : 0.0, 0.0, 1.0));
    if (res && res->samples > 0) o.raw("residual", residualJ(*res, supportF >= 0, supportF));
    if (!note.empty()) o.s("note", note);
    return o.text();
}

inline std::string surfaceProvenance(const FitResult& R, const Surface& s) {
    const auto& pr = R.prims[static_cast<size_t>(s.prim)];
    const bool unobserved = s.supportFraction < 0.5;
    const std::string label = unobserved ? "fitted-unobserved" : pr.corrected ? "photo-corrected" : "fitted";
    const bool measured = !unobserved && !pr.corrected;
    std::string note;
    if (unobserved) note = "placed by the fit where the scan has samples on " + sj::num(std::round(s.supportFraction * 1000) / 10) + "% of its visible surface";
    if (pr.corrected) note = pr.correctionNote;
    return provenanceJson(label, measured, pr.method, unobserved ? s.supportFraction : (pr.corrected ? 0.7 : std::numeric_limits<double>::quiet_NaN()), &s.fit, note, s.supportFraction);
}

inline std::string chartJson(const Surface& s) {
    if (s.kind == ChartKind::Plane) {
        sj::Object p;
        p.raw("origin", v3j(s.origin)).raw("u", v3j(s.u)).raw("v", v3j(s.v)).raw("normal", v3j(s.n)).raw("extentUv", polyJ(s.extentUv));
        return "{\"plane\":" + p.text() + "}";
    }
    sj::Object c;
    c.raw("axisOrigin", v3j(s.axisOrigin)).raw("axisDir", v3j(s.axisDir)).raw("thetaZeroDir", v3j(s.thetaZeroDir)).n("radiusM", std::max(0.01, s.radius))
        .raw("thetaDeg", "[" + sj::num(s.th0) + "," + sj::num(s.th1) + "]").raw("zM", "[" + sj::num(s.z0) + "," + sj::num(s.z1) + "]").i("normalSign", s.normalSign);
    return "{\"cylinder\":" + c.text() + "}";
}

inline std::string frameJson(const Frame& F) {
    sj::Object o;
    o.raw("origin", v3j(F.o)).raw("x", v3j(F.ex)).raw("y", v3j(F.ey)).raw("z", v3j(F.ez));
    return o.text();
}

inline std::string gateJson(const GateRec& g) {
    sj::Object o;
    o.s("gate", g.gate).n("value", g.value).n("threshold", g.threshold).s("comparison", g.le ? "<=" : ">=").b("passed", g.passed()).s("unit", g.unit);
    return o.text();
}

/** The StructureFit JSON (contract scratchbox.structure-fit/2). */
inline std::string structureFitJson(const FitResult& R, const FitRequest& Q, const Outputs& out) {
    sj::Object o;
    o.s("schema", "scratchbox.structure-fit/2").s("buildingId", R.buildingId);
    {
        sj::Object in;
        in.s("scanSha256", Q.scanSha256).i("scanTriangles", static_cast<long long>(Q.inputTriangles ? Q.inputTriangles : R.scan.triangles())).s("scanSource", Q.scanSource);
        if (!Q.texturedSha256.empty()) in.s("texturedSha256", Q.texturedSha256);
        in.raw("anchor", "[" + sj::num(Q.anchorX) + "," + sj::num(Q.anchorZ) + "]");
        if (!Q.refitOf.empty()) in.s("refitOf", Q.refitOf);
        if (R.ownership.used) {
            sj::Object ow;
            ow.i("votedTriangles", static_cast<long long>(R.ownership.voted)).i("structureTriangles", static_cast<long long>(R.ownership.structure))
                .i("otherTriangles", static_cast<long long>(R.ownership.other)).n("otherAreaM2", R.ownership.otherAreaM2);
            in.raw("ownership", ow.text());
        }
        o.raw("input", in.text());
    }
    o.raw("frame", frameJson(R.frame));
    {
        sj::Object g;
        const Vec3 nW = R.frame.dirToWorld(R.groundL.n);
        g.raw("normal", v3j(nW)).n("offsetM", R.groundL.d + nW.dot(R.frame.o) * 0 + R.groundL.n.dot(Vec3(0, 0, 0))).n("tiltDeg", R.groundTiltDeg).n("rmsM", R.groundRms).n("baseY", R.baseY + R.frame.o.y);
        o.raw("ground", g.text());
    }
    {
        // the plan the structure covers: its largest outer loop at the lowest band, less that loop's holes. A passage is open at
        // both ends, so it is no hole: an arch's footprint is its whole plan, the roof over the opening included.
        const auto toTile = [&](const Loop& L) {
            std::vector<P2> pts;
            for (const auto& p : tessellate(L, 0.005)) { const Vec3 w = R.frame.toWorld(Vec3(static_cast<float>(p.x), 0, static_cast<float>(p.y))); pts.push_back(P2(w.x, w.z)); }
            return pts;
        };
        std::vector<P2> outer;
        std::vector<std::vector<P2>> holes;
        double area = 0;
        size_t big = 0;
        double bigArea = -1;
        for (size_t i = 0; i < R.footprint.size(); ++i) {
            const double a = std::fabs(sg::signedArea(toTile(R.footprint[i])));
            if (a > bigArea) { bigArea = a; big = i; }
        }
        if (!R.footprint.empty()) {
            outer = toTile(R.footprint[big]);
            area = bigArea;
            for (const auto& h : R.footprintHoles[big]) { holes.push_back(toTile(h)); area -= std::fabs(sg::signedArea(holes.back())); }
        }
        if (outer.size() < 3 && R.footprintHullTile.size() >= 3) { outer = R.footprintHullTile; area = std::fabs(sg::signedArea(outer)); }
        if (outer.size() < 3) throw ScanFitError("no_structure", "no footprint could be measured: the scan holds no plan");
        sj::Object f;
        f.raw("outer", polyJ(outer));
        if (!holes.empty()) { std::string hs = "["; for (size_t i = 0; i < holes.size(); ++i) hs += (i ? "," : "") + polyJ(holes[i]); hs += "]"; f.raw("holes", hs); }
        f.n("areaM2", std::max(0.0, area));
        o.raw("footprint", f.text());
    }
    {
        sj::Object L;
        L.n("leafGeometricErrorM", R.limits.leafGeometricErrorM).n("meshEdgeP50M", R.limits.meshEdgeP50M).n("meshResolvableM", R.limits.meshResolvableM)
            .n("texelM", R.limits.texelM).n("photoResolvableM", R.limits.photoResolvableM);
        o.raw("sourceLimits", L.text());
    }
    {
        std::vector<std::string> ps;
        for (const auto& pr : R.prims) {
            sj::Object p;
            p.s("id", pr.id).s("label", pr.label).raw("spec", pr.specJson).raw("frame", frameJson(R.frame)).raw("fit", residualJ(pr.fit));
            std::vector<std::string> gs;
            for (const auto& g : pr.gates) gs.push_back(gateJson(g));
            p.raw("gates", sj::array(gs)).b("accepted", pr.accepted);
            p.raw("provenance", provenanceJson(pr.corrected ? "photo-corrected" : "fitted", !pr.corrected, pr.method, pr.corrected ? 0.7 : std::numeric_limits<double>::quiet_NaN(), &pr.fit, pr.correctionNote));
            p.i("buildOrder", pr.buildOrder);
            std::vector<std::string> sids;
            for (int si : pr.surfaces) sids.push_back(sj::str(R.surfaces[static_cast<size_t>(si)].id));
            p.raw("surfaceIds", sj::array(sids));
            std::vector<std::string> fp;
            for (size_t k = 0; k < pr.fitParams.size(); ++k) {
                sj::Object q;
                q.i("index", static_cast<long long>(k)).n("value", pr.fitParams[k]).s("unit", pr.fitParamMeta[k][0]).s("description", pr.fitParamMeta[k][1]);
                fp.push_back(q.text());
            }
            p.raw("fitParams", sj::array(fp));
            std::vector<std::string> cs;
            for (const auto& c : pr.correctable) {
                sj::Object q;
                std::vector<std::string> curve;
                for (const auto& v : c.curve) curve.push_back("[" + sj::num(v[0]) + "," + sj::num(v[1]) + "]");
                q.i("param", c.param).s("key", c.key).n("value", c.value).n("min", c.min).n("max", c.max).s("unit", c.unit).s("description", c.description)
                    .n("toleranceM", std::min(c.toleranceM, 0.31)).raw("residualCurve", sj::array(curve));
                cs.push_back(q.text());
            }
            p.raw("correctable", sj::array(cs));
            std::vector<std::string> as;
            for (const auto& a : pr.alternatives) { sj::Object q; q.raw("spec", a.specJson).raw("fit", residualJ(a.fit)).s("why", a.why); as.push_back(q.text()); }
            p.raw("alternatives", sj::array(as));
            ps.push_back(p.text());
        }
        o.raw("primitives", sj::array(ps));
    }
    {
        std::vector<std::string> ss;
        for (const auto& s : R.surfaces) {
            sj::Object q;
            q.s("id", s.id).s("primitiveId", R.prims[static_cast<size_t>(s.prim)].id).raw("chart", chartJson(s)).n("areaM2", s.area).raw("fit", residualJ(s.fit))
                .n("visibleFraction", std::clamp(s.visibleFraction, 0.0, 1.0)).n("supportFraction", std::clamp(s.supportFraction, 0.0, 1.0)).raw("provenance", surfaceProvenance(R, s));
            ss.push_back(q.text());
        }
        o.raw("surfaces", sj::array(ss));
    }
    {
        std::vector<std::string> sl;
        for (const auto& s : R.slots) {
            sj::Object q;
            q.s("id", s.id).s("label", s.label).s("primitiveId", s.primitiveId);
            if (s.edge) {
                std::vector<std::string> pts;
                double len = 0;
                for (size_t i = 0; i < s.carrier.size(); ++i) { pts.push_back(v3j(s.carrier[i])); if (i) len += (s.carrier[i] - s.carrier[i - 1]).length(); }
                sj::Object carrier;
                carrier.raw("points", sj::array(pts)).b("closed", false).n("lengthM", len);
                std::vector<std::string> sids;
                for (const auto& id : s.surfaceIds) sids.push_back(sj::str(id));
                sj::Object e;
                e.raw("carrier", carrier.text()).raw("surfaceIds", sj::array(sids)).raw("envelope", polyJ(s.envelope));
                q.raw("host", "{\"edge\":" + e.text() + "}");
            } else {
                sj::Object sf;
                sf.s("surfaceId", s.surfaceId).raw("regionUv", polyJ(s.regionUv));
                q.raw("host", "{\"surface\":" + sf.text() + "}");
            }
            q.raw("sizeM", "[" + sj::num(s.sizeU) + "," + sj::num(s.sizeV) + "]");
            sj::Object b;
            b.n("maxProudM", std::max(0.0, s.maxProud)).n("maxRecessM", std::max(0.0, s.maxRecess)).n("minFeatureM", std::max(0.0, s.minFeature));
            q.raw("bounds", b.text());
            sl.push_back(q.text());
        }
        o.raw("slots", sj::array(sl));
    }
    {
        double area = 0;
        size_t tris = 0;
        std::vector<std::string> regs;
        for (const auto& p : R.pass) {
            area += p.area;
            tris += p.tris.size();
            sj::Object q;
            q.s("id", p.id).i("triangles", static_cast<long long>(p.tris.size())).n("areaM2", p.area).raw("aabbMin", v3j(p.lo)).raw("aabbMax", v3j(p.hi)).s("reason", p.reason);
            sj::Object t;
            for (const auto& [k, v] : p.test) t.n(k, v);
            q.raw("test", t.text());
            regs.push_back(q.text());
        }
        sj::Object pt;
        pt.i("triangles", static_cast<long long>(tris)).n("areaM2", area).raw("regions", sj::array(regs));
        o.raw("passThrough", pt.text());
    }
    {
        sj::Object m;
        m.raw("scanToFit", residualJ(R.scanToFit)).raw("fitToScan", residualJ(R.fitToScan)).raw("scanToFitPlusPassThrough", residualJ(R.scanToFitPlusPass))
            .n("coverage", std::clamp(R.coverage, 0.0, 1.0)).n("hausdorffM", R.hausdorff);
        if (R.haveRemesh) m.raw("remeshToScan", residualJ(R.remeshToScan));
        o.raw("metrics", m.text());
    }
    {
        std::vector<std::string> gs;
        for (const auto& g : R.gates) gs.push_back(gateJson(g));
        o.raw("gates", sj::array(gs)).b("accepted", R.accepted);
    }
    {
        sj::Object c;
        c.i("vertices", static_cast<long long>(R.verticesOut)).i("triangles", static_cast<long long>(R.trianglesOut));
        o.raw("counts", c.text());
    }
    {
        sj::Object ou;
        ou.s("fittedGlb", out.fittedGlb).s("outlinesGlb", out.outlinesGlb);
        if (!out.passThroughGlb.empty()) ou.s("passThroughGlb", out.passThroughGlb);
        ou.raw("orthos", sj::array(out.orthoJson)).s("reportJson", out.reportJson);
        o.raw("outputs", ou.text());
    }
    {
        sj::Object t;
        for (const auto& [k, v] : R.timings) t.n(k, v);
        o.raw("timingsMs", t.text());
    }
    return o.text();
}

/** cividis(x), x in [0, 1]: a colour-vision-safe ramp (5 stops, linear between). */
inline std::array<uint8_t, 4> cividis(double x) {
    static const double st[5][3] = {{0, 32, 77}, {64, 76, 107}, {124, 123, 120}, {188, 175, 111}, {253, 231, 55}};
    x = std::clamp(x, 0.0, 1.0) * 4;
    const int i = std::min(3, static_cast<int>(x));
    const double f = x - i;
    std::array<uint8_t, 4> c{};
    for (int k = 0; k < 3; ++k) c[static_cast<size_t>(k)] = static_cast<uint8_t>(std::lround(st[i][k] + f * (st[i + 1][k] - st[i][k])));
    c[3] = 255;
    return c;
}

/** fitted.glb: one node per fitted surface (stage "fit"), in build order. */
inline std::vector<uint8_t> fittedGlb(const FitResult& R, const std::string& stageKey) {
    std::vector<staged_glb::StagedNode> nodes;
    const size_t n = R.surfaces.size();
    for (size_t i = 0; i < n; ++i) {
        const auto& s = R.surfaces[i];
        staged_glb::StagedNode node;
        node.name = s.id;
        staged_glb::StagedPrimitive pr;
        for (const auto& p : s.lpos) pr.positions.push_back(R.frame.toWorld(p));
        for (const auto& q : s.lnrm) pr.normals.push_back(R.frame.dirToWorld(q));
        pr.indices = s.tri;
        node.primitives.push_back(std::move(pr));
        const auto& prim = R.prims[static_cast<size_t>(s.prim)];
        std::string sbJ;
        {
            sj::Object sb;
            sb.s("schema", "scratchbox.staged-node/2").s("stage", "fit").raw("provenance", surfaceProvenance(R, s)).i("buildOrder", static_cast<long long>(i)).i("buildCount", static_cast<long long>(std::max<size_t>(1, n)))
                .s("revealKind", "crossfade").raw("reveal", "{\"attribute\":null,\"displacement\":null,\"durationShare\":1}");
            sj::Object ids;
            ids.s("primitiveId", prim.id).s("surfaceId", s.id);
            sb.raw("ids", ids.text());
            if (s.fit.samples > 0) sb.raw("fitError", residualJ(s.fit));
            sj::Object c;
            c.i("vertices", static_cast<long long>(s.lpos.size())).i("triangles", static_cast<long long>(s.tri.size() / 3));
            sb.raw("counts", c.text());
            sbJ = sb.text();
        }
        node.extrasJson = "{\"sb\":" + sbJ + "}";
        nodes.push_back(std::move(node));
    }
    staged_glb::WriteOptions opt;
    opt.generator = "Scratchbox scan_fit (fitted rebuild)";
    opt.rootName = "scan_fit_rebuild";
    opt.rootExtrasJson = staged_glb::rootExtrasJson("fit", stageKey, "tile frame: x east, y up, z south (metres)", R.buildingId);
    return staged_glb::write(nodes, opt);
}

/** outlines.glb: one LINES node per primitive, its creases coloured by the local fit error (cividis over 0..10 cm). */
inline std::vector<uint8_t> outlinesGlb(const FitResult& R, const std::string& stageKey) {
    std::vector<staged_glb::StagedNode> nodes;
    const size_t n = R.prims.size();
    for (size_t i = 0; i < n; ++i) {
        const auto& pr = R.prims[i];
        staged_glb::StagedNode node;
        node.name = pr.id + "_outline";
        staged_glb::StagedPrimitive lp;
        lp.mode = 1;
        const auto col = cividis(std::min(1.0, pr.fit.rms / 0.10));
        const float x = staged_glb::rankUnit(i, n);
        for (const auto& c : pr.creases) {
            const uint32_t b = static_cast<uint32_t>(lp.positions.size());
            lp.positions.push_back(R.frame.toWorld(c[0]));
            lp.positions.push_back(R.frame.toWorld(c[1]));
            lp.colors.push_back(col); lp.colors.push_back(col);
            lp.reveal.push_back({x, 0}); lp.reveal.push_back({x, 0});
            lp.indices.push_back(b); lp.indices.push_back(b + 1);
        }
        const size_t segs = lp.indices.size() / 2;
        if (segs) node.primitives.push_back(std::move(lp));
        sj::Object sb;
        sb.s("schema", "scratchbox.staged-node/2").s("stage", "fit")
            .raw("provenance", provenanceJson(pr.corrected ? "photo-corrected" : "fitted", !pr.corrected, pr.method, pr.corrected ? 0.7 : std::numeric_limits<double>::quiet_NaN(), &pr.fit, pr.correctionNote))
            .i("buildOrder", static_cast<long long>(i)).i("buildCount", static_cast<long long>(std::max<size_t>(1, n))).s("revealKind", "outline")
            .raw("reveal", segs ? "{\"attribute\":\"_REVEAL\",\"displacement\":null,\"durationShare\":1}" : "{\"attribute\":null,\"displacement\":null,\"durationShare\":1}");
        sj::Object ids;
        ids.s("primitiveId", pr.id);
        sb.raw("ids", ids.text());
        if (pr.fit.samples > 0) sb.raw("fitError", residualJ(pr.fit));
        sj::Object c;
        c.i("vertices", static_cast<long long>(2 * segs)).i("triangles", 0).i("lines", static_cast<long long>(segs));
        sb.raw("counts", c.text());
        node.extrasJson = "{\"sb\":" + sb.text() + "}";
        nodes.push_back(std::move(node));
    }
    staged_glb::WriteOptions opt;
    opt.generator = "Scratchbox scan_fit (fitted outlines)";
    opt.rootName = "scan_fit_outlines";
    opt.rootExtrasJson = staged_glb::rootExtrasJson("fit", stageKey, "tile frame: x east, y up, z south (metres)", R.buildingId);
    return staged_glb::write(nodes, opt);
}

/** passthrough.glb: one node per region, the scan's own triangles (as-scanned). */
inline std::vector<uint8_t> passThroughGlb(const FitResult& R, const std::string& stageKey) {
    std::vector<staged_glb::StagedNode> nodes;
    const size_t n = R.pass.size();
    for (size_t i = 0; i < n; ++i) {
        const auto& p = R.pass[i];
        staged_glb::StagedNode node;
        node.name = p.id;
        staged_glb::StagedPrimitive pr;
        for (uint32_t t : p.tris) for (int j = 0; j < 3; ++j) { pr.indices.push_back(static_cast<uint32_t>(pr.positions.size())); pr.positions.push_back(R.scan.pos[R.scan.tri[3 * t + j]]); }
        node.primitives.push_back(std::move(pr));
        sj::Object sb;
        sb.s("schema", "scratchbox.staged-node/2").s("stage", "fit")
            .raw("provenance", provenanceJson("as-scanned", true, "scan_fit: a residual region of the scan the fit could not explain as a box, kept as scanned", std::numeric_limits<double>::quiet_NaN(), nullptr, p.reason))
            .i("buildOrder", static_cast<long long>(i)).i("buildCount", static_cast<long long>(std::max<size_t>(1, n))).s("revealKind", "crossfade")
            .raw("reveal", "{\"attribute\":null,\"displacement\":null,\"durationShare\":1}").raw("ids", "{}");
        sj::Object c;
        c.i("vertices", static_cast<long long>(3 * p.tris.size())).i("triangles", static_cast<long long>(p.tris.size()));
        sb.raw("counts", c.text());
        node.extrasJson = "{\"regionId\":" + sj::str(p.id) + ",\"sb\":" + sb.text() + "}";
        nodes.push_back(std::move(node));
    }
    staged_glb::WriteOptions opt;
    opt.generator = "Scratchbox scan_fit (pass-through)";
    opt.rootName = "scan_fit_pass_through";
    opt.rootExtrasJson = staged_glb::rootExtrasJson("fit", stageKey, "tile frame: x east, y up, z south (metres)", R.buildingId);
    return staged_glb::write(nodes, opt);
}

} // namespace scan_fit
} // namespace scratchbox

#endif // SCRATCHBOX_SCAN_FIT_HPP
