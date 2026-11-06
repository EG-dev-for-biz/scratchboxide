/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#pragma once

/**
 * Grass field: real blade geometry grown over the ground cells a grass mask marks, as a few clump variants
 * (GrassClumpGenerator: V-keel blades, gravitropic droop, splay, senescent tips) and one instance list per variant.
 *
 * Placement: a jittered grid at the spacing the density asks for (blue noise: one sample per stratum), each sample kept
 * with the probability of its cell's confidence, only on mask cells, only inside a band around a centre (the near ground;
 * far ground stays the tile photo), and only where no excluded cell (a building footprint, water) lies within the clump's
 * reach, so no blade stands over one in plan. Past `maxInstances`, the samples nearest the centre are kept and the radius
 * reached is reported. Each instance stands on the scan's own surface where the scan has one within `snapM` of the
 * cell's surface (measured; of the scan's heights at that point, the nearest), else on the cell surface (bilinear
 * between cell centres; an estimate under crowns), turned about the vertical,
 * scaled, and tinted toward its cell's photo colour (linear RGB, relative to the clump's own mid tone).
 *
 * Distance: a blade a few millimetres wide falls under a pixel some metres out, so the clump variants are built in rings
 * around the band's centre (the viewer's place): in ring r the blades are 2^r times wider and fewer (coverage per clump
 * kept), r the doubling that brings a blade to `pixelAngle` x its distance from the centre, capped at `maxWidthScale`.
 * `pixelAngle` 0 keeps one ring.
 *
 * Density cues. A real lawn reads dense because no ground shows between its blades, not because each blade is seen:
 *   - self-occlusion: the lower part of every blade lies in its neighbours' shade, so the vertex tone climbs from
 *     `rootShade` at the root to full at `occlusionHeight` of the blade;
 *   - an underlayer: a sheet lifted `underlayerLiftM` over the grass cells within `underlayerRadiusM`, standing on the
 *     scan's surface, in the cell's photo colour darkened to `underlayerShade` (the dense lower grass seen from above) and
 *     further by `contactShade` where clumps stand, fading back to the photo colour over `underlayerFadeM` at the grass
 *     edge and over the last `underlayerRadialFade` of its radius, and carrying a tiling blade-detail texture (strokes at
 *     blade scale, `detailTileM` a tile);
 *   - shells (the fur method) for the near ground: `shellLayers` copies of the underlayer within `shellRadiusM`, stacked
 *     up to `shellHeightM`, sharing one texture of blade cross-sections (`shellBladesPerM2`, gathered in tufts, each a
 *     flat sliver in its own direction; `shellTileM` a tile) whose alpha is the height the blade at each texel reaches
 *     (tapering); layer i is drawn where that height passes i / shellLayers (glTF alpha mask, cutoff per layer), so many
 *     thousand blade cross-sections per m2 cost a few triangles; tone climbs from `shellBottomTone` of the underlayer's
 *     to `shellTopTone` of it at the top, with a slow brightness swell that hides the tile's repeat; vertex alpha
 *     thins them out at the rim and the grass edge. Needs the underlayer (they are built on its lattice).
 *
 * Every shape quantity is a continuous parameter: blade height and width, keel depth, droop, splay, curl, clump radius,
 * senescence; nothing selects a grass kind.
 *
 * Input (SBGF v2, little endian): "SBGF" u32 2, u32 nx, u32 nz, f32 x0, f32 z0, f32 cellM, then per cell arrays:
 * u8 mask[N] (0 = not grass), u8 exclude[N] (non-zero = never grown over), f32 confidence[N], f32 surfaceY[N],
 * f32 colour[N * 3] (linear RGB lit photo colour of the cell; 0,0,0 = none), then u32 nTri and nTri * 9 f32: the scan's
 * triangles over the band (x y z per corner; 0 triangles = no snapping).
 *
 * Output: underlayer.bin (positions f32x3, normals f32x3, colours f32x4, uvs f32x2, indices u32) and detail.rgba (the
 * detail texture, RGBA8), counts in report.json's `underlayer`; shells.bin (the same layout, layer after layer, each
 * layer's indices a run of report.json's `shells.indicesPerLayer`) and shell.rgba; mesh.bin (per variant: positions f32x3, normals f32x3, colours f32x4, indices u32) and instances.bin (per
 * variant: translation f32x3, rotation f32x4 (x y z w), scale f32x3, colour f32x3, confidence f32: its cell's mask
 * confidence), laid out as report.json says.
 */

#include "scratchbox_nature.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

namespace scratchbox::grass_field {

using math::Vec4;
using nature::GrassClumpConfig;
using nature::GrassClumpGenerator;

struct Params {
    // placement
    double densityPerM2 = 8.0;      // clumps per m2 on a cell of confidence 1
    double minConfidence = 0.0;     // cells below are left bare
    double centreX = 0.0, centreZ = 0.0;
    double bandRadiusM = 60.0;      // ground farther from the centre stays the tile photo
    double maxInstances = 150000;
    double edgeMarginM = 0.05;      // extra clearance from an excluded cell, past the clump's reach
    double snapM = 0.75;            // farthest the scan's surface may lie from the cell surface and still carry a clump
    double jitter = 0.85;           // share of a stratum a sample may move (1 = anywhere in it)
    double scaleMin = 0.8, scaleMax = 1.25;
    double heightJitter = 0.2;      // extra vertical scale spread, +-
    double tintJitter = 0.08;       // per-instance brightness spread, +-
    double variants = 4;
    double seed = 1;
    // clump shape (GrassClumpConfig, continuous)
    double bladeCount = 30, clumpRadius = 0.11;
    double bladeHeightMin = 0.06, bladeHeightMax = 0.14;
    double bladeWidthBase = 0.004, bladeWidthMid = 0.005, keelDepth = 0.0015;
    double segmentsPerBlade = 5;      // spine segments of the near blades (ring 0)
    double farSegmentsPerBlade = 2;   // spine segments of the widened blades (rings 1 and out), whose curve is not seen
    double gravityDroop = 0.3, radialSplay = 0.5, curlStochasticity = 0.25, centerHeightBias = 0.3;
    double clumpNormalBlend = 0.35;
    double senescence = 0.2;        // how far the tip goes toward straw (0 = all green)
    // distance rings
    // self-occlusion up the blade
    double rootShade = 0.3;         // tone at the root, relative to the lit lamina
    double occlusionHeight = 0.6;   // share of the blade the shade climbs
    // underlayer
    double underlayerRadiusM = 40;  // 0 = none
    double underlayerSpacingM = 0.25;
    double underlayerLiftM = 0.02;
    double underlayerShade = 0.78;  // the lower grass seen from above, relative to the photo colour (which already averages blades and gaps)
    double contactShade = 0.25;     // further darkening where clumps stand
    double underlayerRadialFade = 0.25; // share of the radius over which the sheet fades back to the photo colour at its rim
    double contactRadiusM = 0.3;
    double underlayerFadeM = 1.5;   // at the grass edge the shade fades back to the photo colour over this
    double detailTexPx = 256, detailTileM = 0.5;
    // shells
    double shellRadiusM = 12;       // 0 = none; within the underlayer
    double shellLayers = 12;
    double shellHeightM = 0.09;
    double shellBladesPerM2 = 8000;
    double shellTileM = 1.0, shellTexPx = 1024;
    double shellTuftsPerM2 = 40, shellTuftRadiusM = 0.08, shellTuftShare = 0.25;  // blades gathered in tufts
    // tone of the bottom and top layers relative to the underlayer's (the floor they stand on): flat layers catch the
    // overhead light fully where an upright blade catches less, so they stay at or below the floor's tone
    double shellBottomTone = 0.8, shellTopTone = 1.0;
    double shellToneNoise = 0.12, shellNoiseCellM = 0.7;                          // slow brightness swell
    double pixelAngle = 0.0015;     // radians a pixel spans (about 1 px at 1000 px over 60 degrees); 0 = no rings
    double maxWidthScale = 16;      // widest blade, as a multiple of the near blade

