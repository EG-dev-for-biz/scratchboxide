/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_ORNAMENT_HPP
#define SCRATCHBOX_ORNAMENT_HPP

/**
 * The ornament builder: a StructureFit, the fitted surfaces' meshes, an OrnamentSpec (photo-inferred detail, each element
 * one of the four universal operators with continuous parameters) and the textured extraction in; the detail layer and a
 * report of what was built and what was dropped, and why, out.
 *
 * Every vertex is generated in the element's host and mapped through it:
 *   - a surface slot's host is the surface's chart: (a, b, c) = (u, v, n), metres. A plane's u and v are its axes and n
 *     its outward normal; a cylinder is unrolled, u = r * theta, v = z along its axis, n along its visible normal
 *     (normalSign * radial). A coffer lattice on a barrel soffit therefore bends with the soffit.
 *   - an edge slot's host is its crease: (a, b, c) = (s, u, v), s metres along the crease (arc length), and (u, v) the
 *     section frame at that point: u out along the first surface's normal, v in that surface's plane, perpendicular to the
 *     crease, across the crease toward the second surface. The carrier a sweep follows is the crease itself (t0..t1 by arc
 *     length, offset in the section), so an element moves with the crease when a refit moves it.
 *
 * Operator 1 (sweep): a profile (with holes) swept along a carrier with rotation-minimising frames (double reflection),
 *   scale s(t) and twist theta(t); corners mitre up to miterLimit, else bevel; caps by ear clipping through keyhole
 *   bridges; `_REVEAL.y` is the arc length so far over the carrier's length, the order the rings were generated in.
 * Operator 2 (revolve): r(theta, z) = r(z) * (1 + A cos(K theta + 2 pi helixTurns z / H)) about an axis in the host, over a
 *   start and sweep angle.
 * Operator 3 (replicate): the seed (a sweep, a revolve or a relief) at startOffset + k pitch along a carrier, or over a
 *   lattice (i pu + (j mod 2) rowOffset, j pv) in the host chart; an instance whose footprint leaves the slot is skipped and
 *   counted; the instance index is the element's `_REVEAL.x`.
 * Operator 4 (relief): the region re-tessellated by conforming longest-edge bisection down to maxEdgeM, displaced by
 *   dh(u, v) along n (`_DISP` = dh * n). A recess cuts the host face: the builder writes a recut copy of that one surface (the
 *   region removed, the displaced patch stitched into its hole on the same vertices) which replaces it; a proud relief is a
 *   closed shell embedded 1 mm into the host.
 *
 * Before an element is written it is checked, and a failed check drops the element with its value and limit:
 *   the profile inside the edge slot's envelope; the displacement inside the slot's bounds; the footprint inside the slot;
 *   no self-intersection; no penetration of the fitted solid deeper than 5 mm (the embed excepted); at most 60k triangles
 *   an element and 400k a layer. An element that cites only a tile ortho must also show in the tile's own photo, sampled
 *   through the chart at the surface's native texel (not the resampled PNG): a repeating element needs power at its pitch
 *   (at least 3 x the median in 0.5 to 2 x its frequency, and a pitch of at least 2 texels); any other needs the mean
 *   luminance gradient across its outline to be at least 1.5 x the slot's median. Street View evidence is never decoded.
 *
 * Nothing here branches on what an element is called.
 */

#include "scratchbox_scan_geom.hpp"
#include "scratchbox_scan_ortho.hpp"
#include "scratchbox_staged_glb.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cstring>
#include <cmath>
#include <complex>
#include <functional>
#include <map>
#include <memory>
#include <queue>
#include <set>
#include <tuple>
#include <string>
#include <unordered_map>
#include <vector>

namespace scratchbox {
namespace ornament {

namespace sg = scan_geom;
namespace sj = staged_glb::json;
using math::Vec3;
using sg::P2;

class OrnamentError : public std::runtime_error {
public:
    OrnamentError(std::string code, const std::string& message) : std::runtime_error(message), code_(std::move(code)) {}
    const std::string& code() const { return code_; }
private:
    std::string code_;
};

// ============================================================================================
// Small vectors (doubles: the host maps accumulate)
// ============================================================================================

struct D3 {
    double x{0}, y{0}, z{0};
    D3() = default;
    D3(double a, double b, double c) : x(a), y(b), z(c) {}
    explicit D3(const Vec3& v) : x(v.x), y(v.y), z(v.z) {}
    D3 operator+(const D3& o) const { return {x + o.x, y + o.y, z + o.z}; }
    D3 operator-(const D3& o) const { return {x - o.x, y - o.y, z - o.z}; }
    D3 operator*(double s) const { return {x * s, y * s, z * s}; }
    double dot(const D3& o) const { return x * o.x + y * o.y + z * o.z; }
    D3 cross(const D3& o) const { return {y * o.z - z * o.y, z * o.x - x * o.z, x * o.y - y * o.x}; }
    double len() const { return std::sqrt(dot(*this)); }
    D3 unit() const { const double l = len(); return l > 1e-15 ? *this * (1.0 / l) : D3(1, 0, 0); }
    Vec3 f() const { return Vec3(static_cast<float>(x), static_cast<float>(y), static_cast<float>(z)); }
};

// ============================================================================================
// JSON access (the contract's own shapes)
// ============================================================================================

using Json = io::GlbJsonValue;

inline double num(const Json& j, double def = 0) { return j.type == Json::Number ? j.num : def; }
inline std::string str(const Json& j) { return j.type == Json::String ? j.str : std::string(); }
inline bool isArr(const Json& j) { return j.type == Json::Array; }
inline bool isObj(const Json& j) { return j.type == Json::Object; }

inline P2 p2(const Json& j) { return P2(num(j[0]), num(j[1])); }
inline D3 d3(const Json& j) { return D3(num(j[0]), num(j[1]), num(j[2])); }
inline std::vector<P2> poly(const Json& j) { std::vector<P2> o; if (isArr(j)) for (const auto& q : j.arr) o.push_back(p2(q)); return o; }

// ============================================================================================
// The fitted surfaces' meshes, read from fitted.glb (one node per surface, named by its id)
// ============================================================================================

struct NodeMesh { std::vector<D3> pos; std::vector<uint32_t> tri; };

/** The triangle primitives of every named node of a GLB written by the staged writer (positions float, indices u16 or u32). */
inline std::map<std::string, NodeMesh> readNodeMeshes(const std::vector<uint8_t>& glb) {
    auto rd32 = [&](size_t o) { return static_cast<uint32_t>(glb[o]) | (static_cast<uint32_t>(glb[o + 1]) << 8) | (static_cast<uint32_t>(glb[o + 2]) << 16) | (static_cast<uint32_t>(glb[o + 3]) << 24); };
    if (glb.size() < 20 || rd32(0) != 0x46546C67u) throw OrnamentError("input_unreadable", "fitted.glb is not a GLB");
    const uint32_t jl = rd32(12);
    io::GlbJsonParser parser(reinterpret_cast<const char*>(glb.data() + 20), jl);
    const Json doc = parser.parse();
    const size_t binOff = 20 + jl + 8;
    std::map<std::string, NodeMesh> out;
    for (const auto& node : doc["nodes"].arr) {
        if (!node.has("mesh") || !node.has("name")) continue;
        const auto& mesh = doc["meshes"][static_cast<size_t>(num(node["mesh"]))];
        NodeMesh nm;
        for (const auto& prim : mesh["primitives"].arr) {
            if (prim.has("mode") && num(prim["mode"]) != 4) continue;
            auto acc = [&](size_t ai, size_t& count, int& comp, size_t& ofs, size_t& stride) {
                const auto& a = doc["accessors"][ai];
                const auto& bv = doc["bufferViews"][static_cast<size_t>(num(a["bufferView"]))];
                count = static_cast<size_t>(num(a["count"]));
                comp = static_cast<int>(num(a["componentType"]));
                ofs = binOff + static_cast<size_t>(num(bv["byteOffset"])) + static_cast<size_t>(num(a["byteOffset"]));
                stride = static_cast<size_t>(num(bv["byteStride"]));
            };
            size_t pc, pofs, pstr; int pcomp;
            acc(static_cast<size_t>(num(prim["attributes"]["POSITION"])), pc, pcomp, pofs, pstr);
            if (pcomp != 5126) throw OrnamentError("input_unreadable", "fitted.glb positions must be float");
            if (!pstr) pstr = 12;
            const uint32_t base = static_cast<uint32_t>(nm.pos.size());
            for (size_t i = 0; i < pc; ++i) {
                float v[3];
                std::memcpy(v, glb.data() + pofs + i * pstr, 12);
                nm.pos.push_back(D3(v[0], v[1], v[2]));
            }
            if (prim.has("indices")) {
                size_t ic, iofs, istr; int icomp;
                acc(static_cast<size_t>(num(prim["indices"])), ic, icomp, iofs, istr);
                for (size_t i = 0; i < ic; ++i) {
                    const uint32_t id = icomp == 5125 ? rd32(iofs + 4 * i) : static_cast<uint32_t>(glb[iofs + 2 * i]) | (static_cast<uint32_t>(glb[iofs + 2 * i + 1]) << 8);
                    nm.tri.push_back(base + id);
                }
            } else {
                for (size_t i = 0; i < pc; ++i) nm.tri.push_back(base + static_cast<uint32_t>(i));
            }
        }
        out[str(node["name"])] = std::move(nm);
    }
    return out;
}

// ============================================================================================
// The fit, as the builder needs it
// ============================================================================================

struct Surface {
    std::string id;
    bool cyl{false};
    D3 origin, u, v, n;                       // plane
    std::vector<P2> extent;
    D3 axisO, axisD, thetaZ, e2;              // cylinder
    double r{0}, th0{0}, th1{0}, z0{0}, z1{0};
    int sign{1};
    NodeMesh mesh;                            // tile frame
    double texelM{0};

    /** Chart coordinates (u, v, n) of a tile-frame point. */
    D3 toChart(const D3& p) const {
        if (!cyl) { const D3 d = p - origin; return {d.dot(u), d.dot(v), d.dot(n)}; }
        const D3 d = p - axisO;
        const double z = d.dot(axisD), x = d.dot(thetaZ), y = d.dot(e2);
        double th = std::atan2(y, x);
        const double lo = th0 * sg::kPi / 180.0;
        while (th < lo - 1e-4) th += 2 * sg::kPi;   // a vertex on the chart's edge stays on it however its float noise falls
        while (th > lo + 2 * sg::kPi - 1e-4) th -= 2 * sg::kPi;
        return {r * th, z, sign * (std::hypot(x, y) - r)};
    }
    /** The tile-frame point of chart coordinates (u, v, n). */
    D3 fromChart(double a, double b, double c) const {
        if (!cyl) return origin + u * a + v * b + n * c;
        const double th = a / r;
        const D3 radial = thetaZ * std::cos(th) + e2 * std::sin(th);
        return axisO + axisD * b + radial * (r + sign * c);
    }
    /** The visible normal at chart (u, v). */
    D3 normalAt(double a) const {
        if (!cyl) return n;
        const double th = a / r;
        return (thetaZ * std::cos(th) + e2 * std::sin(th)) * static_cast<double>(sign);
    }
};

struct Slot {
    std::string id, primitiveId;
    bool edge{false};
    std::string surfaceId;
    std::vector<P2> regionUv;                 // surface slot
    std::vector<D3> carrier;                  // edge slot: the crease (tile frame)
    std::vector<double> arc;                  // cumulative arc length along it
    std::array<std::string, 2> edgeSurfaces;  // the two surfaces
    std::vector<P2> envelope;                 // edge slot: the measured section (u out, v across the crease)
    double sizeU{0}, sizeV{0}, maxProud{0}, maxRecess{0}, minFeature{0};
    double length() const { return arc.empty() ? 0 : arc.back(); }
};

struct Fit {
    std::map<std::string, Surface> surfaces;
    std::map<std::string, Slot> slots;
    double texelM{0}, photoResolvableM{0};
    std::string sha256;
};

inline Fit loadFit(const std::string& fitJsonText, const std::map<std::string, NodeMesh>& meshes) {
    io::GlbJsonParser parser(fitJsonText.data(), fitJsonText.size());
    const Json doc = parser.parse();
    if (str(doc["schema"]) != "scratchbox.structure-fit/2") throw OrnamentError("input_unreadable", "--fit must hold a scratchbox.structure-fit/2 object");
    Fit F;
    F.sha256 = sg::sha256Hex(reinterpret_cast<const uint8_t*>(fitJsonText.data()), fitJsonText.size());
    F.texelM = num(doc["sourceLimits"]["texelM"]);
    F.photoResolvableM = num(doc["sourceLimits"]["photoResolvableM"]);
    for (const auto& sj_ : doc["surfaces"].arr) {
        Surface s;
        s.id = str(sj_["id"]);
        const auto& ch = sj_["chart"];
        if (ch.has("plane")) {
            const auto& p = ch["plane"];
            s.origin = d3(p["origin"]); s.u = d3(p["u"]); s.v = d3(p["v"]); s.n = d3(p["normal"]);
            s.extent = poly(p["extentUv"]);
        } else {
            const auto& c = ch["cylinder"];
            s.cyl = true;
            s.axisO = d3(c["axisOrigin"]); s.axisD = d3(c["axisDir"]).unit(); s.thetaZ = d3(c["thetaZeroDir"]).unit();
            s.e2 = s.axisD.cross(s.thetaZ).unit();
            s.r = num(c["radiusM"]); s.th0 = num(c["thetaDeg"][0]); s.th1 = num(c["thetaDeg"][1]); s.z0 = num(c["zM"][0]); s.z1 = num(c["zM"][1]);
            s.sign = num(c["normalSign"], 1) < 0 ? -1 : 1;
            const double a0 = s.r * s.th0 * sg::kPi / 180.0, a1 = s.r * s.th1 * sg::kPi / 180.0;
            s.extent = {{a0, s.z0}, {a1, s.z0}, {a1, s.z1}, {a0, s.z1}};
        }
        const auto it = meshes.find(s.id);
        if (it != meshes.end()) s.mesh = it->second;
        s.texelM = F.texelM;
        F.surfaces[s.id] = std::move(s);
    }
    for (const auto& sl : doc["slots"].arr) {
        Slot s;
        s.id = str(sl["id"]);
        s.primitiveId = str(sl["primitiveId"]);
        const auto& host = sl["host"];
        if (host.has("surface")) {
            s.surfaceId = str(host["surface"]["surfaceId"]);
            s.regionUv = poly(host["surface"]["regionUv"]);
        } else {
            s.edge = true;
            const auto& e = host["edge"];
            for (const auto& q : e["carrier"]["points"].arr) s.carrier.push_back(d3(q));
            s.arc.assign(s.carrier.size(), 0.0);
            for (size_t i = 1; i < s.carrier.size(); ++i) s.arc[i] = s.arc[i - 1] + (s.carrier[i] - s.carrier[i - 1]).len();
            for (size_t i = 0; i < 2 && i < e["surfaceIds"].arr.size(); ++i) s.edgeSurfaces[i] = str(e["surfaceIds"][i]);
            s.envelope = poly(e["envelope"]);
        }
        s.sizeU = num(sl["sizeM"][0]); s.sizeV = num(sl["sizeM"][1]);
        s.maxProud = num(sl["bounds"]["maxProudM"]); s.maxRecess = num(sl["bounds"]["maxRecessM"]); s.minFeature = num(sl["bounds"]["minFeatureM"]);
        F.slots[s.id] = std::move(s);
    }
    return F;
}


// ============================================================================================
// A host: where an element's coordinates (a, b, c) land in the tile frame
// ============================================================================================

struct Section { D3 c, T, U, V; };

class Host {
public:
    Host(const Fit& fit, const Slot& slot) : fit_(fit), slot_(slot) {
        if (slot.edge) {
            A_ = findSurface(slot.edgeSurfaces[0]);
            B_ = findSurface(slot.edgeSurfaces[1]);
            if (slot.carrier.size() < 2) throw OrnamentError("input_unreadable", "edge slot " + slot.id + " has no crease");
        } else {
            S_ = findSurface(slot.surfaceId);
        }
    }

