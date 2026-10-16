/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_SCAN_ORTHO_HPP
#define SCRATCHBOX_SCAN_ORTHO_HPP

/**
 * Facade orthos: the textured extraction's own photo, laid out on a fitted surface's chart.
 *
 * A plane's chart is (u, v) metres along its axes; a cylinder's is unrolled, u = r * theta from its zero direction and v
 * = z along the axis. Each pixel of the ortho (0.05 m, coarser only to stay within a side limit) casts a BVH ray from 1 m
 * in front of the surface along the inward normal and takes the first face within [-0.5, +1.0] m of the surface; that face's
 * texture is sampled bilinearly at its UV. A pixel nothing is hit for stays transparent. The photo's own sample distance on
 * the surface (texelM: the median over the faces hit of sqrt(face area / face area in texels)) is recorded, because the
 * photo cannot show anything smaller than twice that, however finely the ortho is sampled.
 *
 * Slot outlines are drawn on top, 2 px wide in distinct colours, with the slot's id in a built-in 5 x 7 font beside its
 * first corner: the picture a reader of the surface (a model, a person) is shown to name where detail goes.
 */

#include "scratchbox_bvh.hpp"
#include "scratchbox_gltf_scene.hpp"
#include "scratchbox_scan_geom.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <map>
#include <string>
#include <vector>

