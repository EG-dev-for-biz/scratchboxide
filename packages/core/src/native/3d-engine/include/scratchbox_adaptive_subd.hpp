/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

// Adaptive tessellation for displacement: crack-free, by projected (or world) edge length.
//
// The method is DiagSplit (Fisher, Fatahalian, Boulos, Akeley, Mark, Hanrahan, "DiagSplit: Parallel, Crack-free,
// Adaptive Tessellation for Micropolygon Rendering", SIGGRAPH Asia 2009) with edge-factor dicing in the manner of the
// DX11 / ARB_tessellation_shader tessellator, written here for our triangle meshes. Its logic follows Blender Cycles'
// subd/ (Apache-2.0; read, not copied): the edge factor from sampled edge lengths, splitting the longest non-uniform
// edge, and dicing a triangle with an inner grid stitched to its edges by the shorter diagonal.
//
// What it does
//  - The input is welded by position into a control mesh, so every edge is shared by index: the tessellation is
//    crack-free across it, UV seams and hard-normal seams included (attributes stay per face corner).
//  - Every edge gets a segment count T from its length, measured at a few points along it: with a camera, in pixels
//    (a pixel's world width at each point) over `dicingRate` pixels per segment; without one, in metres over
//    `dicingRate` metres per segment. An edge whose length varies too much along it (its far end much smaller on screen
//    than its near end), or that would need more than kMaxSegments segments, is marked to split.
//  - A triangle with an edge marked to split is cut in two through that edge's midpoint and the opposite corner
//    (the longest marked edge first); the halves are processed again. A triangle whose three edges all have a final T is
//    diced: an inner grid of max(T) segments stitched to each edge's own T, so neighbours meet vertex for vertex.
//    An edge's vertices are made once, by whichever triangle reaches it first, and shared.
//  - The surface is the input's own triangles (flat): it is tessellated, never smoothed, so corners stay sharp.
//  - Each vertex is moved once along the welded smooth normal by the caller's height (metres), read at the UV of the
//    face that made it, so shared edges stay shut. Normals are then recomputed from the displaced surface, smoothed
//    within each input normal group (a hard input edge stays hard); every output vertex keeps its own face corner's UV,
//    second UV, colour and tangent.
//
// Measured surfaces: this moves whatever it is given. Callers must not pass measured scan surfaces with an inferred
// height (AGENTS.md section 2); a height of 0 leaves the surface where it is.

#ifndef SCRATCHBOX_ADAPTIVE_SUBD_HPP
#define SCRATCHBOX_ADAPTIVE_SUBD_HPP

#include "scratchbox_geometry.hpp"
#include "scratchbox_math.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <functional>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