    bool edge() const { return slot_.edge; }
    const Slot& slot() const { return slot_; }
    const Surface* surface() const { return S_; }
    const Surface* faceA() const { return A_; }
    const Surface* faceB() const { return B_; }
    double carrierLength() const { return slot_.length(); }

    /** The crease's section frame at arc length s: c the point, T the tangent, U out of face A, V across the crease toward face B. */
    Section sectionAt(double s) const {
        const auto& C = slot_.carrier;
        const auto& arc = slot_.arc;
        s = std::clamp(s, 0.0, arc.back());
        size_t k = static_cast<size_t>(std::upper_bound(arc.begin(), arc.end(), s) - arc.begin());
        k = std::clamp<size_t>(k, 1, C.size() - 1);
        const double seg = std::max(1e-12, arc[k] - arc[k - 1]);
        const double f = (s - arc[k - 1]) / seg;
        Section sec;
        sec.c = C[k - 1] + (C[k] - C[k - 1]) * f;
        sec.T = (C[k] - C[k - 1]).unit();
        D3 U = A_ ? A_->normalAt(0) : D3(0, 0, 1);
        if (A_ && A_->cyl) U = A_->normalAt(A_->toChart(sec.c).x);
        U = (U - sec.T * U.dot(sec.T)).unit();
        D3 V = U.cross(sec.T).unit();
        D3 nB = B_ ? (B_->cyl ? B_->normalAt(B_->toChart(sec.c).x) : B_->n) : D3(0, 1, 0);
        if (V.dot(nB) < 0) V = V * -1.0;
        sec.U = U; sec.V = V;
        return sec;
    }

    /** Host coordinates to the tile frame. */
    D3 map(const D3& h) const {
        if (S_) return S_->fromChart(h.x, h.y, h.z);
        const Section sec = sectionAt(h.x);
        return sec.c + sec.U * h.y + sec.V * h.z;
    }

    /** The host's outward direction at host coordinates (the surface's normal, or the crease's U). */
    D3 outAt(const D3& h) const {
        if (S_) return S_->normalAt(h.x);
        return sectionAt(h.x).U;
    }

private:
    const Fit& fit_;
    const Slot& slot_;
    const Surface* S_{nullptr};
    const Surface* A_{nullptr};
    const Surface* B_{nullptr};

