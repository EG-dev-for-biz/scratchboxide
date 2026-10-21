/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_LOD_RETEXTURE_HPP
#define SCRATCHBOX_LOD_RETEXTURE_HPP

/**
 * Re-texturing of a coarse LOD level: every coarse triangle gets its own cell in a new atlas, and the
 * cell's texels are baked by projecting back along the coarse normal onto the finer surface the
 * triangle was simplified from and sampling that surface's albedo there. With its own atlas a level's
 * simplification no longer has to stop at UV seams or material borders, which is what keeps a charted
 * photogrammetry DAG shallow.
 *
 * Cells are squares; the triangle sits on the lower-left half with a one-texel gutter and the whole
 * cell is baked with barycentrics clamped to the triangle, so bilinear lookups near the edges never
 * read unrelated texels. Cell sizes follow triangle area at a texel size tied to the level's error
 * (a level is only drawn once its error projects below a pixel, so finer texels would not show), and
 * the whole atlas is scaled down to fit the size cap.
 */

#include "scratchbox_bvh.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_texture.hpp"
#include "scratchbox_view_transform.hpp"
#include "scratchbox_virtual_geometry.hpp"
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <limits>
#include <thread>
#include <vector>

namespace scratchbox {
namespace vgeo {
namespace retex {

/** Bilinear lookup of an 8-bit glTF colour texture with its wrap modes, decoded to linear RGB. */
inline F3 sampleImageLinear(const texture::ImageBuffer& img, const F2& uv, int wrapS, int wrapT) {
    if (img.width <= 0 || img.height <= 0) return F3(1, 1, 1);
    auto wrap = [](int i, int n, int mode) {
        if (mode == 33071) return std::clamp(i, 0, n - 1);
        if (mode == 33648) {
            const int period = 2 * n;
            const int m = ((i % period) + period) % period;
            return m < n ? m : period - 1 - m;
        }
        return ((i % n) + n) % n;
    };
    const float fx = std::clamp(uv.x, -1e5f, 1e5f) * img.width - 0.5f;
    const float fy = std::clamp(uv.y, -1e5f, 1e5f) * img.height - 0.5f;
    if (!std::isfinite(fx) || !std::isfinite(fy)) return F3(0, 0, 0);
    const float x0f = std::floor(fx), y0f = std::floor(fy);
    const float tx = fx - x0f, ty = fy - y0f;
    const int x0 = static_cast<int>(x0f), y0 = static_cast<int>(y0f);
    const int xa = wrap(x0, img.width, wrapS), xb = wrap(x0 + 1, img.width, wrapS);
    const int ya = wrap(y0, img.height, wrapT), yb = wrap(y0 + 1, img.height, wrapT);
    auto fetch = [&](int x, int y) {
        const size_t i = (static_cast<size_t>(y) * img.width + x) * img.channels;
        if (img.channels >= 3) return F3(view::srgbDecode(img.data[i] / 255.0f), view::srgbDecode(img.data[i + 1] / 255.0f), view::srgbDecode(img.data[i + 2] / 255.0f));
        const float v = view::srgbDecode(img.data[i] / 255.0f);
        return F3(v, v, v);
    };
    const F3 top = fetch(xa, ya) * (1.0f - tx) + fetch(xb, ya) * tx;
    const F3 bottom = fetch(xa, yb) * (1.0f - tx) + fetch(xb, yb) * tx;
    return top * (1.0f - ty) + bottom * ty;
}

/**
 * The source textures' texel size in world units (median over the textured triangles of the welded
 * mesh), so no atlas is baked finer than what the source can show. 0.05 when nothing is textured.
 */
template <typename Scene>
inline float sourceTexelWorld(const WeldedMesh& m, const Scene& scene) {
    std::vector<float> texels;
    for (size_t t = 0; t + 2 < m.indices.size(); t += 3) {
        const uint32_t material = m.triMaterial[t / 3];
        if (material >= scene.materials.size()) continue;
        const auto& mat = scene.materials[material];
        if (mat.baseColorImage < 0 || mat.baseColorImage >= static_cast<int>(scene.images.size())) continue;
        const auto& img = scene.images[static_cast<size_t>(mat.baseColorImage)];
        if (!img.decoded || img.pixels.width <= 0 || img.pixels.height <= 0) continue;
        const F3& a = m.positions[m.indices[t]];
        const F3& b = m.positions[m.indices[t + 1]];
        const F3& c = m.positions[m.indices[t + 2]];
        const float area = 0.5f * length(cross(b - a, c - a));
        const F2& ua = m.cornerUv[t];
        const F2& ub = m.cornerUv[t + 1];
        const F2& uc = m.cornerUv[t + 2];
        const float uvArea = 0.5f * std::abs((ub.x - ua.x) * (uc.y - ua.y) - (uc.x - ua.x) * (ub.y - ua.y)) * img.pixels.width * img.pixels.height;
        if (area <= 0.0f || uvArea <= 1e-6f) continue;
        texels.push_back(std::sqrt(area / uvArea));
    }
    if (texels.empty()) return 0.05f;
    std::nth_element(texels.begin(), texels.begin() + static_cast<std::ptrdiff_t>(texels.size() / 2), texels.end());
    return std::max(texels[texels.size() / 2], 1e-4f);
}

namespace detail {

inline F3 closestPointOnTriangle(const F3& p, const F3& a, const F3& b, const F3& c) {
    const F3 ab = b - a, ac = c - a, ap = p - a;
    const float d1 = dot(ab, ap), d2 = dot(ac, ap);
    if (d1 <= 0 && d2 <= 0) return a;
    const F3 bp = p - b;
    const float d3 = dot(ab, bp), d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) return b;
    const float vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) return a + ab * (d1 / (d1 - d3));
    const F3 cp = p - c;
    const float d5 = dot(ab, cp), d6 = dot(ac, cp);
    if (d6 >= 0 && d5 <= d6) return c;
    const float vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) return a + ac * (d2 / (d2 - d6));
    const float va = d3 * d6 - d5 * d4;
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) return b + (c - b) * ((d4 - d3) / ((d4 - d3) + (d5 - d6)));
    const float denom = 1.0f / (va + vb + vc);
    return a + ab * (vb * denom) + ac * (vc * denom);
}

