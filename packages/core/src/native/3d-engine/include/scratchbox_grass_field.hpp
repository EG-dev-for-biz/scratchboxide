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
 * Every shape quantity is a continuous parameter: blade height and width, keel depth, droop, splay, curl, clump radius,
 * senescence; nothing selects a grass kind.
 *
 * Input (SBGF v2, little endian): "SBGF" u32 2, u32 nx, u32 nz, f32 x0, f32 z0, f32 cellM, then per cell arrays:
 * u8 mask[N] (0 = not grass), u8 exclude[N] (non-zero = never grown over), f32 confidence[N], f32 surfaceY[N],
 * f32 colour[N * 3] (linear RGB lit photo colour of the cell; 0,0,0 = none), then u32 nTri and nTri * 9 f32: the scan's
 * triangles over the band (x y z per corner; 0 triangles = no snapping).
 *
 * Output: mesh.bin (per variant: positions f32x3, normals f32x3, colours f32x4, indices u32) and instances.bin (per
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
    double senescence = 0.35;       // how far the tip goes toward straw (0 = all green)
    // distance rings
    double pixelAngle = 0.0015;     // radians a pixel spans (about 1 px at 1000 px over 60 degrees); 0 = no rings
    double maxWidthScale = 16;      // widest blade, as a multiple of the near blade

    void set(const std::string& k, double v) {
#define SB_GF_P(name) if (k == #name) { name = v; return; }
        SB_GF_P(densityPerM2) SB_GF_P(minConfidence) SB_GF_P(centreX) SB_GF_P(centreZ) SB_GF_P(bandRadiusM) SB_GF_P(maxInstances)
        SB_GF_P(edgeMarginM) SB_GF_P(snapM) SB_GF_P(jitter) SB_GF_P(scaleMin) SB_GF_P(scaleMax) SB_GF_P(heightJitter) SB_GF_P(tintJitter)
        SB_GF_P(variants) SB_GF_P(seed) SB_GF_P(bladeCount) SB_GF_P(clumpRadius) SB_GF_P(bladeHeightMin) SB_GF_P(bladeHeightMax)
        SB_GF_P(bladeWidthBase) SB_GF_P(bladeWidthMid) SB_GF_P(keelDepth) SB_GF_P(segmentsPerBlade) SB_GF_P(farSegmentsPerBlade) SB_GF_P(gravityDroop)
        SB_GF_P(radialSplay) SB_GF_P(curlStochasticity) SB_GF_P(centerHeightBias) SB_GF_P(clumpNormalBlend) SB_GF_P(senescence)
        SB_GF_P(pixelAngle) SB_GF_P(maxWidthScale)
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
          << ",\"radiusReachedM\":" << s.radiusReachedM << "}}";
        return j.str();
    }

private:
    Grid g_;
    Params p_;
    std::vector<Variant> variants_;
    Stats stats_;
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
        c.rootColor = Vec4(0.95f, 0.95f, 0.78f, 1);
        c.tipColor = Vec4(math::lerp(k, 0.98f, s), math::lerp(k, 0.86f, s), math::lerp(k, 0.5f, s), 1);
        c.seed = uint32_t(p_.seed) * 7919u + uint32_t(v) * 104729u + 17u;
        return GrassClumpGenerator::generateClump(c);
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
                const float* rgb = &g_.colour[size_t(c) * 3];
                const double tint = 1 + p_.tintJitter * (2 * hash01(ua, ub, salt + 47) - 1);
                const bool has = rgb[0] > 0 || rgb[1] > 0 || rgb[2] > 0;
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