    const Surface* findSurface(const std::string& id) const {
        const auto it = fit_.surfaces.find(id);
        return it == fit_.surfaces.end() ? nullptr : &it->second;
    }
};

// ============================================================================================
// What an operator generates, in the tile frame
// ============================================================================================

struct Gen {
    std::vector<D3> pos;                // tile frame
    std::vector<uint32_t> idx;          // triangles
    std::vector<float> revealY;         // per vertex: the order inside the item (sweep t), else 0
    std::vector<float> instance;        // per vertex: the instance rank of a replicated element, else 0
    std::vector<D3> disp;               // per vertex: displacement from the host surface, tile frame (relief, recess)
    bool hasDisp{false};
    uint32_t add(const D3& p, float ry = 0, float inst = 0, const D3& d = D3()) {
        pos.push_back(p); revealY.push_back(ry); instance.push_back(inst); disp.push_back(d);
        return static_cast<uint32_t>(pos.size() - 1);
    }
    void tri(uint32_t a, uint32_t b, uint32_t c) { idx.insert(idx.end(), {a, b, c}); }
    size_t triangles() const { return idx.size() / 3; }
    void append(const Gen& o) {
        const uint32_t base = static_cast<uint32_t>(pos.size());
        pos.insert(pos.end(), o.pos.begin(), o.pos.end());
        revealY.insert(revealY.end(), o.revealY.begin(), o.revealY.end());
        instance.insert(instance.end(), o.instance.begin(), o.instance.end());
        disp.insert(disp.end(), o.disp.begin(), o.disp.end());
        for (uint32_t i : o.idx) idx.push_back(base + i);
        hasDisp = hasDisp || o.hasDisp;
    }
};

/** One check that dropped an element (BuildCheck). */
struct Check { std::string check; double value{0}, limit{0}; std::string unit, message; };

struct Dropped { std::string reason; std::vector<Check> checks; };

// ============================================================================================
// Small geometry helpers
// ============================================================================================

/** Segments of at most `maxLen` along a closed ring or open polyline (the original vertices kept). */
inline std::vector<P2> resample(const std::vector<P2>& pts, bool closed, double maxLen) {
    std::vector<P2> out;
    const size_t n = pts.size();
    for (size_t i = 0; i < n; ++i) {
        const P2 a = pts[i], b = pts[(i + 1) % n];
        out.push_back(a);
        if (!closed && i + 1 == n) break;
        const double L = (b - a).len();
        const int k = std::max(1, static_cast<int>(std::ceil(L / maxLen)));
        for (int j = 1; j < k; ++j) out.push_back(a + (b - a) * (static_cast<double>(j) / k));
    }
    return out;
}

/** The mesh with its vertices split along creases: `origin[i]` is the input vertex of output vertex i, `normals` its normal. */
struct Creased { std::vector<uint32_t> origin, idx; std::vector<Vec3> normals; };

/** Area-weighted vertex normals, where faces within `creaseDeg` of one another share a vertex and the rest get their own. */
inline Creased splitByCrease(const std::vector<Vec3>& pos, const std::vector<uint32_t>& idx, double creaseDeg) {
    const size_t T = idx.size() / 3;
    std::vector<Vec3> fn(T);
    std::vector<double> fa(T);
    for (size_t t = 0; t < T; ++t) {
        const Vec3 n = (pos[idx[3 * t + 1]] - pos[idx[3 * t]]).cross(pos[idx[3 * t + 2]] - pos[idx[3 * t]]);
        fa[t] = 0.5 * n.length();
        fn[t] = n.length() > 1e-20f ? n.normalized() : Vec3(0, 1, 0);
    }
    std::vector<std::vector<uint32_t>> incident(pos.size());
    for (size_t t = 0; t < T; ++t) for (int j = 0; j < 3; ++j) incident[idx[3 * t + j]].push_back(static_cast<uint32_t>(t));
    const float cosC = static_cast<float>(std::cos(creaseDeg * sg::kPi / 180.0));
    Creased out;
    out.idx.assign(idx.size(), 0);
    struct Group { Vec3 acc, ref; uint32_t id; };
    for (size_t v = 0; v < pos.size(); ++v) {
        std::vector<Group> groups;
        for (uint32_t t : incident[v]) {
            Group* g = nullptr;
            for (auto& q : groups) if (q.ref.dot(fn[t]) >= cosC) { g = &q; break; }
            if (!g) {
                groups.push_back({Vec3(0, 0, 0), fn[t], static_cast<uint32_t>(out.origin.size())});
                out.origin.push_back(static_cast<uint32_t>(v));
                out.normals.push_back(Vec3(0, 0, 0));
                g = &groups.back();
            }
            g->acc += fn[t] * static_cast<float>(fa[t]);
            for (int j = 0; j < 3; ++j) if (idx[3 * t + j] == v) out.idx[3 * t + j] = g->id;
        }
        for (const auto& g : groups) out.normals[g.id] = g.acc.length() > 1e-20f ? g.acc.normalized() : g.ref;
    }
    return out;
}

/** A triangle mesh's signed volume (positive: the triangles face outward). */
inline double signedVolume(const std::vector<D3>& p, const std::vector<uint32_t>& idx) {
    double v = 0;
    for (size_t t = 0; t + 2 < idx.size(); t += 3) v += p[idx[t]].dot(p[idx[t + 1]].cross(p[idx[t + 2]])) / 6.0;
    return v;
}

inline void flip(std::vector<uint32_t>& idx) { for (size_t t = 0; t + 2 < idx.size(); t += 3) std::swap(idx[t + 1], idx[t + 2]); }

/** A point of a piecewise-linear [t, value] curve (flat beyond its ends); an empty curve is `def`. */
inline double curveAt(const std::vector<P2>& c, double t, double def) {
    if (c.empty()) return def;
    if (t <= c.front().x) return c.front().y;
    for (size_t i = 1; i < c.size(); ++i) if (t <= c[i].x) { const double f = (t - c[i - 1].x) / std::max(1e-12, c[i].x - c[i - 1].x); return c[i - 1].y + f * (c[i].y - c[i - 1].y); }
    return c.back().y;
}


// ============================================================================================
// Operator 1: sweep
// ============================================================================================

struct Profile { std::vector<P2> outer; std::vector<std::vector<P2>> holes; };

inline Profile readProfile(const Json& j) {
    Profile p;
    p.outer = poly(j["outer"]);
    if (p.outer.size() < 3) throw OrnamentError("invalid_spec", "a sweep's profile needs at least three points");
    if (sg::signedArea(p.outer) < 0) std::reverse(p.outer.begin(), p.outer.end());
    if (isArr(j["holes"])) for (const auto& h : j["holes"].arr) { auto hp = poly(h); if (sg::signedArea(hp) > 0) std::reverse(hp.begin(), hp.end()); if (hp.size() >= 3) p.holes.push_back(hp); }
    return p;
}

/** A local frame for a sweep with an explicit path (rotation-minimising, by double reflection). */
inline std::vector<std::array<D3, 2>> rotationMinimising(const std::vector<D3>& pts, const D3& up0) {
    std::vector<std::array<D3, 2>> out;  // per point: (r, s) with t = r x s
    if (pts.size() < 2) return out;
    std::vector<D3> t(pts.size());
    for (size_t i = 0; i < pts.size(); ++i) t[i] = ((pts[std::min(i + 1, pts.size() - 1)] - pts[i > 0 ? i - 1 : 0])).unit();
    D3 r = t[0].cross(up0).len() > 1e-6 ? t[0].cross(up0).unit() : t[0].cross(D3(1, 0, 0)).unit();
    D3 s = t[0].cross(r).unit();
    out.push_back({r, s});
    for (size_t i = 0; i + 1 < pts.size(); ++i) {
        const D3 v1 = pts[i + 1] - pts[i];
        const double c1 = v1.dot(v1);
        if (c1 < 1e-18) { out.push_back(out.back()); continue; }
        const D3 rL = r - v1 * (2.0 / c1 * v1.dot(r)), tL = t[i] - v1 * (2.0 / c1 * v1.dot(t[i]));
        const D3 v2 = t[i + 1] - tL;
        const double c2 = v2.dot(v2);
        r = c2 < 1e-18 ? rL : rL - v2 * (2.0 / c2 * v2.dot(rL));
        s = t[i + 1].cross(r).unit();
        out.push_back({r, s});
    }
    return out;
}

/**
 * One station of a swept path: the point and the two frames either side of it (equal on a straight run). A corner is
 * mitred (the profile's offsets carried along the incoming tangent into the plane that bisects the two) up to the limit
 * and bevelled beyond it (a ring for each frame).
 */
struct Station {
    double s{0};          // arc length along the carrier (reveal)
    D3 c;
    D3 tIn, uIn, vIn, tOut, uOut, vOut;
    bool corner{false};
};

struct SweepSpec {
    Profile profile;
    std::vector<P2> scale, twistDeg;   // [t, value] curves
    double miterLimit{4};
    bool caps{true};
};

/** The profile point (pu, pv) at a station, in the station's incoming or outgoing frame. */
inline D3 place(const Station& s, bool out, double pu, double pv) { return s.c + (out ? s.uOut : s.uIn) * pu + (out ? s.vOut : s.vIn) * pv; }

/**
 * The profile swept through the stations: a ring at each (two at a bevelled corner), the sides between rings, and caps by
 * ear clipping. Scale and twist curves are read at the station's share of the carrier's length. `offU`, `offV` shift the
 * profile in the section (the carrier's offset).
 */
inline void buildSweep(const std::vector<Station>& st, const SweepSpec& sp, double offU, double offV, Gen& g, float instance) {
    if (st.size() < 2) throw OrnamentError("invalid_spec", "a sweep's carrier has no length");
    const double total = std::max(1e-9, st.back().s - st.front().s);
    std::vector<const std::vector<P2>*> loops{&sp.profile.outer};
    for (const auto& h : sp.profile.holes) loops.push_back(&h);
    using Ring = std::vector<std::vector<uint32_t>>;   // per loop: vertex ids
    std::vector<Ring> rings;
    // the profile point at a station, with the scale and twist of its place along the carrier
    auto point = [&](const Station& s, bool out, const P2& q, double* mitreOffset) {
        const double tn = (s.s - st.front().s) / total;
        const double sc = curveAt(sp.scale, tn, 1.0), tw = curveAt(sp.twistDeg, tn, 0.0) * sg::kPi / 180.0;
        const double ct = std::cos(tw), sn = std::sin(tw);
        const double pu = offU + sc * (q.x * ct - q.y * sn), pv = offV + sc * (q.x * sn + q.y * ct);
        if (mitreOffset) *mitreOffset = std::hypot(pu, pv);
        return place(s, out, pu, pv);
    };
    auto plain = [&](const Station& s, bool out) {
        const float tn = static_cast<float>((s.s - st.front().s) / total);
        Ring ring;
        for (const auto* L : loops) { std::vector<uint32_t> ids; for (const auto& q : *L) ids.push_back(g.add(point(s, out, q, nullptr), tn, instance)); ring.push_back(std::move(ids)); }
        rings.push_back(std::move(ring));
    };
    for (const Station& s : st) {
        if (!s.corner) { plain(s, false); continue; }
        // mitre: every offset (in the incoming frame) carried along the incoming tangent onto the plane that bisects the corner
        const D3 B = (s.tIn + s.tOut).unit();
        const double bt = B.dot(s.tIn);
        bool bevel = bt < 1e-6;
        std::vector<std::vector<D3>> pts;
        if (!bevel) {
            for (const auto* L : loops) {
                std::vector<D3> ps;
                for (const auto& q : *L) {
                    double mag = 0;
                    const D3 p = point(s, false, q, &mag);
                    const double shift = -B.dot(p - s.c) / bt;
                    if (std::fabs(shift) > sp.miterLimit * std::max(1e-9, mag)) bevel = true;
                    ps.push_back(p + s.tIn * shift);
                }
                pts.push_back(std::move(ps));
            }
        }
        if (bevel) { plain(s, false); plain(s, true); continue; }
        const float tn = static_cast<float>((s.s - st.front().s) / total);
        Ring ring;
        for (const auto& ps : pts) { std::vector<uint32_t> ids; for (const auto& p : ps) ids.push_back(g.add(p, tn, instance)); ring.push_back(std::move(ids)); }
        rings.push_back(std::move(ring));
    }
    for (size_t r = 0; r + 1 < rings.size(); ++r) {
        for (size_t l = 0; l < loops.size(); ++l) {
            const size_t n = loops[l]->size();
            for (size_t i = 0; i < n; ++i) {
                const uint32_t a = rings[r][l][i], b = rings[r][l][(i + 1) % n], c = rings[r + 1][l][(i + 1) % n], d = rings[r + 1][l][i];
                g.tri(a, b, c); g.tri(a, c, d);
            }
        }
    }
    if (sp.caps) {
        std::vector<P2> verts;
        const auto tris = sg::triangulate(sp.profile.outer, sp.profile.holes, verts);
        auto idOf = [&](const Ring& ring, const P2& q) -> uint32_t {
            for (size_t l = 0; l < loops.size(); ++l) for (size_t i = 0; i < loops[l]->size(); ++i) if (((*loops[l])[i] - q).len() < 1e-12) return ring[l][i];
            return ring[0][0];
        };
        for (size_t t = 0; t + 2 < tris.size(); t += 3) {
            g.tri(idOf(rings.front(), verts[tris[t]]), idOf(rings.front(), verts[tris[t + 2]]), idOf(rings.front(), verts[tris[t + 1]]));
            g.tri(idOf(rings.back(), verts[tris[t]]), idOf(rings.back(), verts[tris[t + 1]]), idOf(rings.back(), verts[tris[t + 2]]));
        }
        if (signedVolume(g.pos, g.idx) < 0) flip(g.idx);  // outward: a closed shell has positive volume
    }
}

// ============================================================================================
// Operator 2: revolve
// ============================================================================================

struct RevolveSpec {
    D3 axisO, axisD;                    // host coordinates (a, b, c)
    std::vector<P2> profile;            // [r, z]
    double lobes{0}, amplitude{0}, helixTurns{0}, startDeg{0}, sweepDeg{360};
    int segments{48};
};

/** A solid of revolution in host coordinates (u, v, n), then mapped through the host. */
inline void buildRevolve(const Host& host, const RevolveSpec& rs, const D3& origin, double rotate, Gen& g, float instance) {
    const auto& pr = rs.profile;
    if (pr.size() < 2) throw OrnamentError("invalid_spec", "a revolve's profile needs at least two points");
    D3 zax = rs.axisD.len() > 1e-12 ? rs.axisD.unit() : D3(0, 0, 1);
    D3 e1 = std::fabs(zax.x) < 0.9 ? D3(1, 0, 0) : D3(0, 1, 0);
    e1 = (e1 - zax * e1.dot(zax)).unit();
    const D3 e2 = zax.cross(e1);
    double zMin = 1e30, zMax = -1e30;
    for (const auto& q : pr) { zMin = std::min(zMin, q.y); zMax = std::max(zMax, q.y); }
    const double H = std::max(1e-9, zMax - zMin);
    const bool full = rs.sweepDeg >= 359.999;
    const int N = std::max(3, rs.segments);
    const int cols = full ? N : N + 1;
    const double a0 = rs.startDeg * sg::kPi / 180.0, da = std::min(rs.sweepDeg, 360.0) * sg::kPi / 180.0 / N;
    const double cr = std::cos(rotate), sr = std::sin(rotate);
    auto at = [&](double r, double z, double th) {
        const double rr = r * (1 + rs.amplitude * std::cos(rs.lobes * th + 2 * sg::kPi * rs.helixTurns * (z - zMin) / H));
        D3 h = rs.axisO + zax * z + (e1 * std::cos(th) + e2 * std::sin(th)) * rr;
        h = D3(h.x * cr - h.y * sr, h.x * sr + h.y * cr, h.z);   // about the host's n axis
        return host.map(h + origin);
    };
    // rings: one per profile vertex; a vertex on the axis is a single vertex
    const size_t M = pr.size();
    std::vector<std::vector<uint32_t>> ring(M);
    for (size_t i = 0; i < M; ++i) {
        const bool onAxis = pr[i].x <= 1e-12;
        const float ry = 0;
        if (onAxis) { const uint32_t v = g.add(at(0, pr[i].y, a0), ry, instance); ring[i].assign(static_cast<size_t>(cols), v); continue; }
        for (int j = 0; j < cols; ++j) ring[i].push_back(g.add(at(pr[i].x, pr[i].y, a0 + da * j), ry, instance));
    }
    for (size_t i = 0; i < M; ++i) {
        const size_t k = (i + 1) % M;
        if (pr[i].x <= 1e-12 && pr[k].x <= 1e-12) continue;  // along the axis
        const int segs = full ? N : N;
        for (int j = 0; j < segs; ++j) {
            const int j2 = full ? (j + 1) % N : j + 1;
            const uint32_t a = ring[i][static_cast<size_t>(j)], b = ring[i][static_cast<size_t>(j2)], c = ring[k][static_cast<size_t>(j2)], d = ring[k][static_cast<size_t>(j)];
            if (a != b) { if (b != c) g.tri(a, b, c); }
            if (c != d && a != d) g.tri(a, c, d);
        }
    }
    // the two cut faces of a partial sweep: the meridian polygon at each end
    if (!full) {
        std::vector<P2> verts;
        const auto tris = sg::triangulate(pr, {}, verts);
        auto vid = [&](const P2& q, int col) { for (size_t i = 0; i < M; ++i) if ((pr[i] - q).len() < 1e-12 || (sg::signedArea(pr) < 0 && false)) return ring[i][static_cast<size_t>(col)]; return ring[0][static_cast<size_t>(col)]; };
        for (size_t t = 0; t + 2 < tris.size(); t += 3) {
            g.tri(vid(verts[tris[t]], 0), vid(verts[tris[t + 2]], 0), vid(verts[tris[t + 1]], 0));
            g.tri(vid(verts[tris[t]], cols - 1), vid(verts[tris[t + 1]], cols - 1), vid(verts[tris[t + 2]], cols - 1));
        }
    }
    if (signedVolume(g.pos, g.idx) < 0) flip(g.idx);
}


// ============================================================================================
// Operator 4: relief
// ============================================================================================

struct Tess {
    std::vector<P2> v;
    std::vector<std::array<uint32_t, 3>> t;
};

/**
 * Conforming longest-edge bisection: while any edge is longer than `maxEdge`, the longest is split at its midpoint and
 * both triangles on it become two (the bisection stays conforming whichever edge of the neighbour was its longest).
 * Returns false when it would pass `triangleCap` triangles.
 */
inline bool refineToEdge(Tess& m, double maxEdge, size_t triangleCap) {
    using Key = std::pair<uint32_t, uint32_t>;
    auto key = [](uint32_t a, uint32_t b) { return a < b ? Key{a, b} : Key{b, a}; };
    std::map<Key, std::vector<uint32_t>> edges;
    for (uint32_t i = 0; i < m.t.size(); ++i) for (int j = 0; j < 3; ++j) edges[key(m.t[i][static_cast<size_t>(j)], m.t[i][static_cast<size_t>((j + 1) % 3)])].push_back(i);
    using Item = std::tuple<double, uint32_t, uint32_t>;
    std::priority_queue<Item> heap;
    auto len = [&](uint32_t a, uint32_t b) { return (m.v[a] - m.v[b]).len(); };
    for (const auto& [k, _] : edges) if (len(k.first, k.second) > maxEdge) heap.push({len(k.first, k.second), k.first, k.second});
    while (!heap.empty()) {
        const auto [L, a, b] = heap.top();
        heap.pop();
        const auto it = edges.find(key(a, b));
        if (it == edges.end() || it->second.empty() || L <= maxEdge) continue;
        if (m.t.size() + 2 > triangleCap) return false;
        const uint32_t mid = static_cast<uint32_t>(m.v.size());
        m.v.push_back((m.v[a] + m.v[b]) * 0.5);
        const std::vector<uint32_t> tris = it->second;
        edges.erase(it);
        for (uint32_t ti : tris) {
            std::array<uint32_t, 3> tr = m.t[ti];
            // rotate so the split edge is (p, q) with r opposite, in the triangle's winding
            size_t e = 0;
            for (; e < 3; ++e) if (key(tr[e], tr[(e + 1) % 3]) == key(a, b)) break;
            const uint32_t p = tr[e], q = tr[(e + 1) % 3], r = tr[(e + 2) % 3];
            const uint32_t t2 = static_cast<uint32_t>(m.t.size());
            m.t[ti] = {p, mid, r};
            m.t.push_back({mid, q, r});
            // the edge (q, r) now belongs to the new triangle; (r, p) stays with the old one
            auto& qr = edges[key(q, r)];
            for (auto& x : qr) if (x == ti) x = t2;
            edges[key(p, mid)].push_back(ti);
            edges[key(mid, q)].push_back(t2);
            edges[key(mid, r)] = {ti, t2};
            for (const Key& k : {key(p, mid), key(mid, q), key(mid, r)}) if (len(k.first, k.second) > maxEdge) heap.push({len(k.first, k.second), k.first, k.second});
        }
    }
    return true;
}

/** The distance from a point to the nearest edge of any loop (inside distance for a point inside a region). */
inline double distanceToLoops(const P2& p, const std::vector<std::vector<P2>>& loops) {
    double d = 1e30;
    for (const auto& L : loops) d = std::min(d, sg::polygonDistance(L, p));
    return d;
}

struct ReliefSpec {
    std::vector<P2> outer;
    std::vector<std::vector<P2>> holes;
    // panel
    bool panel{true};
    double depthM{0}, edgeWidthM{0};
    std::vector<P2> edgeProfile;
    // grid
    int cols{0}, rows{0};
    double cellM{0};
    P2 originUv;
    std::vector<double> heights;
    double maxEdgeM{0.05};
    std::string surfaceId;
};

/** dh(u, v) of a relief at chart (u, v), `dist` the distance to the region's boundary. */
inline double reliefHeight(const ReliefSpec& r, const P2& uv, double dist) {
    if (r.panel) {
        if (r.edgeWidthM <= 1e-9) return r.depthM;
        return r.depthM * curveAt(r.edgeProfile, std::min(1.0, dist / r.edgeWidthM), std::min(1.0, dist / r.edgeWidthM));
    }
    if (r.cols < 2 || r.rows < 2 || r.heights.size() < static_cast<size_t>(r.cols) * static_cast<size_t>(r.rows)) return 0;
    const double fx = (uv.x - r.originUv.x) / r.cellM, fy = (uv.y - r.originUv.y) / r.cellM;
    if (fx < 0 || fy < 0 || fx > r.cols - 1 || fy > r.rows - 1) return 0;
    const int x0 = std::min(r.cols - 2, static_cast<int>(fx)), y0 = std::min(r.rows - 2, static_cast<int>(fy));
    const double tx = fx - x0, ty = fy - y0;
    auto H = [&](int x, int y) { return r.heights[static_cast<size_t>(y) * static_cast<size_t>(r.cols) + static_cast<size_t>(x)]; };
    return (H(x0, y0) * (1 - tx) + H(x0 + 1, y0) * tx) * (1 - ty) + (H(x0, y0 + 1) * (1 - tx) + H(x0 + 1, y0 + 1) * tx) * ty;
}


/**
 * A Delaunay triangulation (Bowyer-Watson) of the region's ring vertices and a hexagonal lattice of interior points at about
 * `edge` spacing, clear of the rings by 0.7 edge; triangles whose centroid is outside the region (or in a hole) are dropped.
 * Equilateral-ish triangles, so a region costs about area / (0.43 edge^2) triangles. Returns false when a ring edge is not
 * an edge of the result (the caller falls back to ear clipping and bisection) or the point count passes `pointCap`.
 */
inline bool delaunayRegion(const std::vector<P2>& outer, const std::vector<std::vector<P2>>& holes, double edge, size_t pointCap, Tess& out) {
    std::vector<P2> pts = outer;
    const size_t nRing = outer.size();
    std::vector<size_t> ringStart{0};
    for (const auto& h : holes) { ringStart.push_back(pts.size()); pts.insert(pts.end(), h.begin(), h.end()); }
    std::vector<std::vector<P2>> loops{outer};
    for (const auto& h : holes) loops.push_back(h);
    double x0 = 1e30, x1 = -1e30, y0 = 1e30, y1 = -1e30;
    for (const auto& q : outer) { x0 = std::min(x0, q.x); x1 = std::max(x1, q.x); y0 = std::min(y0, q.y); y1 = std::max(y1, q.y); }
    const double dy = edge * 0.8660254;
    int row = 0;
    for (double y = y0 + 0.7 * edge; y < y1; y += dy, ++row) {
        for (double x = x0 + 0.7 * edge + (row % 2 ? 0.5 * edge : 0.0); x < x1; x += edge) {
            const P2 q(x, y);
            if (!sg::insidePolygon(outer, x, y)) continue;
            bool inHole = false;
            for (const auto& h : holes) if (sg::insidePolygon(h, x, y)) { inHole = true; break; }
            if (inHole || distanceToLoops(q, loops) < 0.7 * edge) continue;
            pts.push_back(q);
            if (pts.size() > pointCap) return false;
        }
    }
    (void)nRing;
    const size_t n = pts.size();
    // super triangle
    const double R = std::max({x1 - x0, y1 - y0, edge}) * 20;
    const P2 c((x0 + x1) / 2, (y0 + y1) / 2);
    std::vector<P2> v = pts;
    v.push_back(P2(c.x - 2 * R, c.y - R)); v.push_back(P2(c.x + 2 * R, c.y - R)); v.push_back(P2(c.x, c.y + 2 * R));
    struct T { uint32_t a, b, c; double cx, cy, r2; bool alive; };
    std::vector<T> tris;
    auto make = [&](uint32_t a, uint32_t b, uint32_t d) {
        T t{a, b, d, 0, 0, 0, true};
        const P2 A = v[a], B = v[b], C = v[d];
        const double D = 2 * (A.x * (B.y - C.y) + B.x * (C.y - A.y) + C.x * (A.y - B.y));
        if (std::fabs(D) < 1e-18) { t.alive = false; return t; }
        t.cx = ((A.x * A.x + A.y * A.y) * (B.y - C.y) + (B.x * B.x + B.y * B.y) * (C.y - A.y) + (C.x * C.x + C.y * C.y) * (A.y - B.y)) / D;
        t.cy = ((A.x * A.x + A.y * A.y) * (C.x - B.x) + (B.x * B.x + B.y * B.y) * (A.x - C.x) + (C.x * C.x + C.y * C.y) * (B.x - A.x)) / D;
        t.r2 = (A.x - t.cx) * (A.x - t.cx) + (A.y - t.cy) * (A.y - t.cy);
        return t;
    };
    tris.push_back(make(static_cast<uint32_t>(n), static_cast<uint32_t>(n + 1), static_cast<uint32_t>(n + 2)));
    for (uint32_t i = 0; i < n; ++i) {
        const P2 p = v[i];
        std::map<std::pair<uint32_t, uint32_t>, int> boundary;
        for (auto& t : tris) {
            if (!t.alive) continue;
            const double d2 = (p.x - t.cx) * (p.x - t.cx) + (p.y - t.cy) * (p.y - t.cy);
            if (d2 < t.r2 * (1 - 1e-12)) {
                t.alive = false;
                const uint32_t e[3][2] = {{t.a, t.b}, {t.b, t.c}, {t.c, t.a}};
                for (const auto& k : e) ++boundary[{std::min(k[0], k[1]), std::max(k[0], k[1])}];
            }
        }
        for (const auto& [k, cnt] : boundary) if (cnt == 1) { T t = make(k.first, k.second, i); if (t.alive) tris.push_back(t); }
        if (tris.size() > 8 * pointCap) return false;
    }
    out.v.assign(pts.begin(), pts.end());
    out.t.clear();
    for (const auto& t : tris) {
        if (!t.alive || t.a >= n || t.b >= n || t.c >= n) continue;
        const P2 A = v[t.a], B = v[t.b], C = v[t.c];
        const P2 g((A.x + B.x + C.x) / 3, (A.y + B.y + C.y) / 3);
        if (!sg::insidePolygon(outer, g.x, g.y)) continue;
        bool inHole = false;
        for (const auto& h : holes) if (sg::insidePolygon(h, g.x, g.y)) { inHole = true; break; }
        if (inHole) continue;
        if ((B - A).cross(C - A) > 0) out.t.push_back({t.a, t.b, t.c}); else out.t.push_back({t.a, t.c, t.b});
    }
    // every ring edge must be an edge of the result
    std::set<std::pair<uint32_t, uint32_t>> edges;
    for (const auto& t : out.t) for (int j = 0; j < 3; ++j) { const uint32_t a = t[static_cast<size_t>(j)], b = t[static_cast<size_t>((j + 1) % 3)]; edges.insert({std::min(a, b), std::max(a, b)}); }
    for (size_t l = 0; l < loops.size(); ++l) {
        const size_t base = ringStart[l], m = loops[l].size();
        for (size_t i = 0; i < m; ++i) {
            const uint32_t a = static_cast<uint32_t>(base + i), b = static_cast<uint32_t>(base + (i + 1) % m);
            if (!edges.count({std::min(a, b), std::max(a, b)})) return false;
        }
    }
    return !out.t.empty();
}

/** What a relief instance (a region, its tessellation and its displacements) holds. */
struct ReliefPatch {
    Tess mesh;                           // in chart (u, v), conforming, boundary vertices on the resampled rings
    std::vector<double> dh;              // per vertex
    std::vector<uint8_t> boundary;       // per vertex: on the region's boundary
    std::vector<std::vector<P2>> rings;  // outer then holes, resampled
    double minDh{0}, maxDh{0};
    float rank{0};                       // the instance's order in its element
};

inline bool tessellateRelief(const ReliefSpec& spec, const P2& shift, size_t triangleCap, ReliefPatch& out) {
    std::vector<P2> outer = resample(spec.outer, true, spec.maxEdgeM);
    for (auto& q : outer) q = q + shift;
    if (sg::signedArea(outer) < 0) std::reverse(outer.begin(), outer.end());
    std::vector<std::vector<P2>> holes;
    for (const auto& h : spec.holes) { auto r = resample(h, true, spec.maxEdgeM); for (auto& q : r) q = q + shift; if (sg::signedArea(r) > 0) std::reverse(r.begin(), r.end()); holes.push_back(std::move(r)); }
    if (!delaunayRegion(outer, holes, spec.maxEdgeM, triangleCap / 2, out.mesh)) {
        // ear clipping through bridges, then longest-edge bisection to the edge length
        std::vector<P2> verts;
        const auto tris = sg::triangulate(outer, holes, verts);
        out.mesh = Tess();
        out.mesh.v = verts;
        for (size_t i = 0; i + 2 < tris.size(); i += 3) out.mesh.t.push_back({tris[i], tris[i + 1], tris[i + 2]});
        if (!refineToEdge(out.mesh, spec.maxEdgeM, triangleCap)) return false;
    }
    out.rings.push_back(outer);
    for (const auto& h : holes) out.rings.push_back(h);
    out.dh.assign(out.mesh.v.size(), 0);
    out.boundary.assign(out.mesh.v.size(), 0);
    // boundary vertices: on an edge used by one triangle
    std::map<std::pair<uint32_t, uint32_t>, int> use;
    for (const auto& t : out.mesh.t) for (int j = 0; j < 3; ++j) { const uint32_t a = t[static_cast<size_t>(j)], b = t[static_cast<size_t>((j + 1) % 3)]; ++use[{std::min(a, b), std::max(a, b)}]; }
    for (const auto& [k, n] : use) if (n == 1) out.boundary[k.first] = out.boundary[k.second] = 1;
    out.minDh = 1e30; out.maxDh = -1e30;
    for (size_t i = 0; i < out.mesh.v.size(); ++i) {
        const double d = out.boundary[i] ? 0.0 : distanceToLoops(out.mesh.v[i], out.rings);
        out.dh[i] = reliefHeight(spec, out.mesh.v[i] - shift, d);
        out.minDh = std::min(out.minDh, out.dh[i]); out.maxDh = std::max(out.maxDh, out.dh[i]);
    }
    return true;
}

/** A proud relief: a closed shell, its top displaced by dh, its foot embedded 1 mm into the host. */
inline void buildProudShell(const Surface& S, const ReliefPatch& P, Gen& g, float instance) {
    const double embed = 0.001;
    const size_t n = P.mesh.v.size();
    std::vector<uint32_t> top(n), bot(n);
    for (size_t i = 0; i < n; ++i) {
        const P2 q = P.mesh.v[i];
        double nt = P.dh[i];
        const bool lip = P.boundary[i] && nt > 0.0005;
        if (P.boundary[i] && !lip) nt = -embed;
        const D3 host0 = S.fromChart(q.x, q.y, 0);
        top[i] = g.add(S.fromChart(q.x, q.y, nt), 0, instance, S.fromChart(q.x, q.y, nt) - host0);
        g.hasDisp = true;
        if (P.boundary[i] && !lip) bot[i] = top[i];
        else bot[i] = g.add(S.fromChart(q.x, q.y, -embed), 0, instance, S.fromChart(q.x, q.y, -embed) - host0);
    }
    for (const auto& t : P.mesh.t) {
        g.tri(top[t[0]], top[t[1]], top[t[2]]);
        g.tri(bot[t[0]], bot[t[2]], bot[t[1]]);
    }
    // the lip: a wall along every boundary edge whose top stands proud of the foot
    std::map<std::pair<uint32_t, uint32_t>, std::pair<int, std::pair<uint32_t, uint32_t>>> edge;
    for (const auto& t : P.mesh.t) for (int j = 0; j < 3; ++j) {
        const uint32_t a = t[static_cast<size_t>(j)], b = t[static_cast<size_t>((j + 1) % 3)];
        auto& e = edge[{std::min(a, b), std::max(a, b)}];
        ++e.first; e.second = {a, b};
    }
    for (const auto& [k, e] : edge) {
        if (e.first != 1) continue;
        const uint32_t a = e.second.first, b = e.second.second;
        if (top[a] == bot[a] && top[b] == bot[b]) continue;
        g.tri(top[a], bot[a], bot[b]);
        g.tri(top[a], bot[b], top[b]);
    }
    if (signedVolume(g.pos, g.idx) < 0) flip(g.idx);
}


// ============================================================================================
// Recess: a recut copy of the host surface, the region removed and the displaced patch stitched into its hole
// ============================================================================================

/** The boundary loops of a surface's mesh in its chart: the largest by area is the outer one, the rest are holes. */
inline bool surfaceLoops(const Surface& S, std::vector<P2>& outer, std::vector<std::vector<P2>>& holes) {
    std::map<std::pair<int64_t, int64_t>, uint32_t> weld;
    std::vector<P2> pts;
    std::vector<uint32_t> id(S.mesh.pos.size());
    for (size_t i = 0; i < S.mesh.pos.size(); ++i) {
        const D3 c = S.toChart(S.mesh.pos[i]);
        const std::pair<int64_t, int64_t> k{std::llround(c.x * 1e5), std::llround(c.y * 1e5)};
        const auto it = weld.find(k);
        if (it == weld.end()) { weld[k] = static_cast<uint32_t>(pts.size()); id[i] = static_cast<uint32_t>(pts.size()); pts.push_back(P2(c.x, c.y)); }
        else id[i] = it->second;
    }
    std::map<std::pair<uint32_t, uint32_t>, int> use;
    for (size_t t = 0; t + 2 < S.mesh.tri.size(); t += 3) for (int j = 0; j < 3; ++j) {
        const uint32_t a = id[S.mesh.tri[t + static_cast<size_t>(j)]], b = id[S.mesh.tri[t + static_cast<size_t>((j + 1) % 3)]];
        if (a != b) ++use[{std::min(a, b), std::max(a, b)}];
    }
    std::map<uint32_t, std::vector<uint32_t>> nb;
    for (const auto& [k, n] : use) if (n == 1) { nb[k.first].push_back(k.second); nb[k.second].push_back(k.first); }
    std::set<uint32_t> seen;
    std::vector<std::vector<P2>> loops;
    for (const auto& [v0, _] : nb) {
        if (seen.count(v0)) continue;
        std::vector<P2> loop;
        uint32_t prev = UINT32_MAX, cur = v0;
        for (size_t guard = 0; guard < pts.size() + 2; ++guard) {
            seen.insert(cur);
            loop.push_back(pts[cur]);
            uint32_t next = UINT32_MAX;
            for (uint32_t q : nb[cur]) if (q != prev && !(seen.count(q) && q != v0)) { next = q; break; }
            if (next == UINT32_MAX || next == v0) break;
            prev = cur; cur = next;
        }
        if (loop.size() >= 3) loops.push_back(std::move(loop));
    }
    if (loops.empty()) return false;
    size_t big = 0;
    for (size_t i = 1; i < loops.size(); ++i) if (std::fabs(sg::signedArea(loops[i])) > std::fabs(sg::signedArea(loops[big]))) big = i;
    outer = loops[big];
    holes.clear();
    for (size_t i = 0; i < loops.size(); ++i) if (i != big) holes.push_back(loops[i]);
    return true;
}

/**
 * The surface with every patch's region cut out and the patches (displaced by dh) in their places, one mesh: the host fill
 * is the surface's outline (and its own holes) with the patch rings as holes, the patches reuse those ring vertices, so
 * the result is watertight where the original was. The faces point as the surface's normal does.
 */
inline bool buildRecut(const Surface& S, const std::vector<ReliefPatch>& patches, size_t triangleCap, Gen& out, std::string& why, float instanceOf = 0) {
    std::vector<P2> outer;
    std::vector<std::vector<P2>> holes;
    if (!surfaceLoops(S, outer, holes)) { why = "the surface has no mesh to cut"; return false; }
    std::vector<std::vector<P2>> hostHoles = holes;
    std::vector<std::vector<P2>> islands;
    for (const auto& p : patches) {
        for (const auto& q : p.rings[0]) {
            if (!sg::insidePolygon(outer, q.x, q.y)) { why = "the region leaves the surface"; return false; }
            for (const auto& h : holes) if (sg::insidePolygon(h, q.x, q.y)) { why = "the region crosses an opening of the surface"; return false; }
        }
        hostHoles.push_back(p.rings[0]);
        for (size_t r = 1; r < p.rings.size(); ++r) islands.push_back(p.rings[r]);
    }
    Tess host;
    {
        // the surface's outline and the cut-out regions' rings, with interior points spaced so a cylinder's chords stay within
        // 5 mm of it (sqrt(0.04 r)), and about a metre on a plane
        const double edge = S.cyl ? std::sqrt(0.04 * S.r) : 1.0;
        const std::vector<P2> ring = resample(outer, true, edge);
        if (!delaunayRegion(ring, hostHoles, edge, triangleCap / 2, host)) {
            std::vector<P2> verts;
            const auto tris = sg::triangulate(outer, hostHoles, verts);
            host = Tess();
            host.v = verts;
            for (size_t i = 0; i + 2 < tris.size(); i += 3) host.t.push_back({tris[i], tris[i + 1], tris[i + 2]});
            if (!refineToEdge(host, edge, triangleCap)) { why = "the surface is too large to cut"; return false; }
        }
    }
    std::map<std::pair<int64_t, int64_t>, uint32_t> shared;
    auto vertex = [&](const P2& q, double dh, float rank = 0) {
        const std::pair<int64_t, int64_t> k{std::llround(q.x * 1e6), std::llround(q.y * 1e6)};
        const auto it = shared.find(k);
        if (it != shared.end()) return it->second;
        const D3 base = S.fromChart(q.x, q.y, 0);
        const uint32_t v = out.add(S.fromChart(q.x, q.y, dh), 0, rank + instanceOf, S.fromChart(q.x, q.y, dh) - base);
        shared[k] = v;
        return v;
    };
    for (const auto& t : host.t) out.tri(vertex(host.v[t[0]], 0), vertex(host.v[t[1]], 0), vertex(host.v[t[2]], 0));
    for (const auto& isl : islands) {
        std::vector<P2> verts;
        const auto tris = sg::triangulate(isl, {}, verts);
        for (size_t i = 0; i + 2 < tris.size(); i += 3) out.tri(vertex(verts[tris[i]], 0), vertex(verts[tris[i + 1]], 0), vertex(verts[tris[i + 2]], 0));
    }
    for (const auto& p : patches) {
        // a patch vertex on the region's boundary is the host's own vertex unless the patch leaves the surface there (a vertical edge): then the
        // patch has its own, and a wall joins the two along the boundary
        std::vector<uint32_t> pv(p.mesh.v.size());
        for (size_t i = 0; i < pv.size(); ++i) {
            const bool lip = p.boundary[i] && std::fabs(p.dh[i]) > 0.0005;
            pv[i] = lip ? out.add(S.fromChart(p.mesh.v[i].x, p.mesh.v[i].y, p.dh[i]), 0, p.rank + instanceOf, S.fromChart(p.mesh.v[i].x, p.mesh.v[i].y, p.dh[i]) - S.fromChart(p.mesh.v[i].x, p.mesh.v[i].y, 0)) : vertex(p.mesh.v[i], p.dh[i], p.rank);
        }
        for (const auto& t : p.mesh.t) out.tri(pv[t[0]], pv[t[1]], pv[t[2]]);
        std::map<std::pair<uint32_t, uint32_t>, std::pair<int, std::pair<uint32_t, uint32_t>>> edge;
        for (const auto& t : p.mesh.t) for (int j = 0; j < 3; ++j) {
            const uint32_t a = t[static_cast<size_t>(j)], b = t[static_cast<size_t>((j + 1) % 3)];
            auto& e = edge[{std::min(a, b), std::max(a, b)}];
            ++e.first; e.second = {a, b};
        }
        for (const auto& [k, e] : edge) {
            if (e.first != 1) continue;
            const uint32_t a = e.second.first, b = e.second.second;
            const bool la = p.boundary[a] && std::fabs(p.dh[a]) > 0.0005, lb = p.boundary[b] && std::fabs(p.dh[b]) > 0.0005;
            if (!la && !lb) continue;
            const uint32_t ha = vertex(p.mesh.v[a], 0), hb = vertex(p.mesh.v[b], 0);
            out.tri(ha, hb, pv[b]);
            out.tri(ha, pv[b], pv[a]);
        }
    }
    out.hasDisp = true;
    // the faces point as the surface does
    double agree = 0;
    for (size_t t = 0; t + 2 < out.idx.size(); t += 3) {
        const D3 n = (out.pos[out.idx[t + 1]] - out.pos[out.idx[t]]).cross(out.pos[out.idx[t + 2]] - out.pos[out.idx[t]]);
        const D3 c = (out.pos[out.idx[t]] + out.pos[out.idx[t + 1]] + out.pos[out.idx[t + 2]]) * (1.0 / 3.0);
        agree += n.dot(S.normalAt(S.toChart(c).x));
    }
    if (agree < 0) flip(out.idx);
    return true;
}


// ============================================================================================
// Elements: the specs, instanced, built through a host
// ============================================================================================

struct Limits {
    size_t elementTriangles{60000}, layerTriangles{400000};
    double penetrationM{0.005}, embedM{0.001}, envelopeToleranceM{0.005}, insideSlotShare{0.98}, slotToleranceM{0.02};
    double pitchPeakRatio{3.0}, gradientRatio{1.5}, gradientFloor{0.02};
};

/** What building one element made: its geometry and what the checks need to know about how it was made. */
struct Built {
    Gen gen;
    std::string replaces;                       // the surface a recut copy replaces
    std::string kind;                           // the operator, for the report only
    double carrierLengthM{0};
    bool sweep{false};
    size_t placed{0}, skipped{0};
    bool replicated{false};
    double maxProudM{0}, maxRecessM{0};         // relief displacement; for other operators, the extent out of and into the host
    std::vector<P2> profilePts;                 // edge hosts: every profile point as placed (u out, v across), for the envelope
    double sLo{1e30}, sHi{-1e30};               // edge hosts: the along-crease range covered
    std::vector<double> pitches;                // replicate: the claimed pitches (metres) per axis
    std::vector<int> pitchCounts;
    std::vector<P2> pitchAxes;                  // replicate: the axes in the host chart (unit)
    std::vector<P2> footprintUv;                // surface hosts: where the element stands in the host chart (relief: its ring vertices)
    std::vector<ReliefPatch> patches;           // surface hosts: relief instances to cut or raise
    ReliefSpec reliefSpec;
};

struct Instance { P2 shift; double rotate{0}; double ds{0}; };

struct SeedBounds { double u0{1e30}, v0{1e30}, u1{-1e30}, v1{-1e30}, s0{1e30}, s1{-1e30}; bool any{false}; void add(double u, double v) { u0 = std::min(u0, u); u1 = std::max(u1, u); v0 = std::min(v0, v); v1 = std::max(v1, v); any = true; } };

inline std::vector<P2> rotated(const std::vector<P2>& pts, double a) {
    const double c = std::cos(a), s = std::sin(a);
    std::vector<P2> o;
    for (const auto& q : pts) o.push_back(P2(q.x * c - q.y * s, q.x * s + q.y * c));
    return o;
}

class ElementBuilder {
public:
    ElementBuilder(const Fit& fit, const Limits& lim) : fit_(fit), lim_(lim) {}

