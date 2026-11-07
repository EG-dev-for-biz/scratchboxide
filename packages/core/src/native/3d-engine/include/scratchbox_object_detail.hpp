/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

// Per-part weathering and decals for a generated object (object_detail_pass, object-detail-pass.ts).
//
// Input: the object after the UV rewrap gave every material its own atlas (UvAtlasRewrap.ts 'rewrap'): per atlas its
// size, its base colour and metallic-roughness (the material's rebaked images, else its factors), and the surfaces
// drawn with it (object space, atlas UVs in texels, the part each belongs to). Output: per atlas the same two maps
// with wear composited, every texel starting from its own part's material, so nothing is ever averaged across parts
// or materials. The geometry is read, never changed.
//
// Masks, each continuous in 0..1 and read from the geometry alone:
//   edge wear - convexity: the dihedral angles of the part's own convex edges integrated over a ball of radius
//               edgeWidthM around the texel (angle x chord inside the ball / (2 r), over a right angle). A sharp edge
//               reads 1 on it and falls to 0 at r; a fillet or rod of radius R reads about r / R (worn from about
//               R < 1.5 r, a thin rod all round); and the measure does not
//               depend on how finely the surface is tessellated (per-vertex curvature, as in scratchbox_halfedge.hpp,
//               spreads over whole triangles, so on a low-poly part every face would wear);
//   grime     - cavity: cosine-weighted hemisphere rays against every part, and the ground the object stands on,
//               hitting within aoRadiusM; the part's concave creases (the same measure over its concave edges, radius
//               creaseWidthM); and shelter from the sky;
//   streaks   - run-off below whatever overhangs a steep face within streakReachM, fading with the drop, stronger and
//               longer the further the overhang stands out (a bolt head a tick, a ledge a long run), in vertical columns
//               streakColumnM wide;
//   dust      - up-facing surfaces open to the sky straight above, less on edges rubbed clean;
//   sun fade  - exposure: the share of the sky the texel sees, weighted towards the zenith.
// Mesh-measured maps (scratchbox_mesh_maps.hpp) steer the same layers: the part's mean curvature at curvatureRadiusM
// adds to convexity where the part bulges (a rounded knob or rim wears though no single edge is sharp), cavity at
// cavityRadiusM (over every part, so the crease where two parts meet counts) adds to grime, and the inward thickness
// lightens what is thinner than thinM where the material is not metal (light passes through it).
// Decals are projector boxes on named parts: a texel of such a part that faces the decal and is the part's frontmost
// surface along it takes the decal's colour (and, by finishMix, its roughness and metalness), under the wear, so worn
// edges show the part beneath. Every strength, width and colour is a number; zero turns a layer off.

#pragma once

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_bvh.hpp"
#include "scratchbox_uv_rewrap.hpp"
#include "scratchbox_mesh_maps.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <functional>
#include <limits>
#include <thread>
#include <unordered_map>
#include <vector>

