/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_STAGED_MASSING_HPP
#define SCRATCHBOX_STAGED_MASSING_HPP

/**
 * Staged-location pipeline E, the native half: a clean massing solid from continuous parameters, its faces textured by
 * orthographic renders of the photo tile, and the scan's residual detail.
 *
 *   - Massing. Prism parts (plan loops in the tile frame x east / z south, a base and a top height, optional roof planes
 *     y = a + b x + c z whose lower envelope, capped at the top, is the roof) and triangle solids (a modelled volume, used
 *     as given). Walls are planar and meet at the plan's corners; a wall whose outside is another part's inside is cut down
 *     to what stands above that part (or dropped), so the union of parts is closed. Walls may be moved onto the facade the
 *     scan measures (`snap`): per wall, the area-weighted mode of the scan's outward-facing vertical surface within the snap
 *     distance, and the corners re-intersected.
 *   - Faces. Every wall, roof region and planar facet of a solid is a face with an orthonormal frame (normal, s right,
 *     t up when seen from outside). Openings are rectangles in a wall's (s, t): a recess `depth` deep with four reveals,
 *     or, for openings the scan shows (a passage cut into the solid), a plain hole the scanned residual fills.
 *   - Profile sweeps (bands, parapets): a profile in (outward offset, height) swept along consecutive walls with mitred
 *     corners, capped where the chain ends.
 *   - Ortho bake. Per face, every tile triangle facing out of it inside a thin slab [-slabBack, slabFront] about its plane
 *     is projected along the normal; the outermost one per pixel gives the colour (and the depth). A second pass records the
 *     outermost surface within [-slabBack, protrusionReach]: what stands proud of the face (cornices, awnings, crowns).
 *   - Residual. The tile triangles of the isolated scan (matched to its clay by centroid) are classified against the closed
 *     solid: clearly proud (outside, further than `residualProud`), clearly cut in (inside, deeper than `residualCut`), the
 *     ground apron (outside the plan, near the base) or explained by the solid. Proud and cut clusters above
 *     `residualMinArea` stay as scanned detail with their tile photo; a cut cluster reaching a wall opens that wall.
 *   - Sections (side-on renders through each large wall: the scan's protrusion profile over height) and a top-down render
 *     with its height map, for the inference steps in TypeScript.
 *
 * Nothing here names a kind of building or part: parts are loops and numbers, labels are opaque tokens passed through.
 */

#include "scratchbox_gltf_scene.hpp"
#include "scratchbox_png.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <functional>
#include <limits>
#include <map>
#include <numeric>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

namespace scratchbox {
namespace staged_massing {

struct V3 {
    double x{0}, y{0}, z{0};
    V3() = default;
    V3(double a, double b, double c) : x(a), y(b), z(c) {}
    V3 operator+(const V3& o) const { return {x + o.x, y + o.y, z + o.z}; }
    V3 operator-(const V3& o) const { return {x - o.x, y - o.y, z - o.z}; }
    V3 operator*(double k) const { return {x * k, y * k, z * k}; }
    double dot(const V3& o) const { return x * o.x + y * o.y + z * o.z; }
    V3 cross(const V3& o) const { return {y * o.z - z * o.y, z * o.x - x * o.z, x * o.y - y * o.x}; }
    double len() const { return std::sqrt(dot(*this)); }
    V3 unit() const { double l = len(); return l > 1e-15 ? (*this) * (1.0 / l) : V3{0, 1, 0}; }
};
struct V2 { double x{0}, z{0}; };

/** y = a + b x + c z over the plan. */
struct RoofPlane { double a{0}, b{0}, c{0}; std::string tag; double at(double x, double z) const { return a + b * x + c * z; } };

struct Part {
    std::string id, provenance;
    double baseY{0}, topY{0};
    /** First loop outer, the rest holes (any orientation). */
    std::vector<std::vector<V2>> loops;
    std::vector<RoofPlane> planes;
    double roofAt(double x, double z) const {
        double y = topY;
        for (const auto& p : planes) y = std::min(y, p.at(x, z));
        return std::max(y, baseY + 0.25);
    }
};

struct MeshSolid { std::string id, provenance; std::vector<V3> v; std::vector<uint32_t> tri; };

/** A profile (outward offset, height: absolute y, or above each wall's own top with relativeToTop) swept along walls (wall keys, any order; split walls resolve to their pieces). */
struct SweepSpec { std::string id, provenance; double confidence{0}; std::vector<std::pair<double, double>> profile; std::vector<std::string> faces; bool relativeToTop{false}; };

/**
 * An opening in a wall's (s, t): a rectangle [s0, s1] x [t0, t1], or, with `archRise` > 0, a rectangle up to t1 - archRise
 * crowned by a circular arc from (s0, t1 - archRise) through (mid, t1) to (s1, t1 - archRise) (a semicircle at half the width,
 * a segmental arch below that; clamped to half the width). Arches are cut on extruded walls; a modelled volume's facet keeps
 * the rectangle.
 */
struct OpeningSpec { std::string id, face, provenance; double s0{0}, s1{0}, t0{0}, t1{0}, depth{0}, confidence{0}, archRise{0}; bool scanned{false}; };

/**
 * A profile swept along one axis of a face's own frame (a curve sweep on the face plane): `axis` 0 sweeps along s with the
 * profile in (offset along the normal, t), 1 along t with the profile in (offset, s). The profile is a function
 * offset(c) >= 0 sampled at increasing c; the solid is 0 <= offset' <= offset(c), its back on the face. Each placement
 * (a0, a1, dc) sweeps it from a0 to a1 with the profile's c shifted by dc; the ends are capped.
 */
struct FaceSweepSpec { std::string id, provenance, face; double confidence{0}; int axis{0}; std::vector<std::pair<double, double>> profile; std::vector<std::array<double, 3>> placements; };

struct Spec {
    std::string tile, isolate, outDir;
    double pixel{0.05}, slabBack{1.5}, slabFront{0.8}, protrusionReach{2.5};
    double snapMaxM{2.0}, snapMinSupport{0.15};
    /** Walls snapped here (off when the caller placed them on fitted planes already; modelled volumes still snap). */
    bool snapWalls{true};
    /**
     * Openings and face sweeps on an edge this solid split in pieces are clipped to every piece they overlap (each piece
     * its own copy, id <id>:<k>), and to the part of a wall a neighbour part does not cover, instead of rejected when they
     * cross a piece's end or reach below its raised bottom. Off by default (callers placing openings on a known piece).
     */
    bool clipOpenings{false};
    double residualProud{0.6}, residualCut{0.6}, residualClear{1.5}, residualOpen{2.0}, residualMinArea{2.0}, apronHeight{0.8}, attachReach{1.5};
    double maxFaceSide{3000};
    /**
     * A wall the slab hardly sees (coverage under reslabBelow) is baked again about the depth where the tile's photo surface
     * facing it lies (the projected-area mode within +-reslabReach of its plane), when that covers more: a modelled volume
     * is moved as a whole, so one of its walls can stand a few metres off the facade the scan measures. 0 turns it off.
     */
    double reslabBelow{0.35}, reslabReach{4.0};
    bool bake{true}, residual{true}, sections{true}, topdown{true};
    std::vector<Part> parts;
    std::vector<MeshSolid> meshes;
    std::vector<SweepSpec> sweeps;
    std::vector<OpeningSpec> openings;
    std::vector<FaceSweepSpec> faceSweeps;
};

/** A planar face of the solid: frame, polygon in its (s, t), triangles. */
struct Face {
    std::string key, kind, provenance;
    V3 n, axisS, axisT, origin;
    /** Wall faces: the polygon is a bottom at tBottom between sA and sB and a top polyline over [sA, sB]. */
    bool wall{false};
    double tBottom{0};
    std::vector<std::pair<double, double>> top;  // (s, t), s ascending
    /** Roof / facet faces: outer and hole loops in (s, t). */
    std::vector<std::vector<std::pair<double, double>>> loops;
    /** Mesh facets keep their own triangles (world). */
    std::vector<V3> meshTris;
    std::vector<int> openings;  // indices into Spec::openings
    double sMin{1e300}, sMax{-1e300}, tMin{1e300}, tMax{-1e300};
    double area{0};
    std::string part;  // owning part / mesh id
    int loop{-1}, edge{-1};
    // ortho image frame
    double pixel{0}, orthoSMin{0}, orthoTMax{0};
    int width{0}, height{0};
    double coverage{0};
    /** Where the slab the texture was baked through is centred along the normal (0: the face's own plane). */
    double textureOffset{0};
    V3 at(double s, double t) const { return origin + axisS * s + axisT * t; }
    void st(const V3& p, double& s, double& t) const { V3 d = p - origin; s = d.dot(axisS); t = d.dot(axisT); }
};

/** Output vertex: position, normal, the face whose ortho textures it (and its (s, t)) or a tile image (and its uv). */
struct OutVertex { V3 p, n; int face{-1}; double s{0}, t{0}; int image{-1}; double u{0}, v{0}; };
struct OutNode { std::string name, kind, provenance; double confidence{-1}; std::vector<OutVertex> v; std::vector<uint32_t> idx; };

namespace detail {

inline std::string fmt(double v) {
    if (!std::isfinite(v)) return "null";
    char b[64];
    std::snprintf(b, sizeof b, "%.6g", v);
    return b;
}
inline std::string jstr(const std::string& s) {
    std::string o = "\"";
    for (char c : s) {
        if (c == '"' || c == '\\') { o += '\\'; o += c; }
        else if (c == '\n') o += "\\n";
        else if (static_cast<unsigned char>(c) < 0x20) o += ' ';
        else o += c;
    }
    return o + "\"";
}
inline double nowMs() { return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count(); }

inline double ringArea(const std::vector<V2>& r) {
    double a = 0;
    for (size_t i = 0, j = r.size() - 1; i < r.size(); j = i++) a += r[j].x * r[i].z - r[i].x * r[j].z;
    return 0.5 * a;
}
inline bool inRing(double x, double z, const std::vector<V2>& r) {
    bool in = false;
    for (size_t i = 0, j = r.size() - 1; i < r.size(); j = i++) {
        if ((r[i].z > z) != (r[j].z > z) && x < (r[j].x - r[i].x) * (z - r[i].z) / (r[j].z - r[i].z) + r[i].x) in = !in;
    }
    return in;
}
inline bool inPart(const Part& p, double x, double z) {
    bool in = false;
    for (const auto& l : p.loops) if (l.size() >= 3 && inRing(x, z, l)) in = !in;
    return in;
}

/** Twice the signed area of a (s, t) loop. */
inline double loopArea2(const std::vector<std::pair<double, double>>& l) {
    double a = 0;
    for (size_t i = 0, j = l.size() - 1; i < l.size(); j = i++) a += l[j].first * l[i].second - l[i].first * l[j].second;
    return a;
}

/**
 * Ear clipping of one outer loop with holes (each hole joined to the outer loop by a bridge to the nearest visible outer
 * vertex). Returns triangles as indices into the concatenated input points; counter-clockwise output.
 */
inline std::vector<std::array<int, 3>> triangulate(const std::vector<std::vector<std::pair<double, double>>>& loops, std::vector<std::pair<double, double>>& pts) {
    pts.clear();
    std::vector<std::array<int, 3>> out;
    if (loops.empty() || loops[0].size() < 3) return out;
    auto push = [&](const std::vector<std::pair<double, double>>& l, bool ccw) {
        std::vector<int> ids;
        int base = static_cast<int>(pts.size());
        for (const auto& p : l) pts.push_back(p);
        for (size_t i = 0; i < l.size(); ++i) ids.push_back(base + static_cast<int>(i));
        if ((loopArea2(l) > 0) != ccw) std::reverse(ids.begin(), ids.end());
        return ids;
    };
    std::vector<int> poly = push(loops[0], true);
    auto segCross = [&](int a, int b, int c, int d) {
        auto o = [&](int p, int q, int r) {
            double v = (pts[q].first - pts[p].first) * (pts[r].second - pts[p].second) - (pts[q].second - pts[p].second) * (pts[r].first - pts[p].first);
            return v > 1e-12 ? 1 : (v < -1e-12 ? -1 : 0);
        };
        if (a == c || a == d || b == c || b == d) return false;
        return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
    };
    // holes: rightmost first
    std::vector<std::vector<int>> holes;
    for (size_t h = 1; h < loops.size(); ++h) if (loops[h].size() >= 3) holes.push_back(push(loops[h], false));
    std::sort(holes.begin(), holes.end(), [&](const std::vector<int>& a, const std::vector<int>& b) {
        double ma = -1e300, mb = -1e300;
        for (int i : a) ma = std::max(ma, pts[i].first);
        for (int i : b) mb = std::max(mb, pts[i].first);
        return ma > mb;
    });
    for (const auto& hole : holes) {
        size_t hi = 0;
        for (size_t k = 1; k < hole.size(); ++k) if (pts[hole[k]].first > pts[hole[hi]].first) hi = k;
        int hv = hole[hi];
        // nearest polygon vertex whose bridge crosses no edge
        int best = -1;
        double bestD = 1e300;
        for (size_t k = 0; k < poly.size(); ++k) {
            int pv = poly[k];
            double d = std::hypot(pts[pv].first - pts[hv].first, pts[pv].second - pts[hv].second);
            if (d >= bestD) continue;
            bool ok = true;
            for (size_t e = 0; e < poly.size() && ok; ++e) if (segCross(hv, pv, poly[e], poly[(e + 1) % poly.size()])) ok = false;
            for (const auto& h2 : holes) for (size_t e = 0; e < h2.size() && ok; ++e) if (segCross(hv, pv, h2[e], h2[(e + 1) % h2.size()])) ok = false;
            if (ok) { best = static_cast<int>(k); bestD = d; }
        }
        if (best < 0) continue;  // a hole with no visible bridge is left closed
        std::vector<int> merged(poly.begin(), poly.begin() + best + 1);
        for (size_t k = 0; k <= hole.size(); ++k) merged.push_back(hole[(hi + k) % hole.size()]);
        merged.push_back(poly[static_cast<size_t>(best)]);
        merged.insert(merged.end(), poly.begin() + best + 1, poly.end());
        poly.swap(merged);
    }
    auto cross = [&](int a, int b, int c) {
        return (pts[b].first - pts[a].first) * (pts[c].second - pts[a].second) - (pts[b].second - pts[a].second) * (pts[c].first - pts[a].first);
    };
    auto inside = [&](int p, int a, int b, int c) {
        if (p == a || p == b || p == c) return false;
        if (pts[p] == pts[a] || pts[p] == pts[b] || pts[p] == pts[c]) return false;
        return cross(a, b, p) >= -1e-12 && cross(b, c, p) >= -1e-12 && cross(c, a, p) >= -1e-12;
    };
    std::vector<int> v = poly;
    size_t guard = 0;
    while (v.size() > 3 && guard < 100000) {
        bool clipped = false;
        for (size_t i = 0; i < v.size(); ++i) {
            int a = v[(i + v.size() - 1) % v.size()], b = v[i], c = v[(i + 1) % v.size()];
            if (cross(a, b, c) <= 1e-12) continue;
            bool ear = true;
            for (int p : v) if (inside(p, a, b, c)) { ear = false; break; }
            if (!ear) continue;
            out.push_back({a, b, c});
            v.erase(v.begin() + static_cast<long>(i));
            clipped = true;
            break;
        }
        if (!clipped) {
            // degenerate remainder (collinear runs): drop the flattest vertex and go on
            size_t worst = 0;
            double wv = 1e300;
            for (size_t i = 0; i < v.size(); ++i) {
                double c = std::abs(cross(v[(i + v.size() - 1) % v.size()], v[i], v[(i + 1) % v.size()]));
                if (c < wv) { wv = c; worst = i; }
            }
            v.erase(v.begin() + static_cast<long>(worst));
        }
        ++guard;
    }
    if (v.size() == 3 && cross(v[0], v[1], v[2]) > 1e-12) out.push_back({v[0], v[1], v[2]});
    return out;
}

/** Sutherland-Hodgman clip of a loop to the half plane k0 + kx x + kz z <= 0. */
inline std::vector<V2> clipHalf(const std::vector<V2>& in, double k0, double kx, double kz) {
    std::vector<V2> out;
    if (in.empty()) return out;
    auto f = [&](const V2& p) { return k0 + kx * p.x + kz * p.z; };
    for (size_t i = 0; i < in.size(); ++i) {
        const V2& a = in[i];
        const V2& b = in[(i + 1) % in.size()];
        double fa = f(a), fb = f(b);
        if (fa <= 0) out.push_back(a);
        if ((fa <= 0) != (fb <= 0)) {
            double t = fa / (fa - fb);
            out.push_back({a.x + t * (b.x - a.x), a.z + t * (b.z - a.z)});
        }
    }
    return out;
}

inline double sqr(double v) { return v * v; }

/** Closest distance from p to triangle abc. */
inline double pointTriDist(const V3& p, const V3& a, const V3& b, const V3& c) {
    V3 ab = b - a, ac = c - a, ap = p - a;
    double d1 = ab.dot(ap), d2 = ac.dot(ap);
    if (d1 <= 0 && d2 <= 0) return ap.len();
    V3 bp = p - b;
    double d3 = ab.dot(bp), d4 = ac.dot(bp);
    if (d3 >= 0 && d4 <= d3) return bp.len();
    double vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) { double v = d1 / (d1 - d3); return (p - (a + ab * v)).len(); }
    V3 cp = p - c;
    double d5 = ab.dot(cp), d6 = ac.dot(cp);
    if (d6 >= 0 && d5 <= d6) return cp.len();
    double vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) { double w = d2 / (d2 - d6); return (p - (a + ac * w)).len(); }
    double va = d3 * d6 - d5 * d4;
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) { double w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return (p - (b + (c - b) * w)).len(); }
    double denom = 1.0 / (va + vb + vc);
    double v = vb * denom, w = vc * denom;
    return (p - (a + ab * v + ac * w)).len();
}

