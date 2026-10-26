/********************************************************************************
 * Scratchbox Geometry-Driven Weathering Bake
 *
 * Bakes where weather marks a built mesh into a unique texture atlas and returns an
 * overlay shell that carries it: a copy of the receiving surfaces offset a few millimetres
 * along their normals, UV-mapped into the atlas, with an alpha-blended RGBA weathering map.
 * The shell layers over the surfaces' own (tiled) materials, since one glTF material cannot
 * blend two base-colour textures.
 *
 * Atlas: every receiving triangle is charted by the axis its face points along, a depth slab
 * along that axis and a coarse cell in the chart plane, projected orthographically in metres,
 * and the charts are shelf-packed at one texel size. Inside a chart the frontmost surface
 * along the axis owns each texel, which is the surface seen from that side.
 *
 * Every mask is computed from the geometry by ray queries against all occluders:
 *   streaks      - wall texels with something overhead within reach get dirty run-off that
 *                  fades with the drop and is heavier at the ends of the ledge above;
 *   exposure     - cosine-weighted hemisphere rays measure how much rain-bearing sky a
 *                  surface sees: open surfaces wash lighter, sheltered ones gather grime;
 *   cavity       - the share of short hemisphere hits darkens joints, recesses and corners;
 *   rising damp  - a ragged tide line falling off with height above the ground;
 *   soot         - deposits falling off with distance from source points (chimney tops).
 * All strengths are continuous; zero turns a layer off.
 ********************************************************************************/

#ifndef SCRATCHBOX_WEATHERING_HPP
#define SCRATCHBOX_WEATHERING_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_bvh.hpp"
#include "scratchbox_texture.hpp"
#include <vector>
#include <string>
#include <cmath>
#include <algorithm>
#include <cstdint>
#include <map>
#include <thread>
#include <tuple>

namespace scratchbox {
namespace weathering {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using math::Ray;
using geometry::ScratchboxMesh;
using geometry::Vertex;
using texture::ImageBuffer;

struct WeatheringParams {
    float texelM{0.05f};                // atlas texel size (metres)
    int maxAtlasWidth{4096};
    float overlayOffsetM{0.004f};       // shell offset along each face normal

    float streakStrength{0.55f};
    float streakReachM{3.0f};           // how far below a ledge run-off reaches
    float streakColumnM{0.10f};         // lateral scale of the run-off striations
    float streakEndBoost{0.8f};         // extra run-off under the ends of a ledge

    float exposureWash{0.18f};          // lightening of surfaces open to rain-bearing sky
    float shelterGrime{0.30f};          // darkening of sheltered surfaces
    float cavityGrime{0.35f};
    float cavityRadiusM{0.40f};
    int hemisphereSamples{12};
    float skyDistanceM{60.0f};

    float groundY{0.0f};
    float dampHeightM{0.9f};
    float dampStrength{0.45f};

    std::vector<Vec3> sootSources;
    float sootStrength{0.80f};
    float sootRadiusM{3.5f};

    float variation{0.35f};             // large-scale patchiness of every layer, 0..1