namespace scratchbox {
namespace adaptive_subd {

using geometry::ScratchboxMesh;
using geometry::Vertex;
using math::Vec2;
using math::Vec3;
using math::Vec4;

/** A pinhole camera: where it stands, where it looks, its vertical field of view and its raster. */
struct CameraSpec {
    Vec3 position{0, 0, 0};
    Vec3 target{0, 0, -1};
    Vec3 up{0, 1, 0};
    float fovYRadians{0.8f};
    int width{1920};
    int height{1080};
    /** Surfaces outside the frame are diced up to this many times coarser (reached one frame width outside). */
    float offscreenDicingScale{4.0f};
};

struct Params {
    /** With a camera: pixels per edge segment. Without: metres per edge segment. */
    float dicingRate{1.0f};
    bool useCamera{false};
    CameraSpec camera;
    /** An input edge is cut into at most 2^maxLevel segments. */
    int maxLevel{12};
    /** Points an edge is measured at, and how far (in segments) its two length estimates may differ before it splits. */
    int testSteps{3};
    int splitThreshold{1};
    /** Positions closer than this (metres) are welded into one control vertex. */
    float weldMeters{1e-5f};
    /** 0: no limit. When the split asks for more triangles than this, nothing is diced and the result says so. */
    size_t maxTriangles{0};
    bool recomputeNormals{true};
};

/**
 * Height (metres, along the normal) at a surface point: its UV, undisplaced position and normal, and the input triangle.
 * It is called from several threads at once, so it must only read shared state.
 */
using HeightFn = std::function<float(const Vec2& uv, const Vec3& position, const Vec3& normal, uint32_t sourceTriangle)>;

struct Stats {
    size_t inputTriangles{0};
    size_t skippedDegenerate{0};
    size_t controlVertices{0};
    size_t patches{0};
    size_t dicedVertices{0};
    size_t triangles{0};
    double msSplit{0}, msDice{0}, msDisplace{0}, msOutput{0}, msTotal{0};
};

struct Result {
    bool ok{false};
    std::string error;
    ScratchboxMesh mesh;
    /** The input triangle each output triangle came from. */
    std::vector<uint32_t> triangleSource;
    Stats stats;
};

namespace detail {

constexpr int kNonUniform = -1;
constexpr int kMaxDepth = 16;
constexpr int kMaxSegments = 8;
constexpr uint32_t kNone = 0xffffffffu;

/** A point's barycentric coordinates in its input face. */
struct B3 {
    float w[3]{0, 0, 0};
};
inline B3 mix(const B3& a, const B3& b, float t) {
    B3 r;
    for (int k = 0; k < 3; k++) r.w[k] = a.w[k] + t * (b.w[k] - a.w[k]);
    return r;
}

struct Edge {
    uint32_t a, b;      // vertex ids, in the edge's own direction
    int depth;
    int T{0};           // 0: not yet measured; kNonUniform: must split; else its final segment count
    float length{0};    // world length (picks the edge to split)
    uint32_t mid{kNone};
    uint32_t second{kNone};  // first interior vertex; interior vertex n (1..T-1) is second + n - 1
    uint32_t vertex(int n) const { return n == 0 ? a : n == T ? b : second + static_cast<uint32_t>(n - 1); }
};

/** A triangle's edge as the triangle walks it (corner k to corner k+1). */
struct SideRef {
    uint32_t edge;
    bool reversed;
};

struct SubTri {
    uint32_t face;
    B3 corner[3];
    SideRef side[3];
};

/** A pixel's world width at a point, for a camera. */
struct PixelScale {
    bool on{false};
    Vec3 pos, fwd, right, up;
    float pixelAngle{0}, halfW{0}, halfH{0}, offscreen{1};
    explicit PixelScale(const Params& P) {
        if (!P.useCamera) return;
        on = true;
        pos = P.camera.position;
        fwd = (P.camera.target - P.camera.position).normalized();
        right = fwd.cross(P.camera.up).normalized();
        up = right.cross(fwd);
        pixelAngle = 2.0f * std::tan(0.5f * P.camera.fovYRadians) / std::max(1, P.camera.height);
        halfW = 0.5f * P.camera.width * pixelAngle;
        halfH = 0.5f * P.camera.height * pixelAngle;
        offscreen = P.camera.offscreenDicingScale;
    }
    float at(const Vec3& p) const {
        const Vec3 d = p - pos;
        float res = d.length() * pixelAngle;
        if (offscreen > 1.0f) {
            const float depth = d.dot(fwd);
            float outside = 1.0f;
            if (depth > 1e-6f) {
                const float nx = std::fabs(d.dot(right) / depth) / halfW, ny = std::fabs(d.dot(up) / depth) / halfH;
                outside = std::max(0.0f, std::max(nx, ny) - 1.0f);
            }
            res += res * std::min(outside, 1.0f) * (offscreen - 1.0f);
        }
        return std::max(res, 1e-9f);
    }
};

class Tessellator {
public:
    Tessellator(const Params& P, std::vector<Vec3>& pos, std::vector<uint32_t>& vFace, std::vector<B3>& vBary,
                const std::vector<std::array<uint32_t, 3>>& faceCorners)
        : P_(P), px_(P), pos_(pos), vFace_(vFace), vBary_(vBary), faceCorners_(faceCorners) {}

    /** Splits face f until every piece can be diced; the pieces are appended to `final`. */
    void splitFace(uint32_t f, std::vector<SubTri>& final) {
        const auto& c = faceCorners_[f];
        SubTri s;
        s.face = f;
        for (int k = 0; k < 3; k++) {
            s.corner[k].w[k] = 1.0f;
            s.side[k] = side(c[k], c[(k + 1) % 3], 0);
        }
        splitTriangle(s, final);
    }

    /** Triangles dicing `s` makes (the count dice() writes). */
    size_t triangleCount(const SubTri& s) const {
        const int T0 = edges_[s.side[0].edge].T, T1 = edges_[s.side[1].edge].T, T2 = edges_[s.side[2].edge].T;
        const int M = std::max({T0, T1, T2});
        if (M == 1) return 1;
        if (M == 2) return static_cast<size_t>(T0 + T1 + T2 - 2);
        const int inner = M - 2;
        return static_cast<size_t>(inner * inner + T0 + T1 + T2 + 3 * inner);
    }