inline int wrapCoord(int i, int n, int mode) {
    if (mode == 33071) return std::clamp(i, 0, n - 1);
    if (mode == 33648) { int p = 2 * n; int m = ((i % p) + p) % p; return m < n ? m : p - 1 - m; }
    return ((i % n) + n) % n;
}
inline void sampleBilinear(const texture::ImageBuffer& img, double u, double v, int wrapS, int wrapT, double out[3]) {
    const int W = img.width, H = img.height, ch = img.channels;
    double x = u * W - 0.5, y = v * H - 0.5;
    int x0 = static_cast<int>(std::floor(x)), y0 = static_cast<int>(std::floor(y));
    double fx = x - x0, fy = y - y0;
    int xs[2] = {wrapCoord(x0, W, wrapS), wrapCoord(x0 + 1, W, wrapS)};
    int ys[2] = {wrapCoord(y0, H, wrapT), wrapCoord(y0 + 1, H, wrapT)};
    double w[4] = {(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy};
    out[0] = out[1] = out[2] = 0;
    for (int k = 0; k < 4; ++k) {
        size_t idx = (static_cast<size_t>(ys[k >> 1]) * W + xs[k & 1]) * ch;
        for (int c = 0; c < 3; ++c) out[c] += w[k] * img.data[idx + (ch == 1 ? 0 : c)] / 255.0;
    }
}

inline void writeFile(const std::string& path, const void* data, size_t n) {
    std::ofstream f(path, std::ios::binary);
    if (!f) throw std::runtime_error("cannot write " + path);
    f.write(reinterpret_cast<const char*>(data), static_cast<std::streamsize>(n));
}
inline void writePng(const std::string& path, const texture::ImageBuffer& img, int level = 3) {
    auto bytes = png::encode(img, level);
    writeFile(path, bytes.data(), bytes.size());
}

}  // namespace detail

/** The tile as triangles with their texture sampling, plus a coarse 3D grid for range queries. */
struct TileSource {
    gltf::GltfScene scene;
    std::vector<V3> p;  // 3 per triangle
    std::vector<V3> n;  // unit normal per triangle
    std::vector<double> area;
    size_t triCount{0};
    double cell{4.0};
    V3 lo, hi;
    int nx{0}, ny{0}, nz{0};
    std::vector<std::vector<uint32_t>> grid;

    bool load(const std::string& path, std::string& err) {
        scene = gltf::GlbSceneReader::readFile(path);
        if (!scene.ok) { err = scene.error.empty() ? "cannot read " + path : scene.error; return false; }
        const auto& vs = scene.mesh.vertices;
        const auto& ix = scene.mesh.indices;
        triCount = ix.size() / 3;
        p.resize(triCount * 3);
        n.resize(triCount);
        area.resize(triCount);
        lo = {1e300, 1e300, 1e300};
        hi = {-1e300, -1e300, -1e300};
        for (size_t t = 0; t < triCount; ++t) {
            for (int k = 0; k < 3; ++k) {
                const auto& q = vs[ix[3 * t + k]].position;
                V3 v{q.x, q.y, q.z};
                p[3 * t + k] = v;
                lo = {std::min(lo.x, v.x), std::min(lo.y, v.y), std::min(lo.z, v.z)};
                hi = {std::max(hi.x, v.x), std::max(hi.y, v.y), std::max(hi.z, v.z)};
            }
            V3 c = (p[3 * t + 1] - p[3 * t]).cross(p[3 * t + 2] - p[3 * t]);
            area[t] = 0.5 * c.len();
            n[t] = c.unit();
        }
        if (!triCount) { err = "the tile has no triangles"; return false; }
        nx = std::max(1, static_cast<int>(std::ceil((hi.x - lo.x) / cell)) + 1);
        ny = std::max(1, static_cast<int>(std::ceil((hi.y - lo.y) / cell)) + 1);
        nz = std::max(1, static_cast<int>(std::ceil((hi.z - lo.z) / cell)) + 1);
        grid.assign(static_cast<size_t>(nx) * ny * nz, {});
        for (size_t t = 0; t < triCount; ++t) {
            V3 a = p[3 * t], b = p[3 * t + 1], c = p[3 * t + 2];
            int x0 = cx(std::min({a.x, b.x, c.x})), x1 = cx(std::max({a.x, b.x, c.x}));
            int y0 = cy(std::min({a.y, b.y, c.y})), y1 = cy(std::max({a.y, b.y, c.y}));
            int z0 = cz(std::min({a.z, b.z, c.z})), z1 = cz(std::max({a.z, b.z, c.z}));
            for (int i = x0; i <= x1; ++i) for (int j = y0; j <= y1; ++j) for (int k = z0; k <= z1; ++k) grid[(static_cast<size_t>(k) * ny + j) * nx + i].push_back(static_cast<uint32_t>(t));
        }
        return true;
    }
    int cx(double v) const { return std::clamp(static_cast<int>((v - lo.x) / cell), 0, nx - 1); }
    int cy(double v) const { return std::clamp(static_cast<int>((v - lo.y) / cell), 0, ny - 1); }
    int cz(double v) const { return std::clamp(static_cast<int>((v - lo.z) / cell), 0, nz - 1); }
    /** Triangles whose box may meet [a, b] (each once). */
    std::vector<uint32_t> query(const V3& a, const V3& b) const {
        std::vector<uint32_t> out;
        std::vector<uint8_t> seen;
        int x0 = cx(a.x), x1 = cx(b.x), y0 = cy(a.y), y1 = cy(b.y), z0 = cz(a.z), z1 = cz(b.z);
        if (b.x < lo.x || a.x > hi.x || b.y < lo.y || a.y > hi.y || b.z < lo.z || a.z > hi.z) return out;
        seen.assign(triCount, 0);
        for (int i = x0; i <= x1; ++i) for (int j = y0; j <= y1; ++j) for (int k = z0; k <= z1; ++k)
            for (uint32_t t : grid[(static_cast<size_t>(k) * ny + j) * nx + i]) if (!seen[t]) { seen[t] = 1; out.push_back(t); }
        return out;
    }
    /** The photo colour at barycentric (w0, w1, w2) of triangle t (0..1 RGB). */
    void colour(size_t t, double w0, double w1, double w2, double rgb[3]) const {
        const auto& vs = scene.mesh.vertices;
        const auto& ix = scene.mesh.indices;
        uint32_t mat = t < scene.triangleMaterial.size() ? scene.triangleMaterial[t] : 0;
        const gltf::SceneMaterial* sm = mat < scene.materials.size() ? &scene.materials[mat] : nullptr;
        if (sm && sm->baseColorImage >= 0 && sm->baseColorImage < static_cast<int>(scene.images.size()) && scene.images[static_cast<size_t>(sm->baseColorImage)].decoded) {
            const auto& a = vs[ix[3 * t]].uv;
            const auto& b = vs[ix[3 * t + 1]].uv;
            const auto& c = vs[ix[3 * t + 2]].uv;
            detail::sampleBilinear(scene.images[static_cast<size_t>(sm->baseColorImage)].pixels, w0 * a.x + w1 * b.x + w2 * c.x, w0 * a.y + w1 * b.y + w2 * c.y, sm->wrapS, sm->wrapT, rgb);
        } else {
            rgb[0] = sm ? sm->baseColorFactor.x : 0.7;
            rgb[1] = sm ? sm->baseColorFactor.y : 0.7;
            rgb[2] = sm ? sm->baseColorFactor.z : 0.7;
        }
    }
    int imageOf(size_t t) const {
        uint32_t mat = t < scene.triangleMaterial.size() ? scene.triangleMaterial[t] : 0;
        return mat < scene.materials.size() ? scene.materials[mat].baseColorImage : -1;
    }
    /** Whether triangle t carries a photo (a decoded base-colour image). The tile's own triangles all do; surfaces a stage
     *  added without one (the vegetation strip's caps and skirts where trees were taken out) do not, and are not a photo. */
    bool hasPhoto(size_t t) const {
        int img = imageOf(t);
        if (!(img >= 0 && img < static_cast<int>(scene.images.size()) && scene.images[static_cast<size_t>(img)].decoded)) return false;
        // the strip's fill of its caps and skirts is carried from neighbouring texels, not the scan's photo of that surface
        const uint32_t mat = t < scene.triangleMaterial.size() ? scene.triangleMaterial[t] : 0;
        return !(mat < scene.materials.size() && scene.materials[mat].photoInferredFill);
    }
};

/** The closed solid's triangles with a vertical-ray grid (inside test) and a 3D grid (distance). */
struct SolidIndex {
    std::vector<V3> p;
    double cell{1.0};
    V3 lo, hi;
    int nx{0}, ny{0}, nz{0};
    std::vector<std::vector<uint32_t>> col;   // xz columns
    std::vector<std::vector<uint32_t>> vox;   // 3D cells
    void build(const std::vector<V3>& tris) {
        p = tris;
        lo = {1e300, 1e300, 1e300};
        hi = {-1e300, -1e300, -1e300};
        for (const auto& v : p) { lo = {std::min(lo.x, v.x), std::min(lo.y, v.y), std::min(lo.z, v.z)}; hi = {std::max(hi.x, v.x), std::max(hi.y, v.y), std::max(hi.z, v.z)}; }
        lo = lo - V3{4, 4, 4};
        hi = hi + V3{4, 4, 4};
        nx = static_cast<int>(std::ceil((hi.x - lo.x) / cell)) + 1;
        ny = static_cast<int>(std::ceil((hi.y - lo.y) / cell)) + 1;
        nz = static_cast<int>(std::ceil((hi.z - lo.z) / cell)) + 1;
        col.assign(static_cast<size_t>(nx) * nz, {});
        vox.assign(static_cast<size_t>(nx) * ny * nz, {});
        for (size_t t = 0; t < p.size() / 3; ++t) {
            V3 a = p[3 * t], b = p[3 * t + 1], c = p[3 * t + 2];
            int x0 = ix(std::min({a.x, b.x, c.x})), x1 = ix(std::max({a.x, b.x, c.x}));
            int y0 = iy(std::min({a.y, b.y, c.y})), y1 = iy(std::max({a.y, b.y, c.y}));
            int z0 = iz(std::min({a.z, b.z, c.z})), z1 = iz(std::max({a.z, b.z, c.z}));
            for (int i = x0; i <= x1; ++i) for (int k = z0; k <= z1; ++k) {
                col[static_cast<size_t>(k) * nx + i].push_back(static_cast<uint32_t>(t));
                for (int j = y0; j <= y1; ++j) vox[(static_cast<size_t>(k) * ny + j) * nx + i].push_back(static_cast<uint32_t>(t));
            }
        }
    }
    int ix(double v) const { return std::clamp(static_cast<int>((v - lo.x) / cell), 0, nx - 1); }
    int iy(double v) const { return std::clamp(static_cast<int>((v - lo.y) / cell), 0, ny - 1); }
    int iz(double v) const { return std::clamp(static_cast<int>((v - lo.z) / cell), 0, nz - 1); }
    /** Parity of the crossings of the upward vertical ray (a tiny xz jitter keeps it off shared edges). */
    bool inside(const V3& q0) const {
        if (q0.x < lo.x || q0.x > hi.x || q0.z < lo.z || q0.z > hi.z) return false;
        V3 q{q0.x + 1.234e-5, q0.y, q0.z + 2.345e-5};
        int hits = 0;
        for (uint32_t t : col[static_cast<size_t>(iz(q.z)) * nx + ix(q.x)]) {
            const V3 &a = p[3 * t], &b = p[3 * t + 1], &c = p[3 * t + 2];
            double d = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
            if (std::abs(d) < 1e-14) continue;
            double l1 = ((b.z - c.z) * (q.x - c.x) + (c.x - b.x) * (q.z - c.z)) / d;
            double l2 = ((c.z - a.z) * (q.x - c.x) + (a.x - c.x) * (q.z - c.z)) / d;
            double l3 = 1 - l1 - l2;
            if (l1 < 0 || l2 < 0 || l3 < 0) continue;
            if (l1 * a.y + l2 * b.y + l3 * c.y > q.y) ++hits;
        }
        return hits & 1;
    }
    /** Distance to the surface, searched up to `reach` (returns reach when nothing is nearer). */
    double distance(const V3& q, double reach) const {
        double best = reach;
        int r = static_cast<int>(std::ceil(reach / cell));
        int i0 = ix(q.x), j0 = iy(q.y), k0 = iz(q.z);
        for (int i = std::max(0, i0 - r); i <= std::min(nx - 1, i0 + r); ++i)
            for (int j = std::max(0, j0 - r); j <= std::min(ny - 1, j0 + r); ++j)
                for (int k = std::max(0, k0 - r); k <= std::min(nz - 1, k0 + r); ++k)
                    for (uint32_t t : vox[(static_cast<size_t>(k) * ny + j) * nx + i]) best = std::min(best, detail::pointTriDist(q, p[3 * t], p[3 * t + 1], p[3 * t + 2]));
        return best;
    }
};

struct SnapRecord { std::string part; int loop{0}, edge{0}; double lengthM{0}, offsetM{0}, supportM2{0}, supportShare{0}; bool applied{false}; };
struct ResidualCluster { std::string kind; double areaM2{0}, extremeM{0}; size_t triangles{0}; V3 lo, hi; std::string face; double s0{0}, s1{0}, t0{0}, t1{0}; bool opensFace{false}; };

class StagedMassing {
public:
    explicit StagedMassing(Spec s) : spec_(std::move(s)) {}

    /** Runs everything the spec asks for and writes the outputs into spec.outDir. Throws on bad input. */
    void run() {
        const double t0 = detail::nowMs();
        std::string err;
        if (!spec_.tile.empty()) {
            if (!tile_.load(spec_.tile, err)) throw std::runtime_error("tile: " + err);
            haveTile_ = true;
        }
        timings_.push_back({"load_tile", detail::nowMs() - t0});
        double t = detail::nowMs();
        if (haveTile_ && !spec_.isolate.empty()) matchIsolate();
        timings_.push_back({"match_isolate", detail::nowMs() - t});
        t = detail::nowMs();
        if (haveTile_ && !isoTris_.empty() && spec_.snapMaxM > 0) { if (spec_.snapWalls) snapWalls(); snapMeshes(); }
        timings_.push_back({"snap", detail::nowMs() - t});
        t = detail::nowMs();
        buildFaces();
        timings_.push_back({"faces", detail::nowMs() - t});
        t = detail::nowMs();
        if (haveTile_ && !isoTris_.empty() && spec_.residual) residual();
        timings_.push_back({"residual", detail::nowMs() - t});
        t = detail::nowMs();
        emitGeometry();
        timings_.push_back({"geometry", detail::nowMs() - t});
        t = detail::nowMs();
        if (haveTile_ && spec_.bake) bake();
        timings_.push_back({"bake", detail::nowMs() - t});
        t = detail::nowMs();
        if (haveTile_ && !isoTris_.empty() && spec_.sections) sections();
        if (haveTile_ && spec_.topdown) topdown();
        timings_.push_back({"sections_topdown", detail::nowMs() - t});
        t = detail::nowMs();
        writeOutputs();
        timings_.push_back({"write", detail::nowMs() - t});
        timings_.push_back({"total", detail::nowMs() - t0});
        writeReport();
    }

    const std::vector<Face>& faces() const { return faces_; }
    const std::vector<OutNode>& nodes() const { return nodes_; }
    const Spec& spec() const { return spec_; }
    double signedVolume() const { return volume_; }

private:
    Spec spec_;
    TileSource tile_;
    bool haveTile_{false};
    std::vector<uint32_t> isoTris_;
    std::vector<Face> faces_;
    std::vector<OutNode> nodes_;
    std::vector<SnapRecord> snaps_;
    std::vector<ResidualCluster> clusters_;
    std::vector<uint32_t> residualTris_;
    std::vector<std::string> residualKind_;
    std::vector<std::pair<std::string, double>> timings_;
    std::vector<std::string> notes_;
    double volume_{0};
    size_t residualStats_[5]{0, 0, 0, 0, 0};  // surface, proud, cut, apron, dropped-small

    // ------------------------------------------------------------------------------------------------
    // isolate: the tile triangles whose centroid matches one of the isolated scan's (1 cm)
    // ------------------------------------------------------------------------------------------------
    void matchIsolate() {
        gltf::GltfScene iso = gltf::GlbSceneReader::readFile(spec_.isolate);
        if (!iso.ok) throw std::runtime_error("isolate: " + iso.error);
        const double tol = 0.01;
        auto key = [&](double x, double y, double z) {
            return (static_cast<int64_t>(std::floor(x / tol)) * 73856093LL) ^ (static_cast<int64_t>(std::floor(y / tol)) * 19349663LL) ^ (static_cast<int64_t>(std::floor(z / tol)) * 83492791LL);
        };
        std::unordered_map<int64_t, std::vector<V3>> h;
        const auto& vs = iso.mesh.vertices;
        const auto& ix = iso.mesh.indices;
        for (size_t t = 0; t + 2 < ix.size(); t += 3) {
            V3 c{0, 0, 0};
            for (int k = 0; k < 3; ++k) { const auto& q = vs[ix[t + k]].position; c = c + V3{q.x, q.y, q.z}; }
            c = c * (1.0 / 3.0);
            h[key(c.x, c.y, c.z)].push_back(c);
        }
        for (size_t t = 0; t < tile_.triCount; ++t) {
            V3 c = (tile_.p[3 * t] + tile_.p[3 * t + 1] + tile_.p[3 * t + 2]) * (1.0 / 3.0);
            bool hit = false;
            for (int dx = -1; dx <= 1 && !hit; ++dx) for (int dy = -1; dy <= 1 && !hit; ++dy) for (int dz = -1; dz <= 1 && !hit; ++dz) {
                auto it = h.find(key(c.x + dx * tol, c.y + dy * tol, c.z + dz * tol));
                if (it == h.end()) continue;
                for (const auto& q : it->second) if ((q - c).len() <= tol) { hit = true; break; }
            }
            if (hit) isoTris_.push_back(static_cast<uint32_t>(t));
        }
        notes_.push_back(std::to_string(isoTris_.size()) + " of " + std::to_string(ix.size() / 3) + " isolate triangles matched to the photo tile");
    }