    /** Builds an OperatorSpec through the host. Throws OrnamentError("invalid_spec") for what the host cannot carry. */
    Built build(const Json& spec, const Host& host) const {
        Built b;
        const std::string op = str(spec["operator"]);
        b.kind = op;
        if (op == "replicate") return buildReplicate(spec["replicate"], host, b);
        std::vector<Instance> one{Instance{}};
        buildLeaf(spec, op, host, one, b, 0);
        finishLeaf(host, b);
        return b;
    }

private:
    const Fit& fit_;
    const Limits& lim_;

    // ---- the leaf operators, once per instance
    void buildLeaf(const Json& spec, const std::string& op, const Host& host, const std::vector<Instance>& inst, Built& b, size_t firstInstance) const {
        for (size_t k = 0; k < inst.size(); ++k) {
            const float rank = static_cast<float>(firstInstance + k);
            if (op == "sweep") leafSweep(spec["sweep"], host, inst[k], b, rank);
            else if (op == "revolve") leafRevolve(spec["revolve"], host, inst[k], b, rank);
            else if (op == "relief") leafRelief(spec["relief"], host, inst[k], b);
            else throw OrnamentError("invalid_spec", "unknown operator '" + op + "'");
            ++b.placed;
        }
    }

    /** Relief patches become geometry: recess instances one recut of their surface, proud ones shells. */
    void finishLeaf(const Host& host, Built& b) const {
        if (b.patches.empty()) return;
        const Surface& S = *host.surface();
        std::vector<ReliefPatch> cut;
        float rank = 0;
        for (const auto& p : b.patches) {
            for (const auto& r : p.rings) for (const auto& q : r) b.footprintUv.push_back(q);
            if (p.minDh < -0.001) cut.push_back(p);
            else { buildProudShell(S, p, b.gen, p.rank); }
            rank += 1;
            b.maxProudM = std::max(b.maxProudM, p.maxDh);
            b.maxRecessM = std::max(b.maxRecessM, -p.minDh);
        }
        if (!cut.empty()) {
            std::string why;
            Gen recut;
            if (!buildRecut(S, cut, lim_.elementTriangles, recut, why)) throw OrnamentError("invalid_spec", "relief: " + why);
            b.gen.append(recut);
            b.replaces = S.id;
        }
        b.patches.clear();
    }