namespace scratchbox::object_detail {

using math::Vec3;

struct WearParams {
    // strengths, 0..1 (0 turns the layer off)
    float edgeWear = 0.6f, grime = 0.5f, streaks = 0.3f, dust = 0.25f, sunFade = 0.15f;
    float variation = 0.35f;            // large-scale patchiness of every layer
    // scales, metres
    float edgeWidthM = 0.01f, creaseWidthM = 0.02f, aoRadiusM = 0.1f, streakReachM = 0.3f, streakColumnM = 0.01f;
    float patchScaleM = 0.2f, chipScaleM = 0.006f;
    float chipNoise = 0.5f;             // raggedness of the worn edge's border, 0..1
    float openEdgeAngle = 0.9f;         // radians credited to an edge only one triangle has (a sheet's free edge)
    // mesh-measured maps (scratchbox_mesh_maps.hpp): their scales (metres) and how much each steers its layer (0 off)
    float curvatureRadiusM = 0.04f, cavityRadiusM = 0.02f, thinM = 0.01f;
    float curvatureWear = 0.6f, cavityGrime = 0.6f, thinLight = 0.25f;
    int thicknessSamples = 8;
    // the layers' own finish (linear RGB)
    Vec3 grimeColor{0.045f, 0.038f, 0.030f};
    Vec3 streakColor{0.060f, 0.050f, 0.040f};
    Vec3 dustColor{0.420f, 0.390f, 0.340f};
    float grimeRoughness = 0.85f, streakRoughness = 0.75f, dustRoughness = 0.95f;
    int aoSamples = 16;
    bool ground = true;                 // the object stands on the plane y = groundY, which occludes like a surface
    float groundY = 0.0f;
    float weldM = 1e-5f;                // positions this close are one vertex when the part's edges are read
    float rayEpsM = 1e-4f;              // rays leave the surface this far along its normal
    uint32_t seed = 7;
};

/** One part's share of the wear: multipliers on the strengths, and the finish its worn edges show. */
struct PartWear {
    float edgeWear = 1, grime = 1, streaks = 1, dust = 1, sunFade = 1;
    bool hasEdgeColor = false;
    Vec3 edgeColor{0, 0, 0};            // linear RGB; absent: the part's own colour, lightened
    float edgeRoughness = -1;           // < 0: the part's own, polished
    float edgeMetalness = -1;           // < 0: the part's own
};

struct AtlasInput {
    uint32_t width = 0, height = 0, gutter = 4;
    std::vector<uint8_t> base;          // RGBA8 sRGB, the material's rebaked base colour image (empty: factor only)
    std::vector<uint8_t> mr;            // RGBA8 linear, G roughness, B metalness (empty: factors only)
    float baseFactor[4] = {1, 1, 1, 1}; // linear
    float roughness = 1, metalness = 1; // factors
    float transmission = 0;             // a see-through surface wears no edges and does not fade
    float texelM = 0.001f;              // metres per texel
};

/** A primitive drawn with one atlas: object-space triangles of one part. */
struct Surface {
    uint32_t atlas = 0, part = 0;
    std::vector<float> pos, nrm, uvPx;  // 3, 3 (may be empty), 2 per vertex
    std::vector<uint32_t> idx;
};

struct Decal {
    std::vector<uint32_t> parts;
    Vec3 center{0, 0, 0}, normal{0, 0, 1}, up{0, 1, 0};
    float widthM = 1, heightM = 1, depthM = 1, opacity = 1, maxAngleDeg = 80;
    float roughness = 0.5f, metalness = 0, finishMix = 0;
    uint32_t width = 0, height = 0;
    std::vector<uint8_t> rgba;          // straight alpha, sRGB colour; row 0 is the image's top
};

struct DetailInput {
    WearParams wear;
    std::vector<AtlasInput> atlases;
    std::vector<PartWear> parts;
    std::vector<Surface> surfaces;
    std::vector<float> occluders;       // 9 per triangle: every surface of the object, drawn or not
    std::vector<Decal> decals;
    bool wantMasks = false;
    uint32_t threads = 0;
};

struct MaskStats {
    double texels = 0, edge = 0, grime = 0, streak = 0, dust = 0, exposure = 0, decal = 0, cavity = 0, thin = 0;
    void add(const MaskStats& o) { texels += o.texels; edge += o.edge; grime += o.grime; streak += o.streak; dust += o.dust; exposure += o.exposure; decal += o.decal; cavity += o.cavity; thin += o.thin; }
};

struct AtlasOutput {
    uint32_t width = 0, height = 0;
    std::vector<uint8_t> base, mr;      // RGBA8: sRGB colour (alpha kept), and R 255 / G roughness / B metalness
    std::vector<uint8_t> masksA, masksB;// wantMasks: R edge, G grime, B streak, A dust; R exposure, G decal, B occlusion, A convexity
    std::vector<uint8_t> maps;          // wantMasks: the mesh-measured maps, R curvature (0.5 + 0.5 H r), G cavity, B thickness / (2 thinM), A ao
    MaskStats stats;                    // sums over the atlas's texels (masks before strengths)
};

struct DetailOutput {
    std::vector<AtlasOutput> atlases;
    std::vector<MaskStats> parts;
    std::vector<uint64_t> decalTexels;
    uint32_t convexEdges = 0, concaveEdges = 0, openEdges = 0;
    double msEdges = 0, msBvh = 0, msMasks = 0, msComposite = 0, msDilate = 0;
    float curvatureRadiusM = 0, cavityRadiusM = 0;   // as read (larger than asked when the point budget forced it)
};

namespace detail {

inline uint32_t hashU(uint32_t x) {
    x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16;
    return x;
}

inline float hash3f(int x, int y, int z, uint32_t seed) {
    const uint32_t h = hashU(static_cast<uint32_t>(x) * 73856093u ^ static_cast<uint32_t>(y) * 19349663u ^ static_cast<uint32_t>(z) * 83492791u ^ seed * 2654435761u);
    return static_cast<float>(h & 0xffffffu) / static_cast<float>(0xffffff);
}

/** Smooth value noise in [-1, 1] at world scale `cell` metres. */
inline float noise3(const Vec3& p, float cell, uint32_t seed) {
    const float x = p.x / cell, y = p.y / cell, z = p.z / cell;
    const int xi = static_cast<int>(std::floor(x)), yi = static_cast<int>(std::floor(y)), zi = static_cast<int>(std::floor(z));
    float fx = x - xi, fy = y - yi, fz = z - zi;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
    auto h = [&](int a, int b, int c) { return hash3f(xi + a, yi + b, zi + c, seed); };
    const float x00 = h(0, 0, 0) + (h(1, 0, 0) - h(0, 0, 0)) * fx, x10 = h(0, 1, 0) + (h(1, 1, 0) - h(0, 1, 0)) * fx;
    const float x01 = h(0, 0, 1) + (h(1, 0, 1) - h(0, 0, 1)) * fx, x11 = h(0, 1, 1) + (h(1, 1, 1) - h(0, 1, 1)) * fx;
    const float y0 = x00 + (x10 - x00) * fy, y1 = x01 + (x11 - x01) * fy;
    return (y0 + (y1 - y0) * fz) * 2.0f - 1.0f;
}

/** Two octaves of noise3, in about [-1, 1]. */
inline float fbm(const Vec3& p, float cell, uint32_t seed) {
    return 0.65f * noise3(p, cell, seed) + 0.35f * noise3(p, cell * 0.43f, seed + 101);
}

inline float smoothstep(float e0, float e1, float x) {
    const float t = std::clamp((x - e0) / std::max(1e-6f, e1 - e0), 0.0f, 1.0f);
    return t * t * (3 - 2 * t);
}

inline float mixf(float a, float b, float t) { return a + (b - a) * t; }
inline Vec3 mixv(const Vec3& a, const Vec3& b, float t) { return a + (b - a) * t; }

inline float srgbToLinear(float c) { return c <= 0.04045f ? c / 12.92f : std::pow((c + 0.055f) / 1.055f, 2.4f); }
inline float linearToSrgb(float c) { c = std::clamp(c, 0.0f, 1.0f); return c <= 0.0031308f ? 12.92f * c : 1.055f * std::pow(c, 1.0f / 2.4f) - 0.055f; }
inline uint8_t toByte(float v) { return static_cast<uint8_t>(std::lround(std::clamp(v, 0.0f, 1.0f) * 255.0f)); }

/** Length of segment a-b inside the ball of radius r around p. */
inline float chordInBall(const Vec3& p, const Vec3& a, const Vec3& b, float r) {
    const Vec3 ab = b - a;
    const float L = ab.length();
    if (L < 1e-12f) return 0.0f;
    const Vec3 u = ab * (1.0f / L);
    const Vec3 ap = p - a;
    const float t = ap.dot(u);
    const float d2 = ap.lengthSq() - t * t;
    if (d2 >= r * r) return 0.0f;
    const float h = std::sqrt(std::max(0.0f, r * r - d2));
    return std::max(0.0f, std::min(L, t + h) - std::max(0.0f, t - h));
}

struct FeatureEdge { Vec3 a, b; float angle; uint32_t part; };  // angle > 0 convex, < 0 concave (radians)

struct WeldKey {
    int64_t x, y, z; uint32_t part;
    bool operator==(const WeldKey& o) const { return x == o.x && y == o.y && z == o.z && part == o.part; }
};
struct WeldKeyHash {
    size_t operator()(const WeldKey& k) const {
        uint64_t h = static_cast<uint64_t>(k.x) * 0x9E3779B97F4A7C15ull;
        h ^= static_cast<uint64_t>(k.y) * 0xC2B2AE3D27D4EB4Full + (h << 6) + (h >> 2);
        h ^= static_cast<uint64_t>(k.z) * 0x165667B19E3779F9ull + (h << 6) + (h >> 2);
        h ^= static_cast<uint64_t>(k.part) * 0x27D4EB2F165667C5ull;
        return static_cast<size_t>(h);
    }
};

/**
 * The parts' feature edges: positions welded per part (a part's surfaces are triangle soup split at hard edges), then
 * every edge two triangles share keeps their signed dihedral angle (convex when the second triangle's far corner lies
 * below the first's plane), an edge only one triangle has is credited `openAngle` as convex, and an edge of three or
 * more is left out. Edges flatter than 0.2 degrees are dropped (they add nothing).
 */
inline std::vector<FeatureEdge> featureEdges(const std::vector<Surface>& surfaces, float weldM, float openAngle, uint32_t& convex, uint32_t& concave, uint32_t& open) {
    const double q = std::max(1e-9, double(weldM));
    std::unordered_map<WeldKey, uint32_t, WeldKeyHash> welded;
    std::vector<Vec3> wpos;
    struct Tri { uint32_t w[3]; Vec3 n; uint32_t part; };
    std::vector<Tri> tris;
    for (const Surface& s : surfaces) {
        const size_t V = s.pos.size() / 3;
        std::vector<uint32_t> map(V);
        for (size_t v = 0; v < V; ++v) {
            const WeldKey k{std::llround(s.pos[v * 3] / q), std::llround(s.pos[v * 3 + 1] / q), std::llround(s.pos[v * 3 + 2] / q), s.part};
            auto it = welded.find(k);
            if (it == welded.end()) {
                it = welded.emplace(k, static_cast<uint32_t>(wpos.size())).first;
                wpos.emplace_back(s.pos[v * 3], s.pos[v * 3 + 1], s.pos[v * 3 + 2]);
            }
            map[v] = it->second;
        }
        for (size_t t = 0; t + 2 < s.idx.size(); t += 3) {
            Tri tr;
            for (int k = 0; k < 3; ++k) tr.w[k] = map[s.idx[t + k]];
            if (tr.w[0] == tr.w[1] || tr.w[1] == tr.w[2] || tr.w[0] == tr.w[2]) continue;
            const Vec3 n = (wpos[tr.w[1]] - wpos[tr.w[0]]).cross(wpos[tr.w[2]] - wpos[tr.w[0]]);
            const float l = n.length();
            if (l < 1e-20f) continue;
            tr.n = n * (1.0f / l);
            tr.part = s.part;
            tris.push_back(tr);
        }
    }
    struct EdgeUse { uint32_t tri[2]; uint8_t corner[2]; bool forward[2]; uint32_t count = 0; };
    std::unordered_map<uint64_t, EdgeUse> edges;
    edges.reserve(tris.size() * 2);
    for (uint32_t t = 0; t < tris.size(); ++t) {
        for (int k = 0; k < 3; ++k) {
            const uint32_t a = tris[t].w[k], b = tris[t].w[(k + 1) % 3];
            const uint64_t key = (uint64_t(std::min(a, b)) << 32) | std::max(a, b);
            EdgeUse& e = edges[key];
            if (e.count < 2) { e.tri[e.count] = t; e.corner[e.count] = static_cast<uint8_t>((k + 2) % 3); e.forward[e.count] = a < b; }
            ++e.count;
        }
    }
    std::vector<FeatureEdge> out;
    const float minAngle = 0.2f * math::PI / 180.0f;
    for (const auto& [key, e] : edges) {
        const uint32_t a = static_cast<uint32_t>(key >> 32), b = static_cast<uint32_t>(key & 0xffffffffu);
        if (e.count == 1) {
            if (openAngle > 0) { out.push_back({wpos[a], wpos[b], openAngle, tris[e.tri[0]].part}); ++open; }
            continue;
        }
        if (e.count != 2) continue;
        const Tri& t1 = tris[e.tri[0]];
        const Tri& t2 = tris[e.tri[1]];
        // consistently wound neighbours run their shared edge in opposite directions; otherwise one is flipped
        const Vec3 n2 = e.forward[0] != e.forward[1] ? t2.n : t2.n * -1.0f;
        const float angle = std::acos(std::clamp(t1.n.dot(n2), -1.0f, 1.0f));
        if (angle < minAngle) continue;
        const Vec3 far2 = wpos[t2.w[e.corner[1]]];
        const bool isConvex = (far2 - wpos[a]).dot(t1.n) < 0.0f;
        out.push_back({wpos[a], wpos[b], isConvex ? angle : -angle, t1.part});
        if (isConvex) ++convex; else ++concave;
    }
    return out;
}

/**
 * Feature edges by grid cell: every edge is sampled every reach / 2 and filed under the 27 cells around each sample
 * (cells 1.25 x reach), so the one cell holding a point lists every edge passing within reach of it.
 */
struct EdgeGrid {
    float cell = 1;
    std::unordered_map<uint64_t, std::vector<uint32_t>> cells;
    static uint64_t key(int64_t x, int64_t y, int64_t z) {
        return (uint64_t(x & 0x1fffff) << 42) | (uint64_t(y & 0x1fffff) << 21) | uint64_t(z & 0x1fffff);
    }
    void build(const std::vector<FeatureEdge>& edges, float reach) {
        cell = std::max(1e-6f, reach * 1.25f);
        const float step = std::max(1e-6f, reach * 0.5f);
        for (uint32_t e = 0; e < edges.size(); ++e) {
            const Vec3 ab = edges[e].b - edges[e].a;
            const int n = std::max(1, static_cast<int>(std::ceil(ab.length() / step)));
            for (int i = 0; i <= n; ++i) {
                const Vec3 s = edges[e].a + ab * (float(i) / n);
                const int64_t cx = static_cast<int64_t>(std::floor(s.x / cell)), cy = static_cast<int64_t>(std::floor(s.y / cell)), cz = static_cast<int64_t>(std::floor(s.z / cell));
                for (int dz = -1; dz <= 1; ++dz) for (int dy = -1; dy <= 1; ++dy) for (int dx = -1; dx <= 1; ++dx) {
                    auto& list = cells[key(cx + dx, cy + dy, cz + dz)];
                    if (list.empty() || list.back() != e) list.push_back(e);
                }
            }
        }
    }
    const std::vector<uint32_t>* at(const Vec3& p) const {
        auto it = cells.find(key(static_cast<int64_t>(std::floor(p.x / cell)), static_cast<int64_t>(std::floor(p.y / cell)), static_cast<int64_t>(std::floor(p.z / cell))));
        return it == cells.end() ? nullptr : &it->second;
    }
};

/** Builds a BVH mesh from a triangle soup (9 floats per triangle). */
inline geometry::ScratchboxMesh soupMesh(const std::vector<float>& soup, const char* name) {
    geometry::ScratchboxMesh m(name);
    const size_t T = soup.size() / 9;
    m.vertices.reserve(T * 3);
    m.indices.reserve(T * 3);
    for (size_t t = 0; t < T; ++t) {
        const Vec3 a(soup[t * 9], soup[t * 9 + 1], soup[t * 9 + 2]), b(soup[t * 9 + 3], soup[t * 9 + 4], soup[t * 9 + 5]), c(soup[t * 9 + 6], soup[t * 9 + 7], soup[t * 9 + 8]);
        Vec3 n = (b - a).cross(c - a);
        n = n.length() > 1e-20f ? n.normalized() : Vec3(0, 1, 0);
        const uint32_t base = static_cast<uint32_t>(m.vertices.size());
        m.addVertex(geometry::Vertex(a, n));
        m.addVertex(geometry::Vertex(b, n));
        m.addVertex(geometry::Vertex(c, n));
        m.addTriangle(base, base + 1, base + 2);
    }
    return m;
}

inline void decalFrame(const Vec3& normal, const Vec3& up, Vec3& N, Vec3& R, Vec3& U) {
    N = normal.normalized();
    Vec3 u = up;
    if (u.cross(N).length() < 1e-4f * std::max(1e-6f, u.length())) u = std::abs(N.y) > 0.9f ? Vec3(0, 0, -1) : Vec3(0, 1, 0);
    R = u.cross(N).normalized();
    U = N.cross(R);
}

inline void sampleImage(const std::vector<uint8_t>& rgba, uint32_t w, uint32_t h, float u, float v, float out[4]) {
    const float x = std::clamp(u, 0.0f, 1.0f) * (w - 1), y = std::clamp(v, 0.0f, 1.0f) * (h - 1);
    const uint32_t x0 = static_cast<uint32_t>(x), y0 = static_cast<uint32_t>(y);
    const uint32_t x1 = std::min(x0 + 1, w - 1), y1 = std::min(y0 + 1, h - 1);
    const float fx = x - x0, fy = y - y0;
    for (int k = 0; k < 4; ++k) {
        auto px = [&](uint32_t xx, uint32_t yy) { return rgba[(size_t(yy) * w + xx) * 4 + k] / 255.0f; };
        const float top = px(x0, y0) * (1 - fx) + px(x1, y0) * fx, bottom = px(x0, y1) * (1 - fx) + px(x1, y1) * fx;
        out[k] = top * (1 - fy) + bottom * fy;
    }
}

}  // namespace detail

inline DetailOutput bake(const DetailInput& in) {
    using clock = std::chrono::steady_clock;
    using namespace detail;
    const WearParams& P = in.wear;
    DetailOutput out;
    out.parts.assign(in.parts.size(), MaskStats{});
    out.decalTexels.assign(in.decals.size(), 0);
    const uint32_t threads = std::max(1u, in.threads ? in.threads : std::min(16u, std::max(1u, std::thread::hardware_concurrency())));

    // feature edges of every part, convex and concave apart, each part's in grids of its own (a texel only ever reads
    // its own part's edges, at each kind's reach)
    auto t0 = clock::now();
    const float edgeR = std::max(1e-5f, P.edgeWidthM), creaseR = std::max(1e-5f, P.creaseWidthM);
    const std::vector<FeatureEdge> edges = featureEdges(in.surfaces, P.weldM, P.openEdgeAngle, out.convexEdges, out.concaveEdges, out.openEdges);
    std::vector<std::vector<FeatureEdge>> convexOf(in.parts.size()), concaveOf(in.parts.size());
    for (const FeatureEdge& e : edges) if (e.part < in.parts.size()) (e.angle > 0 ? convexOf : concaveOf)[e.part].push_back(e);
    std::vector<EdgeGrid> convexGrid(in.parts.size()), concaveGrid(in.parts.size());
    for (size_t p = 0; p < in.parts.size(); ++p) { convexGrid[p].build(convexOf[p], edgeR); concaveGrid[p].build(concaveOf[p], creaseR); }
    out.msEdges = std::chrono::duration<double, std::milli>(clock::now() - t0).count();

    // occluders: every surface of the object (rays and cavity read them; curvature reads each part's own surfaces);
    // per decal, the parts it lies on (its frontmost-surface test)
    t0 = clock::now();
    const float thicknessCap = 2.0f * std::max(1e-5f, P.thinM);
    mesh_maps::MeshMaps maps;
    {
        mesh_maps::Params mp;
        mp.curvatureRadiusM = std::max(1e-5f, P.curvatureRadiusM);
        mp.cavityRadiusM = std::max(1e-5f, P.cavityRadiusM);
        mp.aoRadiusM = std::max(1e-5f, P.aoRadiusM);
        mp.aoSamples = 0;                 // the occlusion below is read with the sky in the same rays
        mp.thicknessMaxM = thicknessCap;
        mp.thicknessSamples = P.thinLight > 0 ? std::max(0, P.thicknessSamples) : 0;
        mp.rayEpsM = P.rayEpsM;
        mp.maxSamples = 3000000;
        mp.seed = P.seed;
        std::vector<float> grouped;
        std::vector<uint32_t> groups;
        for (const Surface& s : in.surfaces) {
            for (size_t t = 0; t + 2 < s.idx.size(); t += 3) {
                for (int k = 0; k < 3; ++k) for (int c = 0; c < 3; ++c) grouped.push_back(s.pos[s.idx[t + k] * 3 + c]);
                groups.push_back(s.part);
            }
        }
        maps.build(in.occluders, grouped, groups, mp);
        out.curvatureRadiusM = maps.curvatureRadius();
        out.cavityRadiusM = maps.cavityRadius();
    }
    const bvh::BvhTree& occluders = maps.bvh();
    const bool haveOccluders = maps.haveBvh();
    std::vector<geometry::ScratchboxMesh> decalMeshes(in.decals.size());
    std::vector<bvh::BvhTree> decalTrees(in.decals.size());
    std::vector<std::vector<uint8_t>> decalOnPart(in.decals.size(), std::vector<uint8_t>(in.parts.size(), 0));
    for (size_t d = 0; d < in.decals.size(); ++d) {
        for (uint32_t p : in.decals[d].parts) if (p < in.parts.size()) decalOnPart[d][p] = 1;
        std::vector<float> soup;
        for (const Surface& s : in.surfaces) {
            if (s.part >= in.parts.size() || !decalOnPart[d][s.part]) continue;
            for (size_t t = 0; t + 2 < s.idx.size(); t += 3) for (int k = 0; k < 3; ++k) for (int c = 0; c < 3; ++c) soup.push_back(s.pos[s.idx[t + k] * 3 + c]);
        }
        decalMeshes[d] = soupMesh(soup, "object_detail_decal");
        decalTrees[d].build(decalMeshes[d]);
    }
    out.msBvh = std::chrono::duration<double, std::milli>(clock::now() - t0).count();

    float srgbLut[256];
    for (int i = 0; i < 256; ++i) srgbLut[i] = srgbToLinear(i / 255.0f);

    const float twoThirds = 2.0f / 3.0f;
    const int S = std::max(4, P.aoSamples);
    for (size_t a = 0; a < in.atlases.size(); ++a) {
        const AtlasInput& A = in.atlases[a];
        const uint32_t W = A.width, H = A.height;
        const size_t N = size_t(W) * H;
        AtlasOutput ao;
        ao.width = W; ao.height = H;
        // the atlas's triangles, concatenated
        std::vector<uint32_t> idx, triSurface;
        std::vector<float> uvPx;
        for (uint32_t s = 0; s < in.surfaces.size(); ++s) {
            const Surface& sf = in.surfaces[s];
            if (sf.atlas != a) continue;
            const uint32_t base = static_cast<uint32_t>(uvPx.size() / 2);
            uvPx.insert(uvPx.end(), sf.uvPx.begin(), sf.uvPx.end());
            for (uint32_t i : sf.idx) idx.push_back(i + base);
            for (size_t t = 0; t < sf.idx.size() / 3; ++t) triSurface.push_back(s);
        }
        std::vector<uint32_t> triLocal(triSurface.size());
        {
            std::vector<uint32_t> seen(in.surfaces.size(), 0);
            for (size_t t = 0; t < triSurface.size(); ++t) triLocal[t] = seen[triSurface[t]]++;
        }
        const uv_rewrap::TexelRaster raster = uv_rewrap::rasterTexels(idx, uvPx, W, H, 1.5);

        // 1. per texel: where it is, and the raw ray and edge measures
        auto tm = clock::now();
        std::vector<Vec3> tp(N), tng(N), tns(N);
        std::vector<uint32_t> tpart(N, 0);
        std::vector<float> convexM(N, 0), concaveM(N, 0), cavity(N, 0), exposure(N, 0), skyAbove(N, 0), streak(N, 0);
        std::vector<float> curvMap(N, 0), cavMap(N, 0), thickM(N, thicknessCap);
        std::atomic<uint32_t> nextRow{0};
        auto measure = [&]() {
            for (uint32_t y; (y = nextRow.fetch_add(1)) < H;) {
                for (uint32_t x = 0; x < W; ++x) {
                    const size_t i = size_t(y) * W + x;
                    if (!raster.state[i]) continue;
                    const uint32_t t = static_cast<uint32_t>(raster.owner[i]);
                    const Surface& sf = in.surfaces[triSurface[t]];
                    const uint32_t lt = triLocal[t];
                    const uint32_t i0 = sf.idx[lt * 3], i1 = sf.idx[lt * 3 + 1], i2 = sf.idx[lt * 3 + 2];
                    const float b0 = raster.bary[i * 2], b1 = raster.bary[i * 2 + 1], b2 = 1 - b0 - b1;
                    auto at3 = [](const std::vector<float>& v, uint32_t k) { return Vec3(v[k * 3], v[k * 3 + 1], v[k * 3 + 2]); };
                    const Vec3 p0 = at3(sf.pos, i0), p1 = at3(sf.pos, i1), p2 = at3(sf.pos, i2);
                    const Vec3 p = p0 * b0 + p1 * b1 + p2 * b2;
                    Vec3 ng = (p1 - p0).cross(p2 - p0);
                    ng = ng.length() > 1e-20f ? ng.normalized() : Vec3(0, 1, 0);
                    Vec3 ns = ng;
                    if (!sf.nrm.empty()) {
                        const Vec3 s = at3(sf.nrm, i0) * b0 + at3(sf.nrm, i1) * b1 + at3(sf.nrm, i2) * b2;
                        if (s.length() > 1e-6f) ns = s.normalized();
                        if (ns.dot(ng) < 0) ng = ng * -1.0f;   // a triangle wound against its normals
                    }
                    tp[i] = p; tng[i] = ng; tns[i] = ns; tpart[i] = sf.part;

                    // convexity and creases: the part's own edges within reach
                    if (sf.part < in.parts.size()) {
                        float cx = 0, cc = 0;
                        if (const std::vector<uint32_t>* list = convexGrid[sf.part].at(p)) {
                            for (uint32_t e : *list) cx += convexOf[sf.part][e].angle * chordInBall(p, convexOf[sf.part][e].a, convexOf[sf.part][e].b, edgeR) / (2 * edgeR);
                        }
                        if (const std::vector<uint32_t>* list = concaveGrid[sf.part].at(p)) {
                            for (uint32_t e : *list) cc += -concaveOf[sf.part][e].angle * chordInBall(p, concaveOf[sf.part][e].a, concaveOf[sf.part][e].b, creaseR) / (2 * creaseR);
                        }
                        convexM[i] = cx / (0.5f * math::PI);
                        concaveM[i] = cc / (0.5f * math::PI);
                    }

                }
            }
        };
        auto runRows = [&](auto&& fn) {
            nextRow = 0;
            std::vector<std::thread> pool;
            for (uint32_t k = 0; k < threads; ++k) pool.emplace_back(fn);
            for (auto& th : pool) th.join();
        };
        runRows(measure);

        // the rays measure slow signals (cavity, sky, run-off): one set per 2 x 2 block of texels lying on one surface
        // (its top-left texel's); a texel off its block's surface casts its own
        const float near2 = std::pow(2.5f * std::max(1e-6f, A.texelM), 2.0f);
        std::vector<uint32_t> rep(N);
        for (uint32_t y = 0; y < H; ++y) for (uint32_t x = 0; x < W; ++x) {
            const size_t i = size_t(y) * W + x, j = size_t(y & ~1u) * W + (x & ~1u);
            rep[i] = static_cast<uint32_t>(raster.state[i] && raster.state[j] && tpart[j] == tpart[i] && (tp[j] - tp[i]).lengthSq() <= near2 && tng[j].dot(tng[i]) > 0.8f ? j : i);
        }
        auto rays = [&]() {
            for (uint32_t y; (y = nextRow.fetch_add(1)) < H;) {
                for (uint32_t x = 0; x < W; ++x) {
                    const size_t i = size_t(y) * W + x;
                    if (!raster.state[i] || rep[i] != i) continue;
                    const Vec3 p = tp[i], ng = tng[i], ns = tns[i];

                    // the mesh-measured maps: the part's curvature, cavity over every part, inward thickness
                    if (P.curvatureWear > 0) curvMap[i] = maps.curvatureAt(p, ns, tpart[i]);
                    if (P.cavityGrime > 0) cavMap[i] = maps.cavityAt(p, ns);
                    if (P.thinLight > 0) thickM[i] = maps.thicknessAt(p, ng, static_cast<uint32_t>(i) ^ (static_cast<uint32_t>(a) << 24));

                    // hemisphere: cavity within aoRadiusM, and the sky it sees
                    const Vec3 origin = p + ng * P.rayEpsM;
                    Vec3 tan = std::abs(ng.y) < 0.9f ? Vec3(0, 1, 0).cross(ng) : Vec3(1, 0, 0).cross(ng);
                    tan = tan.normalized();
                    const Vec3 bit = ng.cross(tan);
                    const float rot = hash3f(int(x), int(y), int(a), P.seed) * math::TWO_PI;
                    float occl = 0, open = 0, aboveOpen = 0, aboveTotal = 0;
                    for (int k = 0; k < S; ++k) {
                        const float u1 = (k + 0.5f) / S;
                        const float phi = rot + k * 2.39996323f;
                        const float r = std::sqrt(u1);
                        const Vec3 dir = (tan * (r * std::cos(phi)) + bit * (r * std::sin(phi)) + ng * std::sqrt(1.0f - u1)).normalized();
                        float hitT = std::numeric_limits<float>::infinity();
                        if (haveOccluders) {
                            bvh::RayHit hit;
                            if (occluders.raycast(math::Ray(origin, dir), hit)) hitT = hit.t;
                        }
                        if (P.ground && dir.y < -1e-4f) {
                            const float tg = (origin.y - P.groundY) / -dir.y;
                            if (tg > 0) hitT = std::min(hitT, tg);
                        }
                        if (hitT < P.aoRadiusM) occl += 1.0f - hitT / P.aoRadiusM;
                        const bool escapes = !std::isfinite(hitT);
                        if (escapes) open += std::max(0.0f, dir.y);
                        if (dir.y > 0.7f) { aboveTotal += 1; if (escapes) aboveOpen += 1; }
                    }
                    cavity[i] = occl / S;
                    exposure[i] = std::min(1.0f, open / S / twoThirds);
                    // straight up, when no sample went that way
                    if (aboveTotal == 0 && ns.y > 0.3f) {
                        bool blocked = false;
                        if (haveOccluders) { bvh::RayHit hit; blocked = occluders.raycast(math::Ray(origin, Vec3(0, 1, 0)), hit); }
                        aboveTotal = 1; aboveOpen = blocked ? 0 : 1;
                    }
                    skyAbove[i] = aboveTotal > 0 ? aboveOpen / aboveTotal : 0.0f;

                    // run-off: something overhead a steep face that water runs down (not an underside), within reach.
                    // How far it stands out from the face sets how much it sheds and how far the streak runs: a bolt
                    // head leaves a short tick, a ledge a long run
                    if (P.streaks > 0 && ns.y < 0.8f && ns.y > -0.2f && haveOccluders) {
                        bvh::RayHit hit;
                        if (occluders.raycast(math::Ray(origin, Vec3(0, 1, 0)), hit) && hit.t < P.streakReachM && hit.t > 4.0f * P.rayEpsM) {
                            Vec3 out(ns.x, 0, ns.z);
                            out = out.length() > 1e-4f ? out.normalized() : ng;
                            float reach = 0;
                            for (float f : {0.05f, 0.12f, 0.25f}) {
                                const float off = f * P.streakReachM;
                                bvh::RayHit h2;
                                if (occluders.raycast(math::Ray(origin + out * off, Vec3(0, 1, 0)), h2) && std::abs(h2.t - hit.t) < 0.25f * P.streakReachM + off) reach += 1.0f / 3.0f;
                            }
                            const float run = P.streakReachM * (0.15f + 0.85f * reach);
                            streak[i] = (0.25f + 0.75f * reach) * std::exp(-hit.t / std::max(1e-5f, 0.5f * run));
                        }
                    }
                }
            }
        };
        runRows(rays);
        for (size_t i = 0; i < N; ++i) {
            if (!raster.state[i] || rep[i] == i) continue;
            cavity[i] = cavity[rep[i]]; exposure[i] = exposure[rep[i]]; skyAbove[i] = skyAbove[rep[i]]; streak[i] = streak[rep[i]];
            curvMap[i] = curvMap[rep[i]]; cavMap[i] = cavMap[rep[i]]; thickM[i] = thickM[rep[i]];
        }

        // 2. the ray measures smoothed over each texel's own surface (neighbours within a couple of texels in space)
        {
            auto smooth = [&](std::vector<float>& f) {
                std::vector<float> g = f;
                for (uint32_t y = 0; y < H; ++y) for (uint32_t x = 0; x < W; ++x) {
                    const size_t i = size_t(y) * W + x;
                    if (!raster.state[i]) continue;
                    float sum = 0, wsum = 0;
                    for (int dy = -1; dy <= 1; ++dy) for (int dx = -1; dx <= 1; ++dx) {
                        const int xx = int(x) + dx, yy = int(y) + dy;
                        if (xx < 0 || yy < 0 || xx >= int(W) || yy >= int(H)) continue;
                        const size_t j = size_t(yy) * W + xx;
                        if (!raster.state[j] || (tp[j] - tp[i]).lengthSq() > near2 || tng[j].dot(tng[i]) < 0.5f) continue;
                        const float w = (dx == 0 && dy == 0) ? 2.0f : 1.0f;
                        sum += f[j] * w; wsum += w;
                    }
                    g[i] = wsum > 0 ? sum / wsum : f[i];
                }
                f.swap(g);
            };
            smooth(cavity); smooth(exposure); smooth(skyAbove); smooth(streak); smooth(curvMap); smooth(cavMap); smooth(thickM);
        }
        out.msMasks += std::chrono::duration<double, std::milli>(clock::now() - tm).count();

        // 3. masks and composite, from the part's own base material
        auto tc = clock::now();
        ao.base.assign(N * 4, 0);
        ao.mr.assign(N * 4, 0);
        if (in.wantMasks) { ao.masksA.assign(N * 4, 0); ao.masksB.assign(N * 4, 0); ao.maps.assign(N * 4, 0); }
        std::vector<MaskStats> partStats(in.parts.size());
        std::vector<uint64_t> decalHits(in.decals.size(), 0);
        for (size_t i = 0; i < N; ++i) {
            if (!raster.state[i]) continue;
            const Vec3 p = tp[i], ns = tns[i], ng = tng[i];
            const uint32_t part = tpart[i];
            const PartWear pw = part < in.parts.size() ? in.parts[part] : PartWear{};
            const float clear = 1.0f - std::clamp(A.transmission, 0.0f, 1.0f);
            const float patch = std::clamp(1.0f + P.variation * fbm(p, std::max(1e-5f, P.patchScaleM), P.seed + 11), 0.0f, 2.0f);

            // convexity: the part's sharp edges, or its curvature where it bulges at curvatureRadiusM
            // (H r from 0.5, a part about twice as round as the radius, to 1, a part as round as it)
            const float convex = std::max(convexM[i], 1.5f * P.curvatureWear * smoothstep(0.5f, 1.0f, curvMap[i]));
            const float edgeMask = smoothstep(0.45f, 0.9f, convex + P.chipNoise * 0.35f * fbm(p, std::max(1e-5f, P.chipScaleM), P.seed + 3));
            const float aoTerm = smoothstep(0.06f, 0.5f, cavity[i]);
            const float crease = smoothstep(0.15f, 0.7f, concaveM[i]);
            const float cavityTerm = P.cavityGrime * smoothstep(0.1f, 0.6f, cavMap[i]);
            const float grimeMask = std::clamp((aoTerm * 0.9f + crease * 0.8f + cavityTerm + 0.2f * (1.0f - exposure[i])) * patch, 0.0f, 1.0f) * (1.0f - 0.7f * edgeMask);
            // thin: light passes through what is thinner than thinM (an inward ray that meets nothing reads the cap)
            const float thinMask = thickM[i] < thicknessCap ? 1.0f - smoothstep(0.25f * P.thinM, P.thinM, thickM[i]) : 0.0f;
            float streakMask = 0;
            if (streak[i] > 0) {
                Vec3 across = Vec3(0, 1, 0).cross(ns);
                across = across.length() > 1e-4f ? across.normalized() : Vec3(1, 0, 0);
                const float col = std::max(1e-5f, P.streakColumnM);
                const float columns = 0.5f + 0.5f * noise3(Vec3(p.dot(across), p.y * 0.08f, 0.37f), col, P.seed + 5);
                streakMask = std::clamp(streak[i] * (0.3f + 0.7f * columns) * patch, 0.0f, 1.0f);
            }
            const float dustMask = std::clamp(smoothstep(0.3f, 0.9f, ns.y) * skyAbove[i] * (0.8f + 0.4f * aoTerm) * (0.6f + 0.4f * patch) * (1.0f - 0.85f * edgeMask), 0.0f, 1.0f);
            const float exposureM = exposure[i];

            // the part's own material at this texel
            Vec3 c0(A.baseFactor[0], A.baseFactor[1], A.baseFactor[2]);
            uint8_t alpha = 255;
            if (!A.base.empty()) {
                c0 = Vec3(c0.x * srgbLut[A.base[i * 4]], c0.y * srgbLut[A.base[i * 4 + 1]], c0.z * srgbLut[A.base[i * 4 + 2]]);
                alpha = A.base[i * 4 + 3];
            }
            float r0 = A.roughness, m0 = A.metalness;
            if (!A.mr.empty()) { r0 *= A.mr[i * 4 + 1] / 255.0f; m0 *= A.mr[i * 4 + 2] / 255.0f; }
            Vec3 c = c0;
            float rough = r0, metal = m0;

            // sun fade: desaturates and chalks what the sky sees
            const float fade = std::clamp(P.sunFade * pw.sunFade * exposureM * patch * clear, 0.0f, 1.0f);
            if (fade > 0) {
                const float lum = 0.2126f * c.x + 0.7152f * c.y + 0.0722f * c.z;
                c = mixv(c, Vec3(lum, lum, lum), 0.55f * fade);
                c = c + (Vec3(1, 1, 1) - c) * (0.18f * fade);
                rough = rough + (1.0f - rough) * (0.3f * fade);
            }
            // thin parts lighter, light passing through them (a dielectric only: no light passes through metal, by the
            // material's own metalness at this texel)
            const float thin = std::clamp(P.thinLight * thinMask * clear * (1.0f - std::clamp(m0, 0.0f, 1.0f)), 0.0f, 1.0f);
            if (thin > 0) c = c + (Vec3(1, 1, 1) - c) * (0.45f * thin);
            // decals on this part, under the wear
            float decalCover = 0;
            for (size_t d = 0; d < in.decals.size(); ++d) {
                if (part >= in.parts.size() || !decalOnPart[d][part]) continue;
                const Decal& dc = in.decals[d];
                Vec3 dN, dR, dU;
                decalFrame(dc.normal, dc.up, dN, dR, dU);
                const Vec3 rel = p - dc.center;
                if (std::abs(rel.dot(dN)) > dc.depthM) continue;
                const float facing = ns.dot(dN), cosMax = std::cos(std::clamp(dc.maxAngleDeg, 0.0f, 89.0f) * math::PI / 180.0f);
                if (facing < cosMax) continue;
                const float lu = rel.dot(dR) / dc.widthM + 0.5f, lv = rel.dot(dU) / dc.heightM + 0.5f;
                if (lu < 0 || lu > 1 || lv < 0 || lv > 1 || dc.rgba.empty()) continue;
                // the part's frontmost surface along the decal: nothing of the same part between it and the projector
                if (decalTrees[d].raycastAny(math::Ray(p + ng * P.rayEpsM, dN), 2.0f * dc.depthM)) continue;
                float s[4];
                sampleImage(dc.rgba, dc.width, dc.height, lu, 1.0f - lv, s);
                const float da = std::clamp(s[3] * dc.opacity * smoothstep(cosMax, std::min(1.0f, cosMax + 0.15f), facing), 0.0f, 1.0f);
                if (da <= 0.0f) continue;
                c = mixv(c, Vec3(srgbToLinear(s[0]), srgbToLinear(s[1]), srgbToLinear(s[2])), da);
                rough = mixf(rough, dc.roughness, da * dc.finishMix);
                metal = mixf(metal, dc.metalness, da * dc.finishMix);
                decalCover = std::max(decalCover, da);
                ++decalHits[d];
            }
            // edge wear: the worn edge shows the part beneath (its own colour lightened, polished), or the finish named for it
            const float e = std::clamp(P.edgeWear * pw.edgeWear * edgeMask * clear, 0.0f, 1.0f);
            if (e > 0) {
                const Vec3 cw = pw.hasEdgeColor ? pw.edgeColor : c0 + (Vec3(1, 1, 1) - c0) * 0.3f;
                const float rw = pw.edgeRoughness >= 0 ? pw.edgeRoughness : r0 * (0.55f + 0.25f * (1.0f - m0));
                const float mw = pw.edgeMetalness >= 0 ? pw.edgeMetalness : m0;
                c = mixv(c, cw, e); rough = mixf(rough, rw, e); metal = mixf(metal, mw, e);
            }
            const float g = std::clamp(P.grime * pw.grime * grimeMask, 0.0f, 1.0f);
            if (g > 0) { c = mixv(c, P.grimeColor, g); rough = mixf(rough, P.grimeRoughness, 0.8f * g); metal = mixf(metal, 0.0f, 0.8f * g); }
            const float st = std::clamp(P.streaks * pw.streaks * streakMask, 0.0f, 1.0f);
            if (st > 0) { c = mixv(c, P.streakColor, st); rough = mixf(rough, P.streakRoughness, 0.6f * st); metal = mixf(metal, 0.0f, 0.6f * st); }
            const float du = std::clamp(P.dust * pw.dust * dustMask, 0.0f, 1.0f);
            if (du > 0) { c = mixv(c, P.dustColor, du); rough = mixf(rough, P.dustRoughness, du); metal = mixf(metal, 0.0f, du); }

            uint8_t* ob = &ao.base[i * 4];
            ob[0] = toByte(linearToSrgb(c.x)); ob[1] = toByte(linearToSrgb(c.y)); ob[2] = toByte(linearToSrgb(c.z)); ob[3] = alpha;
            uint8_t* om = &ao.mr[i * 4];
            om[0] = 255; om[1] = toByte(rough); om[2] = toByte(metal); om[3] = 255;
            if (in.wantMasks) {
                uint8_t* ma = &ao.masksA[i * 4];
                ma[0] = toByte(edgeMask); ma[1] = toByte(grimeMask); ma[2] = toByte(streakMask); ma[3] = toByte(dustMask);
                uint8_t* mb = &ao.masksB[i * 4];
                mb[0] = toByte(exposureM); mb[1] = toByte(decalCover); mb[2] = toByte(cavity[i]); mb[3] = toByte(convexM[i]);
                uint8_t* mm = &ao.maps[i * 4];
                mm[0] = toByte(0.5f + 0.5f * curvMap[i]); mm[1] = toByte(cavMap[i]); mm[2] = toByte(thickM[i] / thicknessCap); mm[3] = toByte(1.0f - cavity[i]);
            }
            if (raster.state[i] == 1) {
                MaskStats m{1, edgeMask, grimeMask, streakMask, dustMask, exposureM, decalCover, cavMap[i], thinMask};
                ao.stats.add(m);
                if (part < partStats.size()) partStats[part].add(m);
            }
        }
        for (size_t p = 0; p < partStats.size(); ++p) out.parts[p].add(partStats[p]);
        for (size_t d = 0; d < decalHits.size(); ++d) out.decalTexels[d] += decalHits[d];
        out.msComposite += std::chrono::duration<double, std::milli>(clock::now() - tc).count();

        // 4. gutters
        auto td = clock::now();
        std::vector<std::vector<uint8_t>> slots;
        slots.push_back(std::move(ao.base));
        slots.push_back(std::move(ao.mr));
        std::vector<uint32_t> kinds = {uv_rewrap::kSlotSrgb, uv_rewrap::kSlotLinear};
        if (in.wantMasks) { slots.push_back(std::move(ao.masksA)); slots.push_back(std::move(ao.masksB)); slots.push_back(std::move(ao.maps)); for (int k = 0; k < 3; ++k) kinds.push_back(uv_rewrap::kSlotLinear); }
        std::vector<uint8_t> filled(N);
        for (size_t i = 0; i < N; ++i) filled[i] = raster.state[i] ? 1 : 0;
        uv_rewrap::dilateSlots(slots, std::move(filled), W, H, A.gutter, kinds);
        ao.base = std::move(slots[0]);
        ao.mr = std::move(slots[1]);
        if (in.wantMasks) { ao.masksA = std::move(slots[2]); ao.masksB = std::move(slots[3]); ao.maps = std::move(slots[4]); }
        out.msDilate += std::chrono::duration<double, std::milli>(clock::now() - td).count();
        out.atlases.push_back(std::move(ao));
    }
    return out;
}

}  // namespace scratchbox::object_detail