namespace scratchbox {
namespace scan_ortho {

using math::Vec3;
using scan_geom::P2;

/** A slot's outline in the surface's chart (metres): a closed polygon, or an open polyline (a crease). */
struct Slot {
    std::string id;
    std::vector<P2> uv;
    bool closed{true};
};

/** A surface's chart in the tile frame. */
struct Chart {
    bool cylinder{false};
    // plane: origin, in-plane axes, outward normal; the polygon (u, v) the surface occupies
    Vec3 origin, u, v, n;
    std::vector<P2> extentUv;
    // cylinder
    Vec3 axisOrigin, axisDir, thetaZeroDir;
    double radius{0};
    double thetaDeg[2]{0, 0};
    double zM[2]{0, 0};
    int normalSign{1};
};

struct Request {
    std::string surfaceId;
    Chart chart;
    std::vector<Slot> slots;
};

struct Image {
    std::string id, surfaceId;
    int widthPx{0}, heightPx{0};
    double gsdM{0}, texelM{0};
    P2 originUv;                          // the chart's (u, v) of pixel (0, 0); u grows right, v grows up the picture
    std::vector<std::string> slotsDrawn;
    std::vector<uint8_t> png;
    std::string sha256;
    texture::ImageBuffer pixels;          // RGBA, alpha 0 where the photo was not reached
    double coveredShare{0};               // the share of the surface's pixels the photo reached
};

namespace detail {

/** 5 x 7 glyphs, one byte a row, bit 4 the leftmost column: 0-9, A-Z. */
inline const uint8_t* glyph(char c) {
    static const uint8_t G[36][7] = {
        {14, 17, 19, 21, 25, 17, 14}, {4, 12, 4, 4, 4, 4, 14}, {14, 17, 1, 2, 4, 8, 31}, {31, 2, 4, 2, 1, 17, 14}, {2, 6, 10, 18, 31, 2, 2},
        {31, 16, 30, 1, 1, 17, 14}, {6, 8, 16, 30, 17, 17, 14}, {31, 1, 2, 4, 8, 8, 8}, {14, 17, 17, 14, 17, 17, 14}, {14, 17, 17, 15, 1, 2, 12},
        {14, 17, 17, 31, 17, 17, 17}, {30, 17, 17, 30, 17, 17, 30}, {14, 17, 16, 16, 16, 17, 14}, {30, 17, 17, 17, 17, 17, 30}, {31, 16, 16, 30, 16, 16, 31},
        {31, 16, 16, 30, 16, 16, 16}, {14, 17, 16, 23, 17, 17, 15}, {17, 17, 17, 31, 17, 17, 17}, {14, 4, 4, 4, 4, 4, 14}, {7, 2, 2, 2, 2, 18, 12},
        {17, 18, 20, 24, 20, 18, 17}, {16, 16, 16, 16, 16, 16, 31}, {17, 27, 21, 21, 17, 17, 17}, {17, 17, 25, 21, 19, 17, 17}, {14, 17, 17, 17, 17, 17, 14},
        {30, 17, 17, 30, 16, 16, 16}, {14, 17, 17, 17, 21, 18, 13}, {30, 17, 17, 30, 20, 18, 17}, {15, 16, 16, 14, 1, 1, 30}, {31, 4, 4, 4, 4, 4, 4},
        {17, 17, 17, 17, 17, 17, 14}, {17, 17, 17, 17, 17, 10, 4}, {17, 17, 17, 21, 21, 27, 17}, {17, 17, 10, 4, 10, 17, 17}, {17, 17, 10, 4, 4, 4, 4}, {31, 1, 2, 4, 8, 16, 31}};
    static const uint8_t blank[7] = {0, 0, 0, 0, 0, 0, 0};
    if (c >= '0' && c <= '9') return G[c - '0'];
    if (c >= 'A' && c <= 'Z') return G[10 + (c - 'A')];
    if (c >= 'a' && c <= 'z') return G[10 + (c - 'a')];
    return blank;
}

inline void put(texture::ImageBuffer& img, int x, int y, const uint8_t rgb[3]) {
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
    uint8_t* p = &img.data[img.getIndex(x, y)];
    p[0] = rgb[0]; p[1] = rgb[1]; p[2] = rgb[2]; p[3] = 255;
}

inline void line(texture::ImageBuffer& img, double x0, double y0, double x1, double y1, const uint8_t rgb[3]) {
    const int n = std::max(1, static_cast<int>(std::ceil(std::max(std::fabs(x1 - x0), std::fabs(y1 - y0)))));
    for (int i = 0; i <= n; ++i) {
        const double f = static_cast<double>(i) / n;
        const int x = static_cast<int>(std::lround(x0 + f * (x1 - x0))), y = static_cast<int>(std::lround(y0 + f * (y1 - y0)));
        for (int dy = 0; dy < 2; ++dy) for (int dx = 0; dx < 2; ++dx) put(img, x + dx, y + dy, rgb);
    }
}

inline void text(texture::ImageBuffer& img, int x, int y, const std::string& s, const uint8_t rgb[3], const uint8_t shadow[3]) {
    int cx = x;
    for (char c : s) {
        const uint8_t* g = glyph(c);
        for (int pass = 0; pass < 2; ++pass) {
            for (int r = 0; r < 7; ++r) for (int k = 0; k < 5; ++k) {
                if (!(g[r] & (16 >> k))) continue;
                put(img, cx + k + (pass == 0 ? 1 : 0), y + r + (pass == 0 ? 1 : 0), pass == 0 ? shadow : rgb);
            }
        }
        cx += 6;
    }
}

/** Slot colours: hues stepped by the golden angle at full saturation, so neighbours differ. */
inline void slotColour(size_t i, uint8_t rgb[3]) {
    const double h = std::fmod(static_cast<double>(i) * 137.508, 360.0) / 60.0;
    const double x = 1 - std::fabs(std::fmod(h, 2.0) - 1);
    double r = 0, g = 0, b = 0;
    if (h < 1) { r = 1; g = x; } else if (h < 2) { r = x; g = 1; } else if (h < 3) { g = 1; b = x; } else if (h < 4) { g = x; b = 1; } else if (h < 5) { r = x; b = 1; } else { r = 1; b = x; }
    rgb[0] = static_cast<uint8_t>(40 + 215 * r); rgb[1] = static_cast<uint8_t>(40 + 215 * g); rgb[2] = static_cast<uint8_t>(40 + 215 * b);
}

} // namespace detail

class Renderer {
public:
    explicit Renderer(const gltf::GltfScene& scene) : scene_(scene) {
        tree_.build(scene_.mesh);
        const size_t T = scene_.mesh.indices.size() / 3;
        texel_.assign(T, 0.0f);
        scan_geom::parallelFor(T, [&](size_t t) { texel_[t] = texelOf(static_cast<uint32_t>(t)); });
    }