/** Barycentrics (for b and c) of a point known to lie on triangle abc. */
inline void barycentric(const F3& p, const F3& a, const F3& b, const F3& c, float& u, float& v) {
    const F3 v0 = b - a, v1 = c - a, v2 = p - a;
    const float d00 = dot(v0, v0), d01 = dot(v0, v1), d11 = dot(v1, v1), d20 = dot(v2, v0), d21 = dot(v2, v1);
    const float denom = d00 * d11 - d01 * d01;
    if (std::abs(denom) < 1e-20f) { u = 0; v = 0; return; }
    u = std::clamp((d11 * d20 - d01 * d21) / denom, 0.0f, 1.0f);
    v = std::clamp((d00 * d21 - d01 * d20) / denom, 0.0f, 1.0f - u);
}

struct Cell {
    uint32_t x{0}, y{0}, size{0};
};

} // namespace detail

inline BakeResult bakeAtlas(const BakeRequest& r) {
    const WeldedMesh& m = *r.mesh;
    const uint32_t triCount = static_cast<uint32_t>(r.coarseTris.size() / 3);
    BakeResult out;
    out.cornerUv.assign(r.coarseTris.size(), F2(0, 0));
    if (triCount == 0) return out;
    if (r.groupOfTri.size() != triCount || r.sources.size() != r.groupError.size()) throw std::runtime_error("bake request is inconsistent");

    // Cell size per triangle from its area, at the group's texel size.
    const uint32_t gutter = 1;
    std::vector<float> wanted(triCount);
    for (uint32_t t = 0; t < triCount; ++t) {
        const F3& a = m.positions[r.coarseTris[t * 3]];
        const F3& b = m.positions[r.coarseTris[t * 3 + 1]];
        const F3& c = m.positions[r.coarseTris[t * 3 + 2]];
        const float area = 0.5f * length(cross(b - a, c - a));
        const float texelWorld = std::max(r.groupError[r.groupOfTri[t]] * 0.5f, r.minTexelWorld);
        // The triangle covers half the cell: side = sqrt(2 * area) in texels.
        wanted[t] = std::sqrt(2.0f * area) / texelWorld;
    }
    auto cellSize = [&](float w, float scale) {
        return static_cast<uint32_t>(std::clamp(std::ceil(w * scale) + 2 * gutter, 4.0f, 256.0f));
    };
    // Fit the size cap: shrink every cell by one factor until the summed cell area fits.
    float scale = 1.0f;
    uint32_t width = 0;
    for (int attempt = 0; attempt < 40; ++attempt) {
        double sum = 0.0;
        for (uint32_t t = 0; t < triCount; ++t) {
            const double s = cellSize(wanted[t], scale);
            sum += s * s;
        }
        width = 64;
        while (static_cast<double>(width) * width < sum * 1.15 && width < r.maxAtlasSize) width *= 2;
        if (static_cast<double>(width) * width >= sum * 1.15) break;
        scale *= 0.85f;
    }
    // Shelf packing, largest cells first.
    std::vector<uint32_t> order(triCount);
    for (uint32_t t = 0; t < triCount; ++t) order[t] = t;
    std::vector<uint32_t> sizes(triCount);
    for (uint32_t t = 0; t < triCount; ++t) sizes[t] = cellSize(wanted[t], scale);
    std::stable_sort(order.begin(), order.end(), [&](uint32_t a, uint32_t b) { return sizes[a] > sizes[b]; });
    std::vector<detail::Cell> cells(triCount);
    uint32_t x = 0, y = 0, rowHeight = 0;
    for (uint32_t t : order) {
        const uint32_t s = sizes[t];
        if (x + s > width) {
            x = 0;
            y += rowHeight;
            rowHeight = 0;
        }
        if (s > width) throw std::runtime_error("atlas cell wider than the atlas");
        cells[t] = {x, y, s};
        x += s;
        rowHeight = std::max(rowHeight, s);
    }
    const uint32_t height = std::max<uint32_t>(4, y + rowHeight);
    out.atlas.width = width;
    out.atlas.height = height;
    out.atlas.rgb.assign(static_cast<size_t>(width) * height * 3, 0);
    out.cells = triCount;
    double texelWorldSum = 0.0;
    for (uint32_t t = 0; t < triCount; ++t) {
        const detail::Cell& c = cells[t];
        const float inner = static_cast<float>(c.size - 2 * gutter);
        const float fx = static_cast<float>(c.x), fy = static_cast<float>(c.y), g = static_cast<float>(gutter);
        out.cornerUv[t * 3] = F2((fx + g) / width, (fy + g) / height);
        out.cornerUv[t * 3 + 1] = F2((fx + g + inner) / width, (fy + g) / height);
        out.cornerUv[t * 3 + 2] = F2((fx + g) / width, (fy + g + inner) / height);
        out.texels += static_cast<uint64_t>(c.size) * c.size;
        const F3& a = m.positions[r.coarseTris[t * 3]];
        const F3& b = m.positions[r.coarseTris[t * 3 + 1]];
        const F3& cc = m.positions[r.coarseTris[t * 3 + 2]];
        texelWorldSum += std::sqrt(length(cross(b - a, cc - a)) / std::max(1.0f, inner * inner));
    }
    out.texelWorld = static_cast<float>(texelWorldSum / triCount);

    // Coarse triangles per group, so each group's source surface is built once.
    const uint32_t groupCount = static_cast<uint32_t>(r.sources.size());
    std::vector<std::vector<uint32_t>> trisOfGroup(groupCount);
    for (uint32_t t = 0; t < triCount; ++t) {
        if (r.groupOfTri[t] >= groupCount) throw std::runtime_error("coarse triangle names an unknown group");
        trisOfGroup[r.groupOfTri[t]].push_back(t);
    }

    std::atomic<uint32_t> nextGroup{0};
    std::atomic<uint32_t> missed{0};
    auto worker = [&]() {
        uint32_t localMissed = 0;
        for (uint32_t g = nextGroup++; g < groupCount; g = nextGroup++) {
            const SourceSet& src = r.sources[g];
            if (trisOfGroup[g].empty() || src.tris.empty()) continue;
            geometry::ScratchboxMesh surface;
            const uint32_t srcTris = static_cast<uint32_t>(src.tris.size() / 3);
            for (uint32_t s = 0; s < srcTris * 3; ++s) {
                const F3& p = m.positions[src.tris[s]];
                surface.addVertex(geometry::Vertex(math::Vec3(p.x, p.y, p.z)));
                surface.indices.push_back(s);
            }
            bvh::BvhTree tree;
            tree.build(surface);
            const float groupTexel = std::max(r.groupError[g] * 0.5f, r.minTexelWorld);
            // How far the source may sit from the coarse surface: the group's error, and never less than a few texels.
            const float reach = std::max(r.groupError[g] * 2.0f, groupTexel * 4.0f);

            for (uint32_t t : trisOfGroup[g]) {
                const detail::Cell& c = cells[t];
                const F3& a = m.positions[r.coarseTris[t * 3]];
                const F3& b = m.positions[r.coarseTris[t * 3 + 1]];
                const F3& cc = m.positions[r.coarseTris[t * 3 + 2]];
                F3 n = normalize(cross(b - a, cc - a));
                if (dot(n, n) == 0.0f) n = F3(0, 1, 0);
                const float inner = static_cast<float>(c.size - 2 * gutter);
                for (uint32_t j = 0; j < c.size; ++j) {
                    for (uint32_t i = 0; i < c.size; ++i) {
                        float u = (static_cast<float>(i) + 0.5f - gutter) / inner;
                        float v = (static_cast<float>(j) + 0.5f - gutter) / inner;
                        u = std::max(u, 0.0f);
                        v = std::max(v, 0.0f);
                        if (u + v > 1.0f) {
                            const float over = 0.5f * (u + v - 1.0f);
                            u = std::max(u - over, 0.0f);
                            v = std::max(v - over, 0.0f);
                            if (u + v > 1.0f) v = 1.0f - u;
                        }
                        const F3 p = a * (1.0f - u - v) + b * u + cc * v;

                        // Nearest source point along the coarse normal: two rays start `reach` outside the surface on
                        // either side and run through it, so a source lying exactly on the coarse surface (a group
                        // carried up unchanged) is met at t = reach rather than missed at t = 0. Of the two first
                        // hits, the one nearer the texel's point wins; with none, the nearest source point at all.
                        bvh::RayHit best;
                        float bestOffset = std::numeric_limits<float>::max();
                        bool found = false;
                        for (int side = 0; side < 2; ++side) {
                            const F3 d = side == 0 ? n * -1.0f : n;
                            const F3 start = p - d * reach;
                            bvh::RayHit hit;
                            if (tree.raycast(math::Ray(math::Vec3(start.x, start.y, start.z), math::Vec3(d.x, d.y, d.z)), hit) && hit.t <= 2.0f * reach) {
                                const float offset = std::abs(hit.t - reach);
                                if (!found || offset < bestOffset) {
                                    best = hit;
                                    bestOffset = offset;
                                    found = true;
                                }
                            }
                        }
                        uint32_t srcTri = 0;
                        float su = 0.0f, sv = 0.0f;
                        if (found) {
                            srcTri = best.triangleIndex;
                            su = best.u;
                            sv = best.v;
                        } else {
                            ++localMissed;
                            float bestDist = std::numeric_limits<float>::max();
                            F3 bestPoint;
                            for (uint32_t s = 0; s < srcTris; ++s) {
                                const F3 q = detail::closestPointOnTriangle(p, m.positions[src.tris[s * 3]], m.positions[src.tris[s * 3 + 1]], m.positions[src.tris[s * 3 + 2]]);
                                const float d2 = dot(q - p, q - p);
                                if (d2 < bestDist) {
                                    bestDist = d2;
                                    bestPoint = q;
                                    srcTri = s;
                                }
                            }
                            detail::barycentric(bestPoint, m.positions[src.tris[srcTri * 3]], m.positions[src.tris[srcTri * 3 + 1]], m.positions[src.tris[srcTri * 3 + 2]], su, sv);
                        }
                        const F2& uv0 = src.cornerUv[srcTri * 3];
                        const F2& uv1 = src.cornerUv[srcTri * 3 + 1];
                        const F2& uv2 = src.cornerUv[srcTri * 3 + 2];
                        const F2 uv(uv0.x * (1.0f - su - sv) + uv1.x * su + uv2.x * sv, uv0.y * (1.0f - su - sv) + uv1.y * su + uv2.y * sv);
                        const F3 color = r.sample(src.materials[srcTri], uv);
                        uint8_t* px = out.atlas.rgb.data() + (static_cast<size_t>(c.y + j) * width + (c.x + i)) * 3;
                        px[0] = static_cast<uint8_t>(std::clamp(view::srgbEncode(color.x) * 255.0f + 0.5f, 0.0f, 255.0f));
                        px[1] = static_cast<uint8_t>(std::clamp(view::srgbEncode(color.y) * 255.0f + 0.5f, 0.0f, 255.0f));
                        px[2] = static_cast<uint8_t>(std::clamp(view::srgbEncode(color.z) * 255.0f + 0.5f, 0.0f, 255.0f));
                    }
                }
            }
        }
        missed += localMissed;
    };
    const unsigned workers = std::max(1u, std::min(std::thread::hardware_concurrency(), 32u));
    std::vector<std::thread> pool;
    for (unsigned w = 0; w < workers; ++w) pool.emplace_back(worker);
    for (auto& th : pool) th.join();
    out.missed = missed.load();
    return out;
}

} // namespace retex
} // namespace vgeo
} // namespace scratchbox

#endif // SCRATCHBOX_LOD_RETEXTURE_HPP