    // ------------------------------------------------------------------------------------------------
    // snap: each wall onto the facade the scan measures (area-weighted mode of the outward vertical surface)
    // ------------------------------------------------------------------------------------------------
    V2 outwardNormal(const Part& part, const V2& a, const V2& b) const {
        double dx = b.x - a.x, dz = b.z - a.z, l = std::hypot(dx, dz);
        V2 n{dz / l, -dx / l};
        V2 m{(a.x + b.x) / 2 + n.x * 0.05, (a.z + b.z) / 2 + n.z * 0.05};
        if (detail::inPart(part, m.x, m.z)) n = {-n.x, -n.z};
        return n;
    }

    void snapWalls() {
        for (auto& part : spec_.parts) {
            for (size_t li = 0; li < part.loops.size(); ++li) {
                auto& loop = part.loops[li];
                const size_t N = loop.size();
                if (N < 3) continue;
                std::vector<double> off(N, 0.0);
                for (size_t e = 0; e < N; ++e) {
                    V2 a = loop[e], b = loop[(e + 1) % N];
                    double L = std::hypot(b.x - a.x, b.z - a.z);
                    SnapRecord rec{part.id, static_cast<int>(li), static_cast<int>(e), L, 0, 0, 0, false};
                    if (L < 2.0) { snaps_.push_back(rec); continue; }
                    V2 n = outwardNormal(part, a, b);
                    V2 d{(b.x - a.x) / L, (b.z - a.z) / L};
                    const double reach = spec_.snapMaxM + 0.25, bin = 0.05;
                    const int nb = static_cast<int>(std::ceil(2 * reach / bin));
                    std::vector<double> hist(static_cast<size_t>(nb), 0.0);
                    double yLo = part.baseY + 1.5, yHi = std::max(yLo + 1.0, part.topY - 1.0);
                    for (uint32_t t : isoTris_) {
                        V3 tn = tile_.n[t];
                        if (std::abs(tn.y) > 0.35) continue;
                        if (tn.x * n.x + tn.z * n.z < 0.8) continue;
                        V3 c = (tile_.p[3 * t] + tile_.p[3 * t + 1] + tile_.p[3 * t + 2]) * (1.0 / 3.0);
                        if (c.y < yLo || c.y > yHi) continue;
                        double s = (c.x - a.x) * d.x + (c.z - a.z) * d.z;
                        if (s < 0.05 * L || s > 0.95 * L) continue;
                        double h = (c.x - a.x) * n.x + (c.z - a.z) * n.z;
                        if (h < -reach || h >= reach) continue;
                        hist[static_cast<size_t>((h + reach) / bin)] += tile_.area[t];
                    }
                    // smooth (3 bins) and take the mode
                    double total = std::accumulate(hist.begin(), hist.end(), 0.0);
                    int best = -1;
                    double bv = 0;
                    for (int k = 0; k < nb; ++k) {
                        double v = hist[static_cast<size_t>(k)] + 0.5 * ((k > 0 ? hist[static_cast<size_t>(k - 1)] : 0) + (k + 1 < nb ? hist[static_cast<size_t>(k + 1)] : 0));
                        if (v > bv) { bv = v; best = k; }
                    }
                    double wallArea = L * (yHi - yLo);
                    rec.supportM2 = total;
                    rec.supportShare = wallArea > 0 ? total / wallArea : 0;
                    if (best >= 0 && rec.supportShare >= spec_.snapMinSupport) {
                        // area-weighted mean within the mode's +-15 cm
                        double s = 0, w = 0;
                        for (int k = std::max(0, best - 3); k <= std::min(nb - 1, best + 3); ++k) { double c = -reach + (k + 0.5) * bin; s += c * hist[static_cast<size_t>(k)]; w += hist[static_cast<size_t>(k)]; }
                        double o = w > 0 ? s / w : 0;
                        if (std::abs(o) <= spec_.snapMaxM) { rec.offsetM = o; rec.applied = true; off[e] = o; }
                    }
                    snaps_.push_back(rec);
                }
                // re-intersect consecutive offset lines
                std::vector<V2> out(N);
                for (size_t i = 0; i < N; ++i) {
                    size_t ep = (i + N - 1) % N, en = i;
                    V2 a0 = loop[ep], a1 = loop[i], b1 = loop[(i + 1) % N];
                    V2 n0 = outwardNormal(part, a0, a1), n1 = outwardNormal(part, a1, b1);
                    V2 p0{a1.x + n0.x * off[ep], a1.z + n0.z * off[ep]}, d0{a1.x - a0.x, a1.z - a0.z};
                    V2 p1{a1.x + n1.x * off[en], a1.z + n1.z * off[en]}, d1{b1.x - a1.x, b1.z - a1.z};
                    double den = d0.x * d1.z - d0.z * d1.x;
                    double l0 = std::hypot(d0.x, d0.z), l1 = std::hypot(d1.x, d1.z);
                    if (std::abs(den) < 0.17 * l0 * l1) out[i] = {(p0.x + p1.x) / 2, (p0.z + p1.z) / 2};  // nearly parallel
                    else {
                        double u = ((p1.x - p0.x) * d1.z - (p1.z - p0.z) * d1.x) / den;
                        out[i] = {p0.x + u * d0.x, p0.z + u * d0.z};
                    }
                }
                loop = out;
            }
        }
    }

    /**
     * A triangle solid (a modelled volume) moved as a whole onto the facades the scan measures: per vertical triangle, the
     * area-weighted mode of the scan's same-facing vertical surface along its normal within the snap distance; then the
     * horizontal translation that best explains those offsets (weighted least squares, offsets it leaves more than a metre
     * off dropped once). Applied only when the offsets constrain both horizontal directions.
     */
    void snapMeshes() {
        for (auto& m : spec_.meshes) {
            V3 cen{0, 0, 0};
            for (const auto& v : m.v) cen = cen + v;
            cen = cen * (1.0 / std::max<size_t>(1, m.v.size()));
            struct Obs { V3 n; double o, w; };
            std::vector<Obs> obs;
            const double reach = spec_.snapMaxM + 0.25, bin = 0.05;
            const int nb = static_cast<int>(std::ceil(2 * reach / bin));
            for (size_t t = 0; t + 2 < m.tri.size(); t += 3) {
                V3 a = m.v[m.tri[t]], b = m.v[m.tri[t + 1]], c = m.v[m.tri[t + 2]];
                V3 cr = (b - a).cross(c - a);
                double area = 0.5 * cr.len();
                if (area < 1.0) continue;
                V3 n = cr.unit();
                if (std::abs(n.y) > 0.3) continue;
                n = V3{n.x, 0, n.z}.unit();
                V3 ctr = (a + b + c) * (1.0 / 3.0);
                if (n.dot(ctr - cen) < 0) n = n * -1.0;
                V3 tan{-n.z, 0, n.x};
                double s0 = std::min({(a - ctr).dot(tan), (b - ctr).dot(tan), (c - ctr).dot(tan)}), s1 = std::max({(a - ctr).dot(tan), (b - ctr).dot(tan), (c - ctr).dot(tan)});
                double y0 = std::min({a.y, b.y, c.y}), y1 = std::max({a.y, b.y, c.y});
                std::vector<double> hist(static_cast<size_t>(nb), 0.0);
                double total = 0;
                for (uint32_t it : isoTris_) {
                    V3 tn = tile_.n[it];
                    if (std::abs(tn.y) > 0.35 || tn.x * n.x + tn.z * n.z < 0.8) continue;
                    V3 q = (tile_.p[3 * it] + tile_.p[3 * it + 1] + tile_.p[3 * it + 2]) * (1.0 / 3.0);
                    if (q.y < y0 || q.y > y1) continue;
                    double sq = (q - ctr).dot(tan);
                    if (sq < s0 || sq > s1) continue;
                    double h = (q - ctr).dot(n);
                    if (h < -reach || h >= reach) continue;
                    hist[static_cast<size_t>((h + reach) / bin)] += tile_.area[it];
                    total += tile_.area[it];
                }
                if (total < 0.3 * area) continue;
                int best = 0;
                double bv = -1;
                for (int k = 0; k < nb; ++k) {
                    double v = hist[static_cast<size_t>(k)] + 0.5 * ((k > 0 ? hist[static_cast<size_t>(k - 1)] : 0) + (k + 1 < nb ? hist[static_cast<size_t>(k + 1)] : 0));
                    if (v > bv) { bv = v; best = k; }
                }
                obs.push_back({n, -reach + (best + 0.5) * bin, total});
            }
            double tx = 0, tz = 0;
            bool ok = false;
            for (int round = 0; round < 2; ++round) {
                double A = 0, B = 0, C = 0, D = 0, E = 0;
                for (const auto& o : obs) {
                    if (round == 1 && std::abs(o.n.x * tx + o.n.z * tz - o.o) > 1.0) continue;
                    A += o.w * o.n.x * o.n.x; B += o.w * o.n.x * o.n.z; C += o.w * o.n.z * o.n.z; D += o.w * o.n.x * o.o; E += o.w * o.n.z * o.o;
                }
                double det = A * C - B * B, tr = A + C;
                // both directions constrained: the smaller eigenvalue at least a fifth of the larger
                double disc = std::sqrt(std::max(0.0, tr * tr / 4 - det)), lmin = tr / 2 - disc, lmax = tr / 2 + disc;
                if (lmax <= 0 || lmin < 0.2 * lmax) { ok = false; break; }
                tx = (C * D - B * E) / det;
                tz = (A * E - B * D) / det;
                ok = true;
            }
            const bool applied = ok && std::hypot(tx, tz) <= spec_.snapMaxM;
            if (applied) for (auto& v : m.v) { v.x += tx; v.z += tz; }
            meshSnaps_.push_back({m.id, tx, tz, obs.size(), applied});
        }
    }
    struct MeshSnap { std::string id; double tx, tz; size_t constraints; bool applied; };
    std::vector<MeshSnap> meshSnaps_;

    // ------------------------------------------------------------------------------------------------
    // faces
    // ------------------------------------------------------------------------------------------------
    static void frameFor(Face& f, const V3& n) {
        f.n = n.unit();
        V3 up{0, 1, 0};
        V3 t = up - f.n * up.dot(f.n);
        if (t.len() < 1e-6) { V3 north{0, 0, -1}; t = north - f.n * north.dot(f.n); }
        f.axisT = t.unit();
        f.axisS = f.axisT.cross(f.n).unit();
    }

    void buildFaces() {
        faces_.clear();
        for (size_t pi = 0; pi < spec_.parts.size(); ++pi) {
            const Part& part = spec_.parts[pi];
            for (size_t li = 0; li < part.loops.size(); ++li) {
                const auto& loop = part.loops[li];
                const size_t N = loop.size();
                if (N < 3) continue;
                for (size_t e = 0; e < N; ++e) addWalls(pi, li, e);
            }
            addRoof(pi);
            addBase(pi);
        }
        for (const auto& m : spec_.meshes) addMeshFacets(m);
        // openings onto their faces: the wall of that key, or, where this solid split the edge in pieces (<key>:0, <key>:1, ...:
        // another part's corner projects onto it), the piece under the opening's centre, the opening moved into that piece's
        // frame (the whole edge's frame has its origin at the edge's start, a piece's at its own); an opening with no such wall
        // is reported, never dropped silently
        for (size_t oi = 0; oi < spec_.openings.size(); ++oi) {
            Face* host = nullptr;
            double shift = 0;
            std::vector<std::pair<Face*, double>> pieces;
            for (auto& f : faces_) {
                const auto& o = spec_.openings[oi];
                // an extruded wall, or a vertical facet of a modelled volume (its own triangles, cut round the openings)
                if (!f.wall && !(f.kind == "wall" && !f.meshTris.empty())) continue;
                if (f.key == o.face) { host = &f; shift = 0; pieces.clear(); break; }
                if (!f.wall) continue;
                const double d = pieceShift(f, o.face);
                if (std::isnan(d)) continue;
                const double sc = 0.5 * (o.s0 + o.s1) + d;
                if (sc >= f.sMin && sc <= f.sMax) { host = &f; shift = d; }
                if (spec_.clipOpenings && std::min(o.s1 + d, f.sMax - 0.03) - std::max(o.s0 + d, f.sMin + 0.03) >= 0.3) pieces.push_back({&f, d});
            }
            if (spec_.clipOpenings && pieces.size() > 1) {
                // one copy per piece it overlaps, in that piece's frame (attached when the loop reaches it)
                const OpeningSpec o = spec_.openings[oi];
                int k = 0;
                for (const auto& [f, d] : pieces) {
                    OpeningSpec c = o;
                    c.id = o.id + ":" + std::to_string(k++);
                    c.face = f->key;
                    c.s0 = std::max(o.s0 + d, f->sMin + 0.03);
                    c.s1 = std::min(o.s1 + d, f->sMax - 0.03);
                    spec_.openings.push_back(c);
                }
                continue;
            }
            if (!host) { rejectedOpenings_.push_back(spec_.openings[oi].id); continue; }
            auto& o = spec_.openings[oi];
            o.s0 += shift; o.s1 += shift;
            if (spec_.clipOpenings && host->wall && !o.scanned && o.t0 <= host->tBottom + 0.02 && o.t1 > host->tBottom + 0.35) o.t0 = host->tBottom + 0.03;
            attachOpening(*host, static_cast<int>(oi));
        }
    }

    /** For a piece of a split edge (<key>:<k>), the shift from the whole edge's frame (origin at its start) into the piece's; NaN when `f` is not a piece of `key`. */
    double pieceShift(const Face& f, const std::string& key) const {
        if (!f.wall || f.key.size() <= key.size() || f.key.compare(0, key.size(), key) != 0 || f.key[key.size()] != ':') return std::nan("");
        const Part* part = nullptr;
        for (const auto& pp : spec_.parts) if (pp.id == f.part) part = &pp;
        if (!part || f.loop < 0 || static_cast<size_t>(f.loop) >= part->loops.size() || f.edge < 0 || static_cast<size_t>(f.edge) >= part->loops[static_cast<size_t>(f.loop)].size()) return std::nan("");
        const V2 a = part->loops[static_cast<size_t>(f.loop)][static_cast<size_t>(f.edge)];
        return (V3{a.x, 0, a.z} - f.origin).dot(f.axisS);
    }

    double wallTopAt(const Part& part, const V3& p) const { return part.roofAt(p.x, p.z); }

    void addWalls(size_t pi, size_t li, size_t e) {
        const Part& part = spec_.parts[pi];
        const auto& loop = part.loops[li];
        const size_t N = loop.size();
        V2 a = loop[e], b = loop[(e + 1) % N];
        double L = std::hypot(b.x - a.x, b.z - a.z);
        if (L < 0.05) return;
        V2 n2 = outwardNormal(part, a, b);
        V2 d{(b.x - a.x) / L, (b.z - a.z) / L};
        // split the edge where other parts' corners project onto it (their cover may change there)
        std::vector<double> cuts{0.0, L};
        for (size_t pj = 0; pj < spec_.parts.size(); ++pj) {
            if (pj == pi) continue;
            for (const auto& l2 : spec_.parts[pj].loops) for (const auto& q : l2) {
                double s = (q.x - a.x) * d.x + (q.z - a.z) * d.z, h = (q.x - a.x) * n2.x + (q.z - a.z) * n2.z;
                if (s > 0.05 && s < L - 0.05 && std::abs(h) < 0.5) cuts.push_back(s);
            }
        }
        std::sort(cuts.begin(), cuts.end());
        cuts.erase(std::unique(cuts.begin(), cuts.end(), [](double x, double y) { return std::abs(x - y) < 0.05; }), cuts.end());
        for (size_t k = 0; k + 1 < cuts.size(); ++k) {
            double sa = cuts[k], sb = cuts[k + 1];
            V3 pa{a.x + d.x * sa, 0, a.z + d.z * sa}, pb{a.x + d.x * sb, 0, a.z + d.z * sb};
            // what covers the outside of this run: the highest other part there (its roof)
            V3 mid = (pa + pb) * 0.5;
            V3 outside{mid.x + n2.x * 0.1, 0, mid.z + n2.z * 0.1};
            double cover = -1e300;
            for (size_t pj = 0; pj < spec_.parts.size(); ++pj) {
                if (pj == pi) continue;
                const Part& o = spec_.parts[pj];
                if (detail::inPart(o, outside.x, outside.z)) cover = std::max(cover, std::min(o.roofAt(outside.x, outside.z), o.topY));
            }
            Face f;
            f.key = "w:" + part.id + ":" + std::to_string(li) + ":" + std::to_string(e) + (cuts.size() > 2 ? ":" + std::to_string(k) : "");
            f.kind = "wall";
            f.provenance = part.provenance;
            f.part = part.id;
            f.loop = static_cast<int>(li);
            f.edge = static_cast<int>(e);
            f.wall = true;
            frameFor(f, V3{n2.x, 0, n2.z});
            f.origin = V3{pa.x, 0, pa.z};
            // the top polyline: the roof envelope along the run (breaks where two planes cross)
            std::vector<double> us{0.0, 1.0};
            std::vector<RoofPlane> pl = part.planes;
            pl.push_back({part.topY, 0, 0, "top"});
            for (size_t i = 0; i < pl.size(); ++i) for (size_t j = i + 1; j < pl.size(); ++j) {
                double fa = pl[i].at(pa.x, pa.z) - pl[j].at(pa.x, pa.z), fb = pl[i].at(pb.x, pb.z) - pl[j].at(pb.x, pb.z);
                if ((fa < 0) != (fb < 0) && std::abs(fa - fb) > 1e-12) us.push_back(fa / (fa - fb));
            }
            std::sort(us.begin(), us.end());
            double bottom = part.baseY;
            if (cover > -1e299) bottom = std::max(bottom, cover);
            double sA = 1e300, sB = -1e300;
            std::vector<std::pair<double, double>> top;
            bool any = false;
            for (double u : us) {
                V3 p = pa + (pb - pa) * u;
                double y = part.roofAt(p.x, p.z);
                double s, t;
                V3 q{p.x, y, p.z};
                f.st(q, s, t);
                top.push_back({s, std::max(y, bottom)});
                if (y > bottom + 0.05) any = true;
                sA = std::min(sA, s);
                sB = std::max(sB, s);
            }
            if (!any) continue;  // the whole run stands inside a taller neighbour part
            if (top.front().first > top.back().first) std::reverse(top.begin(), top.end());
            f.top = top;
            f.tBottom = bottom;
            f.sMin = sA; f.sMax = sB; f.tMin = bottom;
            f.tMax = bottom;
            for (const auto& q : top) f.tMax = std::max(f.tMax, q.second);
            double area = 0;
            for (size_t i = 0; i + 1 < top.size(); ++i) area += (top[i + 1].first - top[i].first) * (0.5 * (top[i].second + top[i + 1].second) - bottom);
            f.area = std::abs(area);
            faces_.push_back(std::move(f));
        }
    }

