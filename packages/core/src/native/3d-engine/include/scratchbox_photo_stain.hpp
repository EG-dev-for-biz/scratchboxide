/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_PHOTO_STAIN_HPP
#define SCRATCHBOX_PHOTO_STAIN_HPP

#include "scratchbox_gltf_scene.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <random>
#include <string>
#include <vector>

/**
 * A real building's staining read from its photographic scan (Google 3D Tiles, unlit: sun and shade baked in), as a
 * field the weathering bake looks up per texel: where the photos show the facade darker than its clean surface at that
 * height and facing, the bake paints stain (photo-inferred); where they cannot say, its procedural layers fill in.
 *
 * The photos are flattened per facing (eight wall directions and up-facing) into a grid of the facade's plane
 * (along-facade u and height y, or plan x and z for up-facing) at `cellM`, keeping the frontmost surface in each cell,
 * then box-filtered one bay wide and one storey tall: the regular rhythm of windows, piers, spandrels and floors averages
 * away and what is left is staining and tone wider than a bay, such as run-off columns, grime under setbacks, damp at
 * the base and weathered patches. A texel reads the cell its own position projects to on the grid of its own facing, if
 * our surface lies within `depthToleranceM` of the photographed one there; `support` says how much of the filter window
 * the photos actually covered. The field is kept in the build's frame: y measured from the street (groundY in build()).
 */
namespace scratchbox {
namespace photo_stain {

using math::Vec2;
using math::Vec3;

struct Grid {
    Vec3 dir{0, 0, 0}, tan{0, 0, 0};  // outward direction, along-facade direction (up-facing: x and z)
    bool up{false};
    float u0{0}, v0{0};
    int W{0}, H{0};
    std::vector<float> depth;          // the frontmost photographed surface per cell (along dir)
    std::vector<Vec3> colour;          // filtered linear colour
    std::vector<float> support;        // share of the filter window with photo samples
};

struct Field {
    float groundY{0}, cellM{0.25f}, depthToleranceM{2.0f};
    std::array<Grid, 9> grids;          // 0..7 walls N, NE, E, SE, S, SW, W, NW (outward); 8 up-facing
    int samples{0};
    std::string error;

    static int facingOf(const Vec3& n) {
        if (n.y > 0.7f) return 8;
        if (n.y < -0.7f) return -1;
        const double ang = std::fmod(std::atan2(double(n.x), double(-n.z)) * 180.0 / M_PI + 360.0, 360.0);  // 0 = north (z south)
        return int((ang + 22.5) / 45.0) % 8;
    }

