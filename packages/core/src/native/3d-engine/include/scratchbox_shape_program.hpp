/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_SHAPE_PROGRAM_HPP
#define SCRATCHBOX_SHAPE_PROGRAM_HPP

/**
 * Staged-location shape program (trial, sibling of scratchbox_staged_massing.hpp): a building's shape from the tree-free
 * scan, either measured directly (height-map tiers) or written as a short program of continuous geometric operators and
 * fitted to the scan.
 *
 *   - Scan analysis (`analyseScan`). The isolated scan's triangles are split into ground (a flat band at the street),
 *     tree (inside a measured crown's plan polygon, between its crown base and top, and more than a metre outside the vector
 *     footprint; one within it is kept and counted) and
 *     building. The building's dominant wall direction is the area-weighted mode of its vertical triangles' azimuths
 *     (mod 90 degrees); the analysis grid is laid out in that frame (u along it, v across, metres). The building's top is
 *     rendered into the grid (max height per cell, `cell` metres). Tier levels are modes of the up-facing area density
 *     (mean shift, as the scan rectifier's per-footprint tier heights) and of the cell-height histogram; each level's
 *     region is the cells standing above the midpoint to the level below; regions are cleaned (closing then opening),
 *     traced into loops and squared to the frame's axes. Where the vector footprint and the height map disagree the
 *     outline comes from the height map. Four oblique cameras (15 degrees off each frame axis, 20 degrees up) render the
 *     scan's depth and a clay shading: the fit's targets and the contact sheet's views.
 *   - Program (`Program`). Elements, each one geometric operator in the building frame (u, v, h above the street):
 *       prism    a plan outline extruded between two heights, its roof the lower envelope of a flat cap and the planes a
 *                continuous rise, ridge direction and hip share give (0: gable ends, 1: fully hipped);
 *       revolve  a radial profile r(z) revolved about a vertical axis, with K harmonic lobes of amplitude A, a polygon
 *                side count and a helical twist;
 *       sweep    a planar profile (points with DXF bulges for arcs) swept along a 3D carrier polyline, scaled and twisted
 *                along it, capped;
 *       relief   a band of a prism's walls displaced along their outward normal between two heights (a cornice, a belt);
 *     and any element repeated by an affine replicator (count, step vector). No element is named or classified: the
 *     operators are geometry, the labels opaque.
 *   - Fit (`fitProgram`). Every element has a fixed vector of handles (offsets, scales, heights) with bounds and steps; a
 *     coordinate descent with halving steps lowers the loss: the height grid's mean absolute error over the building's
 *     cells (over the building's height), one minus the silhouette IoU per oblique view, and the truncated depth error
 *     where both are seen.
 *
 * Output geometry is in the tile frame (x east, y up, z south): prisms as parts (loops, base, top, roof planes
 * y = a + b x + c z) for the staged massing kernel, the other operators as closed triangle solids.
 */

#include "scratchbox_gltf_scene.hpp"

#include <algorithm>
#include <array>
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
#include <vector>