    // ---- sweep
    void leafSweep(const Json& sw, const Host& host, const Instance& in, Built& b, float rank) const {
        SweepSpec sp;
        sp.profile = readProfile(sw["profile"]);
        sp.scale = poly(sw["scale"]);
        sp.twistDeg = poly(sw["twistDeg"]);
        sp.miterLimit = std::max(1.0, num(sw["miterLimit"], 4));
        sp.caps = !(sw["caps"].type == Json::Bool && !sw["caps"].b);
        const auto& car = sw["carrier"];
        std::vector<Station> st;
        double offU = 0, offV = 0;
        bool closed = false;
        if (car.has("slot")) {
            if (!host.edge()) throw OrnamentError("invalid_spec", "a slot carrier needs an edge slot");
            const auto& c = car["slot"];
            offU = num(c["offset"][0]); offV = num(c["offset"][1]);
            const double L = host.carrierLength();
            const double s0 = std::clamp(num(c["t0"]) * L + in.ds, 0.0, L), s1 = std::clamp(num(c["t1"], 1) * L + in.ds, 0.0, L);
            if (s1 - s0 < 1e-4) throw OrnamentError("outside", "the carrier window lies off the crease");
            st = slotStations(host, s0, s1);
            b.sLo = std::min(b.sLo, s0); b.sHi = std::max(b.sHi, s1);
        } else if (car.has("chart")) {
            if (host.edge()) throw OrnamentError("invalid_spec", "a chart carrier needs a surface slot");
            auto pts = poly(car["chart"]["pointsUv"]);
            closed = car["chart"]["closed"].type == Json::Bool && car["chart"]["closed"].b;
            pts = rotated(pts, in.rotate);
            for (auto& q : pts) q = q + in.shift;
            st = chartStations(host, pts, closed);
        } else if (car.has("path")) {
            std::vector<D3> pts;
            for (const auto& q : car["path"]["points"].arr) pts.push_back(d3(q));
            closed = car["path"]["closed"].type == Json::Bool && car["path"]["closed"].b;
            if (!isArr(sw["profileUp"])) throw OrnamentError("invalid_spec", "a path carrier needs profileUp");
            st = pathStations(pts, d3(sw["profileUp"]), closed);
        } else {
            throw OrnamentError("invalid_spec", "a sweep needs a carrier");
        }
        if (closed) sp.caps = false;
        Gen g;
        buildSweep(st, sp, offU, offV, g, rank);
        b.carrierLengthM = std::max(b.carrierLengthM, st.back().s - st.front().s);
        b.sweep = true;
        // for the checks: the profile as placed, in the section
        for (const auto& q : sp.profile.outer) b.profilePts.push_back(P2(offU + q.x, offV + q.y));
        // the extent out of and into a surface host
        if (!host.edge()) for (const auto& p : g.pos) { const D3 c = host.surface()->toChart(p); b.maxProudM = std::max(b.maxProudM, c.z); b.maxRecessM = std::max(b.maxRecessM, -c.z - lim_.embedM); b.footprintUv.push_back(P2(c.x, c.y)); }
        b.gen.append(g);
    }

    std::vector<Station> slotStations(const Host& host, double s0, double s1) const {
        const Slot& sl = host.slot();
        std::vector<double> ss{s0};
        for (double a : sl.arc) if (a > s0 + 1e-6 && a < s1 - 1e-6) ss.push_back(a);
        ss.push_back(s1);
        std::vector<Station> st;
        const double eps = 1e-6;
        for (size_t i = 0; i < ss.size(); ++i) {
            Station s;
            s.s = ss[i];
            const Section in = host.sectionAt(std::max(0.0, ss[i] - (i == 0 ? -eps : eps)));
            const Section out = host.sectionAt(std::min(sl.length(), ss[i] + (i + 1 == ss.size() ? -eps : eps)));
            s.c = in.c; s.tIn = in.T; s.uIn = in.U; s.vIn = in.V;
            s.tOut = out.T; s.uOut = out.U; s.vOut = out.V;
            if (i == 0) { s.tIn = out.T; s.uIn = out.U; s.vIn = out.V; s.c = out.c; }
            if (i + 1 == ss.size()) { s.tOut = in.T; s.uOut = in.U; s.vOut = in.V; }
            s.corner = i > 0 && i + 1 < ss.size() && s.tIn.dot(s.tOut) < std::cos(0.5 * sg::kPi / 180.0);
            st.push_back(s);
        }
        return st;
    }

    std::vector<Station> chartStations(const Host& host, const std::vector<P2>& pts, bool closed) const {
        std::vector<Station> st;
        const size_t n = pts.size();
        if (n < 2) throw OrnamentError("invalid_spec", "a chart carrier needs at least two points");
        double acc = 0;
        auto frameAt = [&](const P2& p, const P2& dir, D3& c, D3& T, D3& U, D3& V) {
            c = host.map(D3(p.x, p.y, 0));
            const P2 d = dir.unit(), left(-d.y, d.x);
            const double e = 1e-3;
            T = (host.map(D3(p.x + d.x * e, p.y + d.y * e, 0)) - c).unit();
            U = (host.map(D3(p.x + left.x * e, p.y + left.y * e, 0)) - c).unit();
            V = host.outAt(D3(p.x, p.y, 0));
        };
        const size_t last = closed ? n + 1 : n;
        for (size_t i = 0; i < last; ++i) {
            const P2 p = pts[i % n];
            if (i > 0) acc += (p - pts[(i - 1) % n]).len();
            Station s;
            s.s = acc;
            const bool hasPrev = i > 0 || closed, hasNext = i + 1 < last || closed;
            const P2 dPrev = hasPrev ? p - pts[(i + n - 1) % n] : pts[(i + 1) % n] - p;
            const P2 dNext = hasNext ? pts[(i + 1) % n] - p : p - pts[(i + n - 1) % n];
            frameAt(p, dPrev, s.c, s.tIn, s.uIn, s.vIn);
            D3 c2;
            frameAt(p, dNext, c2, s.tOut, s.uOut, s.vOut);
            s.corner = hasPrev && hasNext && s.tIn.dot(s.tOut) < std::cos(0.5 * sg::kPi / 180.0);
            st.push_back(s);
        }
        return st;
    }

    std::vector<Station> pathStations(const std::vector<D3>& pts, const D3& up, bool closed) const {
        std::vector<D3> p = pts;
        if (closed && !p.empty()) p.push_back(p.front());
        const auto fr = rotationMinimising(p, up);
        std::vector<Station> st;
        double acc = 0;
        for (size_t i = 0; i < p.size(); ++i) {
            if (i) acc += (p[i] - p[i - 1]).len();
            Station s;
            s.s = acc; s.c = p[i];
            const D3 tIn = i ? (p[i] - p[i - 1]).unit() : (p[1] - p[0]).unit(), tOut = i + 1 < p.size() ? (p[i + 1] - p[i]).unit() : tIn;
            s.tIn = tIn; s.tOut = tOut;
            s.uIn = s.uOut = fr[i][0]; s.vIn = s.vOut = fr[i][1];
            s.corner = i > 0 && i + 1 < p.size() && tIn.dot(tOut) < std::cos(0.5 * sg::kPi / 180.0);
            st.push_back(s);
        }
        return st;
    }

    // ---- revolve
    void leafRevolve(const Json& rv, const Host& host, const Instance& in, Built& b, float rank) const {
        RevolveSpec rs;
        rs.axisO = d3(rv["axisOrigin"]);
        rs.axisD = d3(rv["axisDir"]);
        rs.profile = poly(rv["profile"]);
        rs.lobes = num(rv["lobes"]); rs.amplitude = num(rv["lobeAmplitude"]); rs.helixTurns = num(rv["helixTurns"]);
        rs.startDeg = num(rv["startAngleDeg"]); rs.sweepDeg = num(rv["sweepAngleDeg"], 360); rs.segments = static_cast<int>(num(rv["segments"], 48));
        const D3 origin = host.edge() ? D3(in.ds, 0, 0) : D3(in.shift.x, in.shift.y, 0);
        Gen g;
        buildRevolve(host, rs, origin, in.rotate, g, rank);
        if (!host.edge()) for (const auto& p : g.pos) { const D3 c = host.surface()->toChart(p); b.maxProudM = std::max(b.maxProudM, c.z); b.maxRecessM = std::max(b.maxRecessM, -c.z - lim_.embedM); b.footprintUv.push_back(P2(c.x, c.y)); }
        else { double rmax = 0, zmax = 0; for (const auto& q : rs.profile) { rmax = std::max(rmax, q.x); zmax = std::max(zmax, std::fabs(q.y)); } b.profilePts.push_back(P2(rs.axisO.y + rmax, rs.axisO.z + zmax)); b.profilePts.push_back(P2(rs.axisO.y - rmax, rs.axisO.z - zmax)); b.sLo = std::min(b.sLo, rs.axisO.x + in.ds - rmax); b.sHi = std::max(b.sHi, rs.axisO.x + in.ds + rmax); }
        b.gen.append(g);
    }