    Vec3 grimeColor{0.20f, 0.18f, 0.15f};
    Vec3 streakColor{0.16f, 0.14f, 0.12f};
    Vec3 dampColor{0.17f, 0.19f, 0.14f};
    Vec3 sootColor{0.04f, 0.04f, 0.04f};
    Vec3 washColor{0.93f, 0.91f, 0.87f};
    float decalAging{0.6f};             // how much of a texel's weathering is laid back over its painted decals
    uint32_t seed{5};
};

// An RGBA image projected onto the surfaces inside a box: centred at `center`, facing out along
// `normal` (surfaces facing away are skipped), `up` giving the image's up direction, widthM x heightM
// across and +/- depthM along the normal. Painted into the weathering atlas, so it follows the surface.
struct Decal {
    Vec3 center{0, 0, 0};
    Vec3 normal{0, 0, 1};
    Vec3 up{0, 1, 0};
    float widthM{1.0f};
    float heightM{1.0f};
    float depthM{0.35f};
    float opacity{1.0f};
    ImageBuffer image;
};

// A procedural mark (stain, water mark, patch, moss) as an RGBA decal image: a soft irregular blot
// with optional downward runs, all continuous.
struct BlotParams {
    int sizePx{256};
    Vec3 color{0.25f, 0.22f, 0.18f};
    float opacity{0.65f};
    float edgeNoise{0.45f};             // raggedness of the outline, 0..1
    float softness{0.45f};              // width of the fade at the outline, 0..1
    float mottling{0.35f};              // variation inside the blot, 0..1
    float drips{0.0f};                  // density of downward runs, 0..1
    float dripLength{0.45f};            // run length as a fraction of the image height
    uint32_t seed{9};
};

struct WeatheringResult {
    ScratchboxMesh overlay;
    ImageBuffer atlas;                  // RGBA weathering map
    int chartCount{0};
    int bakedTexels{0};
};

namespace detail {

inline uint32_t hashU(uint32_t x) {
    x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16;
    return x;
}

inline float hash3f(int x, int y, int z, uint32_t seed) {
    uint32_t h = hashU(static_cast<uint32_t>(x) * 73856093u ^ static_cast<uint32_t>(y) * 19349663u ^
                       static_cast<uint32_t>(z) * 83492791u ^ seed * 2654435761u);
    return static_cast<float>(h & 0xffffffu) / static_cast<float>(0xffffff);
}

// Smooth 3D value noise in [-1, 1] at world scale `cell` metres.
inline float noise3(const Vec3& p, float cell, uint32_t seed) {
    float x = p.x / cell, y = p.y / cell, z = p.z / cell;
    int xi = static_cast<int>(std::floor(x)), yi = static_cast<int>(std::floor(y)), zi = static_cast<int>(std::floor(z));
    float fx = x - xi, fy = y - yi, fz = z - zi;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
    auto h = [&](int a, int b, int c) { return hash3f(xi + a, yi + b, zi + c, seed); };
    float x00 = h(0, 0, 0) + (h(1, 0, 0) - h(0, 0, 0)) * fx, x10 = h(0, 1, 0) + (h(1, 1, 0) - h(0, 1, 0)) * fx;
    float x01 = h(0, 0, 1) + (h(1, 0, 1) - h(0, 0, 1)) * fx, x11 = h(0, 1, 1) + (h(1, 1, 1) - h(0, 1, 1)) * fx;
    float y0 = x00 + (x10 - x00) * fy, y1 = x01 + (x11 - x01) * fy;
    return (y0 + (y1 - y0) * fz) * 2.0f - 1.0f;
}

inline float smoothstep(float e0, float e1, float x) {
    float t = std::clamp((x - e0) / std::max(1e-6f, e1 - e0), 0.0f, 1.0f);
    return t * t * (3 - 2 * t);
}

// Axis 0..5 = +X, -X, +Y, -Y, +Z, -Z. Chart plane coordinates (u right, v up) in metres.
inline int dominantAxis(const Vec3& n) {
    float ax = std::abs(n.x), ay = std::abs(n.y), az = std::abs(n.z);
    if (ax >= ay && ax >= az) return n.x >= 0 ? 0 : 1;
    if (ay >= az) return n.y >= 0 ? 2 : 3;
    return n.z >= 0 ? 4 : 5;
}

inline Vec2 planeCoords(int axis, const Vec3& p) {
    switch (axis) {
        case 0: return Vec2(-p.z, p.y);
        case 1: return Vec2(p.z, p.y);
        case 2: return Vec2(p.x, -p.z);
        case 3: return Vec2(p.x, p.z);
        case 4: return Vec2(p.x, p.y);
        default: return Vec2(-p.x, p.y);
    }
}

inline float axisDepth(int axis, const Vec3& p) {
    switch (axis) {
        case 0: return p.x;  case 1: return -p.x;
        case 2: return p.y;  case 3: return -p.y;
        case 4: return p.z;  default: return -p.z;
    }
}

struct Over {
    Vec3 c{0, 0, 0};
    float a{0};
    void layer(const Vec3& col, float alpha) {
        alpha = std::clamp(alpha, 0.0f, 1.0f);
        if (alpha <= 0.0f) return;
        float aOut = alpha + a * (1.0f - alpha);
        c = (col * alpha + c * (a * (1.0f - alpha))) * (1.0f / std::max(1e-6f, aOut));
        a = aOut;
    }
};

} // namespace detail

inline Vec4 sampleRgba(const ImageBuffer& img, float u, float v) {
    if (img.empty() || img.channels < 4) return Vec4(0, 0, 0, 0);
    float x = std::clamp(u, 0.0f, 1.0f) * (img.width - 1), y = std::clamp(v, 0.0f, 1.0f) * (img.height - 1);
    int x0 = static_cast<int>(x), y0 = static_cast<int>(y);
    int x1 = std::min(x0 + 1, img.width - 1), y1 = std::min(y0 + 1, img.height - 1);
    float fx = x - x0, fy = y - y0;
    auto px = [&](int xx, int yy) {
        size_t o = (static_cast<size_t>(yy) * img.width + xx) * 4;
        return Vec4(img.data[o] / 255.0f, img.data[o + 1] / 255.0f, img.data[o + 2] / 255.0f, img.data[o + 3] / 255.0f);
    };
    Vec4 a = px(x0, y0) * (1 - fx) + px(x1, y0) * fx;
    Vec4 b = px(x0, y1) * (1 - fx) + px(x1, y1) * fx;
    return a * (1 - fy) + b * fy;
}

inline ImageBuffer synthesizeBlot(const BlotParams& bp) {
    using namespace detail;
    const int n = std::clamp(bp.sizePx, 16, 2048);
    ImageBuffer img(n, n, 4);
    // Columns where runs leave the blot.
    std::vector<std::pair<float, float>> runs;
    int runCount = static_cast<int>(std::round(bp.drips * 14.0f));
    for (int r = 0; r < runCount; ++r) {
        runs.emplace_back(0.25f + 0.5f * hash3f(r, 1, 2, bp.seed), 0.006f + 0.018f * hash3f(r, 3, 4, bp.seed));
    }
    for (int y = 0; y < n; ++y) {
        for (int x = 0; x < n; ++x) {
            float u = (x + 0.5f) / n - 0.5f, v = (y + 0.5f) / n - 0.5f;
            float r = std::sqrt(u * u + v * v);
            float ang = std::atan2(v, u);
            Vec3 ring(std::cos(ang) * 1.5f, std::sin(ang) * 1.5f, 0.0f);
            float edge = 0.40f * (1.0f + bp.edgeNoise * 0.55f * noise3(ring, 0.45f, bp.seed) + bp.edgeNoise * 0.2f * noise3(ring, 0.15f, bp.seed + 1));
            float fade = std::max(0.01f, edge * bp.softness);
            float a = 1.0f - smoothstep(edge - fade, edge, r);
            for (const auto& run : runs) {
                float du = std::abs(u + 0.5f - run.first) - run.second;
                if (du < 0.0f && v > 0.0f && v < bp.dripLength) a = std::max(a, (1.0f - v / bp.dripLength) * 0.85f);
            }
            float mott = 1.0f + bp.mottling * 0.6f * noise3(Vec3(u * 9.0f, v * 9.0f, 0.5f), 1.0f, bp.seed + 2);
            a = std::clamp(a * bp.opacity * mott, 0.0f, 1.0f);
            Vec3 c = bp.color * (1.0f + bp.mottling * 0.25f * noise3(Vec3(u * 5.0f, v * 5.0f, 2.0f), 1.0f, bp.seed + 3));
            size_t o = (static_cast<size_t>(y) * n + x) * 4;
            img.data[o] = static_cast<uint8_t>(std::clamp(c.x, 0.0f, 1.0f) * 255.0f + 0.5f);
            img.data[o + 1] = static_cast<uint8_t>(std::clamp(c.y, 0.0f, 1.0f) * 255.0f + 0.5f);
            img.data[o + 2] = static_cast<uint8_t>(std::clamp(c.z, 0.0f, 1.0f) * 255.0f + 0.5f);
            img.data[o + 3] = static_cast<uint8_t>(a * 255.0f + 0.5f);
        }
    }
    return img;
}

/**
 * A panel decal: a widthM x heightM quad standing standoffM off the surface along `normal`
 * (image top towards `up`, UV (0,0) at the top-left), plus edge faces when thicknessM > 0
 * (sign boards, plaques). The caller attaches the image as the material's base colour.
 */
inline ScratchboxMesh makeDecalPanel(const Vec3& center, const Vec3& normal, const Vec3& up, float widthM, float heightM,
                                     float thicknessM, float standoffM, const std::string& name) {
    ScratchboxMesh mesh(name);
    Vec3 N = normal.normalized();
    Vec3 R = up.cross(N).normalized();
    Vec3 U = N.cross(R);
    Vec3 back = center + N * standoffM, front = back + N * std::max(0.0f, thicknessM);
    Vec3 hr = R * (widthM * 0.5f), hu = U * (heightM * 0.5f);
    auto quad = [&](const Vec3& a, const Vec3& b, const Vec3& c, const Vec3& d, const Vec3& nrm,
                    Vec2 ua, Vec2 ub, Vec2 uc, Vec2 ud) {
        uint32_t base = static_cast<uint32_t>(mesh.vertices.size());
        Vec4 tangent(R.x, R.y, R.z, 1.0f);
        mesh.addVertex(Vertex(a, nrm, ua, Vec4(1, 1, 1, 1), tangent));
        mesh.addVertex(Vertex(b, nrm, ub, Vec4(1, 1, 1, 1), tangent));
        mesh.addVertex(Vertex(c, nrm, uc, Vec4(1, 1, 1, 1), tangent));
        mesh.addVertex(Vertex(d, nrm, ud, Vec4(1, 1, 1, 1), tangent));
        bool ccw = (b - a).cross(c - a).dot(nrm) >= 0.0f;
        if (ccw) { mesh.addTriangle(base, base + 1, base + 2); mesh.addTriangle(base, base + 2, base + 3); }
        else { mesh.addTriangle(base, base + 2, base + 1); mesh.addTriangle(base, base + 3, base + 2); }
    };
    quad(front - hr - hu, front + hr - hu, front + hr + hu, front - hr + hu, N,
         Vec2(0, 1), Vec2(1, 1), Vec2(1, 0), Vec2(0, 0));
    if (thicknessM > 0.0f) {
        quad(back - hr + hu, back + hr + hu, front + hr + hu, front - hr + hu, U, Vec2(0, 0.01f), Vec2(1, 0.01f), Vec2(1, 0.01f), Vec2(0, 0.01f));
        quad(back + hr - hu, back - hr - hu, front - hr - hu, front + hr - hu, -U, Vec2(1, 0.99f), Vec2(0, 0.99f), Vec2(0, 0.99f), Vec2(1, 0.99f));
        quad(back + hr + hu, back + hr - hu, front + hr - hu, front + hr + hu, R, Vec2(0.99f, 0), Vec2(0.99f, 1), Vec2(0.99f, 1), Vec2(0.99f, 0));
        quad(back - hr - hu, back - hr + hu, front - hr + hu, front - hr - hu, -R, Vec2(0.01f, 1), Vec2(0.01f, 0), Vec2(0.01f, 0), Vec2(0.01f, 1));
    }
    mesh.material.name = name;
    mesh.material.baseColorFactor = Vec4(1, 1, 1, 1);
    mesh.material.roughnessFactor = 0.7f;
    mesh.material.metallicFactor = 0.0f;
    mesh.material.alphaMode = "MASK";
    mesh.material.alphaCutoff = 0.5f;
    mesh.recomputeBounds();
    return mesh;
}

inline WeatheringResult bakeWeathering(const std::vector<ScratchboxMesh>& receivers,
                                       const std::vector<ScratchboxMesh>& occluders,
                                       const WeatheringParams& prm,
                                       const std::string& name = "Weathering",
                                       const std::vector<Decal>& decals = {}) {
    using namespace detail;
    WeatheringResult result;
    result.overlay = ScratchboxMesh(name);

    // One BVH over every occluding surface.
    ScratchboxMesh scene("weathering_occluders");
    for (const auto& m : occluders) {
        uint32_t base = static_cast<uint32_t>(scene.vertices.size());
        for (const auto& v : m.vertices) scene.addVertex(v);
        for (size_t i = 0; i + 2 < m.indices.size(); i += 3) {
            scene.addTriangle(base + m.indices[i], base + m.indices[i + 1], base + m.indices[i + 2]);
        }
    }
    bvh::BvhTree tree;
    if (scene.indices.empty() || !tree.build(scene)) return result;

    // 1. Chart every receiving triangle.
    struct Tri { Vec3 p[3]; Vec3 n[3]; Vec3 faceN; int axis; Vec2 q[3]; int chart; };
    std::vector<Tri> tris;
    std::map<std::tuple<int, int, int, int>, int> chartIndex;
    struct Chart { Vec2 lo{1e30f, 1e30f}; Vec2 hi{-1e30f, -1e30f}; int axis{0}; int x{0}, y{0}, w{0}, h{0}; };
    std::vector<Chart> charts;
    const float slab = 0.75f, cell = 4.0f;
    for (const auto& m : receivers) {
        for (size_t i = 0; i + 2 < m.indices.size(); i += 3) {
            Tri t;
            for (int k = 0; k < 3; ++k) {
                const Vertex& v = m.vertices[m.indices[i + k]];
                t.p[k] = v.position; t.n[k] = v.normal;
            }
            Vec3 fn = (t.p[1] - t.p[0]).cross(t.p[2] - t.p[0]);
            float len = fn.length();
            if (len < 1e-10f) continue;
            t.faceN = fn / len;
            t.axis = dominantAxis(t.faceN);
            Vec3 c = (t.p[0] + t.p[1] + t.p[2]) * (1.0f / 3.0f);
            Vec2 cq = planeCoords(t.axis, c);
            auto key = std::make_tuple(t.axis, static_cast<int>(std::floor(axisDepth(t.axis, c) / slab)),
                                       static_cast<int>(std::floor(cq.x / cell)), static_cast<int>(std::floor(cq.y / cell)));
            auto it = chartIndex.find(key);
            if (it == chartIndex.end()) {
                it = chartIndex.emplace(key, static_cast<int>(charts.size())).first;
                charts.push_back(Chart{});
                charts.back().axis = t.axis;
            }
            t.chart = it->second;
            Chart& ch = charts[t.chart];
            for (int k = 0; k < 3; ++k) {
                t.q[k] = planeCoords(t.axis, t.p[k]);
                ch.lo = Vec2(std::min(ch.lo.x, t.q[k].x), std::min(ch.lo.y, t.q[k].y));
                ch.hi = Vec2(std::max(ch.hi.x, t.q[k].x), std::max(ch.hi.y, t.q[k].y));
            }
            tris.push_back(t);
        }
    }
    if (tris.empty()) return result;

    // 2. Shelf-pack charts (tallest first) with a 2-texel gutter.
    const float texel = std::max(0.005f, prm.texelM);
    const int pad = 2;
    std::vector<int> order(charts.size());
    for (size_t i = 0; i < charts.size(); ++i) {
        Chart& ch = charts[i];
        ch.w = std::max(1, static_cast<int>(std::ceil((ch.hi.x - ch.lo.x) / texel))) + 1;
        ch.h = std::max(1, static_cast<int>(std::ceil((ch.hi.y - ch.lo.y) / texel))) + 1;
        order[i] = static_cast<int>(i);
    }
    double area = 0;
    for (const auto& ch : charts) area += static_cast<double>(ch.w + 2 * pad) * (ch.h + 2 * pad);
    int widest = 0;
    for (const auto& ch : charts) widest = std::max(widest, ch.w + 2 * pad);
    int atlasW = std::clamp(static_cast<int>(std::ceil(std::sqrt(area * 1.15))), widest, std::max(widest, prm.maxAtlasWidth));
    std::sort(order.begin(), order.end(), [&](int a, int b) { return charts[a].h > charts[b].h; });
    int penX = 0, penY = 0, shelfH = 0;
    for (int idx : order) {
        Chart& ch = charts[idx];
        if (penX + ch.w + 2 * pad > atlasW) { penX = 0; penY += shelfH; shelfH = 0; }
        ch.x = penX + pad; ch.y = penY + pad;
        penX += ch.w + 2 * pad;
        shelfH = std::max(shelfH, ch.h + 2 * pad);
    }
    const int atlasH = penY + shelfH;
    result.chartCount = static_cast<int>(charts.size());

    // 3. Rasterise: each texel takes the frontmost surface along its chart's axis.
    const size_t texCount = static_cast<size_t>(atlasW) * atlasH;
    std::vector<Vec3> texPos(texCount), texNrm(texCount);
    std::vector<float> texDepth(texCount, -1e30f);
    std::vector<uint8_t> valid(texCount, 0);
    for (const Tri& t : tris) {
        const Chart& ch = charts[t.chart];
        Vec2 s[3];
        for (int k = 0; k < 3; ++k) s[k] = Vec2(ch.x + (t.q[k].x - ch.lo.x) / texel, ch.y + (t.q[k].y - ch.lo.y) / texel);
        float area2 = (s[1].x - s[0].x) * (s[2].y - s[0].y) - (s[2].x - s[0].x) * (s[1].y - s[0].y);
        if (std::abs(area2) < 1e-8f) continue;
        int x0 = std::max(0, static_cast<int>(std::floor(std::min({s[0].x, s[1].x, s[2].x}))));
        int x1 = std::min(atlasW - 1, static_cast<int>(std::ceil(std::max({s[0].x, s[1].x, s[2].x}))));
        int y0 = std::max(0, static_cast<int>(std::floor(std::min({s[0].y, s[1].y, s[2].y}))));
        int y1 = std::min(atlasH - 1, static_cast<int>(std::ceil(std::max({s[0].y, s[1].y, s[2].y}))));
        for (int y = y0; y <= y1; ++y) {
            for (int x = x0; x <= x1; ++x) {
                float px = x + 0.5f, py = y + 0.5f;
                float w0 = ((s[1].x - px) * (s[2].y - py) - (s[2].x - px) * (s[1].y - py)) / area2;
                float w1 = ((s[2].x - px) * (s[0].y - py) - (s[0].x - px) * (s[2].y - py)) / area2;
                float w2 = 1.0f - w0 - w1;
                const float eps = -0.02f;
                if (w0 < eps || w1 < eps || w2 < eps) continue;
                Vec3 p = t.p[0] * w0 + t.p[1] * w1 + t.p[2] * w2;
                float depth = axisDepth(t.axis, p);
                size_t i = static_cast<size_t>(y) * atlasW + x;
                if (depth <= texDepth[i]) continue;
                texDepth[i] = depth; texPos[i] = p; texNrm[i] = t.faceN; valid[i] = 1;
            }
        }
    }

    // 4. Shade every valid texel from ray queries, in parallel rows.
    std::vector<Vec4> shaded(texCount, Vec4(0, 0, 0, 0));
    const Vec3 up(0, 1, 0);
    const int samples = std::max(4, prm.hemisphereSamples);
    auto shadeRows = [&](int rowBegin, int rowEnd) {
        for (int y = rowBegin; y < rowEnd; ++y) {
            for (int x = 0; x < atlasW; ++x) {
                size_t i = static_cast<size_t>(y) * atlasW + x;
                if (!valid[i]) continue;
                const Vec3 n = texNrm[i];
                const Vec3 p = texPos[i] + n * 0.01f;
                Vec3 tan = up.cross(n);
                if (tan.length() < 1e-3f) tan = Vec3(1, 0, 0);
                tan = tan.normalized();
                Vec3 bit = n.cross(tan);

                // Hemisphere: rain-weighted openness and short-range cavity hits.
                float rot = hash3f(x, y, 7, prm.seed) * math::TWO_PI;
                float rainOpen = 0, rainTotal = 0, close = 0;
                for (int k = 0; k < samples; ++k) {
                    float u1 = (k + 0.5f) / samples;
                    float phi = rot + k * 2.39996323f;
                    float r = std::sqrt(u1);
                    Vec3 dir = (tan * (r * std::cos(phi)) + bit * (r * std::sin(phi)) + n * std::sqrt(1.0f - u1)).normalized();
                    bvh::RayHit hit;
                    bool blocked = tree.raycast(Ray(p, dir), hit) && hit.t < prm.skyDistanceM;
                    float rainW = std::max(0.0f, dir.y) + 0.15f;
                    rainTotal += rainW;
                    if (!blocked) rainOpen += rainW;
                    if (blocked && hit.t < prm.cavityRadiusM) close += 1.0f;
                }
                float exposure = rainTotal > 0 ? rainOpen / rainTotal : 0.0f;
                float cavity = close / samples;

                float patch = 1.0f + prm.variation * noise3(texPos[i], 2.5f, prm.seed + 11);
                Over o;
                if (n.y > -0.3f) o.layer(prm.washColor, prm.exposureWash * smoothstep(0.35f, 0.9f, exposure) * patch);
                o.layer(prm.grimeColor, prm.shelterGrime * (1.0f - exposure) * patch);
                o.layer(prm.grimeColor, prm.cavityGrime * cavity * patch);

                // Rising damp with a ragged tide line.
                if (prm.dampStrength > 0) {
                    float h = texPos[i].y - prm.groundY;
                    float line = prm.dampHeightM * (1.0f + 0.35f * noise3(texPos[i], 0.6f, prm.seed + 3));
                    o.layer(prm.dampColor, prm.dampStrength * (1.0f - smoothstep(0.45f * line, line, h)));
                }

                // Run-off below anything overhead, heavier under ledge ends.
                if (prm.streakStrength > 0 && std::abs(n.y) < 0.6f) {
                    auto overhead = [&](const Vec3& from) {
                        bvh::RayHit hit;
                        return tree.raycast(Ray(from, up), hit) && hit.t < prm.streakReachM ? hit.t : -1.0f;
                    };
                    float drop = overhead(p);
                    if (drop > 0) {
                        float side = std::max(0.05f, prm.streakColumnM * 2.5f);
                        bool endL = overhead(p - tan * side) < 0, endR = overhead(p + tan * side) < 0;
                        float lateral = texPos[i].dot(tan);
                        float columns = 0.5f + 0.5f * noise3(Vec3(lateral, texPos[i].y * 0.08f, 0), prm.streakColumnM, prm.seed + 5);
                        float fade = std::exp(-drop / std::max(0.05f, prm.streakReachM * 0.45f));
                        float amount = prm.streakStrength * fade * (0.35f + 0.65f * columns) * (1.0f + prm.streakEndBoost * ((endL || endR) ? 1.0f : 0.0f));
                        o.layer(prm.streakColor, amount * patch);
                    }
                }

                // Soot falling off with distance from each source.
                for (const Vec3& srcPt : prm.sootSources) {
                    Vec3 d = srcPt - texPos[i];
                    float dist = d.length();
                    float facing = 0.75f + 0.25f * std::max(0.0f, n.dot(d * (1.0f / std::max(1e-4f, dist))));
                    o.layer(prm.sootColor, prm.sootStrength * std::exp(-dist / std::max(0.1f, prm.sootRadiusM)) * facing);
                }

                // Painted decals over the weathering, then part of the weathering laid back on top.
                bool painted = false;
                Over withDecals = o;
                for (const Decal& dc : decals) {
                    Vec3 dN = dc.normal.normalized();
                    Vec3 rel = texPos[i] - dc.center;
                    if (std::abs(rel.dot(dN)) > dc.depthM || n.dot(dN) < 0.3f) continue;
                    Vec3 dR = dc.up.cross(dN).normalized();
                    Vec3 dU = dN.cross(dR);
                    float lu = rel.dot(dR) / dc.widthM + 0.5f, lv = rel.dot(dU) / dc.heightM + 0.5f;
                    if (lu < 0 || lu > 1 || lv < 0 || lv > 1) continue;
                    Vec4 sample = sampleRgba(dc.image, lu, 1.0f - lv);
                    withDecals.layer(Vec3(sample.x, sample.y, sample.z), sample.w * dc.opacity);
                    painted = true;
                }
                if (painted) {
                    withDecals.layer(o.c, o.a * prm.decalAging);
                    o = withDecals;
                }

                shaded[i] = Vec4(o.c.x, o.c.y, o.c.z, o.a);
            }
        }
    };
    int threads = std::max(1, static_cast<int>(std::thread::hardware_concurrency()));
    std::vector<std::thread> pool;
    for (int t = 0; t < threads; ++t) {
        int r0 = atlasH * t / threads, r1 = atlasH * (t + 1) / threads;
        pool.emplace_back(shadeRows, r0, r1);
    }
    for (auto& th : pool) th.join();

    // 5. Write the atlas, bleeding baked texels into the gutters so filtering never reads blank.
    result.atlas = ImageBuffer(atlasW, atlasH, 4);
    std::vector<uint8_t> filled = valid;
    for (int pass = 0; pass < pad + 1; ++pass) {
        std::vector<uint8_t> next = filled;
        for (int y = 0; y < atlasH; ++y) {
            for (int x = 0; x < atlasW; ++x) {
                size_t i = static_cast<size_t>(y) * atlasW + x;
                if (filled[i]) continue;
                Vec4 sum(0, 0, 0, 0); int count = 0;
                for (int dy = -1; dy <= 1; ++dy) for (int dx = -1; dx <= 1; ++dx) {
                    int xx = x + dx, yy = y + dy;
                    if (xx < 0 || yy < 0 || xx >= atlasW || yy >= atlasH) continue;
                    size_t j = static_cast<size_t>(yy) * atlasW + xx;
                    if (!filled[j]) continue;
                    sum = sum + shaded[j]; ++count;
                }
                if (count > 0) { shaded[i] = sum * (1.0f / count); next[i] = 1; }
            }
        }
        filled.swap(next);
    }
    for (int y = 0; y < atlasH; ++y) {
        for (int x = 0; x < atlasW; ++x) {
            size_t i = static_cast<size_t>(y) * atlasW + x;
            size_t o = (static_cast<size_t>(y) * atlasW + x) * 4;
            const Vec4& c = shaded[i];
            result.atlas.data[o] = static_cast<uint8_t>(std::clamp(c.x, 0.0f, 1.0f) * 255.0f + 0.5f);
            result.atlas.data[o + 1] = static_cast<uint8_t>(std::clamp(c.y, 0.0f, 1.0f) * 255.0f + 0.5f);
            result.atlas.data[o + 2] = static_cast<uint8_t>(std::clamp(c.z, 0.0f, 1.0f) * 255.0f + 0.5f);
            result.atlas.data[o + 3] = static_cast<uint8_t>(std::clamp(c.w, 0.0f, 1.0f) * 255.0f + 0.5f);
            if (valid[i]) ++result.bakedTexels;
        }
    }

    // 6. Overlay shell: receivers offset along their face normals, UVs into the atlas
    //    (glTF UV origin top-left, so v runs down the image).
    ScratchboxMesh& shell = result.overlay;
    for (const Tri& t : tris) {
        const Chart& ch = charts[t.chart];
        uint32_t base = static_cast<uint32_t>(shell.vertices.size());
        for (int k = 0; k < 3; ++k) {
            float ux = (ch.x + (t.q[k].x - ch.lo.x) / texel) / atlasW;
            float vy = (ch.y + (t.q[k].y - ch.lo.y) / texel) / atlasH;
            Vertex v(t.p[k] + t.faceN * prm.overlayOffsetM, t.n[k], Vec2(ux, vy), Vec4(1, 1, 1, 1));
            shell.addVertex(v);
        }
        shell.addTriangle(base, base + 1, base + 2);
    }
    shell.material.name = name;
    shell.material.baseColorFactor = Vec4(1, 1, 1, 1);
    shell.material.roughnessFactor = 0.95f;
    shell.material.metallicFactor = 0.0f;
    shell.material.alphaMode = "BLEND";
    shell.recomputeBounds();
    return result;
}

} // namespace weathering
} // namespace scratchbox

#endif // SCRATCHBOX_WEATHERING_HPP