    void addRoof(size_t pi) {
        const Part& part = spec_.parts[pi];
        std::vector<RoofPlane> pl = part.planes;
        pl.push_back({part.topY, 0, 0, "top"});
        for (size_t i = 0; i < pl.size(); ++i) {
            std::vector<std::vector<V2>> region;
            for (const auto& loop : part.loops) {
                std::vector<V2> r = loop;
                for (size_t j = 0; j < pl.size() && r.size() >= 3; ++j) {
                    if (j == i) continue;
                    // plane i is the lowest: pl_i - pl_j <= 0 (ties go to the lower index)
                    double k0 = pl[i].a - pl[j].a + (j < i ? 1e-9 : -1e-9), kx = pl[i].b - pl[j].b, kz = pl[i].c - pl[j].c;
                    r = detail::clipHalf(r, k0, kx, kz);
                }
                region.push_back(r);
            }
            if (region.empty() || region[0].size() < 3 || std::abs(detail::ringArea(region[0])) < 0.05) continue;
            const RoofPlane& P = pl[i];
            Face f;
            f.key = "r:" + part.id + ":" + std::to_string(i);
            f.kind = "roof";
            f.provenance = part.provenance;
            f.part = part.id;
            frameFor(f, V3{-P.b, 1, -P.c});
            const V2& q0 = region[0][0];
            f.origin = V3{q0.x, P.at(q0.x, q0.z), q0.z};
            for (const auto& r : region) {
                if (r.size() < 3) continue;
                std::vector<std::pair<double, double>> l;
                for (const auto& q : r) {
                    double s, t;
                    f.st(V3{q.x, P.at(q.x, q.z), q.z}, s, t);
                    l.push_back({s, t});
                    f.sMin = std::min(f.sMin, s); f.sMax = std::max(f.sMax, s); f.tMin = std::min(f.tMin, t); f.tMax = std::max(f.tMax, t);
                }
                f.loops.push_back(l);
            }
            double a = std::abs(detail::loopArea2(f.loops[0])) / 2;
            for (size_t h = 1; h < f.loops.size(); ++h) a -= std::abs(detail::loopArea2(f.loops[h])) / 2;
            f.area = a;
            faces_.push_back(std::move(f));
        }
    }

    void addBase(size_t pi) {
        const Part& part = spec_.parts[pi];
        Face f;
        f.key = "b:" + part.id;
        f.kind = "base";
        f.provenance = part.provenance;
        f.part = part.id;
        frameFor(f, V3{0, -1, 0});
        const V2& q0 = part.loops[0][0];
        f.origin = V3{q0.x, part.baseY, q0.z};
        for (const auto& r : part.loops) {
            std::vector<std::pair<double, double>> l;
            for (const auto& q : r) { double s, t; f.st(V3{q.x, part.baseY, q.z}, s, t); l.push_back({s, t}); }
            f.loops.push_back(l);
        }
        f.area = std::abs(detail::loopArea2(f.loops[0])) / 2;
        faces_.push_back(std::move(f));
    }

    /** Planar facets of a triangle solid: adjacent triangles within 3 degrees and 5 cm of one plane. */
    void addMeshFacets(const MeshSolid& m) {
        const size_t T = m.tri.size() / 3;
        std::vector<V3> nrm(T);
        std::vector<double> off(T);
        for (size_t t = 0; t < T; ++t) {
            V3 a = m.v[m.tri[3 * t]], b = m.v[m.tri[3 * t + 1]], c = m.v[m.tri[3 * t + 2]];
            nrm[t] = (b - a).cross(c - a).unit();
            off[t] = nrm[t].dot(a);
        }
        std::map<std::pair<uint32_t, uint32_t>, std::vector<uint32_t>> edges;
        for (size_t t = 0; t < T; ++t) for (int k = 0; k < 3; ++k) {
            uint32_t i = m.tri[3 * t + k], j = m.tri[3 * t + (k + 1) % 3];
            edges[{std::min(i, j), std::max(i, j)}].push_back(static_cast<uint32_t>(t));
        }
        std::vector<int> lab(T, -1);
        int nl = 0;
        for (size_t s = 0; s < T; ++s) {
            if (lab[s] >= 0) continue;
            std::vector<uint32_t> st{static_cast<uint32_t>(s)};
            lab[s] = nl;
            std::vector<uint32_t> members;
            while (!st.empty()) {
                uint32_t t = st.back();
                st.pop_back();
                members.push_back(t);
                for (int k = 0; k < 3; ++k) {
                    uint32_t i = m.tri[3 * t + k], j = m.tri[3 * t + (k + 1) % 3];
                    for (uint32_t u : edges[{std::min(i, j), std::max(i, j)}]) {
                        if (lab[u] >= 0) continue;
                        if (nrm[u].dot(nrm[s]) < std::cos(3.0 * M_PI / 180) || std::abs(off[u] - off[s]) > 0.05) continue;
                        lab[u] = nl;
                        st.push_back(u);
                    }
                }
            }
            Face f;
            f.key = "m:" + m.id + ":" + std::to_string(nl);
            f.kind = std::abs(nrm[s].y) < 0.25 ? "wall" : (nrm[s].y > 0 ? "roof" : "soffit");
            f.provenance = m.provenance;
            f.part = m.id;
            frameFor(f, nrm[s]);
            f.origin = m.v[m.tri[3 * s]];
            for (uint32_t t : members) {
                V3 a = m.v[m.tri[3 * t]], b = m.v[m.tri[3 * t + 1]], c = m.v[m.tri[3 * t + 2]];
                f.meshTris.push_back(a); f.meshTris.push_back(b); f.meshTris.push_back(c);
                f.area += 0.5 * (b - a).cross(c - a).len();
                for (const V3& q : {a, b, c}) { double ss, tt; f.st(q, ss, tt); f.sMin = std::min(f.sMin, ss); f.sMax = std::max(f.sMax, ss); f.tMin = std::min(f.tMin, tt); f.tMax = std::max(f.tMax, tt); }
            }
            faces_.push_back(std::move(f));
            ++nl;
        }
    }

    void attachOpening(Face& f, int oi) {
        const auto& o = spec_.openings[static_cast<size_t>(oi)];
        // the rectangle must lie inside the wall (below its top polyline, above its bottom) and overlap no other opening
        auto topAt = [&](double s) {
            for (size_t i = 0; i + 1 < f.top.size(); ++i) if (s >= f.top[i].first - 1e-9 && s <= f.top[i + 1].first + 1e-9) {
                double w = f.top[i + 1].first - f.top[i].first;
                double u = w > 1e-12 ? (s - f.top[i].first) / w : 0;
                return f.top[i].second + u * (f.top[i + 1].second - f.top[i].second);
            }
            return -1e300;
        };
        bool ok;
        if (!f.meshTris.empty()) {
            // a modelled volume's facet: the rectangle (inset 5 cm) inside the facet's own triangles at its corners, edge
            // midpoints and centre
            auto inFacet = [&](double s, double t) {
                for (size_t q = 0; q + 2 < f.meshTris.size(); q += 3) {
                    double s0, t0, s1, t1, s2, t2;
                    f.st(f.meshTris[q], s0, t0); f.st(f.meshTris[q + 1], s1, t1); f.st(f.meshTris[q + 2], s2, t2);
                    double d = (s1 - s0) * (t2 - t0) - (s2 - s0) * (t1 - t0);
                    if (std::abs(d) < 1e-12) continue;
                    double u = ((s - s0) * (t2 - t0) - (s2 - s0) * (t - t0)) / d, v = ((s1 - s0) * (t - t0) - (s - s0) * (t1 - t0)) / d;
                    if (u >= -1e-9 && v >= -1e-9 && u + v <= 1 + 1e-9) return true;
                }
                return false;
            };
            const double a0 = o.s0 + 0.05, a1 = o.s1 - 0.05, b0 = o.t0 + 0.05, b1 = o.t1 - 0.05;
            ok = o.s1 > o.s0 + 0.15 && o.t1 > o.t0 + 0.15;
            for (double s : {a0, 0.5 * (a0 + a1), a1}) for (double t : {b0, 0.5 * (b0 + b1), b1}) if (ok && !inFacet(s, t)) ok = false;
        } else {
            // a street-level opening (a door, a shop front) may reach the wall's bottom: within 5 cm of it, it starts there
            if (!o.scanned && o.t0 < f.tBottom + 0.05 && o.t0 > f.tBottom - 0.05) spec_.openings[static_cast<size_t>(oi)].t0 = f.tBottom;
            ok = o.s1 > o.s0 + 0.05 && o.t1 > o.t0 + 0.05 && o.s0 > f.sMin + 0.02 && o.s1 < f.sMax - 0.02 && o.t0 >= f.tBottom - (o.scanned ? 1e9 : 1e-9) &&
                 o.t1 < std::min(topAt(o.s0), topAt(o.s1)) - 0.05;
        }
        for (int other : f.openings) {
            const auto& p = spec_.openings[static_cast<size_t>(other)];
            if (o.s0 < p.s1 && p.s0 < o.s1 && o.t0 < p.t1 && p.t0 < o.t1) ok = false;
        }
        if (!ok) { rejectedOpenings_.push_back(o.id); return; }
        f.openings.push_back(oi);
    }
    std::vector<std::string> rejectedOpenings_;

    /**
     * An opening's outline in its face's (s, t), counter-clockwise seen from outside: (s0, t0), (s1, t0), up the right jamb,
     * the head from right to left (the line t1, or the arch sampled about every 11 degrees), down the left jamb. Convex.
     */
    static std::vector<std::pair<double, double>> openingOutline(const Face& f, const OpeningSpec& o) {
        const double half = 0.5 * (o.s1 - o.s0), mid = 0.5 * (o.s0 + o.s1);
        const double rise = (f.wall && f.meshTris.empty()) ? std::min({o.archRise, half, 0.95 * (o.t1 - o.t0)}) : 0.0;
        if (rise < 0.01) return {{o.s0, o.t0}, {o.s1, o.t0}, {o.s1, o.t1}, {o.s0, o.t1}};
        constexpr double kPi = 3.14159265358979323846;
        const double spring = o.t1 - rise;
        const double r = (half * half + rise * rise) / (2 * rise), cy = o.t1 - r;
        const double a0 = std::atan2(spring - cy, half), a1 = kPi - a0;
        const int n = std::max(4, static_cast<int>(std::ceil((a1 - a0) / (kPi / 16))));
        std::vector<std::pair<double, double>> out{{o.s0, o.t0}, {o.s1, o.t0}, {o.s1, spring}};
        for (int k = 1; k < n; ++k) { double a = a0 + (a1 - a0) * k / n; out.push_back({mid + r * std::cos(a), cy + r * std::sin(a)}); }
        out.push_back({o.s0, spring});
        return out;
    }
    /** The top of an opening's outline at s (the head polyline: from index 2 on, s descending). */
    static double outlineTopAt(const std::vector<std::pair<double, double>>& ol, double s) {
        for (size_t i = 2; i + 1 < ol.size(); ++i) {
            const auto& a = ol[i];
            const auto& b = ol[i + 1];
            if (s <= a.first + 1e-9 && s >= b.first - 1e-9) return a.first - b.first > 1e-12 ? b.second + (a.second - b.second) * (s - b.first) / (a.first - b.first) : std::max(a.second, b.second);
        }
        return ol[2].second;
    }

    // ------------------------------------------------------------------------------------------------
    // geometry
    // ------------------------------------------------------------------------------------------------
    /** Triangles of a face (world positions with their (s, t)), openings cut out. */
    void faceTriangles(const Face& f, std::vector<std::pair<V3, std::pair<double, double>>>& out) const {
        out.clear();
        auto put = [&](double s, double t) { out.push_back({f.at(s, t), {s, t}}); };
        if (!f.meshTris.empty()) {
            if (f.openings.empty()) {
                for (const auto& q : f.meshTris) { double s, t; f.st(q, s, t); out.push_back({q, {s, t}}); }
                return;
            }
            // the facet's triangles minus the openings' rectangles, in its (s, t): each convex piece split by a rectangle into
            // the parts left, right, below and above it (half-plane clips), then fanned
            using Poly = std::vector<std::pair<double, double>>;
            auto clip = [](const Poly& P, int axis, double v, bool keepBelow) {
                Poly out;
                for (size_t i = 0; i < P.size(); ++i) {
                    const auto& a = P[i];
                    const auto& b = P[(i + 1) % P.size()];
                    double da = (axis == 0 ? a.first : a.second) - v, db = (axis == 0 ? b.first : b.second) - v;
                    if (keepBelow) { da = -da; db = -db; }
                    if (da >= 0) out.push_back(a);
                    if ((da >= 0) != (db >= 0)) { double u = da / (da - db); out.push_back({a.first + u * (b.first - a.first), a.second + u * (b.second - a.second)}); }
                }
                return out;
            };
            std::vector<Poly> pieces;
            for (size_t q = 0; q + 2 < f.meshTris.size(); q += 3) {
                Poly P;
                for (int k = 0; k < 3; ++k) { double s, t; f.st(f.meshTris[q + static_cast<size_t>(k)], s, t); P.push_back({s, t}); }
                pieces.push_back(P);
            }
            for (int oi : f.openings) {
                const auto& o = spec_.openings[static_cast<size_t>(oi)];
                std::vector<Poly> next;
                for (const auto& P : pieces) {
                    auto keep = [&](const Poly& R) { if (R.size() >= 3) next.push_back(R); };
                    keep(clip(P, 0, o.s0, true));                                         // s <= s0
                    keep(clip(P, 0, o.s1, false));                                        // s >= s1
                    Poly mid = clip(clip(P, 0, o.s0, false), 0, o.s1, true);              // s0 <= s <= s1
                    if (mid.size() >= 3) { keep(clip(mid, 1, o.t0, true)); keep(clip(mid, 1, o.t1, false)); }
                }
                pieces.swap(next);
            }
            for (const auto& P : pieces) for (size_t k = 1; k + 1 < P.size(); ++k) {
                double area = (P[k].first - P[0].first) * (P[k + 1].second - P[0].second) - (P[k + 1].first - P[0].first) * (P[k].second - P[0].second);
                if (std::abs(area) < 1e-10) continue;
                put(P[0].first, P[0].second); put(P[k].first, P[k].second); put(P[k + 1].first, P[k + 1].second);
            }
            return;
        }
        if (f.wall) {
            // vertical slabs between every top-polyline vertex and opening outline vertex; each slab is the bottom-to-top column
            // minus the openings spanning it (their heads straight across the slab: an arch's samples are slab edges), the
            // last piece a trapezoid under the top line
            std::vector<double> xs;
            std::vector<std::vector<std::pair<double, double>>> outlines;
            for (const auto& q : f.top) xs.push_back(q.first);
            for (int oi : f.openings) {
                outlines.push_back(openingOutline(f, spec_.openings[static_cast<size_t>(oi)]));
                for (const auto& p : outlines.back()) xs.push_back(p.first);
            }
            std::sort(xs.begin(), xs.end());
            xs.erase(std::unique(xs.begin(), xs.end(), [](double a, double b) { return std::abs(a - b) < 1e-6; }), xs.end());
            auto topAt = [&](double s) {
                for (size_t i = 0; i + 1 < f.top.size(); ++i) if (s >= f.top[i].first - 1e-9 && s <= f.top[i + 1].first + 1e-9) {
                    double w = f.top[i + 1].first - f.top[i].first;
                    double u = w > 1e-12 ? (s - f.top[i].first) / w : 0;
                    return f.top[i].second + u * (f.top[i + 1].second - f.top[i].second);
                }
                return f.top.back().second;
            };
            for (size_t i = 0; i + 1 < xs.size(); ++i) {
                double sa = xs[i], sb = xs[i + 1];
                if (sb - sa < 1e-6) continue;
                double sm = 0.5 * (sa + sb);
                std::vector<std::array<double, 3>> cut;  // bottom, head at sa, head at sb
                for (size_t k = 0; k < f.openings.size(); ++k) {
                    const auto& o = spec_.openings[static_cast<size_t>(f.openings[k])];
                    if (o.s0 <= sm && sm <= o.s1) cut.push_back({o.t0, outlineTopAt(outlines[k], sa), outlineTopAt(outlines[k], sb)});
                }
                std::sort(cut.begin(), cut.end());
                double curA = f.tBottom, curB = f.tBottom;
                for (const auto& c : cut) {
                    if (c[0] > curA + 1e-6 || c[0] > curB + 1e-6) { put(sa, curA); put(sb, curB); put(sb, c[0]); put(sa, curA); put(sb, c[0]); put(sa, c[0]); }
                    curA = std::max(curA, c[1]);
                    curB = std::max(curB, c[2]);
                }
                double ta = topAt(sa), tb = topAt(sb);
                if (ta > curA + 1e-6 || tb > curB + 1e-6) { put(sa, curA); put(sb, curB); put(sb, tb); put(sa, curA); put(sb, tb); put(sa, ta); }
            }
            return;
        }
        std::vector<std::pair<double, double>> pts;
        auto tris = detail::triangulate(f.loops, pts);
        for (const auto& tr : tris) for (int k : tr) put(pts[static_cast<size_t>(k)].first, pts[static_cast<size_t>(k)].second);
    }