    // ---- relief
    void leafRelief(const Json& rf, const Host& host, const Instance& in, Built& b) const {
        if (host.edge()) throw OrnamentError("invalid_spec", "a relief needs a surface slot");
        ReliefSpec r;
        r.surfaceId = str(rf["surfaceId"]);
        if (r.surfaceId != host.surface()->id) throw OrnamentError("invalid_spec", "the relief names surface " + r.surfaceId + ", not the slot's " + host.surface()->id);
        r.outer = rotated(poly(rf["region"]["outer"]), in.rotate);
        if (isArr(rf["region"]["holes"])) for (const auto& h : rf["region"]["holes"].arr) r.holes.push_back(rotated(poly(h), in.rotate));
        r.maxEdgeM = std::max(0.01, num(rf["maxEdgeM"], 0.05));
        const auto& h = rf["height"];
        if (h.has("panel")) {
            r.panel = true;
            r.depthM = num(h["panel"]["depthM"]); r.edgeWidthM = num(h["panel"]["edgeWidthM"]); r.edgeProfile = poly(h["panel"]["edgeProfile"]);
        } else if (h.has("grid")) {
            r.panel = false;
            const auto& g = h["grid"];
            r.cols = static_cast<int>(num(g["cols"])); r.rows = static_cast<int>(num(g["rows"])); r.cellM = num(g["cellM"]);
            r.originUv = rotated({p2(g["originUv"])}, in.rotate)[0];
            for (const auto& v : g["heightsM"].arr) r.heights.push_back(num(v));
        } else {
            throw OrnamentError("invalid_spec", "a relief needs a panel or a grid");
        }
        ReliefPatch patch;
        if (!tessellateRelief(r, in.shift, lim_.elementTriangles, patch)) throw OrnamentError("too_large", "the relief's tessellation passes " + std::to_string(lim_.elementTriangles) + " triangles");
        patch.rank = static_cast<float>(b.patches.size());
        b.patches.push_back(std::move(patch));
        b.reliefSpec = r;
    }

    // ---- replicate
    SeedBounds seedBounds(const Json& seed, const Host& host) const {
        SeedBounds sb;
        const std::string op = str(seed["operator"]);
        if (op == "relief") { for (const auto& q : poly(seed["relief"]["region"]["outer"])) sb.add(q.x, q.y); }
        else if (op == "revolve") {
            const auto& rv = seed["revolve"];
            double rmax = 0;
            for (const auto& q : poly(rv["profile"])) rmax = std::max(rmax, q.x);
            rmax *= 1 + std::fabs(num(rv["lobeAmplitude"]));
            const D3 o = d3(rv["axisOrigin"]);
            if (host.edge()) { sb.s0 = o.x - rmax; sb.s1 = o.x + rmax; sb.any = true; } else { sb.add(o.x - rmax, o.y - rmax); sb.add(o.x + rmax, o.y + rmax); }
        } else if (op == "sweep") {
            const auto& car = seed["sweep"]["carrier"];
            double pr = 0;
            for (const auto& q : poly(seed["sweep"]["profile"]["outer"])) pr = std::max(pr, std::hypot(q.x, q.y));
            if (car.has("slot")) { sb.s0 = num(car["slot"]["t0"]) * host.carrierLength(); sb.s1 = num(car["slot"]["t1"], 1) * host.carrierLength(); sb.any = true; }
            else if (car.has("chart")) for (const auto& q : poly(car["chart"]["pointsUv"])) { sb.add(q.x - pr, q.y - pr); sb.add(q.x + pr, q.y + pr); }
        }
        return sb;
    }

    Built buildReplicate(const Json& rp, const Host& host, Built& b) const {
        const Json& seed = rp["seed"];
        const std::string op = str(seed["operator"]);
        if (op == "replicate") throw OrnamentError("invalid_spec", "a replicate never nests a replicate");
        b.replicated = true;
        const SeedBounds sbd = seedBounds(seed, host);
        const auto& dom = rp["domain"];
        std::vector<Instance> inst;
        if (dom.has("along")) {
            const auto& a = dom["along"];
            const double pitch = num(a["pitchM"]);
            const int count = static_cast<int>(num(a["count"]));
            if (!(pitch > 0) || count < 1) throw OrnamentError("invalid_spec", "a replicate needs a positive pitch and count");
            b.pitches.push_back(pitch); b.pitchCounts.push_back(count);
            const auto& car = a["carrier"];
            if (car.has("slot")) {
                if (!host.edge()) throw OrnamentError("invalid_spec", "a slot carrier needs an edge slot");
                const double L = host.carrierLength();
                const double base = num(car["slot"]["t0"]) * L + num(a["startOffsetM"]), end = num(car["slot"]["t1"], 1) * L;
                b.pitchAxes.push_back(P2(1, 0));
                for (int k = 0; k < count; ++k) {
                    Instance in;
                    in.ds = base + k * pitch;
                    if (in.ds + sbd.s1 > end + 1e-6 || in.ds + sbd.s0 < -1e-6 || in.ds + sbd.s1 > L + 1e-6) { ++b.skipped; continue; }
                    inst.push_back(in);
                }
            } else if (car.has("chart")) {
                if (host.edge()) throw OrnamentError("invalid_spec", "a chart carrier needs a surface slot");
                const auto pts = poly(car["chart"]["pointsUv"]);
                const double start = num(a["startOffsetM"]);
                b.pitchAxes.push_back(pts.size() >= 2 ? (pts[1] - pts[0]).unit() : P2(1, 0));
                for (int k = 0; k < count; ++k) {
                    const double s = start + k * pitch;
                    // the point and tangent at arc length s along the polyline
                    double acc = 0;
                    P2 at = pts.back(), dir = pts.size() >= 2 ? (pts.back() - pts[pts.size() - 2]) : P2(1, 0);
                    bool on = false;
                    for (size_t i = 1; i < pts.size() && !on; ++i) {
                        const double seg = (pts[i] - pts[i - 1]).len();
                        if (s <= acc + seg + 1e-9) { const double f = (s - acc) / std::max(1e-12, seg); at = pts[i - 1] + (pts[i] - pts[i - 1]) * f; dir = pts[i] - pts[i - 1]; on = true; }
                        acc += seg;
                    }
                    if (!on) { ++b.skipped; continue; }
                    Instance in;
                    in.shift = at;
                    in.rotate = a.has("alignToSurface") ? 0 : 0;
                    if (rp["alignToSurface"].type == Json::Bool && rp["alignToSurface"].b) in.rotate = std::atan2(dir.y, dir.x);
                    inst.push_back(in);
                }
            } else {
                throw OrnamentError("invalid_spec", "a replicate along a carrier needs a slot or a chart carrier");
            }
        } else if (dom.has("lattice")) {
            if (host.edge()) throw OrnamentError("invalid_spec", "a lattice needs a surface slot");
            const auto& l = dom["lattice"];
            const P2 o = p2(l["originUv"]), pu = p2(l["pitchUv"]);
            const int nu = static_cast<int>(num(l["counts"][0])), nv = static_cast<int>(num(l["counts"][1]));
            const double rowOff = num(l["rowOffsetU"]);
            if (!(pu.x > 0 && pu.y > 0) || nu < 1 || nv < 1) throw OrnamentError("invalid_spec", "a lattice needs positive pitches and counts");
            b.pitches = {pu.x, pu.y}; b.pitchCounts = {nu, nv}; b.pitchAxes = {P2(1, 0), P2(0, 1)};
            for (int j = 0; j < nv; ++j) for (int i = 0; i < nu; ++i) {
                Instance in;
                in.shift = P2(o.x + i * pu.x + (j % 2) * rowOff, o.y + j * pu.y);
                inst.push_back(in);
            }
        } else {
            throw OrnamentError("invalid_spec", "a replicate needs an 'along' or a 'lattice' domain");
        }
        // an instance whose footprint leaves the slot is skipped and counted
        std::vector<Instance> kept;
        const Slot& sl = host.slot();
        for (const auto& in : inst) {
            bool inside = true;
            if (!host.edge() && sbd.any && sbd.u1 >= sbd.u0) {
                const double c = std::cos(in.rotate), s = std::sin(in.rotate);
                const P2 corners[4] = {{sbd.u0, sbd.v0}, {sbd.u1, sbd.v0}, {sbd.u1, sbd.v1}, {sbd.u0, sbd.v1}};
                for (const auto& q : corners) {
                    const P2 w(q.x * c - q.y * s + in.shift.x, q.x * s + q.y * c + in.shift.y);
                    if (!sg::insidePolygon(sl.regionUv, w.x, w.y) && sg::polygonDistance(sl.regionUv, w) > lim_.slotToleranceM) inside = false;
                }
            }
            if (inside) kept.push_back(in); else ++b.skipped;
        }
        if (kept.empty()) throw OrnamentError("outside", "every instance lies outside the slot");
        buildLeaf(seed, op, host, kept, b, 0);
        finishLeaf(host, b);
        return std::move(b);
    }
};


// ============================================================================================
// Geometric checks
// ============================================================================================

/** Do two triangles cross (touching along an edge or a point does not count)? Separating-axis test with a 0.1 mm margin. */
inline bool trianglesCross(const D3* a, const D3* b) {
    const double eps = 1e-4;
    const D3 ea[3] = {a[1] - a[0], a[2] - a[1], a[0] - a[2]}, eb[3] = {b[1] - b[0], b[2] - b[1], b[0] - b[2]};
    const D3 na = ea[0].cross(ea[1]), nb = eb[0].cross(eb[1]);
    std::vector<D3> axes{na, nb};
    for (int i = 0; i < 3; ++i) for (int j = 0; j < 3; ++j) axes.push_back(ea[i].cross(eb[j]));
    for (int i = 0; i < 3; ++i) { axes.push_back(na.cross(ea[i])); axes.push_back(nb.cross(eb[i])); }
    for (const auto& ax0 : axes) {
        const double l = ax0.len();
        if (l < 1e-12) continue;
        const D3 ax = ax0 * (1.0 / l);
        double a0 = 1e30, a1 = -1e30, b0 = 1e30, b1 = -1e30;
        for (int i = 0; i < 3; ++i) { const double pa = ax.dot(a[i]), pb = ax.dot(b[i]); a0 = std::min(a0, pa); a1 = std::max(a1, pa); b0 = std::min(b0, pb); b1 = std::max(b1, pb); }
        if (a1 < b0 + eps || b1 < a0 + eps) return false;
    }
    return true;
}

/** How many pairs of triangles that share no vertex cross each other (uniform grid broad phase; each pair tested in one cell). */
inline size_t selfIntersections(const std::vector<D3>& p, const std::vector<uint32_t>& idx, size_t stopAt = 1) {
    const size_t T = idx.size() / 3;
    const double cell = 0.25;
    std::unordered_map<uint64_t, std::vector<uint32_t>> grid;
    auto key = [](int64_t x, int64_t y, int64_t z) { return (static_cast<uint64_t>(x & 0x1FFFFF) << 42) | (static_cast<uint64_t>(y & 0x1FFFFF) << 21) | static_cast<uint64_t>(z & 0x1FFFFF); };
    std::vector<D3> lo(T), hi(T);
    for (uint32_t t = 0; t < T; ++t) {
        const D3 v[3] = {p[idx[3 * t]], p[idx[3 * t + 1]], p[idx[3 * t + 2]]};
        lo[t] = D3(std::min({v[0].x, v[1].x, v[2].x}), std::min({v[0].y, v[1].y, v[2].y}), std::min({v[0].z, v[1].z, v[2].z}));
        hi[t] = D3(std::max({v[0].x, v[1].x, v[2].x}), std::max({v[0].y, v[1].y, v[2].y}), std::max({v[0].z, v[1].z, v[2].z}));
    }
    size_t found = 0;
    for (uint32_t t = 0; t < T && found < stopAt; ++t) {
        const D3 v[3] = {p[idx[3 * t]], p[idx[3 * t + 1]], p[idx[3 * t + 2]]};
        const int64_t x0 = static_cast<int64_t>(std::floor(lo[t].x / cell)), x1 = static_cast<int64_t>(std::floor(hi[t].x / cell));
        const int64_t y0 = static_cast<int64_t>(std::floor(lo[t].y / cell)), y1 = static_cast<int64_t>(std::floor(hi[t].y / cell));
        const int64_t z0 = static_cast<int64_t>(std::floor(lo[t].z / cell)), z1 = static_cast<int64_t>(std::floor(hi[t].z / cell));
        for (int64_t x = x0; x <= x1; ++x) for (int64_t y = y0; y <= y1; ++y) for (int64_t z = z0; z <= z1; ++z) {
            auto& bucket = grid[key(x, y, z)];
            for (uint32_t u : bucket) {
                // the pair is tested once: in the cell that holds the larger of the two boxes' minimum corners
                const int64_t cx = static_cast<int64_t>(std::floor(std::max(lo[u].x, lo[t].x) / cell)), cy = static_cast<int64_t>(std::floor(std::max(lo[u].y, lo[t].y) / cell)), cz = static_cast<int64_t>(std::floor(std::max(lo[u].z, lo[t].z) / cell));
                if (cx != x || cy != y || cz != z) continue;
                if (lo[u].x > hi[t].x || lo[t].x > hi[u].x || lo[u].y > hi[t].y || lo[t].y > hi[u].y || lo[u].z > hi[t].z || lo[t].z > hi[u].z) continue;
                bool shares = false;
                for (int i = 0; i < 3 && !shares; ++i) for (int j = 0; j < 3; ++j) if (idx[3 * u + static_cast<size_t>(i)] == idx[3 * t + static_cast<size_t>(j)]) shares = true;
                if (shares) continue;
                const D3 w[3] = {p[idx[3 * u]], p[idx[3 * u + 1]], p[idx[3 * u + 2]]};
                if (trianglesCross(v, w)) ++found;
            }
            bucket.push_back(t);
        }
    }
    return found;
}

/** The fitted surfaces together, for the penetration test. */
class FittedSolid {
public:
    explicit FittedSolid(const Fit& fit) {
        for (const auto& [id, s] : fit.surfaces) {
            const uint32_t base = static_cast<uint32_t>(mesh_.vertices.size());
            for (const auto& q : s.mesh.pos) mesh_.vertices.push_back(geometry::Vertex(q.f()));
            for (uint32_t i : s.mesh.tri) mesh_.indices.push_back(base + i);
        }
        if (!mesh_.indices.empty()) tree_.build(mesh_);
    }
    bool empty() const { return mesh_.indices.empty(); }