    Image render(const Request& rq, double gsdM = 0.05, int maxSidePx = 1600, bool encode = true) const {
        const Chart& C = rq.chart;
        double u0, u1, v0, v1;
        Vec3 e2;
        if (C.cylinder) {
            u0 = C.radius * C.thetaDeg[0] * scan_geom::kPi / 180.0; u1 = C.radius * C.thetaDeg[1] * scan_geom::kPi / 180.0;
            v0 = C.zM[0]; v1 = C.zM[1];
            e2 = C.axisDir.cross(C.thetaZeroDir).normalized();
        } else {
            u0 = v0 = 1e30; u1 = v1 = -1e30;
            for (const auto& p : C.extentUv) { u0 = std::min(u0, p.x); u1 = std::max(u1, p.x); v0 = std::min(v0, p.y); v1 = std::max(v1, p.y); }
        }
        Image img;
        img.id = "ortho:" + rq.surfaceId;
        img.surfaceId = rq.surfaceId;
        if (!(u1 > u0) || !(v1 > v0)) return img;
        double gsd = gsdM;
        while ((u1 - u0) / gsd > maxSidePx || (v1 - v0) / gsd > maxSidePx) gsd *= 1.25;
        const int W = std::max(1, static_cast<int>(std::ceil((u1 - u0) / gsd))), H = std::max(1, static_cast<int>(std::ceil((v1 - v0) / gsd)));
        img.widthPx = W; img.heightPx = H; img.gsdM = gsd;
        img.originUv = P2(u0, v1);
        texture::ImageBuffer pic(W, H, 4, 0);
        const auto& mesh = scene_.mesh;
        std::vector<float> texels(static_cast<size_t>(W) * static_cast<size_t>(H), -1.0f);
        std::vector<uint8_t> covered(static_cast<size_t>(W) * static_cast<size_t>(H), 0);
        scan_geom::parallelFor(static_cast<size_t>(H), [&](size_t j) {
            for (int i = 0; i < W; ++i) {
                const double u = u0 + (i + 0.5) * gsd, v = v1 - (static_cast<double>(j) + 0.5) * gsd;
                Vec3 p, nrm;
                if (C.cylinder) {
                    const double th = u / C.radius;
                    const Vec3 radial = C.thetaZeroDir * static_cast<float>(std::cos(th)) + e2 * static_cast<float>(std::sin(th));
                    p = C.axisOrigin + C.axisDir * static_cast<float>(v) + radial * static_cast<float>(C.radius);
                    nrm = radial * static_cast<float>(C.normalSign);
                } else {
                    if (!scan_geom::insidePolygon(C.extentUv, u, v)) continue;
                    p = C.origin + C.u * static_cast<float>(u) + C.v * static_cast<float>(v);
                    nrm = C.n;
                }
                covered[j * static_cast<size_t>(W) + static_cast<size_t>(i)] = 0;
                math::Ray ray(p + nrm * 1.0f, nrm * -1.0f);
                bvh::RayHit hit;
                if (!tree_.raycast(ray, hit) || hit.t > 1.5f) continue;
                const uint32_t t = hit.triangleIndex;
                const auto &a = mesh.vertices[mesh.indices[3 * t]], &b = mesh.vertices[mesh.indices[3 * t + 1]], &c = mesh.vertices[mesh.indices[3 * t + 2]];
                const math::Vec2 uv = a.uv * (1.0f - hit.u - hit.v) + b.uv * hit.u + c.uv * hit.v;
                float r = 0.6f, g = 0.6f, bl = 0.6f;
                const size_t mi = t < scene_.triangleMaterial.size() ? scene_.triangleMaterial[t] : 0;
                if (mi < scene_.materials.size()) {
                    const auto& mat = scene_.materials[mi];
                    r = mat.baseColorFactor.x; g = mat.baseColorFactor.y; bl = mat.baseColorFactor.z;
                    if (mat.baseColorImage >= 0 && static_cast<size_t>(mat.baseColorImage) < scene_.images.size() && !scene_.images[static_cast<size_t>(mat.baseColorImage)].pixels.empty()) {
                        const Vec3 s = scene_.images[static_cast<size_t>(mat.baseColorImage)].pixels.sampleBilinear(uv.x, uv.y);
                        r *= s.x; g *= s.y; bl *= s.z;
                    }
                }
                uint8_t* px = &pic.data[pic.getIndex(i, static_cast<int>(j))];
                px[0] = static_cast<uint8_t>(std::clamp(r, 0.0f, 1.0f) * 255 + 0.5f); px[1] = static_cast<uint8_t>(std::clamp(g, 0.0f, 1.0f) * 255 + 0.5f);
                px[2] = static_cast<uint8_t>(std::clamp(bl, 0.0f, 1.0f) * 255 + 0.5f); px[3] = 255;
                covered[j * static_cast<size_t>(W) + static_cast<size_t>(i)] = 1;
                texels[j * static_cast<size_t>(W) + static_cast<size_t>(i)] = texel_[t];
            }
        });
        size_t inside = 0, hits = 0;
        std::vector<float> tex;
        for (size_t k = 0; k < covered.size(); ++k) {
            if (covered[k]) ++hits;
            if (texels[k] > 0) tex.push_back(texels[k]);
        }
        if (C.cylinder) inside = covered.size();
        else for (int j = 0; j < H; ++j) for (int i = 0; i < W; ++i) if (scan_geom::insidePolygon(C.extentUv, u0 + (i + 0.5) * gsd, v1 - (j + 0.5) * gsd)) ++inside;
        img.coveredShare = inside ? static_cast<double>(hits) / static_cast<double>(inside) : 0;
        if (!tex.empty()) { std::nth_element(tex.begin(), tex.begin() + static_cast<long>(tex.size() / 2), tex.end()); img.texelM = tex[tex.size() / 2]; }
        // slot outlines and their ids
        size_t k = 0;
        for (const auto& s : rq.slots) {
            uint8_t col[3], dark[3] = {0, 0, 0};
            detail::slotColour(k++, col);
            bool any = false;
            double lx = 1e30, ly = 1e30;
            const size_t n = s.uv.size();
            for (size_t q = 0; q + (s.closed ? 0 : 1) < n; ++q) {
                const P2 &a = s.uv[q], &b = s.uv[(q + 1) % n];
                const double ax = (a.x - u0) / gsd, ay = (v1 - a.y) / gsd, bx = (b.x - u0) / gsd, by = (v1 - b.y) / gsd;
                if (std::max(ax, bx) < 0 || std::min(ax, bx) > W || std::max(ay, by) < 0 || std::min(ay, by) > H) continue;
                detail::line(pic, ax, ay, bx, by, col);
                any = true;
            }
            for (const auto& q : s.uv) { const double x = (q.x - u0) / gsd, y = (v1 - q.y) / gsd; if (x >= 0 && y >= 0 && x < W && y < H && (y < ly || (y == ly && x < lx))) { ly = y; lx = x; } }
            if (!any) continue;
            if (lx > 1e29) { lx = std::clamp((s.uv[0].x - u0) / gsd, 0.0, static_cast<double>(W - 1)); ly = std::clamp((v1 - s.uv[0].y) / gsd, 0.0, static_cast<double>(H - 1)); }
            detail::text(pic, std::clamp(static_cast<int>(lx) + 3, 0, std::max(0, W - 6 * static_cast<int>(s.id.size()) - 1)), std::clamp(static_cast<int>(ly) + 3, 0, std::max(0, H - 8)), s.id, col, dark);
            img.slotsDrawn.push_back(s.id);
        }
        if (encode) {
            img.png = texture::encodePng(pic);
            img.sha256 = scan_geom::sha256Hex(img.png.data(), img.png.size());
        }
        img.pixels = std::move(pic);
        return img;
    }

private:
    const gltf::GltfScene& scene_;
    bvh::BvhTree tree_;
    std::vector<float> texel_;  // per face, the photo's sample distance on it (0: no photo)