    void emitFaceNode(size_t fi) {
        const Face& f = faces_[fi];
        std::vector<std::pair<V3, std::pair<double, double>>> tri;
        faceTriangles(f, tri);
        if (tri.empty()) return;
        OutNode node;
        node.name = f.key;
        node.kind = f.kind;
        node.provenance = f.provenance;
        for (size_t i = 0; i + 2 < tri.size(); i += 3) {
            V3 a = tri[i].first, b = tri[i + 1].first, c = tri[i + 2].first;
            // wind outward
            bool flip = (b - a).cross(c - a).dot(f.n) < 0;
            for (int k = 0; k < 3; ++k) {
                const auto& q = tri[i + (flip ? (k == 0 ? 0 : 3 - k) : k)];
                OutVertex v;
                v.p = q.first; v.n = f.n; v.face = static_cast<int>(fi); v.s = q.second.first; v.t = q.second.second;
                node.idx.push_back(static_cast<uint32_t>(node.v.size()));
                node.v.push_back(v);
            }
        }
        nodes_.push_back(std::move(node));
        // the recesses of its openings (photo-inferred, or the plain holes the scan fills)
        for (int oi : f.openings) {
            const auto& o = spec_.openings[static_cast<size_t>(oi)];
            if (o.scanned || o.depth <= 0) continue;
            OutNode r;
            r.name = "opening:" + o.id;
            r.kind = "opening";
            r.provenance = o.provenance;
            r.confidence = o.confidence;
            auto quad = [&](V3 p0, V3 p1, V3 p2, V3 p3, V3 n, std::array<std::pair<double, double>, 4> st) {
                V3 ps[4] = {p0, p1, p2, p3};
                bool flip = (p1 - p0).cross(p2 - p0).dot(n) < 0;
                int order[6] = {0, 1, 2, 0, 2, 3};
                for (int k = 0; k < 6; ++k) {
                    int j = order[flip ? 5 - k : k];
                    OutVertex v;
                    v.p = ps[j]; v.n = n; v.face = static_cast<int>(fi); v.s = st[static_cast<size_t>(j)].first; v.t = st[static_cast<size_t>(j)].second;
                    r.idx.push_back(static_cast<uint32_t>(r.v.size()));
                    r.v.push_back(v);
                }
            };
            V3 back = f.n * (-o.depth);
            const auto ol = openingOutline(f, o);
            // the back panel (the outline is convex: a fan), facing out
            for (size_t k = 1; k + 1 < ol.size(); ++k) {
                V3 ps[3] = {f.at(ol[0].first, ol[0].second) + back, f.at(ol[k].first, ol[k].second) + back, f.at(ol[k + 1].first, ol[k + 1].second) + back};
                const std::pair<double, double> st[3] = {ol[0], ol[k], ol[k + 1]};
                bool flip = (ps[1] - ps[0]).cross(ps[2] - ps[0]).dot(f.n) < 0;
                for (int j = 0; j < 3; ++j) {
                    int q = flip ? (j == 0 ? 0 : 3 - j) : j;
                    OutVertex v;
                    v.p = ps[q]; v.n = f.n; v.face = static_cast<int>(fi); v.s = st[q].first; v.t = st[q].second;
                    r.idx.push_back(static_cast<uint32_t>(r.v.size()));
                    r.v.push_back(v);
                }
            }
            // a reveal along every outline edge, facing into the opening (sill up, jambs across, head or arch soffit down)
            for (size_t k = 0; k < ol.size(); ++k) {
                const auto& p = ol[k];
                const auto& q = ol[(k + 1) % ol.size()];
                double ds = q.first - p.first, dt = q.second - p.second, len = std::hypot(ds, dt);
                if (len < 1e-9) continue;
                V3 n = f.axisS * (-dt / len) + f.axisT * (ds / len);
                V3 a = f.at(p.first, p.second), b = f.at(q.first, q.second);
                quad(a, b, b + back, a + back, n, {{p, q, q, p}});
            }
            nodes_.push_back(std::move(r));
        }
    }

    /** A profile swept along consecutive walls (mitred), capped at the chain's ends. */
    /** The walls a sweep's face key names: the wall itself or, when the wall was split since the key was read (another part's corner on it), its pieces "key:k". */
    std::vector<size_t> wallsForKey(const std::string& key) const {
        for (size_t i = 0; i < faces_.size(); ++i) if (faces_[i].wall && faces_[i].key == key) return {i};
        std::vector<size_t> out;
        for (size_t i = 0; i < faces_.size(); ++i) {
            const std::string& k = faces_[i].key;
            if (faces_[i].wall && k.size() > key.size() + 1 && k.compare(0, key.size(), key) == 0 && k[key.size()] == ':') out.push_back(i);
        }
        return out;
    }

    /** The wall's top (its roof envelope polyline) at s. */
    static double faceTopAt(const Face& f, double s) {
        if (f.top.empty()) return f.tMax;
        if (s <= f.top.front().first) return f.top.front().second;
        for (size_t i = 1; i < f.top.size(); ++i) {
            const auto& a = f.top[i - 1];
            const auto& b = f.top[i];
            if (s <= b.first) return b.first - a.first > 1e-12 ? a.second + (b.second - a.second) * (s - a.first) / (b.first - a.first) : b.second;
        }
        return f.top.back().second;
    }

    /**
     * A profile swept along walls. The walls are joined into runs where one ends where the next begins (in plan, 5 cm), in
     * whatever order the keys came: a key that names nothing is skipped and the walls either side of it are NOT joined
     * across the gap, so a missing or split wall never becomes a straight span across the plan. Each run is mitred at its
     * corners and capped at its ends (closed when it comes round to its start). With `relativeToTop` the profile's heights
     * are above the wall's own top at each point (a parapet on a sloping or stepped roof), else absolute.
     */
    void emitSweep(const SweepSpec& sw) {
        std::vector<size_t> walls;
        for (const auto& key : sw.faces) {
            auto found = wallsForKey(key);
            if (found.empty()) notes_.push_back("sweep " + sw.id + ": no wall " + key + " (skipped; the walls either side are not joined across it)");
            for (size_t i : found) if (std::find(walls.begin(), walls.end(), i) == walls.end()) walls.push_back(i);
        }
        if (walls.empty() || sw.profile.size() < 2) { rejectedSweeps_.push_back(sw.id); return; }
        auto plan = [&](size_t i, bool end) { const Face& f = faces_[i]; V3 q = f.at(end ? f.sMax : f.sMin, 0); q.y = 0; return q; };
        const double joinTol = 0.05;
        // runs of walls joined end to start
        std::vector<std::vector<size_t>> runs;
        std::vector<uint8_t> used(walls.size(), 0);
        for (size_t left = walls.size(); left > 0;) {
            // a run starts at a wall no unused wall leads into (else, a loop, at the first unused)
            size_t start = walls.size();
            for (size_t k = 0; k < walls.size() && start == walls.size(); ++k) {
                if (used[k]) continue;
                bool fed = false;
                for (size_t j = 0; j < walls.size() && !fed; ++j) if (j != k && !used[j] && (plan(walls[j], true) - plan(walls[k], false)).len() < joinTol) fed = true;
                if (!fed) start = k;
            }
            if (start == walls.size()) for (size_t k = 0; k < walls.size(); ++k) if (!used[k]) { start = k; break; }
            std::vector<size_t> run{walls[start]};
            used[start] = 1;
            --left;
            for (bool grew = true; grew && left > 0;) {
                grew = false;
                for (size_t j = 0; j < walls.size(); ++j) if (!used[j] && (plan(walls[j], false) - plan(run.back(), true)).len() < joinTol) { run.push_back(walls[j]); used[j] = 1; --left; grew = true; break; }
            }
            runs.push_back(std::move(run));
        }
        if (runs.size() > 1) notes_.push_back("sweep " + sw.id + ": " + std::to_string(runs.size()) + " separate runs (walls that do not meet)");
        OutNode node;
        node.name = "sweep:" + sw.id;
        node.kind = "sweep";
        node.provenance = sw.provenance;
        node.confidence = sw.confidence;
        const auto& prof = sw.profile;
        auto vert = [&](const V3& p, const V3& n, size_t fi) {
            OutVertex v;
            v.p = p; v.n = n;
            const Face& f = faces_[fi];
            v.face = static_cast<int>(fi);
            double s, t;
            f.st(p, s, t);
            v.s = std::clamp(s, f.sMin, f.sMax);
            v.t = std::clamp(t, f.tMin, f.tMax);
            node.idx.push_back(static_cast<uint32_t>(node.v.size()));
            node.v.push_back(v);
        };
        for (const auto& run : runs) {
            // the run's path: per wall its ends and, for a profile on the wall's top, the breaks of the top between them
            struct Seg { V3 a, b; double topA{0}, topB{0}; V3 n; size_t face{0}; };
            std::vector<Seg> segs;
            for (size_t fi : run) {
                const Face& f = faces_[fi];
                std::vector<double> ss{f.sMin};
                if (sw.relativeToTop) for (const auto& q : f.top) if (q.first > f.sMin + 1e-6 && q.first < f.sMax - 1e-6) ss.push_back(q.first);
                ss.push_back(f.sMax);
                V3 n = V3{f.n.x, 0, f.n.z}.unit();
                for (size_t k = 0; k + 1 < ss.size(); ++k) {
                    Seg g;
                    g.a = f.at(ss[k], 0); g.a.y = 0;
                    g.b = f.at(ss[k + 1], 0); g.b.y = 0;
                    g.topA = sw.relativeToTop ? faceTopAt(f, ss[k]) : 0;
                    g.topB = sw.relativeToTop ? faceTopAt(f, ss[k + 1]) : 0;
                    g.n = n;
                    g.face = fi;
                    if ((g.b - g.a).len() > 1e-6) segs.push_back(g);
                }
            }
            if (segs.empty()) continue;
            const size_t S = segs.size();
            const bool closed = run.size() > 2 && (segs.back().b - segs.front().a).len() < joinTol;
            auto join = [](const V3& n1, const V3& n2) { return (n1 + n2) * (1.0 / std::max(0.2, 1 + n1.dot(n2))); };
            auto mitreStart = [&](size_t i) { return i > 0 ? join(segs[i - 1].n, segs[i].n) : closed ? join(segs[S - 1].n, segs[0].n) : segs[0].n; };
            auto mitreEnd = [&](size_t i) { return i + 1 < S ? join(segs[i].n, segs[i + 1].n) : closed ? join(segs[S - 1].n, segs[0].n) : segs[S - 1].n; };
            for (size_t i = 0; i < S; ++i) {
                const Seg& g = segs[i];
                V3 m0 = mitreStart(i), m1 = mitreEnd(i);
                for (size_t k = 0; k + 1 < prof.size(); ++k) {
                    double o0 = prof[k].first, y0 = prof[k].second, o1 = prof[k + 1].first, y1 = prof[k + 1].second;
                    V3 a = g.a + m0 * o0, b = g.b + m1 * o0, c = g.b + m1 * o1, d = g.a + m0 * o1;
                    a.y = g.topA + y0; b.y = g.topB + y0; c.y = g.topB + y1; d.y = g.topA + y1;
                    // the profile segment's outward normal: perpendicular to it in the (wall normal, up) plane
                    V3 n = (g.n * (y1 - y0) + V3{0, 1, 0} * (o0 - o1)).unit();
                    bool flip = (b - a).cross(c - a).dot(n) < 0;
                    V3 q[4] = {a, b, c, d};
                    int order[6] = {0, 1, 2, 0, 2, 3};
                    for (int j = 0; j < 6; ++j) vert(q[order[flip ? 5 - j : j]], n, g.face);
                }
            }
            if (closed) continue;
            // caps: the profile polygon (fan) at both ends of the run
            for (int end = 0; end < 2; ++end) {
                const Seg& g = end == 0 ? segs.front() : segs.back();
                V3 m = end == 0 ? mitreStart(0) : mitreEnd(S - 1);
                V3 p0 = end == 0 ? g.a : g.b;
                double top = end == 0 ? g.topA : g.topB;
                V3 along = (g.b - g.a).unit() * (end == 0 ? -1.0 : 1.0);
                std::vector<V3> ring;
                for (const auto& pr : prof) { V3 p = p0 + m * pr.first; p.y = top + pr.second; ring.push_back(p); }
                for (size_t k = 1; k + 1 < ring.size(); ++k) {
                    V3 a = ring[0], b = ring[k], c = ring[k + 1];
                    bool flip = (b - a).cross(c - a).dot(along) < 0;
                    vert(a, along, g.face);
                    vert(flip ? c : b, along, g.face);
                    vert(flip ? b : c, along, g.face);
                }
            }
        }
        nodes_.push_back(std::move(node));
    }
    std::vector<std::string> rejectedSweeps_;

    /** A profile swept along an axis of one face's frame, at each placement, capped (FaceSweepSpec). */
    void emitFaceSweep(const FaceSweepSpec& fs) {
        size_t fi = faces_.size();
        for (size_t i = 0; i < faces_.size(); ++i) if (faces_[i].key == fs.face) { fi = i; break; }
        if (fi == faces_.size() && fs.axis == 0 && !fs.placements.empty() && fs.profile.size() >= 2) {
            // an edge this solid split in pieces (<key>:0, <key>:1, ...): each piece the placements overlap (clipOpenings),
            // or the piece under their centre, the placements moved into that piece's frame (as openings are); along s only
            double lo = 1e300, hi = -1e300;
            for (const auto& pl : fs.placements) { lo = std::min({lo, pl[0], pl[1]}); hi = std::max({hi, pl[0], pl[1]}); }
            bool any = false;
            for (size_t i = 0; i < faces_.size(); ++i) {
                const Face& f = faces_[i];
                const double d = pieceShift(f, fs.face);
                if (std::isnan(d)) continue;
                const bool overlaps = std::min(hi + d, f.sMax) - std::max(lo + d, f.sMin) >= 0.3;
                const double sc = 0.5 * (lo + hi) + d;
                if (!(spec_.clipOpenings ? overlaps : (sc >= f.sMin && sc <= f.sMax))) continue;
                FaceSweepSpec moved = fs;
                moved.face = f.key;
                moved.id = fs.id + ":" + std::to_string(i);
                for (auto& pl : moved.placements) { pl[0] = std::clamp(pl[0] + d, f.sMin, f.sMax); pl[1] = std::clamp(pl[1] + d, f.sMin, f.sMax); }
                any = emitFaceSweepOn(moved, i) || any;
                if (!spec_.clipOpenings) break;
            }
            if (!any) rejectedSweeps_.push_back(fs.id);
            return;
        }
        if (fi == faces_.size() || fs.profile.size() < 2 || fs.placements.empty() || !emitFaceSweepOn(fs, fi)) rejectedSweeps_.push_back(fs.id);
    }

    /** Emits the sweep on face `fi`; false (nothing emitted) when it does not fit there. */
    bool emitFaceSweepOn(const FaceSweepSpec& in, size_t fi) {
        const Face& f = faces_[fi];
        // a wall a neighbour part covers below: the profile (along s) never reaches below the wall's raised bottom
        FaceSweepSpec clipped = in;
        if (spec_.clipOpenings && f.wall && in.axis == 0) for (auto& q : clipped.profile) q.second = std::max(q.second, f.tBottom);
        const FaceSweepSpec& fs = clipped;
        if (spec_.clipOpenings && fs.axis == 0) {
            double c0 = 1e300, c1 = -1e300;
            for (const auto& q : fs.profile) { c0 = std::min(c0, q.second); c1 = std::max(c1, q.second); }
            if (c1 - c0 < 0.3) return false;
        }
        OutNode node;
        node.name = "facesweep:" + fs.id;
        node.kind = "sweep";
        node.provenance = fs.provenance;
        node.confidence = fs.confidence;
        // (along, cross, offset) -> world, and the face's (s, t) for the texture
        auto P = [&](double a, double c, double o) { return fs.axis == 0 ? f.at(a, c) + f.n * o : f.at(c, a) + f.n * o; };
        auto put = [&](const V3& p, const V3& n) {
            OutVertex v;
            v.p = p; v.n = n; v.face = static_cast<int>(fi);
            double s, t;
            f.st(p, s, t);
            v.s = std::clamp(s, f.sMin, f.sMax);
            v.t = std::clamp(t, f.tMin, f.tMax);
            node.idx.push_back(static_cast<uint32_t>(node.v.size()));
            node.v.push_back(v);
        };
        auto tri = [&](const V3& a, const V3& b, const V3& c, const V3& n) {
            bool flip = (b - a).cross(c - a).dot(n) < 0;
            put(a, n); put(flip ? c : b, n); put(flip ? b : c, n);
        };
        const V3 A = fs.axis == 0 ? f.axisS : f.axisT, C = fs.axis == 0 ? f.axisT : f.axisS;
        const auto& pr = fs.profile;
        for (const auto& pl : fs.placements) {
            const double a0 = std::min(pl[0], pl[1]), a1 = std::max(pl[0], pl[1]), dc = pl[2];
            if (a1 - a0 < 1e-3) continue;
            for (size_t k = 0; k + 1 < pr.size(); ++k) {
                const double c0 = pr[k].second + dc, o0 = std::max(0.0, pr[k].first), c1 = pr[k + 1].second + dc, o1 = std::max(0.0, pr[k + 1].first);
                if (o0 <= 1e-6 && o1 <= 1e-6) continue;
                // the front: the profile segment's outward normal in the (normal, cross) plane, away from the face
                V3 n = (f.n * (c1 - c0) - C * (o1 - o0)).unit();
                if (n.dot(f.n) < 0) n = n * -1.0;
                if (std::abs(c1 - c0) < 1e-9) n = (C * (o1 > o0 ? -1.0 : 1.0));
                V3 p00 = P(a0, c0, o0), p01 = P(a1, c0, o0), p11 = P(a1, c1, o1), p10 = P(a0, c1, o1);
                tri(p00, p01, p11, n); tri(p00, p11, p10, n);
                // the caps: the strip between this segment and the face
                for (int end = 0; end < 2; ++end) {
                    const double a = end ? a1 : a0;
                    const V3 cn = A * (end ? 1.0 : -1.0);
                    V3 q0 = P(a, c0, 0), q1 = P(a, c1, 0), q2 = P(a, c1, o1), q3 = P(a, c0, o0);
                    tri(q0, q1, q2, cn); tri(q0, q2, q3, cn);
                }
            }
            // the profile's first and last samples standing off the face close against it
            for (int end = 0; end < 2; ++end) {
                const auto& q = end ? pr.back() : pr.front();
                if (q.first <= 1e-6) continue;
                const double c = q.second + dc;
                const V3 cn = C * (end ? 1.0 : -1.0);
                V3 b0 = P(a0, c, 0), b1 = P(a1, c, 0), b2 = P(a1, c, q.first), b3 = P(a0, c, q.first);
                tri(b0, b1, b2, cn); tri(b0, b2, b3, cn);
            }
        }
        if (node.v.empty()) return false;
        nodes_.push_back(std::move(node));
        return true;
    }