    /** The filtered photo colour (linear) at a surface point with normal n, or false where the photos do not cover it. */
    bool sample(const Vec3& p, const Vec3& n, Vec3& colour, float& support) const {
        const int f = facingOf(n);
        if (f < 0) return false;
        const Grid& g = grids[f];
        if (g.W == 0) return false;
        const float u = g.up ? p.x : p.dot(g.tan), v = g.up ? p.z : p.y - groundY;
        const int x = int(std::floor((u - g.u0) / cellM)), y = int(std::floor((v - g.v0) / cellM));
        if (x < 0 || y < 0 || x >= g.W || y >= g.H) return false;
        const size_t i = size_t(y) * g.W + x;
        if (g.support[i] <= 0.0f) return false;
        const float d = g.up ? p.y : p.dot(g.dir);
        if (std::abs(d - g.depth[i]) > depthToleranceM) return false;
        colour = g.colour[i];
        support = g.support[i];
        return true;
    }
};

namespace detail {

inline bool nearRings(const std::vector<std::vector<Vec2>>& rings, float x, float z, float margin) {
    if (rings.empty()) return true;
    for (const auto& r : rings) {
        if (r.size() < 3) continue;
        bool in = false;
        float best = 1e30f;
        for (size_t i = 0, j = r.size() - 1; i < r.size(); j = i++) {
            const Vec2 &a = r[i], &b = r[j];
            if ((a.y > z) != (b.y > z) && x < (b.x - a.x) * (z - a.y) / (b.y - a.y) + a.x) in = !in;
            const float ex = b.x - a.x, ez = b.y - a.y, L2 = ex * ex + ez * ez;
            const float t = L2 > 0 ? std::clamp(((x - a.x) * ex + (z - a.y) * ez) / L2, 0.0f, 1.0f) : 0.0f;
            const float dx = x - a.x - t * ex, dz = z - a.y - t * ez;
            best = std::min(best, dx * dx + dz * dz);
        }
        if (in || best <= margin * margin) return true;
    }
    return false;
}

/** Box filter of a sparse grid (only cells with photo count), separable: halfX, halfY cells each way. */
inline void boxFilter(Grid& g, const std::vector<Vec3>& sum, const std::vector<float>& cnt, int halfX, int halfY) {
    const int W = g.W, H = g.H;
    std::vector<Vec3> rowS(size_t(W) * H, Vec3(0, 0, 0));
    std::vector<float> rowC(size_t(W) * H, 0.0f), rowN(size_t(W) * H, 0.0f);
    for (int y = 0; y < H; ++y) {
        Vec3 s(0, 0, 0); float c = 0, k = 0;
        // sliding window over x
        for (int x = -halfX; x < W; ++x) {
            const int add = x + halfX, rem = x - halfX - 1;
            if (add < W) { const size_t i = size_t(y) * W + add; s = s + sum[i]; c += cnt[i]; k += cnt[i] > 0 ? 1.0f : 0.0f; }
            if (rem >= 0) { const size_t i = size_t(y) * W + rem; s = s - sum[i]; c -= cnt[i]; k -= cnt[i] > 0 ? 1.0f : 0.0f; }
            if (x >= 0) { const size_t i = size_t(y) * W + x; rowS[i] = s; rowC[i] = c; rowN[i] = k; }
        }
    }
    g.colour.assign(size_t(W) * H, Vec3(0, 0, 0));
    g.support.assign(size_t(W) * H, 0.0f);
    const float area = float((2 * halfX + 1) * (2 * halfY + 1));
    for (int x = 0; x < W; ++x) {
        Vec3 s(0, 0, 0); float c = 0, k = 0;
        for (int y = -halfY; y < H; ++y) {
            const int add = y + halfY, rem = y - halfY - 1;
            if (add < H) { const size_t i = size_t(add) * W + x; s = s + rowS[i]; c += rowC[i]; k += rowN[i]; }
            if (rem >= 0) { const size_t i = size_t(rem) * W + x; s = s - rowS[i]; c -= rowC[i]; k -= rowN[i]; }
            if (y >= 0) {
                const size_t i = size_t(y) * W + x;
                // a cell is only read where the photos themselves cover it
                if (cnt[i] > 0 && c > 0) { g.colour[i] = s * (1.0f / c); g.support[i] = std::clamp(k / area, 0.0f, 1.0f); }
            }
        }
    }
}

}  // namespace detail

/**
 * Builds the field from a textured scan GLB: photo samples every cellM / 2 over the triangles inside the plan outline
 * (plus marginM), y measured from groundY; filtered `bayM` wide and `storeyM` tall.
 */
inline Field build(const std::string& texturedGlb, float groundY, const std::vector<std::vector<Vec2>>& rings, float bayM, float storeyM,
                   float cellM = 0.25f, float marginM = 2.0f) {
    Field f;
    f.groundY = groundY;
    f.cellM = cellM;
    gltf::GltfScene scene = gltf::GlbSceneReader::readFile(texturedGlb);
    if (!scene.ok) { f.error = scene.error.empty() ? "cannot read " + texturedGlb : scene.error; return f; }
    const auto& mesh = scene.mesh;
    std::array<double, 256> toLin{};
    for (int i = 0; i < 256; ++i) { const double c = i / 255.0; toLin[i] = c <= 0.04045 ? c / 12.92 : std::pow((c + 0.055) / 1.055, 2.4); }
    struct S { Vec3 p; Vec3 c; int facing; };
    std::vector<S> pts;
    std::mt19937 rng(4242);
    std::uniform_real_distribution<float> U(0.0f, 1.0f);
    const float spacing = cellM * 0.5f;
    for (size_t t = 0; t + 2 < mesh.indices.size(); t += 3) {
        const auto &A = mesh.vertices[mesh.indices[t]], &B = mesh.vertices[mesh.indices[t + 1]], &C = mesh.vertices[mesh.indices[t + 2]];
        const Vec3 c = (A.position + B.position + C.position) * (1.0f / 3.0f);
        if (!detail::nearRings(rings, c.x, c.z, marginM)) continue;
        Vec3 n = (B.position - A.position).cross(C.position - A.position);
        const float area2 = n.length();
        if (area2 < 1e-8f) continue;
        n = n / area2;
        const int facing = Field::facingOf(n);
        if (facing < 0) continue;
        const uint32_t mi = scene.triangleMaterial[t / 3];
        if (mi >= scene.materials.size()) continue;
        const int img = scene.materials[mi].baseColorImage;
        if (img < 0 || img >= int(scene.images.size()) || !scene.images[img].decoded) continue;
        const auto& px = scene.images[img].pixels;
        const int count = std::clamp(int(std::ceil(0.5f * area2 / (spacing * spacing))), 1, 2000);
        for (int k = 0; k < count; ++k) {
            float a = U(rng), b = U(rng);
            if (a + b > 1.0f) { a = 1.0f - a; b = 1.0f - b; }
            const Vec3 p = A.position + (B.position - A.position) * a + (C.position - A.position) * b;
            const Vec2 uv = A.uv + (B.uv - A.uv) * a + (C.uv - A.uv) * b;
            const float fu = uv.x - std::floor(uv.x), fv = uv.y - std::floor(uv.y);
            const int x = std::clamp(int(fu * px.width), 0, px.width - 1), y = std::clamp(int(fv * px.height), 0, px.height - 1);
            const uint8_t* s = &px.data[(size_t(y) * px.width + x) * px.channels];
            pts.push_back({p - Vec3(0.0f, groundY, 0.0f), Vec3(float(toLin[s[0]]), float(toLin[s[px.channels > 1 ? 1 : 0]]), float(toLin[s[px.channels > 2 ? 2 : 0]])), facing});
        }
    }
    f.samples = int(pts.size());
    // the samples are now in the build's frame (street at y = 0), the frame the bake's texels are in
    groundY = 0.0f;
    f.groundY = 0.0f;
    for (int g = 0; g < 9; ++g) {
        Grid& G = f.grids[g];
        G.up = g == 8;
        if (!G.up) {
            const double ang = g * 45.0 * M_PI / 180.0;
            G.dir = Vec3(float(std::sin(ang)), 0.0f, float(-std::cos(ang)));  // 0 = north (-z)
            G.tan = Vec3(0, 1, 0).cross(G.dir).normalized();
        } else {
            G.dir = Vec3(0, 1, 0);
        }
        float u0 = 1e30f, u1 = -1e30f, v0 = 1e30f, v1 = -1e30f;
        for (const auto& s : pts) {
            if (s.facing != g) continue;
            const float u = G.up ? s.p.x : s.p.dot(G.tan), v = G.up ? s.p.z : s.p.y - groundY;
            u0 = std::min(u0, u); u1 = std::max(u1, u); v0 = std::min(v0, v); v1 = std::max(v1, v);
        }
        if (u0 > u1) continue;
        G.u0 = u0; G.v0 = v0;
        G.W = int(std::ceil((u1 - u0) / cellM)) + 1; G.H = int(std::ceil((v1 - v0) / cellM)) + 1;
        const size_t N = size_t(G.W) * G.H;
        G.depth.assign(N, -1e30f);
        std::vector<Vec3> sum(N, Vec3(0, 0, 0));
        std::vector<float> cnt(N, 0.0f);
        for (const auto& s : pts) {
            if (s.facing != g) continue;
            const float u = G.up ? s.p.x : s.p.dot(G.tan), v = G.up ? s.p.z : s.p.y - groundY;
            const size_t i = size_t(int((v - v0) / cellM)) * G.W + size_t(int((u - u0) / cellM));
            const float d = G.up ? s.p.y : s.p.dot(G.dir);
            if (d > G.depth[i] + 0.5f) { G.depth[i] = d; sum[i] = s.c; cnt[i] = 1; }   // a nearer surface replaces
            else if (d > G.depth[i] - 0.5f) { sum[i] = sum[i] + s.c; cnt[i] += 1; G.depth[i] = std::max(G.depth[i], d); }
        }
        const int hx = std::max(1, int(std::lround(0.5f * bayM / cellM))), hy = G.up ? hx : std::max(1, int(std::lround(0.5f * storeyM / cellM)));
        detail::boxFilter(G, sum, cnt, hx, hy);
    }
    return f;
}

}  // namespace photo_stain
}  // namespace scratchbox

#endif  // SCRATCHBOX_PHOTO_STAIN_HPP