    /** The photo's own sample distance on a face: sqrt(its area / its area in texels). */
    float texelOf(uint32_t t) const {
        const auto& m = scene_.mesh;
        const auto &a = m.vertices[m.indices[3 * t]], &b = m.vertices[m.indices[3 * t + 1]], &c = m.vertices[m.indices[3 * t + 2]];
        float out = 0;
        const size_t mi = t < scene_.triangleMaterial.size() ? scene_.triangleMaterial[t] : 0;
        if (mi < scene_.materials.size() && scene_.materials[mi].baseColorImage >= 0 && static_cast<size_t>(scene_.materials[mi].baseColorImage) < scene_.images.size()) {
            const auto& px = scene_.images[static_cast<size_t>(scene_.materials[mi].baseColorImage)].pixels;
            if (!px.empty()) {
                const double area3 = 0.5 * (b.position - a.position).cross(c.position - a.position).length();
                const double au = (b.uv.x - a.uv.x) * px.width, av = (b.uv.y - a.uv.y) * px.height, bu = (c.uv.x - a.uv.x) * px.width, bv = (c.uv.y - a.uv.y) * px.height;
                const double areaPx = 0.5 * std::fabs(au * bv - av * bu);
                if (areaPx > 1e-6 && area3 > 1e-4) out = static_cast<float>(std::sqrt(area3 / areaPx));
            }
        }
        return out;
    }
};

} // namespace scan_ortho
} // namespace scratchbox

#endif // SCRATCHBOX_SCAN_ORTHO_HPP