    void emitGeometry() {
        nodes_.clear();
        for (size_t i = 0; i < faces_.size(); ++i) emitFaceNode(i);
        // the closed solid's signed volume (divergence theorem over the faces, openings as cut: an estimate of closure)
        volume_ = 0;
        for (const auto& nd : nodes_) {
            if (nd.kind == "opening") continue;
            for (size_t i = 0; i + 2 < nd.idx.size(); i += 3) {
                const V3 &a = nd.v[nd.idx[i]].p, &b = nd.v[nd.idx[i + 1]].p, &c = nd.v[nd.idx[i + 2]].p;
                volume_ += a.dot(b.cross(c)) / 6.0;
            }
        }
        for (const auto& sw : spec_.sweeps) emitSweep(sw);
        for (const auto& fs : spec_.faceSweeps) emitFaceSweep(fs);
        if (!residualTris_.empty()) emitResidual();
    }

    // ------------------------------------------------------------------------------------------------
    // residual: what the scan shows that the solid does not
    // ------------------------------------------------------------------------------------------------
    void residual() {
        // the closed solid without openings
        std::vector<V3> solid;
        for (const auto& f : faces_) {
            std::vector<std::pair<V3, std::pair<double, double>>> tri;
            Face g = f;
            g.openings.clear();
            faceTriangles(g, tri);
            for (const auto& q : tri) solid.push_back(q.first);
        }
        if (solid.empty()) return;
        SolidIndex idx;
        idx.build(solid);
        const size_t M = isoTris_.size();
        std::vector<int> cls(M, 0);  // 0 surface, 1 proud, 2 cut, 3 apron
        std::vector<double> dist(M, 0);
        auto planBase = [&](double x, double z, bool& inPlan) {
            double base = 1e300;
            inPlan = false;
            for (const auto& p : spec_.parts) {
                if (detail::inPart(p, x, z)) inPlan = true;
                base = std::min(base, p.baseY);
            }
            if (spec_.parts.empty()) for (const auto& m : spec_.meshes) for (const auto& v : m.v) base = std::min(base, v.y);
            return base;
        };
        const unsigned nth = std::max(1u, std::min(16u, std::thread::hardware_concurrency()));
        std::vector<std::thread> th;
        const double reach = std::max(spec_.residualProud + spec_.attachReach, spec_.residualCut) + 0.5;
        for (unsigned w = 0; w < nth; ++w) th.emplace_back([&, w] {
            for (size_t i = w; i < M; i += nth) {
                uint32_t t = isoTris_[i];
                V3 c = (tile_.p[3 * t] + tile_.p[3 * t + 1] + tile_.p[3 * t + 2]) * (1.0 / 3.0);
                bool in = idx.inside(c);
                double d = idx.distance(c, reach);
                dist[i] = in ? -d : d;
                bool inPlan = false;
                double base = planBase(c.x, c.z, inPlan);
                double ymax = std::max({tile_.p[3 * t].y, tile_.p[3 * t + 1].y, tile_.p[3 * t + 2].y});
                if (!in && !inPlan && ymax <= base + spec_.apronHeight) cls[i] = 3;
                else if (!in && d >= spec_.residualProud) cls[i] = 1;
                else if (in && d >= spec_.residualCut) cls[i] = 2;
            }
        });
        for (auto& x : th) x.join();
        // clusters of proud / cut triangles joined by shared (welded, 1 mm) vertices
        auto wkey = [](const V3& p) { return (static_cast<int64_t>(std::llround(p.x * 1000)) * 73856093LL) ^ (static_cast<int64_t>(std::llround(p.y * 1000)) * 19349663LL) ^ (static_cast<int64_t>(std::llround(p.z * 1000)) * 83492791LL); };
        std::unordered_map<int64_t, std::vector<uint32_t>> byVert;
        for (size_t i = 0; i < M; ++i) if (cls[i] == 1 || cls[i] == 2) for (int k = 0; k < 3; ++k) byVert[wkey(tile_.p[3 * isoTris_[i] + k])].push_back(static_cast<uint32_t>(i));
        std::vector<int> comp(M, -1);
        std::vector<uint8_t> keep(M, 0);
        int nc = 0;
        for (size_t s = 0; s < M; ++s) {
            if ((cls[s] != 1 && cls[s] != 2) || comp[s] >= 0) continue;
            std::vector<uint32_t> st{static_cast<uint32_t>(s)}, members;
            comp[s] = nc;
            while (!st.empty()) {
                uint32_t i = st.back();
                st.pop_back();
                members.push_back(i);
                for (int k = 0; k < 3; ++k) for (uint32_t j : byVert[wkey(tile_.p[3 * isoTris_[i] + k])]) {
                    if (comp[j] >= 0 || cls[j] != cls[s]) continue;
                    comp[j] = nc;
                    st.push_back(j);
                }
            }
            ResidualCluster rc;
            rc.kind = cls[s] == 1 ? "proud" : "cut";
            rc.lo = {1e300, 1e300, 1e300};
            rc.hi = {-1e300, -1e300, -1e300};
            double nearest = 1e300;
            for (uint32_t i : members) {
                uint32_t t = isoTris_[i];
                rc.areaM2 += tile_.area[t];
                rc.extremeM = std::max(rc.extremeM, std::abs(dist[i]));
                nearest = std::min(nearest, std::abs(dist[i]));
                for (int k = 0; k < 3; ++k) { const V3& q = tile_.p[3 * t + k]; rc.lo = {std::min(rc.lo.x, q.x), std::min(rc.lo.y, q.y), std::min(rc.lo.z, q.z)}; rc.hi = {std::max(rc.hi.x, q.x), std::max(rc.hi.y, q.y), std::max(rc.hi.z, q.z)}; }
            }
            rc.triangles = members.size();
            bool attached = nearest <= spec_.residualProud + spec_.attachReach;
            bool big = rc.areaM2 >= spec_.residualMinArea;
            // clearly proud or cut: some of it lies at least residualClear off the solid (window reveals, cornices and the
            // facade's own relief stay within it and are the solid's)
            bool clear = rc.extremeM >= spec_.residualClear;
            if (big && attached && clear) {
                for (uint32_t i : members) keep[i] = 1;
                if (rc.kind == "cut" && rc.extremeM >= spec_.residualOpen && rc.areaM2 <= 400) openFaceFor(rc, members);
                clusters_.push_back(rc);
            } else {
                residualStats_[4] += members.size();
            }
            ++nc;
        }
        for (size_t i = 0; i < M; ++i) {
            if (cls[i] == 0) ++residualStats_[0];
            if (cls[i] == 3) { keep[i] = 1; ++residualStats_[3]; }
            if (keep[i] && cls[i] == 1) ++residualStats_[1];
            if (keep[i] && cls[i] == 2) ++residualStats_[2];
            if (keep[i]) { residualTris_.push_back(isoTris_[i]); residualKind_.push_back(cls[i] == 1 ? "proud" : cls[i] == 2 ? "cut" : "apron"); }
        }
    }

    /** A cut cluster that reaches a wall opens it: the box of the cluster's vertices within 1 m of the wall plane, in its (s, t). */
    void openFaceFor(ResidualCluster& rc, const std::vector<uint32_t>& members) {
        int bestFace = -1;
        double bestArea = 0, b0 = 0, b1 = 0, c0 = 0, c1 = 0;
        for (size_t fi = 0; fi < faces_.size(); ++fi) {
            Face& f = faces_[fi];
            if (!f.wall) continue;
            double s0 = 1e300, s1 = -1e300, t0 = 1e300, t1 = -1e300;
            for (uint32_t i : members) for (int k = 0; k < 3; ++k) {
                const V3& q = tile_.p[3 * isoTris_[i] + k];
                double h = (q - f.origin).dot(f.n);
                if (h > 0.3 || h < -1.0) continue;
                double s, t;
                f.st(q, s, t);
                if (s < f.sMin - 0.2 || s > f.sMax + 0.2 || t < f.tMin - 0.2 || t > f.tMax + 0.2) continue;
                s0 = std::min(s0, s); s1 = std::max(s1, s); t0 = std::min(t0, t); t1 = std::max(t1, t);
            }
            if (s1 <= s0 || t1 <= t0) continue;
            // how much of the box the cluster itself fills, seen along the wall's normal (a passage's back, ceiling and floor
            // project into it; scattered recess fragments do not)
            double filled = 0;
            for (uint32_t i : members) {
                uint32_t tt = isoTris_[i];
                filled += tile_.area[tt] * std::abs(tile_.n[tt].dot(f.n));
            }
            double a = (s1 - s0) * (t1 - t0);
            if (filled < 0.5 * a) continue;
            if (a > bestArea) { bestArea = a; bestFace = static_cast<int>(fi); b0 = s0; b1 = s1; c0 = t0; c1 = t1; }
        }
        if (bestFace < 0 || bestArea < 1.0) return;
        Face& f = faces_[static_cast<size_t>(bestFace)];
        if (bestArea > 0.25 * f.area) return;  // never open much of a wall
        OpeningSpec o;
        o.id = "scan:" + std::to_string(clusters_.size());
        o.face = f.key;
        o.provenance = "as-scanned";
        o.scanned = true;
        o.s0 = std::max(b0, f.sMin + 0.03); o.s1 = std::min(b1, f.sMax - 0.03);
        o.t0 = std::max(c0, f.tBottom); o.t1 = c1;
        o.confidence = 1;
        spec_.openings.push_back(o);
        size_t before = f.openings.size();
        attachOpening(f, static_cast<int>(spec_.openings.size() - 1));
        if (f.openings.size() > before) { rc.opensFace = true; rc.face = f.key; rc.s0 = o.s0; rc.s1 = o.s1; rc.t0 = o.t0; rc.t1 = o.t1; }
    }

    void emitResidual() {
        // one node per tile image (its own photo), as scanned
        std::map<int, OutNode> byImage;
        for (size_t k = 0; k < residualTris_.size(); ++k) {
            uint32_t t = residualTris_[k];
            int img = tile_.imageOf(t);
            if (img < 0) continue;  // scan triangles without a photo show nothing real
            OutNode& nd = byImage[img];
            if (nd.name.empty()) { nd.name = "residual:" + std::to_string(img); nd.kind = "residual"; nd.provenance = "as-scanned"; }
            const auto& vs = tile_.scene.mesh.vertices;
            const auto& ix = tile_.scene.mesh.indices;
            for (int j = 0; j < 3; ++j) {
                OutVertex v;
                v.p = tile_.p[3 * t + j];
                v.n = tile_.n[t];
                v.image = img;
                v.u = vs[ix[3 * t + j]].uv.x;
                v.v = vs[ix[3 * t + j]].uv.y;
                nd.idx.push_back(static_cast<uint32_t>(nd.v.size()));
                nd.v.push_back(v);
            }
        }
        for (auto& kv : byImage) nodes_.push_back(std::move(kv.second));
    }

    // ------------------------------------------------------------------------------------------------
    // ortho bake
    // ------------------------------------------------------------------------------------------------
    struct Raster { std::vector<float> depth; std::vector<uint8_t> rgb; std::vector<uint8_t> cov; std::vector<float> prot; };

    void rasterFace(const Face& f, double lo, double hi, bool colour, std::vector<float>& zbuf, std::vector<uint8_t>* rgb, std::vector<uint8_t>* cov) const {
        const int W = f.width, H = f.height;
        const double px = f.pixel;
        V3 c0 = f.at(f.orthoSMin, f.orthoTMax - H * px), c1 = f.at(f.orthoSMin + W * px, f.orthoTMax);
        V3 bl{std::min(c0.x, c1.x), std::min(c0.y, c1.y), std::min(c0.z, c1.z)}, bh{std::max(c0.x, c1.x), std::max(c0.y, c1.y), std::max(c0.z, c1.z)};
        // the box of the face's frame rectangle grown by the slab along the normal
        std::array<V3, 8> corners;
        int ci = 0;
        for (double s : {f.orthoSMin, f.orthoSMin + W * px}) for (double t : {f.orthoTMax - H * px, f.orthoTMax}) for (double h : {lo, hi}) corners[static_cast<size_t>(ci++)] = f.at(s, t) + f.n * h;
        for (const auto& q : corners) { bl = {std::min(bl.x, q.x), std::min(bl.y, q.y), std::min(bl.z, q.z)}; bh = {std::max(bh.x, q.x), std::max(bh.y, q.y), std::max(bh.z, q.z)}; }
        auto cand = tile_.query(bl, bh);
        for (uint32_t t : cand) {
            if (tile_.n[t].dot(f.n) < 0.05) continue;  // facing into the face
            // a surface with no photo (the strip's flat caps and skirts where trees stood) is not the facade's photo: its
            // texels stay uncovered and are filled downstream, labelled, instead of baking a flat clay patch as "as scanned"
            if (colour && !tile_.hasPhoto(t)) continue;
            double xs[3], ys[3], hs[3];
            bool in = true;
            for (int k = 0; k < 3 && in; ++k) {
                V3 d = tile_.p[3 * t + k] - f.origin;
                hs[k] = d.dot(f.n);
                in = hs[k] >= lo && hs[k] <= hi;
                xs[k] = (d.dot(f.axisS) - f.orthoSMin) / px;
                ys[k] = (f.orthoTMax - d.dot(f.axisT)) / px;
            }
            if (!in) continue;
            double area = (xs[1] - xs[0]) * (ys[2] - ys[0]) - (xs[2] - xs[0]) * (ys[1] - ys[0]);
            if (std::abs(area) < 1e-12) continue;
            int x0 = std::max(0, static_cast<int>(std::floor(std::min({xs[0], xs[1], xs[2]}))));
            int x1 = std::min(W - 1, static_cast<int>(std::ceil(std::max({xs[0], xs[1], xs[2]}))));
            int y0 = std::max(0, static_cast<int>(std::floor(std::min({ys[0], ys[1], ys[2]}))));
            int y1 = std::min(H - 1, static_cast<int>(std::ceil(std::max({ys[0], ys[1], ys[2]}))));
            const double tol = -1e-7 * std::abs(area);
            for (int y = y0; y <= y1; ++y) {
                double py = y + 0.5;
                for (int x = x0; x <= x1; ++x) {
                    double pxc = x + 0.5;
                    double w0 = (xs[1] - pxc) * (ys[2] - py) - (xs[2] - pxc) * (ys[1] - py);
                    double w1 = (xs[2] - pxc) * (ys[0] - py) - (xs[0] - pxc) * (ys[2] - py);
                    double w2 = (xs[0] - pxc) * (ys[1] - py) - (xs[1] - pxc) * (ys[0] - py);
                    if (area < 0) { w0 = -w0; w1 = -w1; w2 = -w2; }
                    if (w0 < tol || w1 < tol || w2 < tol) continue;
                    double sum = w0 + w1 + w2;
                    w0 /= sum; w1 /= sum; w2 /= sum;
                    float h = static_cast<float>(w0 * hs[0] + w1 * hs[1] + w2 * hs[2]);
                    size_t i = static_cast<size_t>(y) * W + x;
                    if (h < zbuf[i]) continue;
                    zbuf[i] = h;
                    if (colour) {
                        double c[3];
                        tile_.colour(t, w0, w1, w2, c);
                        for (int k = 0; k < 3; ++k) (*rgb)[i * 3 + k] = static_cast<uint8_t>(std::clamp(c[k] * 255.0 + 0.5, 0.0, 255.0));
                        (*cov)[i] = 1;
                    }
                }
            }
        }
    }