    /** Dices `s`: vertices into pos/vFace/vBary, triangles into tris (3 ids each) with their face and corner coordinates. */
    void dice(const SubTri& s, std::vector<uint32_t>& tris, std::vector<uint32_t>& triFace, std::vector<B3>& triCorner) {
        const int T[3] = {edges_[s.side[0].edge].T, edges_[s.side[1].edge].T, edges_[s.side[2].edge].T};
        const int M = std::max({T[0], T[1], T[2]});
        // (u, v) in the piece: point = (1 - u - v) corner0 + u corner1 + v corner2
        auto toBary = [&](float u, float v) {
            B3 r;
            for (int k = 0; k < 3; k++) r.w[k] = (1.0f - u - v) * s.corner[0].w[k] + u * s.corner[1].w[k] + v * s.corner[2].w[k];
            return r;
        };
        auto tri = [&](uint32_t v0, uint32_t v1, uint32_t v2, Vec2 uv0, Vec2 uv1, Vec2 uv2) {
            tris.insert(tris.end(), {v0, v1, v2});
            triFace.push_back(s.face);
            triCorner.push_back(toBary(uv0.x, uv0.y));
            triCorner.push_back(toBary(uv1.x, uv1.y));
            triCorner.push_back(toBary(uv2.x, uv2.y));
        };
        auto along = [&](int k, int n) { return sideVertex(s.side[k], n); };
        auto cornerV = [&](int k) { return along(k, 0); };

        if (M == 1) {
            tri(cornerV(0), cornerV(1), cornerV(2), Vec2(0, 0), Vec2(1, 0), Vec2(0, 1));
            return;
        }
        if (M == 2) {
            int numSplit = 0, s0 = -1;
            for (int k = 0; k < 3; k++) if (T[k] == 2) { numSplit++; if (s0 < 0) s0 = k; }
            if (s0 == 0 && T[2] == 2) s0 = 2;  // two split edges: s0 is the first of the two consecutive ones
            const int s1 = (s0 + 1) % 3, s2 = (s0 + 2) % 3;
            const uint32_t v[3] = {cornerV(0), cornerV(1), cornerV(2)};
            const Vec2 uv[3] = {Vec2(0, 0), Vec2(1, 0), Vec2(0, 1)};
            const Vec2 muv[3] = {Vec2(0.5f, 0), Vec2(0.5f, 0.5f), Vec2(0, 0.5f)};
            uint32_t mv[3];
            for (int k = 0; k < 3; k++) mv[k] = T[k] == 2 ? along(k, 1) : kNone;
            if (numSplit == 3) {
                tri(v[0], mv[0], mv[2], uv[0], muv[0], muv[2]);
                tri(v[1], mv[1], mv[0], uv[1], muv[1], muv[0]);
                tri(v[2], mv[2], mv[1], uv[2], muv[2], muv[1]);
                tri(mv[0], mv[1], mv[2], muv[0], muv[1], muv[2]);
            } else {
                tri(v[s0], mv[s0], v[s2], uv[s0], muv[s0], uv[s2]);
                if (numSplit == 1) {
                    tri(mv[s0], v[s1], v[s2], muv[s0], uv[s1], uv[s2]);
                } else {
                    tri(mv[s0], v[s1], mv[s1], muv[s0], uv[s1], muv[s1]);
                    tri(mv[s0], mv[s1], v[s2], muv[s0], muv[s1], uv[s2]);
                }
            }
            return;
        }

        // inner grid: rows j = 0..innerM, row j holding j + 1 vertices, spacing d in the piece's (u, v)
        const int innerM = M - 2;
        const float d = 1.0f / static_cast<float>(M + 1);
        const uint32_t base = static_cast<uint32_t>(pos_.size());
        const size_t innerCount = static_cast<size_t>(innerM + 1) * (innerM + 2) / 2;
        pos_.resize(base + innerCount);
        vFace_.resize(base + innerCount);
        vBary_.resize(base + innerCount);
        auto inner = [&](int i, int j) { return base + static_cast<uint32_t>(j * (j + 1) / 2 + i); };
        auto setV = [&](uint32_t v, Vec2 uv) {
            const B3 b = toBary(uv.x, uv.y);
            vFace_[v] = s.face;
            vBary_[v] = b;
            pos_[v] = facePoint(s.face, b);
        };
        const Vec2 innerUv(d, d);
        for (int j = 0; j < innerM; j++) {
            for (int i = 0; i < j + 1; i++) {
                const uint32_t v0 = inner(i, j), v1 = inner(i + 1, j + 1), v2 = inner(i, j + 1);
                const Vec2 uv0 = innerUv + Vec2(float(i), float(j - i)) * d;
                const Vec2 uv1 = innerUv + Vec2(float(i + 1), float(j - i)) * d;
                const Vec2 uv2 = innerUv + Vec2(float(i), float(j + 1 - i)) * d;
                setV(v0, uv0);
                if (j == innerM - 1) { setV(v1, uv1); setV(v2, uv2); }
                tri(v0, v1, v2, uv0, uv1, uv2);
                if (i < j) {
                    const uint32_t v3 = inner(i + 1, j);
                    const Vec2 uv3 = innerUv + Vec2(float(i + 1), float(j - i - 1)) * d;
                    setV(v3, uv3);
                    tri(v0, v3, v1, uv0, uv3, uv1);
                }
            }
        }
        auto gridEdge = [&](int k, int n) -> uint32_t {
            if (k == 0) return inner(n, n);
            if (k == 1) return inner(innerM - n, innerM);
            return inner(0, innerM - n);
        };
        // stitch the inner grid's border to each edge, taking the shorter diagonal at every step
        for (int k = 0; k < 3; k++) {
            const int outerT = T[k], innerT = innerM;
            Vec2 innerP, outerP, innerStep, outerStep;
            if (k == 0) {
                innerP = Vec2(d, d); outerP = Vec2(0, 0);
                innerStep = Vec2(d, 0); outerStep = Vec2(1.0f / outerT, 0);
            } else if (k == 1) {
                innerP = Vec2(1.0f - 2.0f * d, d); outerP = Vec2(1, 0);
                innerStep = Vec2(-d, d); outerStep = Vec2(-1.0f / outerT, 1.0f / outerT);
            } else {
                innerP = Vec2(d, 1.0f - 2.0f * d); outerP = Vec2(0, 1);
                innerStep = Vec2(0, -d); outerStep = Vec2(0, -1.0f / outerT);
            }
            for (int i = 0, j = 0; i < innerT || j < outerT;) {
                const uint32_t v0 = gridEdge(k, i), v1 = along(k, j);
                const Vec2 uv0 = innerP, uv1 = outerP;
                bool advanceOuter;
                if (j == outerT) advanceOuter = false;
                else if (i == innerT) advanceOuter = true;
                else {
                    const uint32_t a = along(k, j + 1), b = gridEdge(k, i + 1);
                    advanceOuter = (pos_[v0] - pos_[a]).lengthSq() < (pos_[v1] - pos_[b]).lengthSq();
                }
                uint32_t v2;
                Vec2 uv2;
                if (advanceOuter) { v2 = along(k, ++j); outerP = outerP + outerStep; uv2 = outerP; }
                else { v2 = gridEdge(k, ++i); innerP = innerP + innerStep; uv2 = innerP; }
                tri(v0, v1, v2, uv0, uv1, uv2);
            }
        }
    }

private:
    const Params& P_;
    PixelScale px_;
    std::vector<Vec3>& pos_;
    std::vector<uint32_t>& vFace_;
    std::vector<B3>& vBary_;
    const std::vector<std::array<uint32_t, 3>>& faceCorners_;
    std::vector<Edge> edges_;
    std::unordered_map<uint64_t, uint32_t> edgeOf_;