    /** How far a point is inside the solid: 0 outside (or on it), else the distance to its surface. Parity of three rays. */
    double depth(const D3& p) const {
        if (empty()) return 0;
        static const D3 dirs[3] = {D3(0.267, 0.535, 0.802), D3(-0.702, 0.302, 0.644), D3(0.12, -0.97, 0.21)};
        int votes = 0;
        for (const auto& d : dirs) {
            const D3 u = d.unit();
            int crossings = 0;
            D3 o = p;
            for (int k = 0; k < 64; ++k) {
                math::Ray ray(o.f(), u.f());
                bvh::RayHit hit;
                if (!tree_.raycast(ray, hit)) break;
                ++crossings;
                o = o + u * (static_cast<double>(hit.t) + 1e-4);
            }
            votes += crossings % 2;
        }
        if (votes < 2) return 0;
        float d2 = 0;
        tree_.closestPoint(p.f(), d2);
        return std::sqrt(static_cast<double>(d2));
    }

private:
    geometry::ScratchboxMesh mesh_;
    bvh::BvhTree tree_;
};

// ============================================================================================
// The photo: evidence that an element shows in the tile's own texture
// ============================================================================================

/** The textured extraction's luminance sampled through a surface's chart on a grid (u0 + (i + 0.5) gsd, v1 - (j + 0.5) gsd). */
struct Lum {
    int w{0}, h{0};
    double u0{0}, v1{0}, gsd{0};
    std::vector<float> L;
    std::vector<uint8_t> ok;
    /** Bilinear luminance at chart (u, v); false when the photo was not reached there. */
    bool at(double u, double v, double& out) const {
        const double fx = (u - u0) / gsd - 0.5, fy = (v1 - v) / gsd - 0.5;
        const int x0 = static_cast<int>(std::floor(fx)), y0 = static_cast<int>(std::floor(fy));
        if (x0 < 0 || y0 < 0 || x0 + 1 >= w || y0 + 1 >= h) return false;
        double acc = 0, wsum = 0;
        for (int dy = 0; dy < 2; ++dy) for (int dx = 0; dx < 2; ++dx) {
            const size_t i = static_cast<size_t>(y0 + dy) * static_cast<size_t>(w) + static_cast<size_t>(x0 + dx);
            if (!ok[i]) return false;
            const double wt = (dx ? fx - x0 : 1 - (fx - x0)) * (dy ? fy - y0 : 1 - (fy - y0));
            acc += wt * L[i]; wsum += wt;
        }
        out = acc / std::max(1e-12, wsum);
        return true;
    }
};

inline Lum sampleLuminance(const scan_ortho::Renderer& rend, const Surface& S, double u0, double u1, double v0, double v1, double texel) {
    scan_ortho::Request rq;
    rq.surfaceId = S.id;
    auto& C = rq.chart;
    C.cylinder = S.cyl;
    if (S.cyl) {
        C.axisOrigin = S.axisO.f(); C.axisDir = S.axisD.f(); C.thetaZeroDir = S.thetaZ.f(); C.radius = S.r; C.normalSign = S.sign;
        C.thetaDeg[0] = u0 / S.r * 180.0 / sg::kPi; C.thetaDeg[1] = u1 / S.r * 180.0 / sg::kPi; C.zM[0] = v0; C.zM[1] = v1;
    } else {
        C.origin = S.origin.f(); C.u = S.u.f(); C.v = S.v.f(); C.n = S.n.f();
        C.extentUv = {P2(u0, v0), P2(u1, v0), P2(u1, v1), P2(u0, v1)};
    }
    const auto im = rend.render(rq, texel, 4096, false);
    Lum l;
    l.w = im.widthPx; l.h = im.heightPx; l.u0 = im.originUv.x; l.v1 = im.originUv.y; l.gsd = im.gsdM;
    l.L.assign(static_cast<size_t>(l.w) * static_cast<size_t>(l.h), 0);
    l.ok.assign(l.L.size(), 0);
    for (int j = 0; j < l.h; ++j) for (int i = 0; i < l.w; ++i) {
        const uint8_t* px = &im.pixels.data[im.pixels.getIndex(i, j)];
        if (px[3] == 0) continue;
        const size_t k = static_cast<size_t>(j) * static_cast<size_t>(l.w) + static_cast<size_t>(i);
        l.ok[k] = 1;
        l.L[k] = static_cast<float>((0.2126 * px[0] + 0.7152 * px[1] + 0.0722 * px[2]) / 255.0);
    }
    return l;
}

/** The convex hull of points (counter-clockwise, Andrew's monotone chain). */
inline std::vector<P2> convexHull(std::vector<P2> pts) {
    std::sort(pts.begin(), pts.end(), [](const P2& a, const P2& b) { return a.x < b.x || (a.x == b.x && a.y < b.y); });
    pts.erase(std::unique(pts.begin(), pts.end(), [](const P2& a, const P2& b) { return std::fabs(a.x - b.x) < 1e-9 && std::fabs(a.y - b.y) < 1e-9; }), pts.end());
    if (pts.size() < 3) return pts;
    std::vector<P2> h(2 * pts.size());
    size_t k = 0;
    for (size_t i = 0; i < pts.size(); ++i) { while (k >= 2 && (h[k - 1] - h[k - 2]).cross(pts[i] - h[k - 2]) <= 0) --k; h[k++] = pts[i]; }
    for (size_t i = pts.size() - 1, t = k + 1; i > 0; --i) { while (k >= t && (h[k - 1] - h[k - 2]).cross(pts[i - 1] - h[k - 2]) <= 0) --k; h[k++] = pts[i - 1]; }
    h.resize(k - 1);
    return h;
}

/** Power of a signal's DFT at frequency f (cycles per metre), a Hann window and the mean removed. */
inline double dftPower(const std::vector<double>& x, double step, double f) {
    const size_t n = x.size();
    std::complex<double> acc(0, 0);
    double mean = 0;
    for (double v : x) mean += v;
    mean /= static_cast<double>(n);
    for (size_t i = 0; i < n; ++i) {
        const double w = 0.5 - 0.5 * std::cos(2 * sg::kPi * static_cast<double>(i) / std::max<size_t>(1, n - 1));
        acc += (x[i] - mean) * w * std::polar(1.0, -2 * sg::kPi * f * step * static_cast<double>(i));
    }
    return std::norm(acc) / static_cast<double>(n);
}

struct Support { bool ran{false}; bool passed{true}; std::string test; double value{0}, limit{0}; std::string unit, message; };

/**
 * An element that cites only tile orthos must show in the photo itself. `points` are its vertices in the chart of the
 * surface the ortho lies on, `axes` and `pitches` the replicate's claim (empty for a single element).
 */
inline Support supportTest(const scan_ortho::Renderer& rend, const Surface& S, const std::vector<P2>& points, const std::vector<P2>& axes, const std::vector<double>& pitches,
                           const std::vector<int>& counts, double texel, const Limits& lim) {
    Support out;
    out.ran = true;
    if (points.size() < 3 || !(texel > 0)) { out.passed = false; out.test = "photo support"; out.message = "no footprint or no texel to test"; return out; }
    double u0 = 1e30, u1 = -1e30, v0 = 1e30, v1 = -1e30;
    for (const auto& q : points) { u0 = std::min(u0, q.x); u1 = std::max(u1, q.x); v0 = std::min(v0, q.y); v1 = std::max(v1, q.y); }
    const double pad = std::max(4 * texel, 0.75);  // the area around the element is the baseline's
    Lum lum = sampleLuminance(rend, S, u0 - pad, u1 + pad, v0 - pad, v1 + pad, texel);
    if (lum.w < 3 || lum.h < 3) { out.passed = false; out.test = "photo support"; out.message = "the element is under three texels across"; return out; }
    if (!pitches.empty()) {
        // repeating: the power at the claimed pitch against the median power around it, along each axis
        out.test = "periodic peak";
        out.unit = "ratio";
        out.limit = lim.pitchPeakRatio;
        double best = 0;
        bool resolvable = true;
        for (size_t a = 0; a < pitches.size(); ++a) {
            if (counts[a] < 2) continue;
            if (pitches[a] < 2 * texel) { resolvable = false; continue; }
            const P2 ax = axes[a].unit(), perp(-ax.y, ax.x);
            // the signal along the axis: the mean over the element's extent across it
            double t0 = 1e30, t1 = -1e30, w0 = 1e30, w1 = -1e30;
            for (const auto& q : points) { const double t = ax.dot(q), w = perp.dot(q); t0 = std::min(t0, t); t1 = std::max(t1, t); w0 = std::min(w0, w); w1 = std::max(w1, w); }
            std::vector<double> sig;
            for (double t = t0; t <= t1; t += texel) {
                double acc = 0; int n = 0;
                for (double w = w0; w <= w1; w += texel) { double l; if (lum.at(ax.x * t + perp.x * w, ax.y * t + perp.y * w, l)) { acc += l; ++n; } }
                sig.push_back(n >= 3 ? acc / n : 0.0);
            }
            if (sig.size() < 8) continue;
            const double f0 = 1.0 / pitches[a];
            double peak = 0;
            for (double f = 0.85 * f0; f <= 1.15 * f0 + 1e-12; f += 0.01 * f0) peak = std::max(peak, dftPower(sig, texel, f));
            std::vector<double> band;
            for (double f = 0.5 * f0; f <= 2.0 * f0 + 1e-12; f += 0.05 * f0) band.push_back(dftPower(sig, texel, f));
            std::nth_element(band.begin(), band.begin() + static_cast<long>(band.size() / 2), band.end());
            const double med = std::max(1e-12, band[band.size() / 2]);
            best = std::max(best, peak / med);
        }
        out.value = best;
        if (!resolvable && best <= 0) { out.passed = false; out.message = "the pitch is under two texels (" + sj::num(std::round(2 * texel * 1000) / 1000) + " m): the photo cannot resolve it"; return out; }
        out.passed = best >= lim.pitchPeakRatio;
        out.message = out.passed ? "the tile photo shows the claimed pitch" : "not visible in the tile photo: no power at the claimed pitch";
        return out;
    }
    // a single element: the luminance step across its outline against the slot's own median
    out.test = "edge contrast";
    out.unit = "ratio";
    out.limit = lim.gradientRatio;
    const auto hull = convexHull(points);
    auto contrast = [&](const P2& p, const P2& dir) { double a, b; if (lum.at(p.x + dir.x * texel, p.y + dir.y * texel, a) && lum.at(p.x - dir.x * texel, p.y - dir.y * texel, b)) return std::fabs(a - b); return -1.0; };
    double acc = 0; int n = 0, tried = 0;
    for (size_t i = 0; i < hull.size(); ++i) {
        const P2 a = hull[i], b = hull[(i + 1) % hull.size()];
        const double L = (b - a).len();
        if (L < 1e-9) continue;
        const P2 d = (b - a) * (1.0 / L), nrm(d.y, -d.x);
        for (double t = 0; t < L; t += texel) { ++tried; const double c = contrast(a + d * t, nrm); if (c >= 0) { acc += c; ++n; } }
    }
    std::vector<double> base;
    // the baseline: contrast across random short steps over the area around the element
    uint64_t rng = 0x9E3779B97F4A7C15ull;
    auto next = [&]() { rng ^= rng << 13; rng ^= rng >> 7; rng ^= rng << 17; return static_cast<double>(rng >> 11) / 9007199254740992.0; };
    for (int i = 0; i < 600; ++i) {
        const P2 p(lum.u0 + next() * lum.w * lum.gsd, lum.v1 - next() * lum.h * lum.gsd);
        const double th = next() * 2 * sg::kPi;
        const double c = contrast(p, P2(std::cos(th), std::sin(th)));
        if (c >= 0) base.push_back(c);
    }
    if (n < 4 || tried == 0 || static_cast<double>(n) < 0.5 * tried || base.size() < 20) { out.passed = false; out.value = 0; out.message = "the photo does not reach enough of the element's outline"; return out; }
    std::nth_element(base.begin(), base.begin() + static_cast<long>(base.size() / 2), base.end());
    const double med = std::max(1e-4, base[base.size() / 2]), mean = acc / n;
    out.value = mean / med;
    out.passed = out.value >= lim.gradientRatio && mean >= lim.gradientFloor;
    out.message = out.passed ? "the tile photo shows an edge along the element's outline" : "not visible in the tile photo: the outline carries " + sj::num(std::round(mean * 1000) / 10) + "% luminance step, " + sj::num(std::round(out.value * 10) / 10) + " times the area's own";
    return out;
}


// ============================================================================================
// The layer
// ============================================================================================

struct Evidence { std::string kind, surfaceId; double texelM{0}; };

inline staged_glb::Provenance readProvenance(const Json& j) {
    staged_glb::Provenance p;
    p.label = str(j["label"]);
    p.measuredGeometry = !(j["measuredGeometry"].type == Json::Bool && !j["measuredGeometry"].b);
    p.method = str(j["method"]);
    for (const auto& s : j["sources"].arr) p.sources.push_back({str(s["kind"]), str(s["id"]), str(s["note"])});
    if (j["confidence"].type == Json::Number) p.confidence = j["confidence"].num;
    p.note = str(j["note"]);
    if (isObj(j["inferred"])) for (const auto& [k, v] : j["inferred"].obj) p.inferred.push_back({k, num(v)});
    if (p.label.empty()) { p.label = "photo-inferred"; p.measuredGeometry = false; }
    if (!p.measuredGeometry && !std::isfinite(p.confidence)) p.confidence = 0;
    return p;
}

struct BuiltElement { std::string id, slotId; Built b; size_t node{0}; Support support; };

struct Output {
    std::vector<uint8_t> glb;
    std::string reportJson;
    size_t built{0}, dropped{0}, vertices{0}, triangles{0};
};

inline std::string checkJson(const Check& c) {
    sj::Object o;
    o.s("check", c.check).n("value", c.value).n("limit", c.limit).s("unit", c.unit).s("message", c.message);
    return o.text();
}

/**
 * Builds the detail layer. `textured` (the photo-textured extraction) is needed only for elements that cite tile orthos
 * and nothing else; without it such an element is dropped with the reason.
 */
inline Output buildOrnament(const std::string& fitJson, const std::vector<uint8_t>& fittedGlb, const std::string& specJson, const gltf::GltfScene* textured,
                            const std::string& stageKey, const Limits& lim = Limits()) {
    const auto t0 = std::chrono::steady_clock::now();
    auto ms = [&]() { return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count(); };
    const Fit fit = loadFit(fitJson, readNodeMeshes(fittedGlb));
    io::GlbJsonParser sp(specJson.data(), specJson.size());
    const Json spec = sp.parse();
    if (str(spec["schema"]) != "scratchbox.ornament-spec/2") throw OrnamentError("input_unreadable", "--spec must hold a scratchbox.ornament-spec/2 object");
    std::map<std::string, Evidence> evidence;
    for (const auto& e : spec["evidence"].arr) evidence[str(e["id"])] = {str(e["kind"]), str(e["surfaceId"]), num(e["texelM"])};
    std::vector<const Json*> order;
    for (const auto& e : spec["elements"].arr) order.push_back(&e);
    std::stable_sort(order.begin(), order.end(), [](const Json* a, const Json* b) { return num((*a)["buildOrder"]) < num((*b)["buildOrder"]); });

    ElementBuilder builder(fit, lim);
    std::unique_ptr<FittedSolid> solid;
    std::unique_ptr<scan_ortho::Renderer> photo;
    std::vector<BuiltElement> built;
    std::vector<std::pair<std::pair<std::string, std::string>, std::vector<Check>>> dropped;  // (element, slot) -> checks
    std::map<std::string, size_t> requested, produced;
    size_t layerTriangles = 0;
    double buildMs = 0, checkMs = 0;

    for (const Json* ep : order) {
        const Json& el = *ep;
        const std::string id = str(el["id"]), slotId = str(el["slotId"]);
        ++requested[slotId];
        std::vector<Check> fails;
        auto drop = [&]() { dropped.push_back({{id, slotId}, fails}); };
        const auto slotIt = fit.slots.find(slotId);
        if (slotIt == fit.slots.end()) { fails.push_back({"slot", 0, 0, "", "the fit has no slot " + slotId}); drop(); continue; }
        const Slot& slot = slotIt->second;
        std::unique_ptr<Host> host;
        try { host = std::make_unique<Host>(fit, slot); } catch (const OrnamentError& e) { fails.push_back({"host", 0, 0, "", e.what()}); drop(); continue; }
        const auto tb = std::chrono::steady_clock::now();
        Built b;
        try {
            b = builder.build(el["spec"], *host);
        } catch (const OrnamentError& e) {
            fails.push_back({e.code() == "outside" ? "footprint inside slot" : "build " + e.code(), 0, 0, "", e.what()});
            drop();
            continue;
        }
        buildMs += std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - tb).count();
        const auto tc = std::chrono::steady_clock::now();
        // 1. triangle caps
        if (b.gen.triangles() > lim.elementTriangles) fails.push_back({"triangles in the element", static_cast<double>(b.gen.triangles()), static_cast<double>(lim.elementTriangles), "triangles", "the element passes the per-element triangle cap"});
        if (layerTriangles + b.gen.triangles() > lim.layerTriangles) fails.push_back({"triangles in the layer", static_cast<double>(layerTriangles + b.gen.triangles()), static_cast<double>(lim.layerTriangles), "triangles", "the layer passes its triangle cap"});
        // 2. the slot's displacement bounds
        if (!slot.edge) {
            if (b.maxProudM > slot.maxProud + lim.embedM) fails.push_back({"proud of the surface", b.maxProudM, slot.maxProud, "m", "the element stands further out of the surface than the slot allows"});
            if (b.maxRecessM > slot.maxRecess + lim.embedM) fails.push_back({"recess into the surface", b.maxRecessM, slot.maxRecess, "m", "the element cuts deeper into the surface than the slot allows"});
        } else {
            double out = 0;
            for (const auto& q : b.profilePts) out = std::max(out, q.x);
            if (out > slot.maxProud + lim.embedM) fails.push_back({"proud of the surface", out, slot.maxProud, "m", "the profile stands further out than the slot allows"});
        }
        // 3. the profile inside the edge slot's measured section
        if (slot.edge && !b.profilePts.empty() && slot.envelope.size() >= 3) {
            double worst = 0;
            for (const auto& q : b.profilePts) if (!sg::insidePolygon(slot.envelope, q.x, q.y)) worst = std::max(worst, sg::polygonDistance(slot.envelope, q));
            if (worst > lim.envelopeToleranceM) fails.push_back({"inside the slot's envelope", worst, lim.envelopeToleranceM, "m", "the profile leaves the section the scan measured for this edge"});
        }
        // 4. the footprint inside the slot
        if (slot.edge) {
            if (b.sHi > b.sLo) {
                const double over = std::max({0.0, -b.sLo, b.sHi - slot.length()});
                if (over > lim.slotToleranceM) fails.push_back({"footprint inside slot", over, lim.slotToleranceM, "m", "the element runs past the end of the crease"});
            }
        } else if (!b.footprintUv.empty() && slot.regionUv.size() >= 3) {
            size_t in = 0;
            for (const auto& q : b.footprintUv) if (sg::insidePolygon(slot.regionUv, q.x, q.y) || sg::polygonDistance(slot.regionUv, q) <= lim.slotToleranceM) ++in;
            const double share = static_cast<double>(in) / static_cast<double>(b.footprintUv.size());
            if (share < lim.insideSlotShare) fails.push_back({"footprint inside slot", share, lim.insideSlotShare, "share", "part of the element lies outside the slot"});
        }
        // 5. no self-intersection, 6. no penetration (a recut is a height field of the surface it replaces)
        if (b.replaces.empty() && fails.empty()) {
            const size_t crossings = selfIntersections(b.gen.pos, b.gen.idx);
            if (crossings > 0) fails.push_back({"self-intersection", static_cast<double>(crossings), 0, "pairs", "the element's triangles cross one another"});
            if (!solid) solid = std::make_unique<FittedSolid>(fit);
            size_t deep = 0;
            double worst = 0;
            for (const auto& p : b.gen.pos) { const double d = solid->depth(p); if (d > lim.penetrationM) { ++deep; worst = std::max(worst, d); } }
            if (static_cast<double>(deep) > 0.02 * static_cast<double>(b.gen.pos.size())) fails.push_back({"penetration of the fitted solid", worst, lim.penetrationM, "m", "the element sinks into the fitted solid"});
        }
        // 7. an element that cites tile orthos only must show in the tile's own photo
        Support support;
        if (fails.empty()) {
            bool orthoOnly = isArr(el["evidence"]) && !el["evidence"].arr.empty(), surfaceKnown = true;
            std::string evSurface;
            for (const auto& e : el["evidence"].arr) {
                const auto it = evidence.find(str(e["imageId"]));
                const bool ortho = it != evidence.end() ? it->second.kind == "tile-ortho" : str(e["imageId"]).rfind("ortho:", 0) == 0;
                orthoOnly = orthoOnly && ortho;
                if (ortho && evSurface.empty()) evSurface = it != evidence.end() && !it->second.surfaceId.empty() ? it->second.surfaceId : str(e["imageId"]).substr(6);
            }
            if (orthoOnly) {
                const auto sit = fit.surfaces.find(evSurface);
                surfaceKnown = sit != fit.surfaces.end();
                if (!textured) fails.push_back({"photo support", 0, 0, "", "no textured extraction to test the element against"});
                else if (!surfaceKnown) fails.push_back({"photo support", 0, 0, "", "the ortho's surface " + evSurface + " is not in the fit"});
                else {
                    const Surface& S = sit->second;
                    std::vector<P2> pts;
                    if (!b.replaces.empty() && host->surface()) for (const auto& q : b.footprintUv) { const D3 c = S.toChart(host->surface()->fromChart(q.x, q.y, 0)); pts.push_back(P2(c.x, c.y)); }
                    else for (const auto& p : b.gen.pos) { const D3 c = S.toChart(p); pts.push_back(P2(c.x, c.y)); }
                    if (!photo) photo = std::make_unique<scan_ortho::Renderer>(*textured);
                    const double texel = S.texelM > 0 ? S.texelM : fit.texelM;
                    support = supportTest(*photo, S, pts, b.pitchAxes, b.pitches, b.pitchCounts, texel, lim);
                    if (!support.passed) fails.push_back({support.test, support.value, support.limit, support.unit, support.message});
                }
            }
        }
        checkMs += std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - tc).count();
        if (!fails.empty()) { drop(); continue; }
        layerTriangles += b.gen.triangles();
        ++produced[slotId];
        BuiltElement be;
        be.id = id; be.slotId = slotId; be.b = std::move(b); be.node = built.size(); be.support = support;
        built.push_back(std::move(be));
    }