    /**
     * The depth along a wall's normal (metres from its plane) where the tile's photo surface facing it lies: the mode of the
     * projected area of the photo triangles facing out of it, over its (s, t) extent, within +-reach, in a 1.5 m window
     * (bins of 0.25 m). NaN when nothing faces it there.
     */
    double photoSurfaceDepth(const Face& f, double reach) const {
        const double bin = 0.25;
        const int nb = static_cast<int>(std::ceil(2 * reach / bin));
        std::vector<double> hist(static_cast<size_t>(nb), 0.0);
        V3 c0 = f.at(f.sMin, f.tMin), c1 = f.at(f.sMax, f.tMax);
        V3 bl{std::min(c0.x, c1.x), std::min(c0.y, c1.y), std::min(c0.z, c1.z)}, bh{std::max(c0.x, c1.x), std::max(c0.y, c1.y), std::max(c0.z, c1.z)};
        for (const V3& q : {f.at(f.sMin, f.tMin) + f.n * reach, f.at(f.sMax, f.tMax) + f.n * reach, f.at(f.sMin, f.tMin) - f.n * reach, f.at(f.sMax, f.tMax) - f.n * reach}) {
            bl = {std::min(bl.x, q.x), std::min(bl.y, q.y), std::min(bl.z, q.z)}; bh = {std::max(bh.x, q.x), std::max(bh.y, q.y), std::max(bh.z, q.z)};
        }
        double total = 0;
        for (uint32_t t : tile_.query(bl, bh)) {
            double facing = tile_.n[t].dot(f.n);
            if (facing < 0.5 || !tile_.hasPhoto(t)) continue;
            V3 m = (tile_.p[3 * t] + tile_.p[3 * t + 1] + tile_.p[3 * t + 2]) * (1.0 / 3.0);
            double s, tt;
            f.st(m, s, tt);
            if (s < f.sMin || s > f.sMax || tt < f.tMin || tt > f.tMax) continue;
            double h = (m - f.origin).dot(f.n);
            if (h < -reach || h >= reach) continue;
            double w = tile_.area[t] * facing;
            hist[static_cast<size_t>(std::clamp(static_cast<int>((h + reach) / bin), 0, nb - 1))] += w;
            total += w;
        }
        if (total <= 0) return std::numeric_limits<double>::quiet_NaN();
        const int win = static_cast<int>(std::round(1.5 / bin));
        double best = -1;
        int at = 0;
        for (int k = 0; k + win <= nb; ++k) {
            double sum = 0;
            for (int j = k; j < k + win; ++j) sum += hist[static_cast<size_t>(j)];
            if (sum > best) { best = sum; at = k; }
        }
        // the window's area-weighted mean depth
        double sw = 0, sh = 0;
        for (int j = at; j < at + win; ++j) { sw += hist[static_cast<size_t>(j)]; sh += hist[static_cast<size_t>(j)] * (-reach + (j + 0.5) * bin); }
        return sw > 0 ? sh / sw : std::numeric_limits<double>::quiet_NaN();
    }

    void bake() {
        // image frames
        for (auto& f : faces_) {
            if (f.kind == "base") continue;
            double px = spec_.pixel;
            double w = f.sMax - f.sMin, h = f.tMax - f.tMin;
            if (!(w > 0 && h > 0)) continue;
            while ((w + 2 * px) / px > spec_.maxFaceSide || (h + 2 * px) / px > spec_.maxFaceSide) px *= 1.25;
            f.pixel = px;
            f.orthoSMin = f.sMin - px;
            f.orthoTMax = f.tMax + px;
            f.width = std::max(2, static_cast<int>(std::ceil((w + 2 * px) / px)));
            f.height = std::max(2, static_cast<int>(std::ceil((h + 2 * px) / px)));
        }
        std::vector<size_t> todo;
        for (size_t i = 0; i < faces_.size(); ++i) if (faces_[i].width > 0) todo.push_back(i);
        const unsigned nth = std::max(1u, std::min(16u, std::thread::hardware_concurrency()));
        std::vector<std::thread> th;
        std::atomic<size_t> next{0};
        for (unsigned w = 0; w < nth; ++w) th.emplace_back([&] {
            for (size_t k; (k = next++) < todo.size();) {
                Face& f = faces_[todo[k]];
                const size_t N = static_cast<size_t>(f.width) * f.height;
                std::vector<float> z(N, -1e30f), zp(N, -1e30f);
                std::vector<uint8_t> rgb(N * 3, 0), cov(N, 0);
                // a roof is textured by the photo seen from above it (whatever stands on it is the residual's); a wall by a thin slab
                const bool up = f.n.y > 0.7;
                rasterFace(f, up ? -std::max(spec_.slabBack, 3.0) : -spec_.slabBack, up ? 30.0 : spec_.slabFront, true, z, &rgb, &cov);
                rasterFace(f, -spec_.slabBack, spec_.protrusionReach, false, zp, nullptr, nullptr);
                size_t covered = 0;
                for (size_t i = 0; i < N; ++i) covered += cov[i];
                f.coverage = static_cast<double>(covered) / static_cast<double>(N);
                // the retry applies to every face that got the narrow wall window (not just near-vertical ones): a
                // shallow-to-medium roof slope (f.n.y in (0.25, 0.7], a dormer or mansard) or a steep soffit
                // (f.n.y < -0.5) is still rastered with the wall window above, and can miss the real photo surface by
                // just as much as a wall can; the retry's own gate (the result must cover more than the original) is
                // unchanged, so a face this doesn't help simply keeps its first raster, same as before
                if (!up && spec_.reslabReach > 0 && f.coverage < spec_.reslabBelow) {
                    double c = photoSurfaceDepth(f, spec_.reslabReach);
                    if (std::isfinite(c) && (c < -spec_.slabBack + 0.5 || c > spec_.slabFront - 0.3)) {
                        std::vector<float> z2(N, -1e30f);
                        std::vector<uint8_t> rgb2(N * 3, 0), cov2(N, 0);
                        rasterFace(f, c - spec_.slabBack, c + spec_.slabFront, true, z2, &rgb2, &cov2);
                        size_t covered2 = 0;
                        for (size_t i = 0; i < N; ++i) covered2 += cov2[i];
                        if (covered2 > covered + N / 20) {
                            z.swap(z2); rgb.swap(rgb2); cov.swap(cov2);
                            f.coverage = static_cast<double>(covered2) / static_cast<double>(N);
                            f.textureOffset = c;
                        }
                    }
                }
                texture::ImageBuffer img(f.width, f.height, 4, 0);
                for (size_t i = 0; i < N; ++i) {
                    for (int c = 0; c < 3; ++c) img.data[i * 4 + c] = cov[i] ? rgb[i * 3 + c] : 128;
                    img.data[i * 4 + 3] = cov[i] ? 255 : 0;
                }
                const std::string base = spec_.outDir + "/face_" + std::to_string(todo[k]);
                detail::writePng(base + ".png", img, 1);
                for (size_t i = 0; i < N; ++i) { if (z[i] < -1e29f) z[i] = std::numeric_limits<float>::quiet_NaN(); if (zp[i] < -1e29f) zp[i] = std::numeric_limits<float>::quiet_NaN(); }
                detail::writeFile(base + ".depth", z.data(), N * sizeof(float));
                detail::writeFile(base + ".prot", zp.data(), N * sizeof(float));
                // the face's own extent in its ortho frame (1 inside its polygon, openings cut out): the relief maps' mask
                {
                    std::vector<uint8_t> inside(N, 0);
                    std::vector<std::pair<V3, std::pair<double, double>>> ft;
                    faceTriangles(f, ft);
                    for (size_t q = 0; q + 2 < ft.size(); q += 3) {
                        double xs[3], ys[3];
                        for (int c = 0; c < 3; ++c) { xs[c] = (ft[q + c].second.first - f.orthoSMin) / f.pixel; ys[c] = (f.orthoTMax - ft[q + c].second.second) / f.pixel; }
                        double ar = (xs[1] - xs[0]) * (ys[2] - ys[0]) - (xs[2] - xs[0]) * (ys[1] - ys[0]);
                        if (std::abs(ar) < 1e-12) continue;
                        int qx0 = std::max(0, static_cast<int>(std::floor(std::min({xs[0], xs[1], xs[2]})))), qx1 = std::min(f.width - 1, static_cast<int>(std::ceil(std::max({xs[0], xs[1], xs[2]}))));
                        int qy0 = std::max(0, static_cast<int>(std::floor(std::min({ys[0], ys[1], ys[2]})))), qy1 = std::min(f.height - 1, static_cast<int>(std::ceil(std::max({ys[0], ys[1], ys[2]}))));
                        for (int y = qy0; y <= qy1; ++y) for (int x = qx0; x <= qx1; ++x) {
                            double px2 = x + 0.5, py2 = y + 0.5;
                            double w0 = (xs[1] - px2) * (ys[2] - py2) - (xs[2] - px2) * (ys[1] - py2);
                            double w1 = (xs[2] - px2) * (ys[0] - py2) - (xs[0] - px2) * (ys[2] - py2);
                            double w2 = (xs[0] - px2) * (ys[1] - py2) - (xs[1] - px2) * (ys[0] - py2);
                            if (ar < 0) { w0 = -w0; w1 = -w1; w2 = -w2; }
                            if (w0 >= 0 && w1 >= 0 && w2 >= 0) inside[static_cast<size_t>(y) * f.width + x] = 1;
                        }
                    }
                    detail::writeFile(base + ".inside", inside.data(), N);
                }
                if (f.kind == "wall") {
                    // the grammar's photo: uncovered pixels exactly mid grey (tile_refine's convention)
                    texture::ImageBuffer g(f.width, f.height, 3, 128);
                    for (size_t i = 0; i < N; ++i) if (cov[i]) for (int c = 0; c < 3; ++c) g.data[i * 3 + c] = (rgb[i * 3] == 128 && rgb[i * 3 + 1] == 128 && rgb[i * 3 + 2] == 128) ? 129 : rgb[i * 3 + c];
                    detail::writePng(spec_.outDir + "/ortho_" + std::to_string(todo[k]) + ".png", g, 1);
                }
            }
        });
        for (auto& x : th) x.join();
    }

    // ------------------------------------------------------------------------------------------------
    // sections and top-down
    // ------------------------------------------------------------------------------------------------
    std::string sectionsJson_;
    void sections() {
        std::ostringstream js;
        js << "[";
        bool first = true;
        const double px = 0.05, hLo = -1.5, hHi = 3.0;
        for (size_t fi = 0; fi < faces_.size(); ++fi) {
            const Face& f = faces_[fi];
            if (!f.wall || f.sMax - f.sMin < 6 || f.tMax - f.tBottom < 5) continue;
            const int W = static_cast<int>(std::ceil((hHi - hLo) / px)), H = static_cast<int>(std::ceil((f.tMax + 1.5 - f.tBottom) / px));
            texture::ImageBuffer img(W, H, 3, 0);
            for (auto& b : img.data) b = 235;
            std::vector<std::vector<float>> prof(3, std::vector<float>(static_cast<size_t>(H), std::numeric_limits<float>::quiet_NaN()));
            for (int cut = 0; cut < 3; ++cut) {
                double sc = f.sMin + (f.sMax - f.sMin) * (0.25 + 0.25 * cut);
                for (uint32_t t : isoTris_) {
                    double s[3], tt[3], h[3];
                    bool near = false;
                    double smin = 1e300, smax = -1e300;
                    for (int k = 0; k < 3; ++k) { f.st(tile_.p[3 * t + k], s[k], tt[k]); h[k] = (tile_.p[3 * t + k] - f.origin).dot(f.n); smin = std::min(smin, s[k]); smax = std::max(smax, s[k]); }
                    near = smin <= sc + 0.4 && smax >= sc - 0.4;
                    if (!near) continue;
                    double c[3];
                    tile_.colour(t, 1.0 / 3, 1.0 / 3, 1.0 / 3, c);
                    // its extent in (h, t): mark the covered rows at the triangle's outermost h per row (conservative band)
                    double tl = std::min({tt[0], tt[1], tt[2]}), th = std::max({tt[0], tt[1], tt[2]});
                    double hl = std::min({h[0], h[1], h[2]}), hh = std::max({h[0], h[1], h[2]});
                    if (hh < hLo || hl > hHi) continue;
                    int r0 = std::clamp(static_cast<int>((f.tMax + 1.5 - th) / px), 0, H - 1), r1 = std::clamp(static_cast<int>((f.tMax + 1.5 - tl) / px), 0, H - 1);
                    for (int r = r0; r <= r1; ++r) {
                        double tr = f.tMax + 1.5 - (r + 0.5) * px;
                        // h of the triangle's cross-section with the plane t = tr (max over its edges' crossings)
                        double hm = -1e300;
                        for (int k = 0; k < 3; ++k) {
                            int j = (k + 1) % 3;
                            if ((tt[k] - tr) * (tt[j] - tr) <= 0 && std::abs(tt[j] - tt[k]) > 1e-9) hm = std::max(hm, h[k] + (tr - tt[k]) / (tt[j] - tt[k]) * (h[j] - h[k]));
                        }
                        if (hm < -1e299) continue;
                        float& pr = prof[static_cast<size_t>(cut)][static_cast<size_t>(r)];
                        if (std::isnan(pr) || hm > pr) pr = static_cast<float>(hm);
                        int x1 = std::clamp(static_cast<int>((hm - hLo) / px), 0, W - 1);
                        for (int x = 0; x <= x1; ++x) for (int ch = 0; ch < 3; ++ch) {
                            uint8_t v = static_cast<uint8_t>(std::clamp(c[ch] * 255.0, 0.0, 255.0));
                            uint8_t& o = img.data[(static_cast<size_t>(r) * W + x) * 3 + ch];
                            o = std::min(o, v);
                        }
                    }
                }
            }
            // the face plane marked (h = 0): one dark column
            int x0 = static_cast<int>((0 - hLo) / px);
            for (int r = 0; r < H; ++r) { img.data[(static_cast<size_t>(r) * W + x0) * 3] = 200; img.data[(static_cast<size_t>(r) * W + x0) * 3 + 1] = 30; img.data[(static_cast<size_t>(r) * W + x0) * 3 + 2] = 30; }
            detail::writePng(spec_.outDir + "/section_" + std::to_string(fi) + ".png", img, 3);
            js << (first ? "" : ",") << "{\"face\":" << fi << ",\"key\":" << detail::jstr(f.key) << ",\"image\":\"section_" << fi << ".png\",\"pixel\":" << px << ",\"hMin\":" << hLo << ",\"hMax\":" << hHi
               << ",\"tTop\":" << detail::fmt(f.tMax + 1.5) << ",\"tBottom\":" << detail::fmt(f.tBottom) << ",\"width\":" << W << ",\"height\":" << H << ",\"profiles\":[";
            for (int cut = 0; cut < 3; ++cut) {
                js << (cut ? "," : "") << "[";
                for (int r = 0; r < H; ++r) js << (r ? "," : "") << detail::fmt(prof[static_cast<size_t>(cut)][static_cast<size_t>(r)]);
                js << "]";
            }
            js << "]}";
            first = false;
        }
        js << "]";
        sectionsJson_ = js.str();
    }

    std::string topdownJson_;
    void topdown() {
        double x0 = 1e300, x1 = -1e300, z0 = 1e300, z1 = -1e300;
        for (const auto& f : faces_) if (f.kind == "base" || f.kind == "roof") {
            std::vector<std::pair<V3, std::pair<double, double>>> tri;
            faceTriangles(f, tri);
            for (const auto& q : tri) { x0 = std::min(x0, q.first.x); x1 = std::max(x1, q.first.x); z0 = std::min(z0, q.first.z); z1 = std::max(z1, q.first.z); }
        }
        for (const auto& m : spec_.meshes) for (const auto& v : m.v) { x0 = std::min(x0, v.x); x1 = std::max(x1, v.x); z0 = std::min(z0, v.z); z1 = std::max(z1, v.z); }
        if (x1 <= x0) return;
        x0 -= 3; x1 += 3; z0 -= 3; z1 += 3;
        const double px = 0.1;
        const int W = static_cast<int>(std::ceil((x1 - x0) / px)), H = static_cast<int>(std::ceil((z1 - z0) / px));
        std::vector<float> top(static_cast<size_t>(W) * H, -1e30f);
        texture::ImageBuffer img(W, H, 3, 128);
        const std::vector<uint32_t>& set = isoTris_;
        auto draw = [&](uint32_t t) {
            double xs[3], ys[3], hs[3];
            for (int k = 0; k < 3; ++k) { xs[k] = (tile_.p[3 * t + k].x - x0) / px; ys[k] = (tile_.p[3 * t + k].z - z0) / px; hs[k] = tile_.p[3 * t + k].y; }
            double area = (xs[1] - xs[0]) * (ys[2] - ys[0]) - (xs[2] - xs[0]) * (ys[1] - ys[0]);
            if (std::abs(area) < 1e-12) return;
            int a0 = std::max(0, static_cast<int>(std::floor(std::min({xs[0], xs[1], xs[2]})))), a1 = std::min(W - 1, static_cast<int>(std::ceil(std::max({xs[0], xs[1], xs[2]}))));
            int b0 = std::max(0, static_cast<int>(std::floor(std::min({ys[0], ys[1], ys[2]})))), b1 = std::min(H - 1, static_cast<int>(std::ceil(std::max({ys[0], ys[1], ys[2]}))));
            for (int y = b0; y <= b1; ++y) for (int x = a0; x <= a1; ++x) {
                double pxc = x + 0.5, py = y + 0.5;
                double w0 = (xs[1] - pxc) * (ys[2] - py) - (xs[2] - pxc) * (ys[1] - py);
                double w1 = (xs[2] - pxc) * (ys[0] - py) - (xs[0] - pxc) * (ys[2] - py);
                double w2 = (xs[0] - pxc) * (ys[1] - py) - (xs[1] - pxc) * (ys[0] - py);
                if (area < 0) { w0 = -w0; w1 = -w1; w2 = -w2; }
                if (w0 < 0 || w1 < 0 || w2 < 0) continue;
                double s = w0 + w1 + w2;
                w0 /= s; w1 /= s; w2 /= s;
                float h = static_cast<float>(w0 * hs[0] + w1 * hs[1] + w2 * hs[2]);
                size_t i = static_cast<size_t>(y) * W + x;
                if (h <= top[i]) continue;
                top[i] = h;
                double c[3];
                tile_.colour(t, w0, w1, w2, c);
                for (int k = 0; k < 3; ++k) img.data[i * 3 + k] = static_cast<uint8_t>(std::clamp(c[k] * 255.0 + 0.5, 0.0, 255.0));
            }
        };
        if (!set.empty()) for (uint32_t t : set) draw(t);
        else for (uint32_t t : tile_.query(V3{x0, -1e9, z0}, V3{x1, 1e9, z1})) draw(t);
        for (auto& v : top) if (v < -1e29f) v = std::numeric_limits<float>::quiet_NaN();
        detail::writePng(spec_.outDir + "/topdown.png", img, 3);
        detail::writeFile(spec_.outDir + "/topdown.height", top.data(), top.size() * sizeof(float));
        std::ostringstream js;
        js << "{\"image\":\"topdown.png\",\"height\":\"topdown.height\",\"x0\":" << detail::fmt(x0) << ",\"z0\":" << detail::fmt(z0) << ",\"pixel\":" << px << ",\"width\":" << W << ",\"rows\":" << H << "}";
        topdownJson_ = js.str();
    }