    Vec3 facePoint(uint32_t f, const B3& b) const {
        const auto& c = faceCorners_[f];
        return pos_[c[0]] * b.w[0] + pos_[c[1]] * b.w[1] + pos_[c[2]] * b.w[2];
    }

    uint32_t newVertex(const Vec3& p, uint32_t face, const B3& b) {
        pos_.push_back(p);
        vFace_.push_back(face);
        vBary_.push_back(b);
        return static_cast<uint32_t>(pos_.size() - 1);
    }

    SideRef side(uint32_t v0, uint32_t v1, int depth) {
        const uint64_t key = v0 < v1 ? (uint64_t(v0) << 32 | v1) : (uint64_t(v1) << 32 | v0);
        auto it = edgeOf_.find(key);
        if (it == edgeOf_.end()) {
            it = edgeOf_.emplace(key, static_cast<uint32_t>(edges_.size())).first;
            edges_.push_back(Edge{v0, v1, depth});
        }
        return SideRef{it->second, edges_[it->second].a != v0};
    }

    uint32_t sideVertex(const SideRef& s, int n) const {
        const Edge& e = edges_[s.edge];
        return e.vertex(s.reversed ? e.T - n : n);
    }

    /** Segment count and world length of the edge p0 -> p1 at subdivision depth `depth`. */
    std::pair<int, float> factor(const Vec3& p0, const Vec3& p1, int depth) const {
        const int steps = std::max(2, P_.testSteps);
        float lsum = 0, lmax = 0, lworld = 0;
        Vec3 last = p0;
        for (int i = 1; i < steps; i++) {
            const Vec3 p = p0 + (p1 - p0) * (i / float(steps - 1));
            float l = (p - last).length();
            lworld += l;
            if (px_.on) l /= px_.at((p + last) * 0.5f);
            lsum += l;
            lmax = std::max(lmax, l);
            last = p;
        }
        const int tmin = static_cast<int>(std::ceil(lsum / P_.dicingRate));
        const int tmax = static_cast<int>(std::ceil((steps - 1) * lmax / P_.dicingRate));
        int t = std::max(tmax, 1);
        if (tmax - tmin > P_.splitThreshold || t > kMaxSegments) t = kNonUniform;
        // an input edge holds at most 2^maxLevel segments: 2^(maxLevel - depth) for a piece `depth` splits down
        const int limit = std::max(1, (1 << std::clamp(P_.maxLevel, 0, 24)) >> std::min(depth, 24));
        if (limit <= 1) t = 1;
        else if (t != kNonUniform) t = std::min(t, limit);
        if (depth >= kMaxDepth - 3 && t == kNonUniform) t = kMaxSegments;
        return {t, lworld};
    }