    void set(const std::string& k, double v) {
#define SB_GF_P(name) if (k == #name) { name = v; return; }
        SB_GF_P(densityPerM2) SB_GF_P(minConfidence) SB_GF_P(centreX) SB_GF_P(centreZ) SB_GF_P(bandRadiusM) SB_GF_P(maxInstances)
        SB_GF_P(edgeMarginM) SB_GF_P(snapM) SB_GF_P(jitter) SB_GF_P(scaleMin) SB_GF_P(scaleMax) SB_GF_P(heightJitter) SB_GF_P(tintJitter)
        SB_GF_P(variants) SB_GF_P(seed) SB_GF_P(bladeCount) SB_GF_P(clumpRadius) SB_GF_P(bladeHeightMin) SB_GF_P(bladeHeightMax)
        SB_GF_P(bladeWidthBase) SB_GF_P(bladeWidthMid) SB_GF_P(keelDepth) SB_GF_P(segmentsPerBlade) SB_GF_P(farSegmentsPerBlade) SB_GF_P(gravityDroop)
        SB_GF_P(radialSplay) SB_GF_P(curlStochasticity) SB_GF_P(centerHeightBias) SB_GF_P(clumpNormalBlend) SB_GF_P(senescence)
        SB_GF_P(pixelAngle) SB_GF_P(maxWidthScale) SB_GF_P(rootShade) SB_GF_P(occlusionHeight)
        SB_GF_P(underlayerRadiusM) SB_GF_P(underlayerSpacingM) SB_GF_P(underlayerLiftM) SB_GF_P(underlayerShade)
        SB_GF_P(contactShade) SB_GF_P(contactRadiusM) SB_GF_P(underlayerFadeM) SB_GF_P(underlayerRadialFade) SB_GF_P(detailTexPx) SB_GF_P(detailTileM)
        SB_GF_P(shellRadiusM) SB_GF_P(shellLayers) SB_GF_P(shellHeightM) SB_GF_P(shellBladesPerM2) SB_GF_P(shellTileM) SB_GF_P(shellTexPx)
        SB_GF_P(shellTuftsPerM2) SB_GF_P(shellTuftRadiusM) SB_GF_P(shellTuftShare) SB_GF_P(shellBottomTone) SB_GF_P(shellTopTone) SB_GF_P(shellToneNoise) SB_GF_P(shellNoiseCellM)
#undef SB_GF_P
        throw std::runtime_error("unknown parameter " + k);
    }
};

struct Grid {
    uint32_t nx = 0, nz = 0;
    float x0 = 0, z0 = 0, cellM = 1;
    std::vector<uint8_t> mask, exclude;
    std::vector<float> confidence, surfaceY, colour;
    std::vector<float> tris;  // nTri * 9
};

inline Grid readInput(const std::string& file) {
    std::ifstream f(file, std::ios::binary);
    if (!f) throw std::runtime_error("cannot read " + file);
    std::vector<char> b((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
    size_t o = 0;
    auto take = [&](void* dst, size_t n) {
        if (o + n > b.size()) throw std::runtime_error("SBGF input is truncated");
        std::memcpy(dst, b.data() + o, n); o += n;
    };
    char magic[4]; take(magic, 4);
    if (std::memcmp(magic, "SBGF", 4) != 0) throw std::runtime_error("not an SBGF file");
    uint32_t version; take(&version, 4);
    if (version != 2) throw std::runtime_error("SBGF version " + std::to_string(version) + " is not 2");
    Grid g;
    take(&g.nx, 4); take(&g.nz, 4); take(&g.x0, 4); take(&g.z0, 4); take(&g.cellM, 4);
    if (!(g.cellM > 0)) throw std::runtime_error("cellM must be positive");
    const size_t N = size_t(g.nx) * g.nz;
    g.mask.resize(N); g.exclude.resize(N); g.confidence.resize(N); g.surfaceY.resize(N); g.colour.resize(N * 3);
    take(g.mask.data(), N); take(g.exclude.data(), N); take(g.confidence.data(), N * 4); take(g.surfaceY.data(), N * 4); take(g.colour.data(), N * 12);
    uint32_t nTri; take(&nTri, 4);
    g.tris.resize(size_t(nTri) * 9);
    take(g.tris.data(), g.tris.size() * 4);
    return g;
}

/** A stateless hash to [0, 1): the same sample always draws the same numbers, whatever else the field holds. */
inline double hash01(uint64_t a, uint64_t b, uint64_t salt) {
    uint64_t h = a * 0x9E3779B97F4A7C15ull ^ (b + 0x632BE59BD9B4E019ull) * 0xC2B2AE3D27D4EB4Full ^ salt * 0x165667B19E3779F9ull;
    h ^= h >> 33; h *= 0xFF51AFD7ED558CCDull; h ^= h >> 33; h *= 0xC4CEB9FE1A85EC53ull; h ^= h >> 33;
    return double(h >> 11) * (1.0 / 9007199254740992.0);
}

struct Instance { float t[3], r[4], s[3], c[3], conf; double d; bool snapped; };

struct Variant { geometry::Mesh mesh; std::vector<Instance> instances; int ring = 0; double widthScale = 1; };

/** The sheet under the blades, and its detail texture. */
struct Underlayer {
    std::vector<float> positions, normals, colours, uvs;
    std::vector<uint32_t> indices;
    std::vector<uint8_t> texture;
    int texPx = 0;
    double areaM2 = 0, textureMean = 0;
    // per vertex, for the shells: the photo colour, how far inside the grass (0..1), the distance from the centre
    std::vector<float> photo, inside, dist;
};

/** The shells: layer after layer in one vertex array, each layer's triangles a run of `indicesPerLayer`. */
struct Shells {
    std::vector<float> positions, normals, colours, uvs;
    std::vector<uint32_t> indices;
    std::vector<uint8_t> texture;
    int texPx = 0, layers = 0;
    size_t indicesPerLayer = 0;
    double areaM2 = 0, textureMean = 0, bladesPerM2 = 0;
};

struct Stats {
    long strata = 0, notGrass = 0, lowConfidence = 0, outsideBand = 0, nearExcluded = 0, thinned = 0, overBudget = 0, snapped = 0, unsnapped = 0;
    double expected = 0, bandGrassM2 = 0, radiusReachedM = 0;
};

/** The vertex tone of the clump's lamina: the instance colour is the photo colour relative to it. */
constexpr float kMidTone = 0.8f;

class GrassField {
public:
    GrassField(Grid g, Params p) : g_(std::move(g)), p_(p) {}

    /** The farthest any blade of a clump reaches from its anchor in plan, at scale 1, with blades `widthScale` times the near ones (m); by default the widest ring's. */
    double reach(double widthScale = -1) const {
        const double h = p_.bladeHeightMax * (1 + p_.centerHeightBias);
        return p_.clumpRadius + h * 0.8 * (p_.radialSplay + p_.curlStochasticity) + p_.bladeWidthMid * (widthScale > 0 ? widthScale : std::ldexp(1.0, rings() - 1));
    }

    /** Rings the band needs: the doubling that brings a blade at the band's edge to a pixel, capped. */
    int rings() const {
        if (!(p_.pixelAngle > 0)) return 1;
        const double need = std::min(std::max(1.0, p_.maxWidthScale), p_.bandRadiusM * p_.pixelAngle / std::max(1e-5, p_.bladeWidthMid));
        return 1 + std::max(0, int(std::ceil(std::log2(std::max(1.0, need)) - 1e-9)));
    }

    /** The ring a clump at distance d from the centre is drawn in. */
    int ringAt(double d, int nr) const {
        if (nr <= 1) return 0;
        const double need = d * p_.pixelAngle / std::max(1e-5, p_.bladeWidthMid);
        return std::clamp(int(std::floor(std::log2(std::max(1.0, need)))), 0, nr - 1);
    }

    void run() {
        const int nv = std::max(1, int(p_.variants)), nr = rings();
        variants_.assign(size_t(nv) * nr, {});
        for (int r = 0; r < nr; ++r) for (int v = 0; v < nv; ++v) {
            auto& var = variants_[size_t(r) * nv + v];
            var.ring = r; var.widthScale = std::ldexp(1.0, r);
            var.mesh = clump(v, nv, var.widthScale);
        }
        bucketScan();
        place(nv, nr);
        underlayer();
        shells();
    }

    const Shells& shellLayers() const { return shells_; }

    void writeShells(const std::string& meshFile, const std::string& texFile) const {
        std::ofstream m(meshFile, std::ios::binary), t(texFile, std::ios::binary);
        if (!m || !t) throw std::runtime_error("cannot write " + meshFile);
        for (const auto* a : {&shells_.positions, &shells_.normals, &shells_.colours, &shells_.uvs}) m.write(reinterpret_cast<const char*>(a->data()), std::streamsize(a->size() * 4));
        m.write(reinterpret_cast<const char*>(shells_.indices.data()), std::streamsize(shells_.indices.size() * 4));
        t.write(reinterpret_cast<const char*>(shells_.texture.data()), std::streamsize(shells_.texture.size()));
    }

    const Underlayer& under() const { return under_; }

    void writeUnderlayer(const std::string& meshFile, const std::string& texFile) const {
        std::ofstream m(meshFile, std::ios::binary), t(texFile, std::ios::binary);
        if (!m || !t) throw std::runtime_error("cannot write " + meshFile);
        for (const auto* a : {&under_.positions, &under_.normals, &under_.colours, &under_.uvs}) m.write(reinterpret_cast<const char*>(a->data()), std::streamsize(a->size() * 4));
        m.write(reinterpret_cast<const char*>(under_.indices.data()), std::streamsize(under_.indices.size() * 4));
        t.write(reinterpret_cast<const char*>(under_.texture.data()), std::streamsize(under_.texture.size()));
    }

    const std::vector<Variant>& variants() const { return variants_; }
    const Stats& stats() const { return stats_; }

    void writeMesh(const std::string& meshFile, const std::string& instFile) const {
        std::ofstream m(meshFile, std::ios::binary), in(instFile, std::ios::binary);
        if (!m || !in) throw std::runtime_error("cannot write " + meshFile);
        for (const auto& v : variants_) {
            for (const auto& p : v.mesh.vertices) writeF(m, {p.x, p.y, p.z});
            for (const auto& n : v.mesh.normals) writeF(m, {n.x, n.y, n.z});
            for (const auto& c : v.mesh.vertexColors) writeF(m, {c.x, c.y, c.z, c.w});
            m.write(reinterpret_cast<const char*>(v.mesh.indices.data()), std::streamsize(v.mesh.indices.size() * 4));
            for (const auto& i : v.instances) {
                in.write(reinterpret_cast<const char*>(i.t), 12); in.write(reinterpret_cast<const char*>(i.r), 16);
                in.write(reinterpret_cast<const char*>(i.s), 12); in.write(reinterpret_cast<const char*>(i.c), 12);
                in.write(reinterpret_cast<const char*>(&i.conf), 4);
            }
        }
    }

    std::string reportJson() const {
        std::ostringstream j;
        j.precision(9);
        size_t mo = 0, io = 0, total = 0, tris = 0;
        j << "{\"variants\":[";
        for (size_t v = 0; v < variants_.size(); ++v) {
            const auto& mesh = variants_[v].mesh;
            const size_t nv = mesh.vertices.size(), ni = mesh.indices.size(), n = variants_[v].instances.size();
            float lo[3] = {1e30f, 1e30f, 1e30f}, hi[3] = {-1e30f, -1e30f, -1e30f};
            for (const auto& p : mesh.vertices) { const float q[3] = {p.x, p.y, p.z}; for (int a = 0; a < 3; ++a) { lo[a] = std::min(lo[a], q[a]); hi[a] = std::max(hi[a], q[a]); } }
            j << (v ? "," : "") << "{\"vertices\":" << nv << ",\"indices\":" << ni << ",\"meshOffset\":" << mo
              << ",\"min\":[" << lo[0] << "," << lo[1] << "," << lo[2] << "],\"max\":[" << hi[0] << "," << hi[1] << "," << hi[2] << "]"
              << ",\"instances\":" << n << ",\"instanceOffset\":" << io << ",\"ring\":" << variants_[v].ring << ",\"widthScale\":" << variants_[v].widthScale << ",\"reachM\":" << reach(variants_[v].widthScale) << "}";
            mo += nv * (12 + 12 + 16) + ni * 4;
            io += n * 56;
            total += n; tris += n * ni / 3;
        }
        const auto& s = stats_;
        j << "],\"instances\":" << total << ",\"instancedTriangles\":" << tris << ",\"reachM\":" << reach()
          << ",\"stats\":{\"strata\":" << s.strata << ",\"notGrass\":" << s.notGrass << ",\"lowConfidence\":" << s.lowConfidence
          << ",\"outsideBand\":" << s.outsideBand << ",\"nearExcluded\":" << s.nearExcluded << ",\"thinned\":" << s.thinned
          << ",\"overBudget\":" << s.overBudget << ",\"snapped\":" << s.snapped << ",\"unsnapped\":" << s.unsnapped << ",\"expected\":" << s.expected << ",\"bandGrassM2\":" << s.bandGrassM2
          << ",\"radiusReachedM\":" << s.radiusReachedM << "},\"underlayer\":{\"vertices\":" << under_.positions.size() / 3
          << ",\"indices\":" << under_.indices.size() << ",\"texPx\":" << under_.texPx << ",\"tileM\":" << p_.detailTileM
          << ",\"areaM2\":" << under_.areaM2 << ",\"textureMean\":" << under_.textureMean << "},\"shells\":{\"layers\":" << shells_.layers
          << ",\"vertices\":" << shells_.positions.size() / 3 << ",\"indices\":" << shells_.indices.size() << ",\"indicesPerLayer\":" << shells_.indicesPerLayer
          << ",\"texPx\":" << shells_.texPx << ",\"tileM\":" << p_.shellTileM << ",\"heightM\":" << p_.shellHeightM << ",\"areaM2\":" << shells_.areaM2
          << ",\"textureMean\":" << shells_.textureMean << ",\"bladesPerM2\":" << shells_.bladesPerM2 << "}}";
        return j.str();
    }

private:
    Grid g_;
    Params p_;
    std::vector<Variant> variants_;
    Stats stats_;
    Underlayer under_;
    Shells shells_;
    // the scan's triangles bucketed by grid cell (every cell a triangle's plan bounds touch)
    std::vector<uint32_t> bucketStart_, bucketTris_;

    void bucketScan() {
        const size_t N = size_t(g_.nx) * g_.nz, nt = g_.tris.size() / 9;
        std::vector<uint32_t> count(N + 1, 0);
        auto span = [&](size_t t, auto&& f) {
            const float* v = &g_.tris[t * 9];
            const double xa = std::min({v[0], v[3], v[6]}), xb = std::max({v[0], v[3], v[6]});
            const double za = std::min({v[2], v[5], v[8]}), zb = std::max({v[2], v[5], v[8]});
            const long i0 = std::max(0L, long(std::floor((xa - g_.x0) / g_.cellM))), i1 = std::min(long(g_.nx) - 1, long(std::floor((xb - g_.x0) / g_.cellM)));
            const long k0 = std::max(0L, long(std::floor((za - g_.z0) / g_.cellM))), k1 = std::min(long(g_.nz) - 1, long(std::floor((zb - g_.z0) / g_.cellM)));
            for (long k = k0; k <= k1; ++k) for (long i = i0; i <= i1; ++i) f(size_t(k) * g_.nx + i);
        };
        for (size_t t = 0; t < nt; ++t) span(t, [&](size_t c) { count[c + 1]++; });
        for (size_t c = 0; c < N; ++c) count[c + 1] += count[c];
        bucketStart_ = count;
        bucketTris_.assign(count[N], 0);
        std::vector<uint32_t> fill(count.begin(), count.end() - 1);
        for (size_t t = 0; t < nt; ++t) span(t, [&](size_t c) { bucketTris_[fill[c]++] = uint32_t(t); });
    }

    /** Of the scan's surface heights at (x, z), the one nearest `near` within snapM; NaN when none. */
    double scanAt(double x, double z, int c, double near) const {
        if (bucketStart_.empty()) return NAN;
        double best = NAN, bd = p_.snapM;
        for (uint32_t q = bucketStart_[c]; q < bucketStart_[c + 1]; ++q) {
            const float* v = &g_.tris[size_t(bucketTris_[q]) * 9];
            const double ax = v[0], az = v[2], bx = v[3], bz = v[5], cx = v[6], cz = v[8];
            const double d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
            if (std::abs(d) < 1e-12) continue;
            const double l0 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d, l1 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d, l2 = 1 - l0 - l1;
            if (l0 < -1e-6 || l1 < -1e-6 || l2 < -1e-6) continue;
            const double y = l0 * v[1] + l1 * v[4] + l2 * v[7];
            if (std::abs(y - near) <= bd) { bd = std::abs(y - near); best = y; }
        }
        return best;
    }

    static void writeF(std::ofstream& o, std::initializer_list<float> v) { for (float f : v) o.write(reinterpret_cast<const char*>(&f), 4); }

    /** Variant v of nv: the blade-height range split across the variants (with overlap), its own seed. */
    geometry::Mesh clump(int v, int nv, double widthScale = 1) const {
        GrassClumpConfig c;
        const double span = p_.bladeHeightMax - p_.bladeHeightMin;
        const double a = nv > 1 ? double(v) / (nv - 1) : 0.5;
        // wider blades, fewer of them: the clump covers about the same ground
        c.bladeCount = std::max(3, int(std::lround(p_.bladeCount / widthScale)));
        c.clumpRadius = float(p_.clumpRadius);
        c.bladeHeightMin = float(p_.bladeHeightMin + span * 0.4 * a);
        c.bladeHeightMax = float(p_.bladeHeightMax - span * 0.4 * (1 - a));
        c.bladeWidthBase = float(p_.bladeWidthBase * widthScale); c.bladeWidthMid = float(p_.bladeWidthMid * widthScale); c.keelDepth = float(p_.keelDepth * widthScale);
        // the near blades keep their curve; the widened distant ones, seen a pixel or two wide, need only a bend
        c.minSegments = 1;
        c.segmentsPerBlade = std::max(1, int(std::lround(widthScale > 1 ? p_.farSegmentsPerBlade : p_.segmentsPerBlade)));
        c.gravityDroop = float(p_.gravityDroop); c.radialSplay = float(p_.radialSplay);
        c.curlStochasticity = float(p_.curlStochasticity); c.centerHeightBias = float(p_.centerHeightBias);
        c.clumpNormalBlend = float(p_.clumpNormalBlend);
        // tones relative to the photo colour the instance carries: a paler sheath, a straw tip by senescence
        const float k = kMidTone, s = float(std::clamp(p_.senescence, 0.0, 1.0));
        c.midColor = Vec4(k, k, k, 1);
        c.rootColor = Vec4(k, k, k, 1);
        c.tipColor = Vec4(math::lerp(k, 0.98f, s), math::lerp(k, 0.86f, s), math::lerp(k, 0.5f, s), 1);
        c.seed = uint32_t(p_.seed) * 7919u + uint32_t(v) * 104729u + 17u;
        geometry::Mesh m = GrassClumpGenerator::generateClump(c);
        // self-occlusion: the blade's lower part in its neighbours' shade (uv.y runs root 0 to tip 1)
        const double h = std::max(1e-3, p_.occlusionHeight), r0 = std::clamp(p_.rootShade, 0.0, 1.0);
        for (size_t i = 0; i < m.vertexColors.size(); ++i) {
            const double t = std::clamp(double(m.uvs[i].y) / h, 0.0, 1.0), occ = r0 + (1 - r0) * t * t * (3 - 2 * t);
            m.vertexColors[i].x *= float(occ); m.vertexColors[i].y *= float(occ); m.vertexColors[i].z *= float(occ);
        }
        return m;
    }

    int cellOf(double x, double z) const {
        const long i = long(std::floor((x - g_.x0) / g_.cellM)), k = long(std::floor((z - g_.z0) / g_.cellM));
        return i < 0 || k < 0 || i >= long(g_.nx) || k >= long(g_.nz) ? -1 : int(k * g_.nx + i);
    }

    /** Whether any excluded (or off-grid) cell overlaps the disk of radius r about (x, z). */
    bool nearExcluded(double x, double z, double r) const {
        const long i0 = long(std::floor((x - r - g_.x0) / g_.cellM)), i1 = long(std::floor((x + r - g_.x0) / g_.cellM));
        const long k0 = long(std::floor((z - r - g_.z0) / g_.cellM)), k1 = long(std::floor((z + r - g_.z0) / g_.cellM));
        for (long k = k0; k <= k1; ++k) for (long i = i0; i <= i1; ++i) {
            // nearest point of the cell to the centre
            const double cx = std::clamp(x, g_.x0 + i * double(g_.cellM), g_.x0 + (i + 1) * double(g_.cellM));
            const double cz = std::clamp(z, g_.z0 + k * double(g_.cellM), g_.z0 + (k + 1) * double(g_.cellM));
            if ((cx - x) * (cx - x) + (cz - z) * (cz - z) > r * r) continue;
            if (i < 0 || k < 0 || i >= long(g_.nx) || k >= long(g_.nz)) continue;
            if (g_.exclude[size_t(k) * g_.nx + i]) return true;
        }
        return false;
    }

    /**
     * `value(cell)` at (x, z), bilinear between the centres of the four cells around it that `ok(cell)` accepts (their
     * weights renormalised), else the own cell's: colours and fades vary smoothly instead of stepping cell by cell.
     */
    template <class Value, class Ok>
    double cellLerp(double x, double z, int own, Value value, Ok ok) const {
        const double fx = (x - g_.x0) / g_.cellM - 0.5, fz = (z - g_.z0) / g_.cellM - 0.5;
        const long i = long(std::floor(fx)), k = long(std::floor(fz));
        const double tx = fx - i, tz = fz - k;
        double sum = 0, w = 0;
        for (int dk = 0; dk < 2; ++dk) for (int di = 0; di < 2; ++di) {
            const long ii = i + di, kk = k + dk;
            if (ii < 0 || kk < 0 || ii >= long(g_.nx) || kk >= long(g_.nz)) continue;
            const int c = int(kk * g_.nx + ii);
            if (!ok(c)) continue;
            const double wt = (di ? tx : 1 - tx) * (dk ? tz : 1 - tz);
            sum += wt * value(c); w += wt;
        }
        return w > 1e-6 ? sum / w : value(own);
    }

    bool hasColour(int c) const { return g_.mask[c] && (g_.colour[size_t(c) * 3] > 0 || g_.colour[size_t(c) * 3 + 1] > 0 || g_.colour[size_t(c) * 3 + 2] > 0); }

    /** The photo colour at (x, z), bilinear between the grass cells with a colour. */
    void colourAt(double x, double z, int own, double out[3]) const {
        for (int q = 0; q < 3; ++q) out[q] = cellLerp(x, z, own, [&](int c) { return double(g_.colour[size_t(c) * 3 + q]); }, [&](int c) { return hasColour(c); });
    }

    /** The surface height at (x, z): bilinear between the centres of the grass cells around it, else its own cell's. */
    double surfaceAt(double x, double z, int own) const {
        const double fx = (x - g_.x0) / g_.cellM - 0.5, fz = (z - g_.z0) / g_.cellM - 0.5;
        const long i = long(std::floor(fx)), k = long(std::floor(fz));
        const double tx = fx - i, tz = fz - k;
        double sum = 0, w = 0;
        for (int dk = 0; dk < 2; ++dk) for (int di = 0; di < 2; ++di) {
            const long ii = i + di, kk = k + dk;
            if (ii < 0 || kk < 0 || ii >= long(g_.nx) || kk >= long(g_.nz)) continue;
            const size_t c = size_t(kk) * g_.nx + ii;
            if (!g_.mask[c] || !std::isfinite(g_.surfaceY[c])) continue;
            const double wt = (di ? tx : 1 - tx) * (dk ? tz : 1 - tz);
            sum += wt * g_.surfaceY[c]; w += wt;
        }
        return w > 1e-6 ? sum / w : g_.surfaceY[own];
    }

    /** A tiling texture of blade-scale strokes (the lawn's top seen from above), grey around 0.8; wraps at its edges. */
    void detailTexture() {
        const int n = std::clamp(int(std::lround(p_.detailTexPx)), 16, 2048);
        std::vector<float> v(size_t(n) * n, 0.8f);
        const long strokes = long(n) * n / 30;
        const uint64_t salt = uint64_t(p_.seed) + 9001;
        for (long q = 0; q < strokes; ++q) {
            const double cx = hash01(q, 1, salt) * n, cy = hash01(q, 2, salt) * n, ang = hash01(q, 3, salt) * math::PI;
            const double len = n * (0.006 + 0.02 * hash01(q, 4, salt)) / std::max(0.05, p_.detailTileM) * 0.5;
            const float val = float(0.45 + 0.6 * hash01(q, 5, salt));
            const int steps = std::max(2, int(len * 2));
            for (int k = 0; k <= steps; ++k) {
                const double f = double(k) / steps - 0.5;
                const int x = ((int(std::floor(cx + std::cos(ang) * len * f)) % n) + n) % n, y = ((int(std::floor(cy + std::sin(ang) * len * f)) % n) + n) % n;
                v[size_t(y) * n + x] = val;
            }
        }
        under_.texPx = n;
        under_.texture.resize(size_t(n) * n * 4);
        double sum = 0;
        for (size_t i = 0; i < v.size(); ++i) {
            const float c = std::clamp(v[i], 0.f, 1.f);
            sum += c;
            const uint8_t b = uint8_t(std::lround(c * 255));
            under_.texture[i * 4] = b; under_.texture[i * 4 + 1] = b; under_.texture[i * 4 + 2] = b; under_.texture[i * 4 + 3] = 255;
        }
        under_.textureMean = sum / v.size();
    }

    void underlayer() {
        detailTexture();
        const double R = p_.underlayerRadiusM, sp = std::max(0.05, p_.underlayerSpacingM);
        if (!(R > 0)) return;
        const size_t N = size_t(g_.nx) * g_.nz;
        auto grass = [&](long c) { return c >= 0 && g_.mask[c] && !g_.exclude[c]; };
        // cells from the grass edge (chessboard distance, in cells), for the fade
        std::vector<int> edge(N, 0);
        {
            std::vector<long> q;
            for (size_t c = 0; c < N; ++c) if (!grass(long(c))) { edge[c] = 0; q.push_back(long(c)); } else edge[c] = -1;
            for (size_t h = 0; h < q.size(); ++h) {
                const long c = q[h], i = c % g_.nx, k = c / g_.nx;
                for (int dk = -1; dk <= 1; ++dk) for (int di = -1; di <= 1; ++di) {
                    const long ii = i + di, kk = k + dk;
                    if (ii < 0 || kk < 0 || ii >= long(g_.nx) || kk >= long(g_.nz)) continue;
                    const long n = kk * long(g_.nx) + ii;
                    if (edge[n] < 0) { edge[n] = edge[c] + 1; q.push_back(n); }
                }
            }
        }
        // the clumps on a hash grid, for the contact shade
        const double cr = std::max(0.05, p_.contactRadiusM);
        std::unordered_map<int64_t, std::vector<std::pair<float, float>>> near;
        auto key = [&](double x, double z) { return (int64_t(std::floor(x / cr)) << 32) ^ (int64_t(std::floor(z / cr)) & 0xffffffff); };
        for (const auto& var : variants_) for (const auto& in : var.instances) near[key(in.t[0], in.t[2])].push_back({in.t[0], in.t[2]});
        // the vertex lattice over the disk, on the grass cells
        const double cx = p_.centreX, cz = p_.centreZ;
        const long a0 = long(std::floor((cx - R) / sp)), a1 = long(std::ceil((cx + R) / sp));
        const long b0 = long(std::floor((cz - R) / sp)), b1 = long(std::ceil((cz + R) / sp));
        const long W = a1 - a0 + 1, Hh = b1 - b0 + 1;
        std::vector<int64_t> vid(size_t(W) * Hh, -1);
        auto& U = under_;
        for (long b = b0; b <= b1; ++b) for (long a = a0; a <= a1; ++a) {
            const double x = a * sp, z = b * sp;
            if ((x - cx) * (x - cx) + (z - cz) * (z - cz) > R * R) continue;
            const int c = cellOf(x, z);
            if (!grass(c)) continue;
            if (!hasColour(c)) continue;
            double col[3];
            colourAt(x, z, c, col);
            const double est = surfaceAt(x, z, c), sy = scanAt(x, z, c, est);
            const double y = (std::isfinite(sy) ? sy : est) + p_.underlayerLiftM;
            // shade: the lower grass, deeper where clumps stand; fading to the photo colour at the grass edge
            const double rim = std::clamp((R - std::sqrt((x - cx) * (x - cx) + (z - cz) * (z - cz))) / std::max(1e-3, R * p_.underlayerRadialFade), 0.0, 1.0);
            // cells from the grass edge, interpolated over every cell (the non-grass ones at 0), so the fade is smooth
            const double edgeCells = cellLerp(x, z, c, [&](int e) { return double(edge[size_t(e)]); }, [](int) { return true; });
            const double inside = std::clamp((edgeCells - 0.5) * double(g_.cellM) / std::max(1e-3, p_.underlayerFadeM), 0.0, 1.0) * rim;
            int count = 0;
            for (int dz = -1; dz <= 1; ++dz) for (int dx = -1; dx <= 1; ++dx) {
                auto it = near.find(key(x + dx * cr, z + dz * cr));
                if (it == near.end()) continue;
                for (const auto& [px, pz] : it->second) if ((px - x) * (px - x) + (pz - z) * (pz - z) <= cr * cr) ++count;
            }
            const double contact = std::min(1.0, count / 3.0);
            const double shade = (1 - inside * (1 - p_.underlayerShade)) * (1 - inside * p_.contactShade * contact);
            // the texture multiplies by its mean; the vertex colour carries the rest
            const double k = shade / std::max(0.1, U.textureMean);
            U.photo.insert(U.photo.end(), {float(col[0]), float(col[1]), float(col[2])});
            U.inside.push_back(float(inside));
            U.dist.push_back(float(std::sqrt((x - cx) * (x - cx) + (z - cz) * (z - cz))));
            vid[size_t(b - b0) * W + (a - a0)] = int64_t(U.positions.size() / 3);
            U.positions.insert(U.positions.end(), {float(x), float(y), float(z)});
            U.normals.insert(U.normals.end(), {0.f, 1.f, 0.f});
            U.colours.insert(U.colours.end(), {float(std::min(1.0, col[0] * k)), float(std::min(1.0, col[1] * k)), float(std::min(1.0, col[2] * k)), 1.f});
            U.uvs.insert(U.uvs.end(), {float(x / p_.detailTileM), float(z / p_.detailTileM)});
        }
        for (long b = b0; b < b1; ++b) for (long a = a0; a < a1; ++a) {
            const int64_t v00 = vid[size_t(b - b0) * W + (a - a0)], v10 = vid[size_t(b - b0) * W + (a + 1 - a0)];
            const int64_t v01 = vid[size_t(b + 1 - b0) * W + (a - a0)], v11 = vid[size_t(b + 1 - b0) * W + (a + 1 - a0)];
            if (v00 < 0 || v10 < 0 || v01 < 0 || v11 < 0) continue;
            U.indices.insert(U.indices.end(), {uint32_t(v00), uint32_t(v11), uint32_t(v10), uint32_t(v00), uint32_t(v01), uint32_t(v11)});
            U.areaM2 += sp * sp;
        }
        // normals from the lattice's own heights
        for (long b = b0; b <= b1; ++b) for (long a = a0; a <= a1; ++a) {
            const int64_t v = vid[size_t(b - b0) * W + (a - a0)];
            if (v < 0) continue;
            auto hy = [&](long aa, long bb) -> double { if (aa < a0 || bb < b0 || aa > a1 || bb > b1) return NAN; const int64_t w = vid[size_t(bb - b0) * W + (aa - a0)]; return w < 0 ? NAN : double(U.positions[size_t(w) * 3 + 1]); };
            const double y0 = U.positions[size_t(v) * 3 + 1];
            double l = hy(a - 1, b), r = hy(a + 1, b), d = hy(a, b - 1), u = hy(a, b + 1);
            const double dx = (std::isfinite(r) ? r : y0) - (std::isfinite(l) ? l : y0), dz = (std::isfinite(u) ? u : y0) - (std::isfinite(d) ? d : y0);
            const double span = 2 * sp, nx = -dx / span, nz = -dz / span, len = std::sqrt(nx * nx + 1 + nz * nz);
            U.normals[size_t(v) * 3] = float(nx / len); U.normals[size_t(v) * 3 + 1] = float(1 / len); U.normals[size_t(v) * 3 + 2] = float(nz / len);
        }
    }

    /**
     * The shells' blade cross-sections: per texel, the height (0..1) the blade standing there reaches, tapering from its
     * base (so higher layers cut thinner slivers). Blades grow in tufts (`shellTuftShare` of them around tuft centres) and
     * each cross-section is a flat sliver in its own direction, as a blade seen from above, not a round dot. RGB is near
     * white with a per-blade variation (the tone is the vertex colour's); alpha the height. Wraps at its edges.
     */
    void shellTexture() {
        const int n = std::clamp(int(std::lround(p_.shellTexPx)), 16, 4096);
        const double tile = std::max(0.02, p_.shellTileM), pxPerM = n / tile;
        std::vector<float> h(size_t(n) * n, 0.f), lum(size_t(n) * n, 1.f);
        const long blades = std::max(1L, long(std::lround(p_.shellBladesPerM2 * tile * tile)));
        const long tufts = std::max(1L, long(std::lround(p_.shellTuftsPerM2 * tile * tile)));
        const double tuftR = p_.shellTuftRadiusM * pxPerM;
        const uint64_t salt = uint64_t(p_.seed) + 4242;
        for (long q = 0; q < blades; ++q) {
            double cx, cy;
            if (hash01(q, 6, salt) < p_.shellTuftShare) {
                // around a tuft centre, denser toward it
                const long t = long(hash01(q, 7, salt) * tufts) % tufts;
                const double a = hash01(q, 8, salt) * 2 * math::PI, r = tuftR * hash01(q, 9, salt) * hash01(q, 10, salt);
                cx = hash01(t, 11, salt) * n + std::cos(a) * r; cy = hash01(t, 12, salt) * n + std::sin(a) * r;
            } else { cx = hash01(q, 1, salt) * n; cy = hash01(q, 2, salt) * n; }
            const double top = 0.4 + 0.6 * hash01(q, 3, salt);
            // a sliver: blade width along its own direction, a keel's thickness across it
            const double len = std::max(1.0, 0.5 * p_.bladeWidthMid * (0.8 + 0.8 * hash01(q, 4, salt)) * pxPerM * 1.4);
            const double thick = std::max(0.7, len * 0.3);
            const double ang = hash01(q, 5, salt) * math::PI, ca = std::cos(ang), sa = std::sin(ang);
            const float shade = float(0.85 + 0.15 * hash01(q, 13, salt));
            const int r = int(std::ceil(len));
            for (int dy = -r; dy <= r; ++dy) for (int dx = -r; dx <= r; ++dx) {
                const double u = (dx * ca + dy * sa) / len, v = (-dx * sa + dy * ca) / thick, d = u * u + v * v;
                if (d >= 1) continue;
                const int x = ((int(std::floor(cx)) + dx) % n + n) % n, y = ((int(std::floor(cy)) + dy) % n + n) % n;
                const float hv = float(top * (1 - std::sqrt(d)));
                if (hv > h[size_t(y) * n + x]) { h[size_t(y) * n + x] = hv; lum[size_t(y) * n + x] = shade; }
            }
        }
        auto& S = shells_;
        S.texPx = n; S.bladesPerM2 = blades / (tile * tile);
        S.texture.resize(size_t(n) * n * 4);
        double sum = 0, cnt = 0;
        for (size_t i = 0; i < h.size(); ++i) {
            const uint8_t b = uint8_t(std::lround(lum[i] * 255));
            S.texture[i * 4] = b; S.texture[i * 4 + 1] = b; S.texture[i * 4 + 2] = b;
            S.texture[i * 4 + 3] = uint8_t(std::lround(std::clamp(double(h[i]), 0.0, 1.0) * 255));
            if (h[i] > 0) { sum += lum[i]; cnt += 1; }
        }
        // the mean over the texels a blade covers: the ones a layer draws
        S.textureMean = cnt > 0 ? sum / cnt : 1;
    }

    /** Smooth value noise (0..1) on a lattice of `cellM`: low-frequency variation that breaks a texture's repeat. */
    double valueNoise(double x, double z, double cellM, uint64_t salt) const {
        const double fx = x / cellM, fz = z / cellM;
        const long i = long(std::floor(fx)), k = long(std::floor(fz));
        const double tx = fx - i, tz = fz - k, sx = tx * tx * (3 - 2 * tx), sz = tz * tz * (3 - 2 * tz);
        auto v = [&](long a, long b) { return hash01(uint64_t(a), uint64_t(b), salt); };
        return (v(i, k) * (1 - sx) + v(i + 1, k) * sx) * (1 - sz) + (v(i, k + 1) * (1 - sx) + v(i + 1, k + 1) * sx) * sz;
    }

    void shells() {
        const int L = std::max(0, int(std::lround(p_.shellLayers)));
        const double R = p_.shellRadiusM;
        if (!(R > 0) || L < 1 || under_.indices.empty()) return;
        shellTexture();
        const auto& U = under_;
        auto& S = shells_;
        const size_t nu = U.positions.size() / 3;
        std::vector<int64_t> map(nu, -1);
        std::vector<uint32_t> keep;
        for (size_t v = 0; v < nu; ++v) if (U.dist[v] <= R) { map[v] = int64_t(keep.size()); keep.push_back(uint32_t(v)); }
        std::vector<uint32_t> tri;
        for (size_t t = 0; t + 2 < U.indices.size(); t += 3) {
            const int64_t a = map[U.indices[t]], b = map[U.indices[t + 1]], c = map[U.indices[t + 2]];
            if (a < 0 || b < 0 || c < 0) continue;
            tri.insert(tri.end(), {uint32_t(a), uint32_t(b), uint32_t(c)});
        }
        if (tri.empty()) return;
        S.layers = L; S.indicesPerLayer = tri.size();
        S.areaM2 = U.areaM2 * double(tri.size()) / double(U.indices.size());
        const double r0 = std::clamp(p_.rootShade, 0.0, 1.0), fade = std::max(1e-3, R * 0.3);
        for (int i = 0; i < L; ++i) {
            const double f = double(i + 1) / L, lift = f * p_.shellHeightM;
            // tone relative to the floor: darker at the bottom (deeper in the grass), the floor's own at the top, so from above
            // the shells match the ground around them and never glow over it
            const double t = std::clamp(f / std::max(1e-3, p_.occlusionHeight), 0.0, 1.0), floor = std::max(r0, p_.underlayerShade);
            const double lo = floor * p_.shellBottomTone, hi = floor * p_.shellTopTone, tone = lo + (hi - lo) * t * t * (3 - 2 * t);
            const uint32_t base = uint32_t(S.positions.size() / 3);
            for (uint32_t v : keep) {
                S.positions.insert(S.positions.end(), {U.positions[v * 3], float(U.positions[v * 3 + 1] + lift), U.positions[v * 3 + 2]});
                S.normals.insert(S.normals.end(), {U.normals[v * 3], U.normals[v * 3 + 1], U.normals[v * 3 + 2]});
                // a slow brightness swell across the lawn, so the texture's tile does not read as a repeat
                const double swell = 1 + p_.shellToneNoise * (2 * valueNoise(U.positions[v * 3], U.positions[v * 3 + 2], p_.shellNoiseCellM, uint64_t(p_.seed) + 77) - 1);
                const double k = tone * swell / std::max(0.1, S.textureMean);
                // thinner toward the rim and the grass edge: the mask compares texture alpha x this to the layer's cutoff
                const double alpha = std::clamp(double(U.inside[v]), 0.0, 1.0) * std::clamp((R - U.dist[v]) / fade, 0.0, 1.0);
                S.colours.insert(S.colours.end(), {float(std::min(1.0, U.photo[v * 3] * k)), float(std::min(1.0, U.photo[v * 3 + 1] * k)), float(std::min(1.0, U.photo[v * 3 + 2] * k)), float(alpha)});
                S.uvs.insert(S.uvs.end(), {float(U.positions[v * 3] / p_.shellTileM), float(U.positions[v * 3 + 2] / p_.shellTileM)});
            }
            for (uint32_t q : tri) S.indices.push_back(base + q);
        }
    }

    void place(int nv, int nr) {
        auto& s = stats_;
        const double density = std::max(1e-6, p_.densityPerM2), step = 1.0 / std::sqrt(density);
        const double R = std::max(0.0, p_.bandRadiusM), cx = p_.centreX, cz = p_.centreZ;
        const double scaleMax = std::max(p_.scaleMin, p_.scaleMax);

        const uint64_t salt = uint64_t(p_.seed) + 1;
        // the band's grass and the expected count
        for (uint32_t k = 0; k < g_.nz; ++k) for (uint32_t i = 0; i < g_.nx; ++i) {
            const size_t c = size_t(k) * g_.nx + i;
            if (!g_.mask[c] || g_.exclude[c] || g_.confidence[c] < p_.minConfidence) continue;
            const double x = g_.x0 + (i + 0.5) * g_.cellM, z = g_.z0 + (k + 0.5) * g_.cellM;
            if ((x - cx) * (x - cx) + (z - cz) * (z - cz) > R * R) continue;
            s.bandGrassM2 += double(g_.cellM) * g_.cellM;
            s.expected += density * g_.cellM * g_.cellM * std::clamp(double(g_.confidence[c]), 0.0, 1.0);
        }
        // strata over the band clipped to the grid
        const double gx0 = std::max<double>(g_.x0, cx - R), gx1 = std::min<double>(g_.x0 + g_.nx * double(g_.cellM), cx + R);
        const double gz0 = std::max<double>(g_.z0, cz - R), gz1 = std::min<double>(g_.z0 + g_.nz * double(g_.cellM), cz + R);
        std::vector<Instance> all;
        std::vector<int> which;
        if (gx1 > gx0 && gz1 > gz0) {
            // strata on a fixed lattice through the origin, so a sample does not move when the band does
            const long a0 = long(std::floor(gx0 / step)), a1 = long(std::ceil(gx1 / step));
            const long b0 = long(std::floor(gz0 / step)), b1 = long(std::ceil(gz1 / step));
            for (long b = b0; b < b1; ++b) for (long a = a0; a < a1; ++a) {
                s.strata++;
                const uint64_t ua = uint64_t(a), ub = uint64_t(b);
                const double j = std::clamp(p_.jitter, 0.0, 1.0);
                const double x = (a + 0.5 + (hash01(ua, ub, salt) - 0.5) * j) * step;
                const double z = (b + 0.5 + (hash01(ua, ub, salt + 11) - 0.5) * j) * step;
                const double d2 = (x - cx) * (x - cx) + (z - cz) * (z - cz);
                if (d2 > R * R) { s.outsideBand++; continue; }
                const int c = cellOf(x, z);
                if (c < 0 || !g_.mask[c] || g_.exclude[c]) { s.notGrass++; continue; }
                const double conf = std::clamp(double(g_.confidence[c]), 0.0, 1.0);
                if (conf < p_.minConfidence) { s.lowConfidence++; continue; }
                if (hash01(ua, ub, salt + 23) >= conf) { s.thinned++; continue; }
                const int ring = ringAt(std::sqrt(d2), nr);
                if (nearExcluded(x, z, reach(std::ldexp(1.0, ring)) * scaleMax + p_.edgeMarginM)) { s.nearExcluded++; continue; }
                Instance in{};
                const double yaw = hash01(ua, ub, salt + 37) * 2 * math::PI;
                const double sc = p_.scaleMin + (scaleMax - p_.scaleMin) * hash01(ua, ub, salt + 41);
                const double hy = sc * (1 + p_.heightJitter * (2 * hash01(ua, ub, salt + 43) - 1));
                const double est = surfaceAt(x, z, c), scanY = scanAt(x, z, c, est);
                in.t[0] = float(x); in.t[1] = float(std::isfinite(scanY) ? scanY : est); in.t[2] = float(z);
                in.r[0] = 0; in.r[1] = float(std::sin(yaw / 2)); in.r[2] = 0; in.r[3] = float(std::cos(yaw / 2));
                in.s[0] = float(sc); in.s[1] = float(hy); in.s[2] = float(sc);
                double rgb[3];
                colourAt(x, z, c, rgb);
                const double tint = 1 + p_.tintJitter * (2 * hash01(ua, ub, salt + 47) - 1);
                const bool has = hasColour(c);
                for (int q = 0; q < 3; ++q) {
                    // no photo colour: the clump's own tone (white tint)
                    const double lin = has ? rgb[q] / kMidTone : 1.0;
                    in.c[q] = float(std::clamp(lin * tint, 0.0, 1.0));
                }
                in.conf = float(conf);
                in.snapped = std::isfinite(scanY);
                in.d = std::sqrt(d2);
                all.push_back(in);
                which.push_back(ring * nv + int(hash01(ua, ub, salt + 53) * nv) % nv);
            }
        }
        // past the budget, the nearest ones
        const size_t budget = size_t(std::max(0.0, p_.maxInstances));
        std::vector<size_t> order(all.size());
        for (size_t q = 0; q < order.size(); ++q) order[q] = q;
        if (all.size() > budget) {
            std::stable_sort(order.begin(), order.end(), [&](size_t l, size_t r) { return all[l].d < all[r].d; });
            s.overBudget = long(all.size() - budget);
            order.resize(budget);
        }
        for (size_t q : order) {
            variants_[which[q]].instances.push_back(all[q]);
            (all[q].snapped ? s.snapped : s.unsnapped)++;
            s.radiusReachedM = std::max(s.radiusReachedM, all[q].d);
        }
    }
};

}  // namespace scratchbox::grass_field