    // ------------------------------------------------------------------------------------------------
    // outputs
    // ------------------------------------------------------------------------------------------------
    void writeOutputs() {
        // mesh.bin: per node, positions (f32 x3), normals (f32 x3), face/image (i32), st/uv (f32 x2), indices (u32)
        std::ofstream bin(spec_.outDir + "/mesh.bin", std::ios::binary);
        if (!bin) throw std::runtime_error("cannot write mesh.bin");
        std::ostringstream js;
        js << "[";
        size_t offset = 0;
        for (size_t k = 0; k < nodes_.size(); ++k) {
            const auto& nd = nodes_[k];
            std::vector<float> pos, nrm, st;
            std::vector<int32_t> ref;
            for (const auto& v : nd.v) {
                pos.insert(pos.end(), {static_cast<float>(v.p.x), static_cast<float>(v.p.y), static_cast<float>(v.p.z)});
                nrm.insert(nrm.end(), {static_cast<float>(v.n.x), static_cast<float>(v.n.y), static_cast<float>(v.n.z)});
                ref.push_back(v.image >= 0 ? -(v.image + 2) : v.face);
                st.insert(st.end(), v.image >= 0 ? std::initializer_list<float>{static_cast<float>(v.u), static_cast<float>(v.v)} : std::initializer_list<float>{static_cast<float>(v.s), static_cast<float>(v.t)});
            }
            auto put = [&](const void* d, size_t n) { bin.write(reinterpret_cast<const char*>(d), static_cast<std::streamsize>(n)); offset += n; };
            size_t start = offset;
            put(pos.data(), pos.size() * 4);
            put(nrm.data(), nrm.size() * 4);
            put(ref.data(), ref.size() * 4);
            put(st.data(), st.size() * 4);
            put(nd.idx.data(), nd.idx.size() * 4);
            js << (k ? "," : "") << "{\"name\":" << detail::jstr(nd.name) << ",\"kind\":" << detail::jstr(nd.kind) << ",\"provenance\":" << detail::jstr(nd.provenance)
               << ",\"confidence\":" << detail::fmt(nd.confidence) << ",\"offset\":" << start << ",\"vertices\":" << nd.v.size() << ",\"indices\":" << nd.idx.size() << "}";
        }
        js << "]";
        nodesJson_ = js.str();
        // the tile images the residual uses, as they were encoded
        std::vector<int> used;
        for (const auto& nd : nodes_) if (nd.kind == "residual" && !nd.v.empty() && nd.v[0].image >= 0) used.push_back(nd.v[0].image);
        std::ostringstream ij;
        ij << "[";
        for (size_t k = 0; k < used.size(); ++k) {
            const auto& im = tile_.scene.images[static_cast<size_t>(used[k])];
            std::string ext = im.mimeType.find("png") != std::string::npos ? "png" : "jpg";
            std::string name = "tileimg_" + std::to_string(used[k]) + "." + ext;
            if (!im.encoded.empty()) detail::writeFile(spec_.outDir + "/" + name, im.encoded.data(), im.encoded.size());
            ij << (k ? "," : "") << "{\"image\":" << used[k] << ",\"file\":" << detail::jstr(name) << ",\"mimeType\":" << detail::jstr(im.mimeType) << "}";
        }
        ij << "]";
        imagesJson_ = ij.str();
    }
    std::string nodesJson_, imagesJson_;

    void writeReport() {
        auto v3 = [](const V3& v) { return "[" + detail::fmt(v.x) + "," + detail::fmt(v.y) + "," + detail::fmt(v.z) + "]"; };
        std::ostringstream js;
        js << "{\"schema\":\"scratchbox.staged-massing/1\",\"faces\":[";
        for (size_t i = 0; i < faces_.size(); ++i) {
            const auto& f = faces_[i];
            js << (i ? "," : "") << "{\"index\":" << i << ",\"key\":" << detail::jstr(f.key) << ",\"kind\":" << detail::jstr(f.kind) << ",\"part\":" << detail::jstr(f.part)
               << ",\"loop\":" << f.loop << ",\"edge\":" << f.edge << ",\"wall\":" << (f.wall ? "true" : "false") << ",\"normal\":" << v3(f.n) << ",\"axisS\":" << v3(f.axisS)
               << ",\"axisT\":" << v3(f.axisT) << ",\"origin\":" << v3(f.origin) << ",\"sMin\":" << detail::fmt(f.sMin) << ",\"sMax\":" << detail::fmt(f.sMax)
               << ",\"tMin\":" << detail::fmt(f.tMin) << ",\"tMax\":" << detail::fmt(f.tMax) << ",\"tBottom\":" << detail::fmt(f.tBottom) << ",\"area\":" << detail::fmt(f.area)
               << ",\"pixel\":" << detail::fmt(f.pixel) << ",\"orthoSMin\":" << detail::fmt(f.orthoSMin) << ",\"orthoTMax\":" << detail::fmt(f.orthoTMax)
               << ",\"width\":" << f.width << ",\"height\":" << f.height << ",\"coverage\":" << detail::fmt(f.coverage) << ",\"textureOffsetM\":" << detail::fmt(f.textureOffset) << ",\"openings\":[";
            for (size_t k = 0; k < f.openings.size(); ++k) js << (k ? "," : "") << detail::jstr(spec_.openings[static_cast<size_t>(f.openings[k])].id);
            js << "],\"top\":[";
            for (size_t k = 0; k < f.top.size(); ++k) js << (k ? "," : "") << "[" << detail::fmt(f.top[k].first) << "," << detail::fmt(f.top[k].second) << "]";
            js << "]}";
        }
        js << "],\"parts\":[";
        for (size_t i = 0; i < spec_.parts.size(); ++i) {
            const auto& p = spec_.parts[i];
            js << (i ? "," : "") << "{\"id\":" << detail::jstr(p.id) << ",\"baseY\":" << detail::fmt(p.baseY) << ",\"topY\":" << detail::fmt(p.topY) << ",\"loops\":[";
            for (size_t l = 0; l < p.loops.size(); ++l) {
                js << (l ? "," : "") << "[";
                for (size_t k = 0; k < p.loops[l].size(); ++k) js << (k ? "," : "") << "[" << detail::fmt(p.loops[l][k].x) << "," << detail::fmt(p.loops[l][k].z) << "]";
                js << "]";
            }
            js << "]}";
        }
        js << "],\"snap\":[";
        for (size_t i = 0; i < snaps_.size(); ++i) {
            const auto& s = snaps_[i];
            js << (i ? "," : "") << "{\"part\":" << detail::jstr(s.part) << ",\"loop\":" << s.loop << ",\"edge\":" << s.edge << ",\"lengthM\":" << detail::fmt(s.lengthM) << ",\"offsetM\":" << detail::fmt(s.offsetM)
               << ",\"supportShare\":" << detail::fmt(s.supportShare) << ",\"applied\":" << (s.applied ? "true" : "false") << "}";
        }
        js << "],\"meshSnap\":[";
        for (size_t i = 0; i < meshSnaps_.size(); ++i) js << (i ? "," : "") << "{\"mesh\":" << detail::jstr(meshSnaps_[i].id) << ",\"tx\":" << detail::fmt(meshSnaps_[i].tx) << ",\"tz\":" << detail::fmt(meshSnaps_[i].tz) << ",\"constraints\":" << meshSnaps_[i].constraints << ",\"applied\":" << (meshSnaps_[i].applied ? "true" : "false") << "}";
        js << "],\"residual\":{\"isolateTriangles\":" << isoTris_.size() << ",\"surface\":" << residualStats_[0] << ",\"proud\":" << residualStats_[1] << ",\"cut\":" << residualStats_[2]
           << ",\"apron\":" << residualStats_[3] << ",\"droppedSmall\":" << residualStats_[4] << ",\"clusters\":[";
        for (size_t i = 0; i < clusters_.size(); ++i) {
            const auto& c = clusters_[i];
            js << (i ? "," : "") << "{\"kind\":" << detail::jstr(c.kind) << ",\"areaM2\":" << detail::fmt(c.areaM2) << ",\"extremeM\":" << detail::fmt(c.extremeM) << ",\"triangles\":" << c.triangles
               << ",\"lo\":" << v3(c.lo) << ",\"hi\":" << v3(c.hi) << ",\"opensFace\":" << (c.opensFace ? "true" : "false") << ",\"face\":" << detail::jstr(c.face)
               << ",\"rect\":[" << detail::fmt(c.s0) << "," << detail::fmt(c.s1) << "," << detail::fmt(c.t0) << "," << detail::fmt(c.t1) << "]}";
        }
        js << "]},\"signedVolumeM3\":" << detail::fmt(volume_) << ",\"rejectedOpenings\":[";
        for (size_t i = 0; i < rejectedOpenings_.size(); ++i) js << (i ? "," : "") << detail::jstr(rejectedOpenings_[i]);
        js << "],\"rejectedSweeps\":[";
        for (size_t i = 0; i < rejectedSweeps_.size(); ++i) js << (i ? "," : "") << detail::jstr(rejectedSweeps_[i]);
        js << "],\"nodes\":" << (nodesJson_.empty() ? "[]" : nodesJson_) << ",\"images\":" << (imagesJson_.empty() ? "[]" : imagesJson_)
           << ",\"sections\":" << (sectionsJson_.empty() ? "[]" : sectionsJson_) << ",\"topdown\":" << (topdownJson_.empty() ? "null" : topdownJson_) << ",\"notes\":[";
        for (size_t i = 0; i < notes_.size(); ++i) js << (i ? "," : "") << detail::jstr(notes_[i]);
        js << "],\"timingsMs\":{";
        for (size_t i = 0; i < timings_.size(); ++i) js << (i ? "," : "") << detail::jstr(timings_[i].first) << ":" << detail::fmt(timings_[i].second);
        js << "}}";
        std::ofstream out(spec_.outDir + "/report.json");
        out << js.str();
    }
};

/**
 * The spec, one item per line ('#' comments):
 *   tile <glb> | isolate <glb> | out <dir> | param <name> <value>
 *   part <id> <baseY> <topY> <provenance>          then: loop <n> x z ... (first outer), plane <a> <b> <c> <tag>
 *   mesh <id> <nv> <nt> <provenance>               then: v x y z (nv lines), t i j k (nt lines)
 *   sweep <id> <confidence> <provenance> <np> o y ... <nf> <face> ... [top]   (top: y is above each wall's own top)
 *   opening <id> <face> <s0> <s1> <t0> <t1> <depth> <scanned 0|1> <confidence> <provenance> [arch <rise>]
 *   facesweep <id> <confidence> <provenance> <face> <axis 0|1> <np> o c ... <nplace> a0 a1 dc ...
 */
inline Spec readSpec(std::istream& in) {
    Spec s;
    std::string line;
    int n = 0;
    auto fail = [&](const std::string& m) { throw std::runtime_error("spec line " + std::to_string(n) + ": " + m); };
    while (std::getline(in, line)) {
        ++n;
        if (line.empty() || line[0] == '#') continue;
        std::istringstream ls(line);
        std::string k;
        ls >> k;
        if (k == "tile") ls >> s.tile;
        else if (k == "isolate") ls >> s.isolate;
        else if (k == "out") ls >> s.outDir;
        else if (k == "param") {
            std::string name;
            double v;
            ls >> name >> v;
            if (!ls) fail("param needs a name and a number");
            if (name == "pixel") s.pixel = v;
            else if (name == "slabBack") s.slabBack = v;
            else if (name == "slabFront") s.slabFront = v;
            else if (name == "protrusionReach") s.protrusionReach = v;
            else if (name == "snapMaxM") s.snapMaxM = v;
            else if (name == "snapMinSupport") s.snapMinSupport = v;
            else if (name == "snapWalls") s.snapWalls = v != 0;
            else if (name == "clipOpenings") s.clipOpenings = v != 0;
            else if (name == "residualProud") s.residualProud = v;
            else if (name == "residualCut") s.residualCut = v;
            else if (name == "residualMinArea") s.residualMinArea = v;
            else if (name == "residualClear") s.residualClear = v;
            else if (name == "residualOpen") s.residualOpen = v;
            else if (name == "apronHeight") s.apronHeight = v;
            else if (name == "attachReach") s.attachReach = v;
            else if (name == "maxFaceSide") s.maxFaceSide = v;
            else if (name == "reslabBelow") s.reslabBelow = v;
            else if (name == "reslabReach") s.reslabReach = v;
            else if (name == "bake") s.bake = v != 0;
            else if (name == "residual") s.residual = v != 0;
            else if (name == "sections") s.sections = v != 0;
            else if (name == "topdown") s.topdown = v != 0;
            else fail("unknown param " + name);
        } else if (k == "part") {
            Part p;
            ls >> p.id >> p.baseY >> p.topY >> p.provenance;
            if (!ls) fail("part needs id, base, top and provenance");
            s.parts.push_back(std::move(p));
        } else if (k == "loop") {
            if (s.parts.empty()) fail("loop before any part");
            size_t m;
            ls >> m;
            std::vector<V2> l(m);
            for (auto& q : l) ls >> q.x >> q.z;
            if (!ls || m < 3) fail("loop needs n >= 3 and n points");
            s.parts.back().loops.push_back(std::move(l));
        } else if (k == "plane") {
            if (s.parts.empty()) fail("plane before any part");
            RoofPlane pl;
            ls >> pl.a >> pl.b >> pl.c >> pl.tag;
            if (!ls) fail("plane needs a b c tag");
            s.parts.back().planes.push_back(pl);
        } else if (k == "mesh") {
            MeshSolid m;
            size_t nv, nt;
            ls >> m.id >> nv >> nt >> m.provenance;
            if (!ls) fail("mesh needs id nv nt provenance");
            for (size_t i = 0; i < nv; ++i) {
                if (!std::getline(in, line)) fail("mesh vertices end early");
                ++n;
                std::istringstream vl(line);
                std::string tag;
                V3 v;
                vl >> tag >> v.x >> v.y >> v.z;
                if (tag != "v" || !vl) fail("expected v x y z");
                m.v.push_back(v);
            }
            for (size_t i = 0; i < nt; ++i) {
                if (!std::getline(in, line)) fail("mesh triangles end early");
                ++n;
                std::istringstream tl(line);
                std::string tag;
                uint32_t a, b, c;
                tl >> tag >> a >> b >> c;
                if (tag != "t" || !tl || a >= nv || b >= nv || c >= nv) fail("expected t i j k within the vertices");
                m.tri.insert(m.tri.end(), {a, b, c});
            }
            s.meshes.push_back(std::move(m));
        } else if (k == "sweep") {
            SweepSpec w;
            size_t np, nf;
            ls >> w.id >> w.confidence >> w.provenance >> np;
            for (size_t i = 0; i < np; ++i) { double o, y; ls >> o >> y; w.profile.push_back({o, y}); }
            ls >> nf;
            for (size_t i = 0; i < nf; ++i) { std::string f; ls >> f; w.faces.push_back(f); }
            if (!ls) fail("sweep needs id confidence provenance np (o y)... nf face... [top]");
            std::string flag;
            if (ls >> flag) {
                if (flag != "top") fail("sweep: unknown trailing token " + flag + " (only \"top\": heights above each wall's top)");
                w.relativeToTop = true;
            }
            s.sweeps.push_back(std::move(w));
        } else if (k == "opening") {
            OpeningSpec o;
            int sc;
            ls >> o.id >> o.face >> o.s0 >> o.s1 >> o.t0 >> o.t1 >> o.depth >> sc >> o.confidence >> o.provenance;
            if (!ls) fail("opening needs id face s0 s1 t0 t1 depth scanned confidence provenance [arch rise]");
            o.scanned = sc != 0;
            std::string flag;
            if (ls >> flag) {
                if (flag != "arch" || !(ls >> o.archRise) || o.archRise < 0) fail("opening: unknown trailing token " + flag + " (only \"arch <rise>\")");
            }
            s.openings.push_back(o);
        } else if (k == "facesweep") {
            FaceSweepSpec w;
            size_t np, nl;
            ls >> w.id >> w.confidence >> w.provenance >> w.face >> w.axis >> np;
            for (size_t i = 0; i < np && ls; ++i) { double o, c; ls >> o >> c; w.profile.push_back({o, c}); }
            ls >> nl;
            for (size_t i = 0; i < nl && ls; ++i) { std::array<double, 3> q{}; ls >> q[0] >> q[1] >> q[2]; w.placements.push_back(q); }
            if (!ls || (w.axis != 0 && w.axis != 1)) fail("facesweep needs id confidence provenance face axis(0|1) np (o c)... nplace (a0 a1 dc)...");
            s.faceSweeps.push_back(std::move(w));
        } else fail("unknown item " + k);
    }
    if (s.outDir.empty()) throw std::runtime_error("spec: no out dir");
    if (s.parts.empty() && s.meshes.empty()) throw std::runtime_error("spec: no part and no mesh");
    for (const auto& p : s.parts) if (p.loops.empty()) throw std::runtime_error("spec: part " + p.id + " has no loop");
    return s;
}

}  // namespace staged_massing
}  // namespace scratchbox

#endif