    /** Measures edge `ei` if new; `ba`, `bb` are its ends' coordinates in face `face`, in the edge's own direction. */
    void measure(uint32_t ei, uint32_t face, const B3& ba, const B3& bb) {
        if (edges_[ei].T != 0) return;
        const auto [t, len] = factor(pos_[edges_[ei].a], pos_[edges_[ei].b], edges_[ei].depth);
        edges_[ei].T = t;
        edges_[ei].length = len;
        if (t > 1) {
            const Vec3 pa = pos_[edges_[ei].a], pb = pos_[edges_[ei].b];
            const uint32_t first = static_cast<uint32_t>(pos_.size());
            for (int n = 1; n < t; n++) {
                const float f = n / float(t);
                newVertex(pa + (pb - pa) * f, face, mix(ba, bb, f));
            }
            edges_[ei].second = first;
        }
    }

    /** Measures a side as the piece walks it (from corner k to corner k + 1). */
    void measureSide(const SideRef& r, uint32_t face, const B3& from, const B3& to) {
        if (r.reversed) measure(r.edge, face, to, from);
        else measure(r.edge, face, from, to);
    }

    void splitTriangle(const SubTri& s, std::vector<SubTri>& final) {
        for (int k = 0; k < 3; k++) measureSide(s.side[k], s.face, s.corner[k], s.corner[(k + 1) % 3]);
        int i0 = -1;
        float best = 0;
        const float bias = 1.00012345f;  // equal edges pick the same one on every platform
        for (int k = 0; k < 3; k++) {
            const Edge& e = edges_[s.side[k].edge];
            if (e.T == kNonUniform && (i0 < 0 || e.length > best)) { i0 = k; best = e.length * bias; }
        }
        if (i0 < 0) { final.push_back(s); return; }
        const int i1 = (i0 + 1) % 3, i2 = (i0 + 2) % 3;
        const SideRef cut = s.side[i0];
        const int depth = edges_[cut.edge].depth;
        const uint32_t start = sideVertex(cut, 0);
        const uint32_t end = edges_[cut.edge].a == start ? edges_[cut.edge].b : edges_[cut.edge].a;
        const B3 bMid = mix(s.corner[i0], s.corner[i1], 0.5f);
        if (edges_[cut.edge].mid == kNone) {
            const uint32_t m = newVertex((pos_[start] + pos_[end]) * 0.5f, s.face, bMid);
            edges_[cut.edge].mid = m;
            measureSide(side(start, m, depth + 1), s.face, s.corner[i0], bMid);
            measureSide(side(m, end, depth + 1), s.face, bMid, s.corner[i1]);
        }
        const uint32_t mid = edges_[cut.edge].mid;
        const uint32_t opp = sideVertex(s.side[i2], 0);

        SubTri a, b;
        a.face = b.face = s.face;
        a.corner[0] = s.corner[i0]; a.corner[1] = bMid; a.corner[2] = s.corner[i2];
        b.corner[0] = bMid; b.corner[1] = s.corner[i1]; b.corner[2] = s.corner[i2];
        a.side[0] = side(start, mid, depth + 1);
        a.side[1] = side(mid, opp, depth + 1);
        a.side[2] = s.side[i2];
        b.side[0] = side(mid, end, depth + 1);
        b.side[1] = s.side[i1];
        b.side[2] = side(opp, mid, depth + 1);
        splitTriangle(a, final);
        splitTriangle(b, final);
    }
};

}  // namespace detail

/**
 * Tessellates `in` adaptively (see the file comment) and displaces it by `height`. A null `height` tessellates only.
 */
inline Result diceAndDisplace(const ScratchboxMesh& in, const Params& P, const HeightFn& height) {
    using clock = std::chrono::steady_clock;
    using detail::B3;
    const auto t0 = clock::now();
    Result R;
    R.mesh.name = in.name + "_adaptive";
    R.mesh.material = in.material;
    R.mesh.hasUv1 = in.hasUv1;
    const size_t triCount = in.indices.size() / 3;
    R.stats.inputTriangles = triCount;
    if (triCount == 0 || in.vertices.empty()) { R.ok = true; return R; }
    if (!(P.dicingRate > 0.0f)) { R.error = "dicingRate must be positive"; return R; }

    // 1. weld by position into the control mesh; a control vertex's normal is the mean of its input normals
    const double q = 1.0 / std::max(1e-9f, P.weldMeters);
    struct QHash {
        size_t operator()(const std::array<int64_t, 3>& k) const {
            uint64_t h = 1469598103934665603ull;
            for (const int64_t v : k) { h ^= static_cast<uint64_t>(v); h *= 1099511628211ull; }
            return static_cast<size_t>(h);
        }
    };
    std::unordered_map<std::array<int64_t, 3>, uint32_t, QHash> weld;
    std::vector<uint32_t> controlOf(in.vertices.size());
    std::vector<Vec3> pos;
    for (size_t i = 0; i < in.vertices.size(); i++) {
        const Vec3& p = in.vertices[i].position;
        const std::array<int64_t, 3> k{std::llround(p.x * q), std::llround(p.y * q), std::llround(p.z * q)};
        auto it = weld.emplace(k, static_cast<uint32_t>(pos.size())).first;
        if (it->second == pos.size()) pos.push_back(p);
        controlOf[i] = it->second;
    }
    const size_t nControl = pos.size();
    std::vector<Vec3> ctrlN(nControl, Vec3(0, 0, 0));
    std::vector<std::array<uint32_t, 3>> faces;
    std::vector<uint32_t> faceTri;
    faces.reserve(triCount);
    faceTri.reserve(triCount);
    for (size_t t = 0; t < triCount; t++) {
        const uint32_t a = in.indices[t * 3], b = in.indices[t * 3 + 1], c = in.indices[t * 3 + 2];
        if (a >= in.vertices.size() || b >= in.vertices.size() || c >= in.vertices.size()) { R.stats.skippedDegenerate++; continue; }
        const uint32_t ca = controlOf[a], cb = controlOf[b], cc = controlOf[c];
        if (ca == cb || cb == cc || ca == cc) { R.stats.skippedDegenerate++; continue; }
        faces.push_back({ca, cb, cc});
        faceTri.push_back(static_cast<uint32_t>(t));
        for (const uint32_t v : {a, b, c}) ctrlN[controlOf[v]] += in.vertices[v].normal;
    }
    R.stats.controlVertices = nControl;
    for (auto& n : ctrlN) n = n.lengthSq() > 1e-20f ? n.normalized() : Vec3(0, 1, 0);
    if (faces.empty()) { R.ok = true; return R; }

    // 2. split
    std::vector<uint32_t> vFace(nControl, detail::kNone);
    std::vector<B3> vBary(nControl);
    for (size_t f = 0; f < faces.size(); f++) {
        for (int k = 0; k < 3; k++) {
            if (vFace[faces[f][k]] != detail::kNone) continue;
            vFace[faces[f][k]] = static_cast<uint32_t>(f);
            vBary[faces[f][k]].w[k] = 1.0f;
        }
    }
    detail::Tessellator tess(P, pos, vFace, vBary, faces);
    std::vector<detail::SubTri> pieces;
    pieces.reserve(faces.size() * 4);
    for (size_t f = 0; f < faces.size(); f++) tess.splitFace(static_cast<uint32_t>(f), pieces);
    const auto t1 = clock::now();
    R.stats.msSplit = std::chrono::duration<double, std::milli>(t1 - t0).count();
    R.stats.patches = pieces.size();
    size_t nT = 0;
    for (const auto& s : pieces) nT += tess.triangleCount(s);
    if (P.maxTriangles > 0 && nT > P.maxTriangles) {
        R.error = "the split asks for " + std::to_string(nT) + " triangles, over the limit of " + std::to_string(P.maxTriangles);
        return R;
    }

    // 3. dice
    std::vector<uint32_t> tris, triFace;
    std::vector<B3> triCorner;
    tris.reserve(nT * 3);
    triFace.reserve(nT);
    triCorner.reserve(nT * 3);
    for (const auto& s : pieces) tess.dice(s, tris, triFace, triCorner);
    const size_t nV = pos.size();
    const auto t2 = clock::now();
    R.stats.msDice = std::chrono::duration<double, std::milli>(t2 - t1).count();
    if (tris.size() != nT * 3) { R.error = "dicing made " + std::to_string(tris.size() / 3) + " triangles, not " + std::to_string(nT); return R; }

    // 4. displace each vertex once, along its face's interpolated smooth normal, at its UV
    auto cornerVertex = [&](uint32_t face, int k) -> const Vertex& { return in.vertices[in.indices[static_cast<size_t>(faceTri[face]) * 3 + k]]; };
    std::vector<Vec3> dP(nV);
    auto displaceRange = [&](size_t begin, size_t end) {
        for (size_t v = begin; v < end; v++) {
            const uint32_t f = vFace[v];
            const B3& w = vBary[v];
            const auto& fc = faces[f];
            Vec3 n = ctrlN[fc[0]] * w.w[0] + ctrlN[fc[1]] * w.w[1] + ctrlN[fc[2]] * w.w[2];
            n = n.lengthSq() > 1e-20f ? n.normalized() : Vec3(0, 1, 0);
            Vec3 p = pos[v];
            if (height) {
                const Vec2 uv = cornerVertex(f, 0).uv * w.w[0] + cornerVertex(f, 1).uv * w.w[1] + cornerVertex(f, 2).uv * w.w[2];
                const float h = height(uv, p, n, faceTri[f]);
                if (std::isfinite(h)) p = p + n * h;
            }
            dP[v] = p;
        }
    };
    {
        const size_t workers = std::max<size_t>(1, std::min<size_t>(16, std::thread::hardware_concurrency()));
        if (workers == 1 || nV < 8192) {
            displaceRange(0, nV);
        } else {
            const size_t per = (nV + workers - 1) / workers;
            std::vector<std::thread> pool;
            for (size_t w = 0; w < workers; w++) {
                const size_t b = w * per, e = std::min(nV, b + per);
                if (b < e) pool.emplace_back(displaceRange, b, e);
            }
            for (auto& th : pool) th.join();
        }
    }
    const auto t3 = clock::now();
    R.stats.msDisplace = std::chrono::duration<double, std::milli>(t3 - t2).count();

    // 5. output: one vertex per (diced vertex, corner UV and input normal); each diced vertex keeps a short chain of the
    //    output vertices made from it, and those sharing an input normal share a smoothing group
    std::vector<uint32_t> firstOut(nV, detail::kNone), nextOut, outGroup;
    struct OKey { int32_t u0, u1, n0, n1, n2; };
    std::vector<OKey> outKey;
    uint32_t groups = 0;
    nextOut.reserve(nV + nV / 8);
    outKey.reserve(nV + nV / 8);
    outGroup.reserve(nV + nV / 8);
    R.mesh.vertices.reserve(nV + nV / 8);
    R.mesh.indices.resize(nT * 3);
    R.triangleSource.resize(nT);
    auto qn = [](float x) { return static_cast<int32_t>(std::lround(x * 1000.0f)); };
    auto qu = [](float x) { return static_cast<int32_t>(std::lround(x * 1048576.0f)); };
    for (size_t t = 0; t < nT; t++) {
        const uint32_t f = triFace[t];
        R.triangleSource[t] = faceTri[f];
        const Vertex* c[3] = {&cornerVertex(f, 0), &cornerVertex(f, 1), &cornerVertex(f, 2)};
        for (int k = 0; k < 3; k++) {
            const uint32_t dv = tris[t * 3 + k];
            const B3& w = triCorner[t * 3 + k];
            const Vec2 uv = c[0]->uv * w.w[0] + c[1]->uv * w.w[1] + c[2]->uv * w.w[2];
            Vec3 n = c[0]->normal * w.w[0] + c[1]->normal * w.w[1] + c[2]->normal * w.w[2];
            n = n.lengthSq() > 1e-20f ? n.normalized() : Vec3(0, 1, 0);
            const OKey key{qu(uv.x), qu(uv.y), qn(n.x), qn(n.y), qn(n.z)};
            uint32_t found = detail::kNone, group = detail::kNone;
            for (uint32_t o = firstOut[dv]; o != detail::kNone; o = nextOut[o]) {
                const OKey& k2 = outKey[o];
                if (k2.n0 == key.n0 && k2.n1 == key.n1 && k2.n2 == key.n2) {
                    group = outGroup[o];
                    if (k2.u0 == key.u0 && k2.u1 == key.u1) { found = o; break; }
                }
            }
            if (found == detail::kNone) {
                found = static_cast<uint32_t>(R.mesh.vertices.size());
                Vertex o;
                o.position = dP[dv];
                o.uv = uv;
                o.uv1 = c[0]->uv1 * w.w[0] + c[1]->uv1 * w.w[1] + c[2]->uv1 * w.w[2];
                o.color = c[0]->color * w.w[0] + c[1]->color * w.w[1] + c[2]->color * w.w[2];
                o.tangent = c[0]->tangent * w.w[0] + c[1]->tangent * w.w[1] + c[2]->tangent * w.w[2];
                o.normal = n;
                R.mesh.vertices.push_back(o);
                outKey.push_back(key);
                outGroup.push_back(group != detail::kNone ? group : groups++);
                nextOut.push_back(firstOut[dv]);
                firstOut[dv] = found;
            }
            R.mesh.indices[t * 3 + k] = found;
        }
    }
    R.stats.msOutput = std::chrono::duration<double, std::milli>(clock::now() - t3).count();
    if (P.recomputeNormals) {
        std::vector<Vec3> acc(groups, Vec3(0, 0, 0));
        for (size_t t = 0; t < nT; t++) {
            const uint32_t a = R.mesh.indices[t * 3], b = R.mesh.indices[t * 3 + 1], c = R.mesh.indices[t * 3 + 2];
            const Vec3 fn = (R.mesh.vertices[b].position - R.mesh.vertices[a].position).cross(R.mesh.vertices[c].position - R.mesh.vertices[a].position);
            for (const uint32_t v : {a, b, c}) acc[outGroup[v]] += fn;
        }
        for (size_t v = 0; v < R.mesh.vertices.size(); v++) {
            const Vec3& n = acc[outGroup[v]];
            if (n.lengthSq() > 1e-24f) R.mesh.vertices[v].normal = n.normalized();
        }
    }
    R.mesh.recomputeBounds();
    R.stats.dicedVertices = nV;
    R.stats.triangles = nT;
    R.stats.msTotal = std::chrono::duration<double, std::milli>(clock::now() - t0).count();
    R.ok = true;
    return R;
}

/**
 * The same on flat arrays (3 floats a position and normal, 2 a UV, 3 indices a triangle), for callers that keep their
 * meshes as buffers (scratchbox_height_displace.hpp's Mesh has this layout). `triangleSource` maps output to input.
 */
struct FlatMesh {
    std::vector<float> pos, nrm, uv;
    std::vector<uint32_t> idx;
    std::vector<uint32_t> triangleSource;
};
inline FlatMesh diceAndDisplaceFlat(const FlatMesh& in, const Params& P, const HeightFn& height, Stats* stats = nullptr, std::string* error = nullptr) {
    ScratchboxMesh m;
    const size_t n = in.pos.size() / 3;
    m.vertices.resize(n);
    for (size_t i = 0; i < n; i++) {
        m.vertices[i].position = Vec3(in.pos[i * 3], in.pos[i * 3 + 1], in.pos[i * 3 + 2]);
        if (in.nrm.size() >= (i + 1) * 3) m.vertices[i].normal = Vec3(in.nrm[i * 3], in.nrm[i * 3 + 1], in.nrm[i * 3 + 2]);
        if (in.uv.size() >= (i + 1) * 2) m.vertices[i].uv = Vec2(in.uv[i * 2], in.uv[i * 2 + 1]);
    }
    m.indices = in.idx;
    Result r = diceAndDisplace(m, P, height);
    FlatMesh out;
    if (stats) *stats = r.stats;
    if (error) *error = r.error;
    if (!r.ok) return out;
    out.pos.reserve(r.mesh.vertices.size() * 3);
    for (const Vertex& v : r.mesh.vertices) {
        out.pos.insert(out.pos.end(), {v.position.x, v.position.y, v.position.z});
        out.nrm.insert(out.nrm.end(), {v.normal.x, v.normal.y, v.normal.z});
        out.uv.insert(out.uv.end(), {v.uv.x, v.uv.y});
    }
    out.idx = std::move(r.mesh.indices);
    out.triangleSource = std::move(r.triangleSource);
    return out;
}

}  // namespace adaptive_subd
}  // namespace scratchbox

#endif  // SCRATCHBOX_ADAPTIVE_SUBD_HPP