namespace scratchbox {
namespace shape_program {

constexpr double PI = 3.14159265358979323846;

struct P2 { double u{0}, v{0}; };
struct P3 { double x{0}, y{0}, z{0}; };
inline P3 operator+(P3 a, P3 b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
inline P3 operator-(P3 a, P3 b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
inline P3 operator*(P3 a, double s) { return {a.x * s, a.y * s, a.z * s}; }
inline double dot(P3 a, P3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
inline P3 cross(P3 a, P3 b) { return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x}; }
inline double len(P3 a) { return std::sqrt(dot(a, a)); }
inline P3 unit(P3 a) { double l = len(a); return l > 1e-12 ? a * (1.0 / l) : P3{0, 0, 0}; }

/** A triangle soup in the building frame (x = u, y = h, z = v), with the element each triangle came from. */
struct Soup {
    std::vector<P3> p;        // 3 per triangle
    std::vector<int> elem;    // 1 per triangle
    void tri(P3 a, P3 b, P3 c, int e) { p.push_back(a); p.push_back(b); p.push_back(c); elem.push_back(e); }
    size_t size() const { return elem.size(); }
};

/** The building frame: u along the dominant wall direction (theta from tile +x toward +z), origin (ox, oz), h above groundY. */
struct Frame {
    double ox{0}, oz{0}, theta{0}, groundY{0};
    P2 toUV(double x, double z) const { double c = std::cos(theta), s = std::sin(theta), dx = x - ox, dz = z - oz; return {c * dx + s * dz, -s * dx + c * dz}; }
    void toXZ(double u, double v, double& x, double& z) const { double c = std::cos(theta), s = std::sin(theta); x = ox + c * u - s * v; z = oz + s * u + c * v; }
    P3 toTile(P3 q) const { double x, z; toXZ(q.x, q.z, x, z); return {x, groundY + q.y, z}; }
    P3 toLocal(P3 q) const { P2 w = toUV(q.x, q.z); return {w.u, q.y - groundY, w.v}; }
};

struct Grid {
    double u0{0}, v0{0}, cell{0.25};
    int nu{0}, nv{0};
    size_t size() const { return static_cast<size_t>(nu) * static_cast<size_t>(nv); }
    double cu(int i) const { return u0 + (i + 0.5) * cell; }
    double cv(int j) const { return v0 + (j + 0.5) * cell; }
};

/** A pinhole camera in the building frame. */
struct Camera {
    P3 eye, fwd, right, up;
    double focal{0};
    int W{0}, H{0};
};

namespace detail {
inline std::string fmt(double v) {
    if (!std::isfinite(v)) return "null";
    char b[40]; std::snprintf(b, sizeof b, "%.5g", v); return b;
}
inline std::string jstr(const std::string& s) {
    std::string o = "\"";
    for (char c : s) { if (c == '"' || c == '\\') { o += '\\'; o += c; } else if (static_cast<unsigned char>(c) < 0x20) o += ' '; else o += c; }
    return o + "\"";
}
inline double ringArea(const std::vector<P2>& r) {
    double a = 0;
    for (size_t i = 0, j = r.size() - 1; i < r.size(); j = i++) a += r[j].u * r[i].v - r[i].u * r[j].v;
    return a / 2;
}
inline bool inRing(double u, double v, const std::vector<P2>& r) {
    bool in = false;
    for (size_t i = 0, j = r.size() - 1; i < r.size(); j = i++) {
        if ((r[i].v > v) != (r[j].v > v) && u < (r[j].u - r[i].u) * (v - r[i].v) / (r[j].v - r[i].v) + r[i].u) in = !in;
    }
    return in;
}
template <class T> void writeRaw(const std::string& file, const std::vector<T>& v) {
    std::ofstream o(file, std::ios::binary);
    if (!o) throw std::runtime_error("cannot write " + file);
    o.write(reinterpret_cast<const char*>(v.data()), static_cast<std::streamsize>(v.size() * sizeof(T)));
}
template <class T> std::vector<T> readRaw(const std::string& file, size_t n) {
    std::ifstream in(file, std::ios::binary);
    if (!in) throw std::runtime_error("cannot read " + file);
    std::vector<T> v(n);
    in.read(reinterpret_cast<char*>(v.data()), static_cast<std::streamsize>(n * sizeof(T)));
    if (static_cast<size_t>(in.gcount()) != n * sizeof(T)) throw std::runtime_error(file + " is shorter than " + std::to_string(n * sizeof(T)) + " bytes");
    return v;
}

/** Ear-clipping triangulation of a simple polygon (either winding); returns index triples. */
inline std::vector<std::array<int, 3>> triangulate(const std::vector<P2>& poly) {
    std::vector<std::array<int, 3>> out;
    const int n = static_cast<int>(poly.size());
    if (n < 3) return out;
    std::vector<int> idx(n);
    std::iota(idx.begin(), idx.end(), 0);
    if (ringArea(poly) < 0) std::reverse(idx.begin(), idx.end());
    auto crossz = [&](int a, int b, int c) { return (poly[b].u - poly[a].u) * (poly[c].v - poly[a].v) - (poly[b].v - poly[a].v) * (poly[c].u - poly[a].u); };
    auto inside = [&](int a, int b, int c, int p) {
        double d1 = (poly[b].u - poly[a].u) * (poly[p].v - poly[a].v) - (poly[b].v - poly[a].v) * (poly[p].u - poly[a].u);
        double d2 = (poly[c].u - poly[b].u) * (poly[p].v - poly[b].v) - (poly[c].v - poly[b].v) * (poly[p].u - poly[b].u);
        double d3 = (poly[a].u - poly[c].u) * (poly[p].v - poly[c].v) - (poly[a].v - poly[c].v) * (poly[p].u - poly[c].u);
        return d1 > 1e-12 && d2 > 1e-12 && d3 > 1e-12;
    };
    int guard = 0;
    while (idx.size() > 3 && guard++ < 10 * n * n) {
        bool clipped = false;
        const int m = static_cast<int>(idx.size());
        for (int k = 0; k < m; ++k) {
            int a = idx[(k + m - 1) % m], b = idx[k], c = idx[(k + 1) % m];
            if (crossz(a, b, c) <= 1e-12) continue;
            bool ear = true;
            for (int q : idx) if (q != a && q != b && q != c && inside(a, b, c, q)) { ear = false; break; }
            if (!ear) continue;
            out.push_back({a, b, c});
            idx.erase(idx.begin() + k);
            clipped = true;
            break;
        }
        if (!clipped) {  // degenerate remainder: drop the flattest vertex
            int best = 0; double bv = 1e300;
            for (int k = 0; k < m; ++k) { double cz = std::abs(crossz(idx[(k + m - 1) % m], idx[k], idx[(k + 1) % m])); if (cz < bv) { bv = cz; best = k; } }
            idx.erase(idx.begin() + best);
        }
    }
    if (idx.size() == 3 && crossz(idx[0], idx[1], idx[2]) > 1e-12) out.push_back({idx[0], idx[1], idx[2]});
    return out;
}

/** Clips a convex polygon to the half-plane k0 + ku u + kv v <= 0. */
inline std::vector<P2> clipHalf(const std::vector<P2>& poly, double k0, double ku, double kv) {
    std::vector<P2> out;
    const size_t n = poly.size();
    for (size_t i = 0; i < n; ++i) {
        const P2& a = poly[i]; const P2& b = poly[(i + 1) % n];
        double fa = k0 + ku * a.u + kv * a.v, fb = k0 + ku * b.u + kv * b.v;
        if (fa <= 0) out.push_back(a);
        if ((fa <= 0) != (fb <= 0)) { double t = fa / (fa - fb); out.push_back({a.u + (b.u - a.u) * t, a.v + (b.v - a.v) * t}); }
    }
    return out;
}

/** Mitred outward offset of a ring by d (negative: inward); the mitre is limited to 3 d. */
inline std::vector<P2> offsetRing(const std::vector<P2>& r, double d) {
    const size_t n = r.size();
    if (n < 3 || std::abs(d) < 1e-9) return r;
    const double sgn = ringArea(r) > 0 ? 1.0 : -1.0;  // CCW: outward normal of edge (a->b) is (dv, -du)
    std::vector<P2> out(n);
    for (size_t i = 0; i < n; ++i) {
        const P2& p = r[(i + n - 1) % n]; const P2& q = r[i]; const P2& s = r[(i + 1) % n];
        double e1u = q.u - p.u, e1v = q.v - p.v, l1 = std::hypot(e1u, e1v);
        double e2u = s.u - q.u, e2v = s.v - q.v, l2 = std::hypot(e2u, e2v);
        if (l1 < 1e-9 || l2 < 1e-9) { out[i] = q; continue; }
        double n1u = sgn * e1v / l1, n1v = -sgn * e1u / l1, n2u = sgn * e2v / l2, n2v = -sgn * e2u / l2;
        double mu = n1u + n2u, mv = n1v + n2v, ml = std::hypot(mu, mv);
        if (ml < 1e-9) { out[i] = {q.u + n1u * d, q.v + n1v * d}; continue; }
        mu /= ml; mv /= ml;
        double c = mu * n1u + mv * n1v;
        double k = std::min(3.0, 1.0 / std::max(1e-3, c));
        out[i] = {q.u + mu * d * k, q.v + mv * d * k};
    }
    return out;
}
}  // namespace detail

// =============================================================================================
// Rasterisation (building frame)
// =============================================================================================

/** Max height per grid cell of a soup seen from above (NaN where nothing). */
inline void rasterTop(const Soup& s, const Grid& g, std::vector<float>& h, std::vector<int>* elemOut = nullptr) {
    h.assign(g.size(), std::numeric_limits<float>::quiet_NaN());
    if (elemOut) elemOut->assign(g.size(), -1);
    for (size_t t = 0; t < s.size(); ++t) {
        const P3 &a = s.p[3 * t], &b = s.p[3 * t + 1], &c = s.p[3 * t + 2];
        double d = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
        if (std::abs(d) < 1e-10) continue;
        int i0 = std::max(0, static_cast<int>(std::floor((std::min({a.x, b.x, c.x}) - g.u0) / g.cell - 0.5)));
        int i1 = std::min(g.nu - 1, static_cast<int>(std::ceil((std::max({a.x, b.x, c.x}) - g.u0) / g.cell - 0.5)));
        int j0 = std::max(0, static_cast<int>(std::floor((std::min({a.z, b.z, c.z}) - g.v0) / g.cell - 0.5)));
        int j1 = std::min(g.nv - 1, static_cast<int>(std::ceil((std::max({a.z, b.z, c.z}) - g.v0) / g.cell - 0.5)));
        for (int j = j0; j <= j1; ++j) for (int i = i0; i <= i1; ++i) {
            double pu = g.cu(i), pv = g.cv(j);
            double l1 = ((b.z - c.z) * (pu - c.x) + (c.x - b.x) * (pv - c.z)) / d;
            double l2 = ((c.z - a.z) * (pu - c.x) + (a.x - c.x) * (pv - c.z)) / d;
            double l3 = 1 - l1 - l2;
            if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
            float y = static_cast<float>(l1 * a.y + l2 * b.y + l3 * c.y);
            size_t k = static_cast<size_t>(j) * g.nu + i;
            if (!(h[k] >= y)) { h[k] = y; if (elemOut) (*elemOut)[k] = s.elem[t]; }
        }
    }
}

/** Depth (camera z, +inf where nothing) and a clay shade (0..255; 0 background) of a soup from a pinhole camera. */
inline void rasterView(const Soup& s, const Camera& cam, std::vector<float>& depth, std::vector<uint8_t>* shade = nullptr) {
    depth.assign(static_cast<size_t>(cam.W) * cam.H, std::numeric_limits<float>::infinity());
    if (shade) shade->assign(depth.size(), 0);
    const double cx = cam.W * 0.5, cy = cam.H * 0.5, near = 0.1;
    const P3 key = unit(cam.fwd * -1.0 + cam.up * 0.6 + cam.right * 0.35);
    for (size_t t = 0; t < s.size(); ++t) {
        P3 q[3];
        for (int k = 0; k < 3; ++k) { P3 d = s.p[3 * t + k] - cam.eye; q[k] = {dot(d, cam.right), dot(d, cam.up), dot(d, cam.fwd)}; }
        if (q[0].z < near || q[1].z < near || q[2].z < near) continue;  // the cameras stand well back: no clipping needed
        double sx[3], sy[3], iz[3];
        for (int k = 0; k < 3; ++k) { iz[k] = 1.0 / q[k].z; sx[k] = cx + cam.focal * q[k].x * iz[k]; sy[k] = cy - cam.focal * q[k].y * iz[k]; }
        double area = (sx[1] - sx[0]) * (sy[2] - sy[0]) - (sx[2] - sx[0]) * (sy[1] - sy[0]);
        if (std::abs(area) < 1e-12) continue;
        int x0 = std::max(0, static_cast<int>(std::floor(std::min({sx[0], sx[1], sx[2]}))));
        int x1 = std::min(cam.W - 1, static_cast<int>(std::ceil(std::max({sx[0], sx[1], sx[2]}))));
        int y0 = std::max(0, static_cast<int>(std::floor(std::min({sy[0], sy[1], sy[2]}))));
        int y1 = std::min(cam.H - 1, static_cast<int>(std::ceil(std::max({sy[0], sy[1], sy[2]}))));
        if (x0 > x1 || y0 > y1) continue;
        uint8_t tone = 0;
        if (shade) {
            P3 n = unit(cross(s.p[3 * t + 1] - s.p[3 * t], s.p[3 * t + 2] - s.p[3 * t]));
            if (dot(n, cam.fwd) > 0) n = n * -1.0;
            double lit = 0.35 + 0.65 * std::max(0.0, dot(n, key));
            tone = static_cast<uint8_t>(std::clamp(40.0 + 200.0 * lit, 1.0, 255.0));
        }
        for (int y = y0; y <= y1; ++y) for (int x = x0; x <= x1; ++x) {
            double px = x + 0.5, py = y + 0.5;
            double w0 = ((sx[1] - px) * (sy[2] - py) - (sx[2] - px) * (sy[1] - py)) / area;
            double w1 = ((sx[2] - px) * (sy[0] - py) - (sx[0] - px) * (sy[2] - py)) / area;
            double w2 = 1 - w0 - w1;
            if (w0 < 0 || w1 < 0 || w2 < 0) continue;
            float z = static_cast<float>(1.0 / (w0 * iz[0] + w1 * iz[1] + w2 * iz[2]));
            size_t k = static_cast<size_t>(y) * cam.W + x;
            if (z < depth[k]) { depth[k] = z; if (shade) (*shade)[k] = tone; }
        }
    }
}

/** Cameras 15 degrees off each frame axis, 20 degrees up, framing the box [lo, hi] (building frame). */
inline std::vector<Camera> obliqueCameras(P3 lo, P3 hi, int W, int H, double fovDeg = 42) {
    std::vector<Camera> cams;
    P3 c = (lo + hi) * 0.5;
    double r = 0.5 * len(hi - lo);
    double f = 0.5 * H / std::tan(fovDeg * PI / 360);
    double dist = r / std::tan(fovDeg * PI / 360) * 1.1;
    for (int k = 0; k < 4; ++k) {
        double az = (15.0 + 90.0 * k) * PI / 180, el = 20.0 * PI / 180;
        P3 dir{std::cos(el) * std::cos(az), std::sin(el), std::cos(el) * std::sin(az)};  // from the centre toward the eye
        Camera cam;
        cam.eye = c + dir * dist;
        cam.fwd = unit(dir * -1.0);
        cam.right = unit(cross(cam.fwd, P3{0, 1, 0}));
        cam.up = cross(cam.right, cam.fwd);
        cam.focal = f; cam.W = W; cam.H = H;
        cams.push_back(cam);
    }
    return cams;
}

// =============================================================================================
// Binary masks: cleaning and tracing
// =============================================================================================

inline std::vector<uint8_t> morph(const std::vector<uint8_t>& m, const Grid& g, int r, bool dilate) {
    std::vector<uint8_t> tmp(m.size()), out(m.size());
    for (int j = 0; j < g.nv; ++j) for (int i = 0; i < g.nu; ++i) {
        bool v = !dilate;
        for (int d = -r; d <= r; ++d) { int ii = i + d; bool x = ii >= 0 && ii < g.nu && m[static_cast<size_t>(j) * g.nu + ii]; if (dilate ? x : !x) { v = dilate; break; } }
        tmp[static_cast<size_t>(j) * g.nu + i] = v;
    }
    for (int j = 0; j < g.nv; ++j) for (int i = 0; i < g.nu; ++i) {
        bool v = !dilate;
        for (int d = -r; d <= r; ++d) { int jj = j + d; bool x = jj >= 0 && jj < g.nv && tmp[static_cast<size_t>(jj) * g.nu + i]; if (dilate ? x : !x) { v = dilate; break; } }
        out[static_cast<size_t>(j) * g.nu + i] = v;
    }
    return out;
}
inline std::vector<uint8_t> closeOpen(const std::vector<uint8_t>& m, const Grid& g, int r) {
    auto c = morph(morph(m, g, r, true), g, r, false);
    return morph(morph(c, g, r, false), g, r, true);
}
/** 4-connected components of a mask: label per cell (-1 outside) and the cell count per label. */
inline std::vector<int> components(const std::vector<uint8_t>& m, const Grid& g, std::vector<int>& sizes) {
    std::vector<int> lab(m.size(), -1);
    sizes.clear();
    std::vector<size_t> st;
    for (size_t s0 = 0; s0 < m.size(); ++s0) {
        if (!m[s0] || lab[s0] >= 0) continue;
        int id = static_cast<int>(sizes.size()), n = 0;
        st.push_back(s0); lab[s0] = id;
        while (!st.empty()) {
            size_t k = st.back(); st.pop_back(); ++n;
            int i = static_cast<int>(k % g.nu), j = static_cast<int>(k / g.nu);
            const int di[4] = {1, -1, 0, 0}, dj[4] = {0, 0, 1, -1};
            for (int q = 0; q < 4; ++q) {
                int ii = i + di[q], jj = j + dj[q];
                if (ii < 0 || jj < 0 || ii >= g.nu || jj >= g.nv) continue;
                size_t kk = static_cast<size_t>(jj) * g.nu + ii;
                if (m[kk] && lab[kk] < 0) { lab[kk] = id; st.push_back(kk); }
            }
        }
        sizes.push_back(n);
    }
    return lab;
}

/**
 * Loops along the cell boundaries of a mask (frame u, v): outer loops counter-clockwise, holes clockwise. Each loop is
 * simplified (Douglas-Peucker at `tol`) and squared: an edge within `squareDeg` of a frame axis is made parallel to it,
 * and consecutive edges are re-intersected.
 */
inline std::vector<std::vector<P2>> traceLoops(const std::vector<uint8_t>& m, const Grid& g, double tol, double squareDeg) {
    auto in = [&](int i, int j) { return i >= 0 && j >= 0 && i < g.nu && j < g.nv && m[static_cast<size_t>(j) * g.nu + i]; };
    // directed boundary edges with the inside on the left: lattice corners (i, j) .. (i + 1, j + 1)
    std::map<std::pair<int, int>, std::vector<std::pair<int, int>>> next;
    for (int j = -1; j <= g.nv; ++j) for (int i = -1; i <= g.nu; ++i) {
        if (!in(i, j)) continue;
        if (!in(i, j - 1)) next[{i, j}].push_back({i + 1, j});          // bottom edge, going +u
        if (!in(i + 1, j)) next[{i + 1, j}].push_back({i + 1, j + 1});  // right edge, going +v
        if (!in(i, j + 1)) next[{i + 1, j + 1}].push_back({i, j + 1});  // top edge, going -u
        if (!in(i - 1, j)) next[{i, j + 1}].push_back({i, j});          // left edge, going -v
    }
    std::vector<std::vector<P2>> loops;
    while (!next.empty()) {
        auto it = next.begin();
        std::pair<int, int> start = it->first, cur = start;
        std::vector<std::pair<int, int>> pts;
        std::pair<int, int> prevDir{0, 0};
        for (int guard = 0; guard < 4 * static_cast<int>(g.size()) + 16; ++guard) {
            auto f = next.find(cur);
            if (f == next.end() || f->second.empty()) break;
            // at a corner shared by two loops prefer the right turn (keeps diagonal touches apart)
            size_t pick = 0;
            if (f->second.size() > 1) {
                for (size_t q = 0; q < f->second.size(); ++q) {
                    std::pair<int, int> d{f->second[q].first - cur.first, f->second[q].second - cur.second};
                    if (prevDir.first * d.second - prevDir.second * d.first < 0) { pick = q; break; }
                }
            }
            std::pair<int, int> nx = f->second[pick];
            f->second.erase(f->second.begin() + static_cast<long>(pick));
            if (f->second.empty()) next.erase(f);
            pts.push_back(cur);
            prevDir = {nx.first - cur.first, nx.second - cur.second};
            cur = nx;
            if (cur == start) break;
        }
        if (pts.size() < 4) continue;
        std::vector<P2> ring;
        for (auto& p : pts) ring.push_back({g.u0 + p.first * g.cell, g.v0 + p.second * g.cell});
        // Douglas-Peucker on the closed ring (split at the vertex furthest from the first)
        auto segd = [](const P2& p, const P2& a, const P2& b) {
            double du = b.u - a.u, dv = b.v - a.v, l2 = du * du + dv * dv;
            double t = l2 > 0 ? std::clamp(((p.u - a.u) * du + (p.v - a.v) * dv) / l2, 0.0, 1.0) : 0;
            return std::hypot(p.u - a.u - t * du, p.v - a.v - t * dv);
        };
        std::function<void(const std::vector<P2>&, size_t, size_t, std::vector<P2>&)> dp = [&](const std::vector<P2>& r, size_t a, size_t b, std::vector<P2>& out) {
            double dm = 0; size_t im = a;
            for (size_t k = a + 1; k < b; ++k) { double d = segd(r[k], r[a], r[b]); if (d > dm) { dm = d; im = k; } }
            if (dm > tol) { dp(r, a, im, out); dp(r, im, b, out); } else out.push_back(r[a]);
        };
        size_t far = 0; double fd = -1;
        for (size_t k = 1; k < ring.size(); ++k) { double d = std::hypot(ring[k].u - ring[0].u, ring[k].v - ring[0].v); if (d > fd) { fd = d; far = k; } }
        std::vector<P2> closed = ring; closed.push_back(ring[0]);
        std::vector<P2> simp;
        dp(closed, 0, far, simp);
        dp(closed, far, closed.size() - 1, simp);
        if (simp.size() < 3) continue;
        // squaring: near-axis edges made axis-parallel, then consecutive lines re-intersected
        const size_t n = simp.size();
        struct Line { double pu, pv, du, dv; };
        std::vector<Line> lines(n);
        const double tq = std::tan(squareDeg * PI / 180);
        for (size_t k = 0; k < n; ++k) {
            const P2 &a = simp[k], &b = simp[(k + 1) % n];
            double du = b.u - a.u, dv = b.v - a.v;
            if (std::abs(dv) <= tq * std::abs(du)) { double vm = (a.v + b.v) / 2; lines[k] = {a.u, vm, du > 0 ? 1.0 : -1.0, 0}; }
            else if (std::abs(du) <= tq * std::abs(dv)) { double um = (a.u + b.u) / 2; lines[k] = {um, a.v, 0, dv > 0 ? 1.0 : -1.0}; }
            else lines[k] = {a.u, a.v, du, dv};
        }
        std::vector<P2> sq;
        for (size_t k = 0; k < n; ++k) {
            const Line &L1 = lines[(k + n - 1) % n], &L2 = lines[k];
            double den = L1.du * L2.dv - L1.dv * L2.du;
            if (std::abs(den) < 1e-9) continue;  // parallel neighbours: the corner is not needed
            double t = ((L2.pu - L1.pu) * L2.dv - (L2.pv - L1.pv) * L2.du) / den;
            sq.push_back({L1.pu + L1.du * t, L1.pv + L1.dv * t});
        }
        // drop near-duplicates and spikes
        std::vector<P2> clean;
        for (const auto& p : sq) if (clean.empty() || std::hypot(p.u - clean.back().u, p.v - clean.back().v) > 0.05) clean.push_back(p);
        if (clean.size() > 2 && std::hypot(clean[0].u - clean.back().u, clean[0].v - clean.back().v) <= 0.05) clean.pop_back();
        if (clean.size() >= 3 && std::abs(detail::ringArea(clean)) >= 0.5) loops.push_back(clean);
    }
    return loops;
}

// =============================================================================================
// Scan analysis
// =============================================================================================

struct Crown { int id{0}; double baseY{0}, topY{0}; std::vector<P2> footprintXZ; };  // footprint in tile x, z

struct TierOut { double baseY{0}, topY{0}, areaM2{0}; std::vector<std::vector<P2>> loopsUV; };

struct ScanResult {
    Frame frame;
    Grid grid;
    std::vector<float> height;     // building top above the street (m), NaN where nothing
    std::vector<uint8_t> mask;     // the building's cells
    Soup building;                 // building triangles (building frame)
    std::vector<Camera> cams;
    std::vector<std::vector<float>> depth;
    std::vector<std::vector<uint8_t>> shade;
    std::vector<TierOut> tiers;
    std::vector<std::pair<double, double>> modes;  // (height above the street, up-facing area)
    std::vector<std::vector<P2>> outlineUV;        // the building's outline loops (frame)
    size_t triTotal{0}, triBuilding{0}, triGround{0}, triTree{0}, triTreeKept{0}, triOutsideOutline{0};
    double areaBuilding{0}, areaGround{0}, areaTree{0}, areaTreeKept{0};
    std::map<int, std::pair<size_t, double>> treeByCrown;
    double footprintAgreement{-1};
    std::string outlineSource;
    double thetaSupport{0};
    P3 boxLo, boxHi;               // the building cells' box (frame)
    std::string directionSource;
    std::vector<std::string> notes;
    std::vector<std::pair<std::string, double>> timings;
};

struct ScanParams {
    double cell{0.25};
    double groundBand{0.6};          // a near-flat triangle this close above the street is ground
    double minBuildingH{2.0};        // a cell is building when its top stands this far above the street
    double footprintDilate{2.0};     // the vector footprint, grown by this, bounds the height map where the two agree
    double agreeShare{0.5};          // share of the footprint's cells the height map must cover to agree
    double modeBandwidth{0.25};      // mean-shift kernel of the tier levels (m)
    double modeMerge{1.5};           // levels closer than this are one (m)
    double minTierArea{6.0};         // a level, or a tier region, needs this much area (m^2)
    double minTierShare{0.02};       // ... or this share of the building's plan, whichever is larger
    int maxTiers{6};
    double cleanRadius{0.75};        // closing then opening radius of a tier region (m)
    double simplifyTol{0.35};        // Douglas-Peucker tolerance of the traced outlines (m)
    double squareDeg{14.0};          // edges within this of a frame axis are squared
    int viewW{480}, viewH{360};
};

inline ScanResult analyseScan(const std::string& isolate, double groundY, const std::vector<std::vector<P2>>& footprintXZ, const std::vector<Crown>& crowns, const ScanParams& P) {
    using Clock = std::chrono::steady_clock;
    auto t0 = Clock::now();
    auto lap = [&](const char* name) { auto t = Clock::now(); return std::make_pair(std::string(name), std::chrono::duration<double, std::milli>(t - t0).count()); };
    ScanResult R;
    gltf::GltfScene sc = gltf::GlbSceneReader::readFile(isolate);
    if (!sc.ok) throw std::runtime_error("isolate: " + sc.error);
    const auto& vs = sc.mesh.vertices;
    const auto& ix = sc.mesh.indices;
    R.triTotal = ix.size() / 3;
    // the union of the footprint's loops (Google's parts can be triangles repeated with both windings: even-odd would cancel)
    auto inFootprint = [&](double x, double z) {
        for (const auto& l : footprintXZ) if (l.size() >= 3 && detail::inRing(x, z, l)) return true;
        return false;
    };
    // --- classify: ground, tree, building
    std::vector<std::array<P3, 3>> bld;
    for (size_t t = 0; t + 2 < ix.size(); t += 3) {
        P3 a{vs[ix[t]].position.x, vs[ix[t]].position.y, vs[ix[t]].position.z};
        P3 b{vs[ix[t + 1]].position.x, vs[ix[t + 1]].position.y, vs[ix[t + 1]].position.z};
        P3 c{vs[ix[t + 2]].position.x, vs[ix[t + 2]].position.y, vs[ix[t + 2]].position.z};
        P3 n = cross(b - a, c - a);
        double area = 0.5 * len(n);
        n = unit(n);
        P3 cen = (a + b + c) * (1.0 / 3);
        if (cen.y < groundY + P.groundBand && std::abs(n.y) > 0.8) { R.triGround++; R.areaGround += area; continue; }
        int crownHit = -1;
        for (const auto& cr : crowns) {
            if (cen.y < cr.baseY || cen.y > cr.topY + 1.0) continue;
            if (detail::inRing(cen.x, cen.z, cr.footprintXZ)) { crownHit = cr.id; break; }
        }
        if (crownHit >= 0) {
            // within a metre of the footprint the triangle may be the building's own wall under the crown: kept, counted
            bool nearFp = inFootprint(cen.x, cen.z);
            for (int q = 0; q < 8 && !nearFp && !footprintXZ.empty(); ++q) nearFp = inFootprint(cen.x + std::cos(q * PI / 4), cen.z + std::sin(q * PI / 4));
            if (nearFp) { R.triTreeKept++; R.areaTreeKept += area; }  // inside the footprint: kept, counted
            else { R.triTree++; R.areaTree += area; auto& e = R.treeByCrown[crownHit]; e.first++; e.second += area; continue; }
        }
        R.triBuilding++; R.areaBuilding += area;
        bld.push_back({a, b, c});
    }
    R.timings.push_back(lap("classify"));
    if (bld.size() < 8) throw std::runtime_error("the tree-free scan holds only " + std::to_string(bld.size()) + " building triangles");
    // --- dominant wall direction: area-weighted azimuth histogram mod 90 degrees (0.5 degree bins, smoothed)
    // candidate directions: the mode of the scan's vertical walls' azimuths and of the vector footprint's edges (each mod
    // 90 degrees); the one whose frame boxes the roof most tightly (percentile box area) wins
    auto modeOf = [](const std::vector<double>& hist, double& support) {
        size_t best = 0; double bv = -1;
        for (size_t k = 0; k < 180; ++k) {
            double s2 = 0;
            for (int d = -3; d <= 3; ++d) s2 += hist[(k + 180 + d) % 180] * std::exp(-0.5 * d * d / 2.0);
            if (s2 > bv) { bv = s2; best = k; }
        }
        double sw = 0, sa = 0;  // refine: circular mean (mod 90) around the peak
        for (int d = -6; d <= 6; ++d) { size_t k = (best + 180 + d) % 180; double a = (k + 0.5) * 0.5 * PI / 180 * 4; sw += hist[k] * std::cos(a); sa += hist[k] * std::sin(a); }
        double tot = std::accumulate(hist.begin(), hist.end(), 0.0);
        support = tot > 0 ? bv / tot : 0;
        return std::atan2(sa, sw) / 4;
    };
    std::vector<double> histW(180, 0.0), histF(180, 0.0);
    double cxs = 0, czs = 0, aw = 0;
    std::vector<std::array<double, 2>> roofPts;
    for (const auto& tr : bld) {
        P3 n = cross(tr[1] - tr[0], tr[2] - tr[0]);
        double area = 0.5 * len(n);
        n = unit(n);
        P3 cen = (tr[0] + tr[1] + tr[2]) * (1.0 / 3);
        cxs += cen.x * area; czs += cen.z * area; aw += area;
        if (std::abs(n.y) > 0.5 && cen.y > groundY + P.minBuildingH) roofPts.push_back({cen.x, cen.z});
        if (std::abs(n.y) > 0.1) continue;
        double az = std::fmod(std::atan2(n.z, n.x) * 180 / PI + 720.0, 90.0);  // a wall's direction is its normal's +- 90
        histW[static_cast<size_t>(std::min(179.0, az * 2))] += area;
    }
    for (const auto& l : footprintXZ) for (size_t i = 0; i < l.size(); ++i) {
        const P2 &a = l[i], &b = l[(i + 1) % l.size()];
        double el = std::hypot(b.u - a.u, b.v - a.v);
        if (el < 0.5) continue;
        double az = std::fmod(std::atan2(b.v - a.v, b.u - a.u) * 180 / PI + 720.0, 90.0);
        histF[static_cast<size_t>(std::min(179.0, az * 2))] += el;
    }
    double supW = 0, supF = 0;
    const double thW = modeOf(histW, supW), thF = footprintXZ.empty() ? thW : modeOf(histF, supF);
    auto boxArea = [&](double th) {
        if (roofPts.size() < 10) return 0.0;
        std::vector<double> us, vs;
        for (const auto& p : roofPts) { us.push_back(std::cos(th) * p[0] + std::sin(th) * p[1]); vs.push_back(-std::sin(th) * p[0] + std::cos(th) * p[1]); }
        std::sort(us.begin(), us.end()); std::sort(vs.begin(), vs.end());
        auto q = [](const std::vector<double>& x, double f) { return x[std::min(x.size() - 1, static_cast<size_t>(f * x.size()))]; };
        return (q(us, 0.99) - q(us, 0.01)) * (q(vs, 0.99) - q(vs, 0.01));
    };
    const double aW = boxArea(thW), aF = boxArea(thF);
    const bool useF = !footprintXZ.empty() && aF < aW;
    double theta = useF ? thF : thW;
    R.thetaSupport = useF ? supF : supW;
    R.directionSource = useF ? "the vector footprint's edges" : "the scan's vertical walls";
    R.notes.push_back("direction: walls " + detail::fmt(thW * 180 / PI) + " deg (roof box " + detail::fmt(aW) + " m^2), footprint " + (footprintXZ.empty() ? std::string("none") : detail::fmt(thF * 180 / PI) + " deg (roof box " + detail::fmt(aF) + " m^2)"));
    R.frame = {cxs / aw, czs / aw, theta, groundY};
    R.timings.push_back(lap("direction"));
    // --- building soup in the frame, grid over it
    P3 lo{1e300, 1e300, 1e300}, hi{-1e300, -1e300, -1e300};
    for (const auto& tr : bld) {
        P3 q[3];
        for (int k = 0; k < 3; ++k) {
            q[k] = R.frame.toLocal(tr[k]);
            lo = {std::min(lo.x, q[k].x), std::min(lo.y, q[k].y), std::min(lo.z, q[k].z)};
            hi = {std::max(hi.x, q[k].x), std::max(hi.y, q[k].y), std::max(hi.z, q[k].z)};
        }
        R.building.tri(q[0], q[1], q[2], 0);
    }
    const double margin = 4.0;
    R.grid.cell = P.cell;
    R.grid.u0 = std::floor((lo.x - margin) / P.cell) * P.cell;
    R.grid.v0 = std::floor((lo.z - margin) / P.cell) * P.cell;
    R.grid.nu = static_cast<int>(std::ceil((hi.x - lo.x + 2 * margin) / P.cell)) + 1;
    R.grid.nv = static_cast<int>(std::ceil((hi.z - lo.z + 2 * margin) / P.cell)) + 1;
    if (R.grid.size() > 6'000'000) throw std::runtime_error("the building's plan is too large for the height grid");
    rasterTop(R.building, R.grid, R.height);
    R.timings.push_back(lap("heightmap"));
    const Grid& g = R.grid;
    // --- the building's cells; the vector footprint where it agrees with the height map
    R.mask.assign(g.size(), 0);
    for (size_t k = 0; k < g.size(); ++k) R.mask[k] = R.height[k] >= P.minBuildingH;
    size_t maskCells = std::accumulate(R.mask.begin(), R.mask.end(), size_t{0});
    if (!footprintXZ.empty()) {
        std::vector<uint8_t> fp(g.size(), 0);
        size_t fpCells = 0, both = 0;
        for (int j = 0; j < g.nv; ++j) for (int i = 0; i < g.nu; ++i) {
            double x, z; R.frame.toXZ(g.cu(i), g.cv(j), x, z);
            size_t k = static_cast<size_t>(j) * g.nu + i;
            if (inFootprint(x, z)) { fp[k] = 1; fpCells++; if (R.mask[k]) both++; }
        }
        R.footprintAgreement = fpCells ? static_cast<double>(both) / fpCells : 0;
        if (R.footprintAgreement >= P.agreeShare) {
            auto grown = morph(fp, g, static_cast<int>(std::round(P.footprintDilate / g.cell)), true);
            for (size_t k = 0; k < g.size(); ++k) R.mask[k] = R.mask[k] && grown[k];
            R.outlineSource = "height map within the vector footprint";
        } else {
            R.outlineSource = "height map (the vector footprint disagrees)";
            R.notes.push_back("the vector footprint covers " + std::to_string(fpCells) + " cells of which the height map stands on " + std::to_string(both) + ": the outline comes from the height map");
        }
    } else R.outlineSource = "height map (no vector footprint)";
    // keep components of a useful size
    {
        std::vector<int> sizes;
        auto lab = components(R.mask, g, sizes);
        const int minCells = static_cast<int>(std::ceil(4.0 / (g.cell * g.cell)));
        for (size_t k = 0; k < g.size(); ++k) if (lab[k] >= 0 && sizes[static_cast<size_t>(lab[k])] < minCells) R.mask[k] = 0;
    }
    maskCells = std::accumulate(R.mask.begin(), R.mask.end(), size_t{0});
    const double planArea = maskCells * g.cell * g.cell;
    if (planArea < 4.0) throw std::runtime_error("no part of the tree-free scan stands " + std::to_string(P.minBuildingH) + " m above the street");
    R.outlineUV = traceLoops(closeOpen(R.mask, g, std::max(1, static_cast<int>(std::round(P.cleanRadius / g.cell)))), g, P.simplifyTol, P.squareDeg);
    // the building is what stands over its cells (grown by a metre): fragments of the isolate outside it (fences, ground
    // skirts, a neighbour's edge) leave the fit's targets and the views
    {
        auto grown = morph(R.mask, g, std::max(1, static_cast<int>(std::round(1.0 / g.cell))), true);
        Soup kept;
        size_t dropped = 0;
        for (size_t t = 0; t < R.building.size(); ++t) {
            P3 cen = (R.building.p[3 * t] + R.building.p[3 * t + 1] + R.building.p[3 * t + 2]) * (1.0 / 3);
            int i = static_cast<int>(std::floor((cen.x - g.u0) / g.cell)), j = static_cast<int>(std::floor((cen.z - g.v0) / g.cell));
            if (i >= 0 && j >= 0 && i < g.nu && j < g.nv && grown[static_cast<size_t>(j) * g.nu + i]) kept.tri(R.building.p[3 * t], R.building.p[3 * t + 1], R.building.p[3 * t + 2], 0);
            else dropped++;
        }
        R.triOutsideOutline = dropped;
        R.building = std::move(kept);
        std::vector<float> hClean;
        rasterTop(R.building, g, hClean);
        R.height = std::move(hClean);
    }
    // --- tier levels: modes of the up-facing area and of the cell heights (mean shift), merged
    const double minArea = std::max(P.minTierArea, P.minTierShare * planArea);
    struct Item { double y, w; };
    std::vector<Item> items;
    for (size_t t = 0; t < R.building.size(); ++t) {
        const P3 &a = R.building.p[3 * t], &b = R.building.p[3 * t + 1], &c = R.building.p[3 * t + 2];
        P3 n = cross(b - a, c - a);
        double area = 0.5 * len(n);
        if (std::abs(unit(n).y) < 0.9) continue;  // up-facing (the scan's winding is mixed)
        P3 cen = (a + b + c) * (1.0 / 3);
        int i = static_cast<int>((cen.x - g.u0) / g.cell), j = static_cast<int>((cen.z - g.v0) / g.cell);
        if (i < 0 || j < 0 || i >= g.nu || j >= g.nv || !R.mask[static_cast<size_t>(j) * g.nu + i]) continue;
        if (cen.y < P.minBuildingH) continue;
        items.push_back({cen.y, area});
    }
    for (size_t k = 0; k < g.size(); ++k) if (R.mask[k] && std::isfinite(R.height[k])) items.push_back({R.height[k], g.cell * g.cell});
    std::sort(items.begin(), items.end(), [](const Item& a, const Item& b) { return a.y < b.y; });
    auto massNear = [&](double y, double half) { double m = 0; for (const auto& it : items) if (std::abs(it.y - y) <= half) m += it.w; return m; };
    std::vector<std::pair<double, double>> modes;
    {
        std::map<long, double> h;
        const double bw = P.modeBandwidth;
        for (const auto& it : items) h[static_cast<long>(std::floor(it.y / bw))] += it.w;
        for (const auto& kv : h) {
            auto get = [&](long b) { auto f = h.find(b); return f == h.end() ? 0.0 : f->second; };
            double c3 = get(kv.first - 1) + kv.second + get(kv.first + 1);
            if (c3 < get(kv.first - 2) + get(kv.first - 1) + kv.second || c3 < kv.second + get(kv.first + 1) + get(kv.first + 2) || c3 < 0.5 * minArea) continue;
            double y = (kv.first + 0.5) * bw;
            for (int it = 0; it < 50; ++it) {
                double s = 0, sy = 0;
                for (const auto& q : items) { double r = (q.y - y) / bw; if (std::abs(r) > 3) continue; double w = q.w * std::exp(-0.5 * r * r); s += w; sy += w * q.y; }
                if (s <= 0) break;
                double ny = sy / s;
                if (std::abs(ny - y) < 1e-4) { y = ny; break; }
                y = ny;
            }
            modes.push_back({y, massNear(y, 0.3)});
        }
    }
    std::sort(modes.begin(), modes.end(), [](auto& a, auto& b) { return a.second > b.second; });
    std::vector<std::pair<double, double>> levels;
    for (const auto& md : modes) {
        if (md.second < minArea) continue;
        bool close = false;
        for (const auto& l : levels) if (std::abs(l.first - md.first) < P.modeMerge) { close = true; break; }
        if (!close) levels.push_back(md);
        if (static_cast<int>(levels.size()) >= P.maxTiers) break;
    }
    std::sort(levels.begin(), levels.end());
    // what stands well above the top level (a spire, a tower top) adds levels at its median and 95th percentile
    if (!levels.empty()) {
        std::vector<double> above;
        for (size_t k = 0; k < g.size(); ++k) if (R.mask[k] && R.height[k] > levels.back().first + 2.5) above.push_back(R.height[k]);
        if (above.size() * g.cell * g.cell >= 1.0) {
            std::sort(above.begin(), above.end());
            double q50 = above[above.size() / 2], q95 = above[std::min(above.size() - 1, static_cast<size_t>(0.95 * above.size()))];
            levels.push_back({q50, above.size() * g.cell * g.cell});
            if (q95 > q50 + 2.5) levels.push_back({q95, 0});
            R.notes.push_back("cells above the top level (" + detail::fmt(above.size() * g.cell * g.cell) + " m^2) add levels at " + detail::fmt(q50) + " and " + detail::fmt(q95) + " m");
        }
    } else {
        std::vector<double> hs;
        for (size_t k = 0; k < g.size(); ++k) if (R.mask[k]) hs.push_back(R.height[k]);
        std::sort(hs.begin(), hs.end());
        levels.push_back({hs[hs.size() / 2], planArea});
        R.notes.push_back("no height level held " + detail::fmt(minArea) + " m^2: one tier at the median height");
    }
    R.modes = levels;
    R.timings.push_back(lap("levels"));
    // --- tiers: level k's region is the cells above the midpoint to the level below, within the region below
    std::vector<uint8_t> below = R.mask;
    const int rad = std::max(1, static_cast<int>(std::round(P.cleanRadius / g.cell)));
    double prevY = 0;
    for (size_t li = 0; li < levels.size(); ++li) {
        double L = levels[li].first;
        double thr = li == 0 ? P.minBuildingH : 0.5 * (prevY + L);
        std::vector<uint8_t> reg(g.size(), 0);
        for (size_t k = 0; k < g.size(); ++k) reg[k] = below[k] && R.height[k] >= thr;
        reg = closeOpen(reg, g, li + 1 < levels.size() || levels.size() == 1 ? rad : std::max(1, rad / 2));
        for (size_t k = 0; k < g.size(); ++k) reg[k] = reg[k] && (li == 0 ? R.mask[k] || below[k] : below[k]);
        size_t cells = std::accumulate(reg.begin(), reg.end(), size_t{0});
        double area = cells * g.cell * g.cell;
        if (area < (li + 1 == levels.size() ? 1.0 : minArea * 0.5)) continue;
        TierOut t;
        t.baseY = groundY + prevY;
        t.topY = groundY + L;
        t.areaM2 = area;
        t.loopsUV = traceLoops(reg, g, P.simplifyTol, P.squareDeg);
        if (t.loopsUV.empty()) continue;
        R.tiers.push_back(t);
        below = reg;
        prevY = L;
    }
    R.timings.push_back(lap("tiers"));
    // --- the oblique views: depth and clay shading of the building
    // framed on the building's cells (stray skirts and fragments of the isolate do not widen the views)
    P3 blo{1e300, 0, 1e300}, bhi{-1e300, 1.0, -1e300};
    for (int j = 0; j < g.nv; ++j) for (int i = 0; i < g.nu; ++i) {
        size_t k = static_cast<size_t>(j) * g.nu + i;
        if (!R.mask[k]) continue;
        blo.x = std::min(blo.x, g.cu(i)); blo.z = std::min(blo.z, g.cv(j)); bhi.x = std::max(bhi.x, g.cu(i)); bhi.z = std::max(bhi.z, g.cv(j));
        bhi.y = std::max(bhi.y, static_cast<double>(R.height[k]));
    }
    R.boxLo = blo; R.boxHi = bhi;
    R.cams = obliqueCameras(blo, bhi, P.viewW, P.viewH);
    for (const auto& cam : R.cams) {
        std::vector<float> d; std::vector<uint8_t> s;
        rasterView(R.building, cam, d, &s);
        R.depth.push_back(std::move(d)); R.shade.push_back(std::move(s));
    }
    R.timings.push_back(lap("views"));
    return R;
}

// =============================================================================================
// The program
// =============================================================================================

/** Handle layouts per operator (fixed positions; the last handle of every element is its replicator's step scale). */
enum : int { PR_MINU = 0, PR_MAXU, PR_MINV, PR_MAXV, PR_BASE, PR_TOP, PR_RISE, PR_N };
enum : int { RV_DU = 0, RV_DV, RV_BASE, RV_SZ, RV_SR, RV_N };
enum : int { SW_DU = 0, SW_DV, SW_DH, SW_SP, SW_SR, SW_N };
enum : int { RL_FROM = 0, RL_TO, RL_OUT, RL_N };

struct Handle { double value{0}, lo{0}, hi{0}, step{0}; };

struct Element {
    int op{0};  // 0 prism, 1 revolve, 2 sweep, 3 relief (geometric operators, not kinds of building part)
    std::string id;
    // prism
    std::vector<P2> outline;
    double ridgeDeg{0}, hipShare{0};
    // revolve
    double cu{0}, cv{0};
    int sides{24}, lobes{0};
    double lobeAmp{0}, twistDeg{0};
    std::vector<P2> profileZR;          // (z above base, radius)
    // sweep
    std::vector<P3> path;               // (u, h, v)
    std::vector<P3> profile;            // (x across, y up, bulge to the next point)
    double scaleEnd{1};
    bool closedPath{false};
    // relief
    int target{-1};
    // replicator
    int count{1};
    double stepU{0}, stepV{0}, stepH{0};
    std::vector<Handle> h;              // the operator's handles, then the step scale
};

struct Program { std::vector<Element> elems; };

/**
 * A prism's plan outline with its handles applied: each side of its box moved on its own (minimum and maximum u, v), the
 * points between stretched linearly, so the four sides are fitted independently.
 */
inline std::vector<P2> prismOutline(const Element& e) {
    double u0 = 1e300, u1 = -1e300, v0 = 1e300, v1 = -1e300;
    for (const auto& p : e.outline) { u0 = std::min(u0, p.u); u1 = std::max(u1, p.u); v0 = std::min(v0, p.v); v1 = std::max(v1, p.v); }
    const double du = std::max(1e-6, u1 - u0), dv = std::max(1e-6, v1 - v0);
    // the moved sides never cross: each extent keeps at least 0.3 m (or what it had, when less)
    auto extent = [](double lo, double hi, double dlo, double dhi, double& nlo, double& nhi) {
        nlo = lo + dlo; nhi = hi + dhi;
        const double minW = std::min(0.3, hi - lo);
        if (nhi - nlo < minW) { const double m = 0.5 * (nlo + nhi); nlo = m - 0.5 * minW; nhi = m + 0.5 * minW; }
    };
    double nu0, nu1, nv0, nv1;
    extent(u0, u1, e.h[PR_MINU].value, e.h[PR_MAXU].value, nu0, nu1);
    extent(v0, v1, e.h[PR_MINV].value, e.h[PR_MAXV].value, nv0, nv1);
    std::vector<P2> o;
    for (const auto& p : e.outline) {
        const double tu = (p.u - u0) / du, tv = (p.v - v0) / dv;
        o.push_back({u1 - u0 > 1e-6 ? nu0 + tu * (nu1 - nu0) : p.u + e.h[PR_MINU].value, v1 - v0 > 1e-6 ? nv0 + tv * (nv1 - nv0) : p.v + e.h[PR_MINV].value});
    }
    return o;
}

/** The roof planes of a prism in the frame: h = a + b u + c v (the flat cap first). */
inline std::vector<std::array<double, 3>> prismPlanes(const Element& e, const std::vector<P2>& o) {
    const double top = e.h[PR_TOP].value, rise = std::max(0.0, e.h[PR_RISE].value);
    std::vector<std::array<double, 3>> planes{{top + rise, 0, 0}};
    if (rise < 0.05 || o.size() < 3) return planes;
    double cu = 0, cv = 0;
    for (const auto& p : o) { cu += p.u; cv += p.v; }
    cu /= o.size(); cv /= o.size();
    const double a = e.ridgeDeg * PI / 180;
    const double du = std::cos(a), dv = std::sin(a);  // along the ridge
    double halfW = 0, halfL = 0;
    for (const auto& p : o) { halfW = std::max(halfW, std::abs(-(p.u - cu) * dv + (p.v - cv) * du)); halfL = std::max(halfL, std::abs((p.u - cu) * du + (p.v - cv) * dv)); }
    if (halfW < 0.1) return planes;
    const double k = rise / halfW;  // the eaves (half the width off the ridge) stand at the wall top
    // h = top + rise - k |w|, w = -(u - cu) dv + (v - cv) du: two planes
    // the signed distance off the ridge w = -dv u + du v + (cu dv - cv du); plane +: h = top + rise - k w, plane -: + k w
    const double w0 = cu * dv - cv * du;
    planes.push_back({top + rise - k * w0, k * dv, -k * du});
    planes.push_back({top + rise + k * w0, -k * dv, k * du});
    const double hs = std::clamp(e.hipShare, 0.0, 1.0);
    if (hs > 0.02 && halfL > 0.1) {
        // hip ends: the roof falls to the eaves over hs of the half length, l = (u - cu) du + (v - cv) dv
        const double kl = rise / std::max(0.1, hs * halfL);
        const double l0 = -(cu * du + cv * dv);
        // h = top + rise + kl (halfL - |l|) - kl halfL... at |l| = halfL the eave: h = top
        // plane +: h = top + rise - kl (l - (halfL - hs halfL))
        const double off = halfL - hs * halfL;
        planes.push_back({top + rise - kl * (l0 - off), -kl * du, -kl * dv});
        planes.push_back({top + rise + kl * (l0 + off), kl * du, kl * dv});
    }
    return planes;
}

inline double envelopeAt(const std::vector<std::array<double, 3>>& planes, double u, double v) {
    double y = 1e300;
    for (const auto& p : planes) y = std::min(y, p[0] + p[1] * u + p[2] * v);
    return y;
}

/** A prism's closed solid (walls up to the roof envelope, the roof, the base). */
inline void emitPrism(const std::vector<P2>& o, double base, const std::vector<std::array<double, 3>>& planes, int ei, Soup& s) {
    if (o.size() < 3) return;
    std::vector<P2> ring = o;
    if (detail::ringArea(ring) < 0) std::reverse(ring.begin(), ring.end());  // CCW in (u, v)
    const size_t n = ring.size();
    // walls: along each edge, the envelope's breakpoints
    for (size_t i = 0; i < n; ++i) {
        const P2 &a = ring[i], &b = ring[(i + 1) % n];
        std::vector<double> ts{0, 1};
        for (size_t p = 0; p < planes.size(); ++p) for (size_t q = p + 1; q < planes.size(); ++q) {
            double fa = (planes[p][0] - planes[q][0]) + (planes[p][1] - planes[q][1]) * a.u + (planes[p][2] - planes[q][2]) * a.v;
            double fb = (planes[p][0] - planes[q][0]) + (planes[p][1] - planes[q][1]) * b.u + (planes[p][2] - planes[q][2]) * b.v;
            if ((fa < 0) != (fb < 0)) ts.push_back(fa / (fa - fb));
        }
        std::sort(ts.begin(), ts.end());
        for (size_t k = 0; k + 1 < ts.size(); ++k) {
            if (ts[k + 1] - ts[k] < 1e-9) continue;
            P2 p0{a.u + (b.u - a.u) * ts[k], a.v + (b.v - a.v) * ts[k]}, p1{a.u + (b.u - a.u) * ts[k + 1], a.v + (b.v - a.v) * ts[k + 1]};
            double h0 = std::max(base, envelopeAt(planes, p0.u, p0.v)), h1 = std::max(base, envelopeAt(planes, p1.u, p1.v));
            P3 A{p0.u, base, p0.v}, B{p1.u, base, p1.v}, C{p1.u, h1, p1.v}, D{p0.u, h0, p0.v};
            // outward for a CCW ring in (u, v) with y up: the right-hand side of the edge
            s.tri(A, C, B, ei); s.tri(A, D, C, ei);
        }
    }
    // roof: each triangle of the plan clipped to each plane's region of the lower envelope
    auto tris = detail::triangulate(ring);
    for (const auto& t : tris) {
        for (size_t p = 0; p < planes.size(); ++p) {
            std::vector<P2> poly{ring[t[0]], ring[t[1]], ring[t[2]]};
            if (detail::ringArea(poly) < 0) std::swap(poly[1], poly[2]);
            for (size_t q = 0; q < planes.size() && poly.size() >= 3; ++q) {
                if (q == p) continue;
                poly = detail::clipHalf(poly, planes[p][0] - planes[q][0], planes[p][1] - planes[q][1], planes[p][2] - planes[q][2]);
            }
            if (poly.size() < 3) continue;
            auto lift = [&](const P2& w) { return P3{w.u, std::max(base, planes[p][0] + planes[p][1] * w.u + planes[p][2] * w.v), w.v}; };
            for (size_t k = 1; k + 1 < poly.size(); ++k) s.tri(lift(poly[0]), lift(poly[k + 1]), lift(poly[k]), ei);
        }
        P3 A{ring[t[0]].u, base, ring[t[0]].v}, B{ring[t[1]].u, base, ring[t[1]].v}, C{ring[t[2]].u, base, ring[t[2]].v};
        if (detail::ringArea({ring[t[0]], ring[t[1]], ring[t[2]]}) > 0) s.tri(A, B, C, ei); else s.tri(A, C, B, ei);
    }
}

inline void emitRevolve(const Element& e, P3 shift, int ei, Soup& s) {
    if (e.profileZR.size() < 2) return;
    const int seg = std::clamp(std::max(e.sides, e.lobes > 0 ? 8 * e.lobes : 3), 3, 128);
    const double base = e.h[RV_BASE].value, sz = e.h[RV_SZ].value, sr = e.h[RV_SR].value;
    const double cu = e.cu + e.h[RV_DU].value + shift.x, cv = e.cv + e.h[RV_DV].value + shift.z;
    const double zmax = std::max(1e-6, e.profileZR.back().u);
    std::vector<std::vector<P3>> rings;
    for (const auto& pr : e.profileZR) {
        std::vector<P3> ring;
        const double z = base + shift.y + pr.u * sz, tw = e.twistDeg * PI / 180 * (pr.u / zmax);
        for (int k = 0; k < seg; ++k) {
            double th = 2 * PI * (k + 0.5) / seg + tw;  // a flat side (not a corner) faces each frame axis
            double r = std::max(0.0, pr.v * sr * (1 + e.lobeAmp * std::cos(e.lobes * (th - tw))));
            ring.push_back({cu + r * std::cos(th), z, cv + r * std::sin(th)});
        }
        rings.push_back(ring);
    }
    for (size_t i = 0; i + 1 < rings.size(); ++i) for (int k = 0; k < seg; ++k) {
        const P3 &a = rings[i][k], &b = rings[i][(k + 1) % seg], &c = rings[i + 1][(k + 1) % seg], &d = rings[i + 1][k];
        s.tri(a, d, c, ei); s.tri(a, c, b, ei);
    }
    auto cap = [&](const std::vector<P3>& ring, bool up) {
        P3 c{0, 0, 0}; for (const auto& p : ring) c = c + p; c = c * (1.0 / ring.size());
        for (int k = 0; k < seg; ++k) { if (up) s.tri(c, ring[(k + 1) % seg], ring[k], ei); else s.tri(c, ring[k], ring[(k + 1) % seg], ei); }
    };
    cap(rings.front(), false);
    cap(rings.back(), true);
}

/** The profile of a sweep with its bulges expanded into arc points. */
inline std::vector<P2> expandProfile(const std::vector<P3>& prof) {
    std::vector<P2> out;
    const size_t n = prof.size();
    for (size_t i = 0; i < n; ++i) {
        const P3 &a = prof[i], &b = prof[(i + 1) % n];
        out.push_back({a.x, a.y});
        if (std::abs(a.z) < 1e-6) continue;
        // DXF bulge: tan of a quarter of the included angle, positive counter-clockwise
        const double ang = 4 * std::atan(a.z), chord = std::hypot(b.x - a.x, b.y - a.y);
        if (chord < 1e-9) continue;
        const double r = chord / (2 * std::sin(std::abs(ang) / 2));
        const double mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const double nx = -(b.y - a.y) / chord, ny = (b.x - a.x) / chord;  // left normal of the chord
        const double d = r * std::cos(ang / 2) * (ang > 0 ? 1 : -1);
        const double ccx = mx + nx * d, ccy = my + ny * d;
        const double a0 = std::atan2(a.y - ccy, a.x - ccx);
        const int steps = std::max(2, static_cast<int>(std::ceil(std::abs(ang) / (PI / 12))));
        for (int k = 1; k < steps; ++k) { double t = a0 + ang * k / steps; out.push_back({ccx + r * std::cos(t), ccy + r * std::sin(t)}); }
    }
    return out;
}

inline void emitSweep(const Element& e, P3 shift, int ei, Soup& s) {
    if (e.path.size() < 2 || e.profile.size() < 3) return;
    std::vector<P2> prof = expandProfile(e.profile);
    if (detail::ringArea(prof) < 0) std::reverse(prof.begin(), prof.end());
    const double sp = e.h[SW_SP].value, sr = e.h[SW_SR].value;
    P3 c{0, 0, 0}; for (const auto& p : e.path) c = c + p; c = c * (1.0 / e.path.size());
    std::vector<P3> path;
    for (const auto& p : e.path) path.push_back(c + (p - c) * sp + P3{e.h[SW_DU].value, e.h[SW_DH].value, e.h[SW_DV].value} + shift);
    if (e.closedPath) path.push_back(path.front());
    const size_t n = path.size();
    // frames: bisector tangents, the profile's x across horizontally, y up (rotation-minimising when the path climbs)
    std::vector<P3> T(n);
    for (size_t i = 0; i < n; ++i) {
        P3 a = i > 0 ? unit(path[i] - path[i - 1]) : P3{0, 0, 0}, b = i + 1 < n ? unit(path[i + 1] - path[i]) : P3{0, 0, 0};
        if (e.closedPath && (i == 0 || i + 1 == n)) { a = unit(path[n - 1] - path[n - 2]); b = unit(path[1] - path[0]); }
        T[i] = unit(a + b);
    }
    P3 N = std::abs(T[0].y) < 0.95 ? unit(cross(P3{0, 1, 0}, T[0])) : P3{1, 0, 0};
    double total = 0; std::vector<double> acc{0};
    for (size_t i = 1; i < n; ++i) { total += len(path[i] - path[i - 1]); acc.push_back(total); }
    std::vector<std::vector<P3>> rings;
    for (size_t i = 0; i < n; ++i) {
        if (i > 0) { P3 Np = N - T[i] * dot(N, T[i]); N = len(Np) > 1e-6 ? unit(Np) : N; }
        P3 B = unit(cross(T[i], N));
        const double f = total > 0 ? acc[i] / total : 0;
        const double sc = sr * (1 + (e.scaleEnd - 1) * f), tw = e.twistDeg * PI / 180 * f;
        std::vector<P3> ring;
        for (const auto& q : prof) {
            double x = q.u * std::cos(tw) - q.v * std::sin(tw), y = q.u * std::sin(tw) + q.v * std::cos(tw);
            ring.push_back(path[i] + N * (x * sc) + B * (y * sc));
        }
        rings.push_back(ring);
    }
    const size_t m = prof.size();
    for (size_t i = 0; i + 1 < n; ++i) for (size_t k = 0; k < m; ++k) {
        const P3 &a = rings[i][k], &b = rings[i][(k + 1) % m], &cc = rings[i + 1][(k + 1) % m], &d = rings[i + 1][k];
        s.tri(a, b, cc, ei); s.tri(a, cc, d, ei);
    }
    if (!e.closedPath) {
        auto tris = detail::triangulate(prof);
        for (const auto& t : tris) { s.tri(rings.front()[t[0]], rings.front()[t[2]], rings.front()[t[1]], ei); s.tri(rings.back()[t[0]], rings.back()[t[1]], rings.back()[t[2]], ei); }
    }
}

/** One prism of the program as the massing kernel's part, in the frame (each replicator copy separately). */
struct PrismOut { int elem{0}; std::vector<P2> outline; double base{0}; std::vector<std::array<double, 3>> planes; };

/** Builds the program: a soup of every element (frame) and the prisms (for the kernel's parts). */
inline Soup buildProgram(const Program& prog, std::vector<PrismOut>* prisms = nullptr) {
    Soup s;
    if (prisms) prisms->clear();
    for (size_t ei = 0; ei < prog.elems.size(); ++ei) {
        const Element& e = prog.elems[ei];
        const double stepScale = e.h.empty() ? 1.0 : e.h.back().value;
        for (int r = 0; r < std::max(1, e.count); ++r) {
            P3 shift{e.stepU * stepScale * r, e.stepH * stepScale * r, e.stepV * stepScale * r};
            const int id = static_cast<int>(ei);
            if (e.op == 0) {
                auto o = prismOutline(e);
                for (auto& p : o) { p.u += shift.x; p.v += shift.z; }
                double base = e.h[PR_BASE].value + shift.y;
                // a fit never removes an element: the solid keeps at least half a metre of height
                Element sh = e; sh.h[PR_TOP].value = std::max(e.h[PR_TOP].value, e.h[PR_BASE].value + 0.5) + shift.y;
                auto planes = prismPlanes(sh, o);
                emitPrism(o, base, planes, id, s);
                if (prisms) prisms->push_back({id, o, base, planes});
            } else if (e.op == 1) emitRevolve(e, shift, id, s);
            else if (e.op == 2) emitSweep(e, shift, id, s);
            else if (e.op == 3 && e.target >= 0 && e.target < static_cast<int>(prog.elems.size()) && prog.elems[static_cast<size_t>(e.target)].op == 0) {
                const Element& tg = prog.elems[static_cast<size_t>(e.target)];
                double from = e.h[RL_FROM].value + shift.y, to = std::max(e.h[RL_TO].value, e.h[RL_FROM].value + 0.1) + shift.y, out = std::max(0.02, e.h[RL_OUT].value);
                auto o = detail::offsetRing(prismOutline(tg), out);
                std::vector<std::array<double, 3>> flat{{to, 0, 0}};
                emitPrism(o, from, flat, id, s);
                if (prisms) prisms->push_back({id, o, from, flat});
            }
        }
    }
    return s;
}

// =============================================================================================
// The fit
// =============================================================================================

struct Loss { double total{0}, height{0}, sil{0}, depth{0}; std::vector<double> silPerView; };

struct FitTargets {
    const Grid* grid{nullptr};
    const std::vector<float>* height{nullptr};   // scan top above the street, NaN where nothing
    const std::vector<Camera>* cams{nullptr};
    const std::vector<std::vector<float>>* depth{nullptr};
    double buildingH{10};
    double wHeight{1.0}, wSil{0.5}, wDepth{0.25};
};

inline Loss evaluate(const Soup& s, const FitTargets& T, std::vector<float>* hOut = nullptr, std::vector<std::vector<float>>* dOut = nullptr) {
    Loss L;
    std::vector<float> h;
    rasterTop(s, *T.grid, h);
    double err = 0; size_t n = 0;
    for (size_t k = 0; k < h.size(); ++k) {
        float a = std::isfinite(h[k]) ? std::max(0.0f, h[k]) : 0.0f, b = std::isfinite((*T.height)[k]) ? std::max(0.0f, (*T.height)[k]) : 0.0f;
        if (a < 0.5f && b < 0.5f) continue;
        err += std::min(6.0, static_cast<double>(std::abs(a - b))); n++;
    }
    L.height = n ? err / n / std::max(1.0, T.buildingH) : 1.0;
    double sil = 0, dep = 0;
    for (size_t v = 0; v < T.cams->size(); ++v) {
        std::vector<float> d;
        rasterView(s, (*T.cams)[v], d);
        const auto& td = (*T.depth)[v];
        size_t inter = 0, uni = 0; double de = 0;
        for (size_t k = 0; k < d.size(); ++k) {
            bool a = std::isfinite(d[k]), b = std::isfinite(td[k]);
            if (a || b) uni++;
            if (a && b) { inter++; de += std::min(3.0, static_cast<double>(std::abs(d[k] - td[k]))); }
        }
        double iou = uni ? static_cast<double>(inter) / uni : 1.0;
        L.silPerView.push_back(1 - iou);
        sil += 1 - iou;
        dep += inter ? de / inter / 3.0 : 1.0;
        if (dOut) dOut->push_back(std::move(d));
    }
    L.sil = sil / std::max<size_t>(1, T.cams->size());
    L.depth = dep / std::max<size_t>(1, T.cams->size());
    L.total = T.wHeight * L.height + T.wSil * L.sil + T.wDepth * L.depth;
    if (hOut) *hOut = std::move(h);
    return L;
}

struct FitResult { Loss before, after; int evals{0}; int passes{0}; double ms{0}; };

/** Coordinate descent over every free handle (step > 0), steps halving per pass. */
inline FitResult fitProgram(Program& prog, const FitTargets& T, int passes = 5, int maxEvals = 4000) {
    auto t0 = std::chrono::steady_clock::now();
    FitResult R;
    auto lossOf = [&]() { R.evals++; return evaluate(buildProgram(prog), T).total; };
    R.before = evaluate(buildProgram(prog), T);
    double cur = R.before.total;
    std::vector<std::pair<size_t, size_t>> free;
    for (size_t e = 0; e < prog.elems.size(); ++e) for (size_t k = 0; k < prog.elems[e].h.size(); ++k) if (prog.elems[e].h[k].step > 0) free.push_back({e, k});
    std::vector<double> step(free.size());
    for (size_t i = 0; i < free.size(); ++i) step[i] = prog.elems[free[i].first].h[free[i].second].step;
    for (int pass = 0; pass < passes && R.evals < maxEvals; ++pass) {
        bool moved = false;
        for (size_t i = 0; i < free.size() && R.evals < maxEvals; ++i) {
            Handle& hd = prog.elems[free[i].first].h[free[i].second];
            for (int dir : {1, -1}) {
                // keep stepping while it helps (at most 6 steps), then the other direction
                int taken = 0;
                while (taken < 6 && R.evals < maxEvals) {
                    double old = hd.value, nv = std::clamp(old + dir * step[i], hd.lo, hd.hi);
                    if (std::abs(nv - old) < 1e-9) break;
                    hd.value = nv;
                    double l = lossOf();
                    if (l < cur - 1e-6) { cur = l; taken++; moved = true; }
                    else { hd.value = old; break; }
                }
                if (taken) break;
            }
        }
        for (auto& st : step) st *= 0.5;
        R.passes = pass + 1;
        if (!moved && pass >= 2) break;
    }
    R.after = evaluate(buildProgram(prog), T);
    R.ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
    return R;
}

}  // namespace shape_program
}  // namespace scratchbox

#endif  // SCRATCHBOX_SHAPE_PROGRAM_HPP