    // slots that were asked for detail and got none
    std::vector<std::string> degraded;
    for (const auto& [slotId, n] : requested) if (n > 0 && produced[slotId] == 0) degraded.push_back(slotId);

    // the nodes
    std::vector<staged_glb::StagedNode> nodes;
    const size_t total = built.size() + degraded.size();
    size_t vertices = 0, triangles = 0;
    const double share = std::clamp(3.0 / std::max<size_t>(1, total), 0.05, 1.0);
    for (size_t k = 0; k < built.size(); ++k) {
        const BuiltElement& be = built[k];
        const Json* el = nullptr;
        for (const auto& e : spec["elements"].arr) if (str(e["id"]) == be.id) { el = &e; break; }
        const Gen& g = be.b.gen;
        std::vector<Vec3> pos;
        for (const auto& p : g.pos) pos.push_back(p.f());
        const Creased cr = splitByCrease(pos, g.idx, 40.0);
        staged_glb::StagedPrimitive pr;
        const double denom = static_cast<double>(std::max<size_t>(1, be.b.placed));
        for (size_t i = 0; i < cr.origin.size(); ++i) {
            const uint32_t o = cr.origin[i];
            pr.positions.push_back(pos[o]);
            pr.normals.push_back(cr.normals[i]);
            const float x = static_cast<float>((static_cast<double>(k) + std::min(1.0, g.instance[o] / denom)) / static_cast<double>(std::max<size_t>(1, built.size())));
            pr.reveal.push_back({std::clamp(x, 0.0f, 1.0f), std::clamp(g.revealY[o], 0.0f, 1.0f)});
            if (g.hasDisp) pr.disp.push_back(g.disp[o].f());
        }
        pr.indices = cr.idx;
        staged_glb::StagedNode node;
        node.name = be.id;
        node.primitives.push_back(std::move(pr));
        staged_glb::NodeExtras ex;
        ex.stage = "detail";
        ex.provenance = readProvenance((*el)["provenance"]);
        ex.buildOrder = static_cast<long long>(k);
        ex.buildCount = static_cast<long long>(total);
        ex.revealKind = be.b.replicated ? "cells" : be.b.sweep ? "sweep" : !be.b.replaces.empty() || g.hasDisp ? "rise" : "appear";
        ex.revealAttribute = true;
        ex.displacement = g.hasDisp;
        ex.durationShare = share;
        if (be.b.sweep && !be.b.replicated) { ex.hasSweep = true; ex.sweepCarrierLengthM = be.b.carrierLengthM; ex.sweepClosed = false; }
        ex.slotId = be.slotId; ex.elementId = be.id;
        if (!be.b.replaces.empty()) ex.replacesSurfaceIds = {be.b.replaces};
        ex.vertices = static_cast<long long>(node.primitives[0].positions.size());
        ex.triangles = static_cast<long long>(g.idx.size() / 3);
        node.extrasJson = ex.toJson();
        vertices += node.primitives[0].positions.size();
        triangles += g.idx.size() / 3;
        nodes.push_back(std::move(node));
    }
    // a slot left without its detail is outlined, so the viewport can show it was asked for
    for (size_t k = 0; k < degraded.size(); ++k) {
        const Slot& sl = fit.slots.at(degraded[k]);
        const Host host(fit, sl);
        staged_glb::StagedPrimitive pr;
        pr.mode = 1;
        std::vector<D3> ring;
        if (sl.edge) { ring = sl.carrier; }
        else for (const auto& q : sl.regionUv) ring.push_back(host.map(D3(q.x, q.y, 0.004)));
        for (const auto& p : ring) pr.positions.push_back(p.f());
        for (size_t i = 0; i + 1 < ring.size(); ++i) pr.indices.insert(pr.indices.end(), {static_cast<uint32_t>(i), static_cast<uint32_t>(i + 1)});
        if (!sl.edge && ring.size() >= 3) pr.indices.insert(pr.indices.end(), {static_cast<uint32_t>(ring.size() - 1), 0u});
        pr.colors.assign(pr.positions.size(), std::array<uint8_t, 4>{255, 255, 255, 255});
        staged_glb::StagedNode node;
        node.name = "degraded_" + degraded[k];
        staged_glb::NodeExtras ex;
        ex.stage = "detail";
        ex.provenance.label = "fitted";
        ex.provenance.measuredGeometry = true;
        ex.provenance.method = "ornament: the outline of a slot whose photo-read detail was asked for and not built";
        ex.buildOrder = static_cast<long long>(built.size() + k);
        ex.buildCount = static_cast<long long>(total);
        ex.revealKind = "outline";
        ex.durationShare = share;
        ex.slotId = degraded[k];
        ex.degradationId = "ornament:" + degraded[k];
        ex.vertices = static_cast<long long>(pr.positions.size());
        ex.triangles = 0;
        ex.lines = static_cast<long long>(pr.indices.size() / 2);
        node.extrasJson = ex.toJson();
        if (!pr.indices.empty()) { node.primitives.push_back(std::move(pr)); nodes.push_back(std::move(node)); }
    }
    Output out;
    staged_glb::WriteOptions wo;
    wo.generator = "Scratchbox ornament builder (photo-inferred detail)";
    wo.rootName = "ornament_detail";
    wo.rootExtrasJson = staged_glb::rootExtrasJson("detail", stageKey, "tile frame: x east, y up, z south (metres)", str(spec["buildingId"]));
    if (nodes.empty()) { staged_glb::StagedNode empty; empty.name = "empty_detail"; nodes.push_back(std::move(empty)); }
    out.glb = staged_glb::write(nodes, wo);
    // the report
    std::vector<std::string> bj, dj, deg;
    for (const auto& be : built) {
        sj::Object o;
        o.s("elementId", be.id).s("slotId", be.slotId).i("node", static_cast<long long>(be.node))
            .i("vertices", static_cast<long long>(nodes[be.node].primitives[0].positions.size())).i("triangles", static_cast<long long>(be.b.gen.idx.size() / 3));
        if (be.b.replicated) { sj::Object in; in.i("placed", static_cast<long long>(be.b.placed)).i("skippedOutside", static_cast<long long>(be.b.skipped)); o.raw("instances", in.text()); }
        if (be.support.ran) { sj::Object su; su.s("test", be.support.test).n("value", be.support.value).n("limit", be.support.limit); o.raw("support", su.text()); }
        bj.push_back(o.text());
    }
    for (const auto& d : dropped) {
        std::vector<std::string> cs;
        for (const auto& c : d.second) cs.push_back(checkJson(c));
        sj::Object o;
        o.s("elementId", d.first.first).s("slotId", d.first.second).raw("checks", sj::array(cs));
        dj.push_back(o.text());
    }
    for (const auto& id : degraded) deg.push_back(sj::str(id));
    sj::Object counts;
    counts.i("vertices", static_cast<long long>(vertices)).i("triangles", static_cast<long long>(triangles));
    sj::Object tm;
    tm.n("build", buildMs).n("checks", checkMs).n("total", ms());
    sj::Object rep;
    rep.s("schema", "scratchbox.ornament-build/1").s("structureFitSha256", fit.sha256).s("ornamentSpecSha256", sg::sha256Hex(reinterpret_cast<const uint8_t*>(specJson.data()), specJson.size()))
        .raw("built", sj::array(bj)).raw("dropped", sj::array(dj)).raw("degradedSlots", sj::array(deg)).raw("counts", counts.text()).raw("timingsMs", tm.text());
    out.reportJson = rep.text();
    out.built = built.size(); out.dropped = dropped.size(); out.vertices = vertices; out.triangles = triangles;
    return out;
}

} // namespace ornament
} // namespace scratchbox

#endif // SCRATCHBOX_ORNAMENT_HPP
