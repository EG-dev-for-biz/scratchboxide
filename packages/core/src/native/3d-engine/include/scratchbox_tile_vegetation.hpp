/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_TILE_VEGETATION_HPP
#define SCRATCHBOX_TILE_VEGETATION_HPP

/**
 * Trees in a photogrammetric tile, measured and rebuilt.
 *
 * strip: reads a photo-textured tile (x = east, y = up, z = south, metres) and measures where its tree crowns are,
 *   from three continuous kinds of evidence per triangle: photo chroma (normalised excess green ExG and ExG - ExR over
 *   texture samples, with a dark-pixel guard), local roughness (area-weighted normal dispersion over welded neighbours
 *   within a radius) and height above the terrain model. Crowns are local maxima of the canopy height model with a
 *   window that grows with height, grown by a marker-controlled watershed with a climb limit. Each crown is measured
 *   against the surface it stands on (roof or ground): the surface it touches around its footprint, reached through
 *   other canopy when it touches none. Crowns at least minTreeHeight above that surface are trees; their triangles
 *   are removed down to the surface and the holes are closed (skirts down walls, caps on the ground, never new holes).
 *   Lower roof vegetation stays in the scan untouched; crowns that touch the extraction boundary keep their canopy and
 *   are reported as cut. Writes the devegetated tile (textures kept, caps untextured), and a crown list with apex,
 *   stem, support, footprint, sector radii and voxel samples of the crown surface, in the tile frame and as lat/lng.
 *
 * plant: grows one SB-Veggie tree per measured crown with the space-colonisation generator
 *   (nature::SpaceColonizationTreeGenerator), attracted to the crown's own measured samples, meshed within a
 *   per-tree share of a total triangle budget, in studio clay. What the scan does not observe (crown base, trunk
 *   radius) comes from explicit ratios and is reported as inferred.
 *
 * Every failure is a VegetationError with a code; nothing is substituted.
 */

#include "scratchbox_gltf_scene.hpp"
#include "scratchbox_height_field.hpp"
#include "scratchbox_io.hpp"
#include "scratchbox_nature.hpp"
#include "scratchbox_texture.hpp"
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <functional>
#include <limits>
#include <map>
#include <numeric>
#include <queue>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

namespace scratchbox {
namespace tile_vegetation {

using math::Vec2;
using math::Vec3;
using math::Vec4;

class VegetationError : public std::runtime_error {
public:
    VegetationError(std::string code, const std::string& message) : std::runtime_error(message), code_(std::move(code)) {}
    const std::string& code() const { return code_; }
private:
    std::string code_;
};

// ============================================================================================
// JSON helpers
// ============================================================================================

namespace json {

inline std::string num(double v) {
    if (!std::isfinite(v)) return "null";
    std::ostringstream s;
    s.precision(10);
    s << v;
    return s.str();
}

inline std::string numPrecise(double v) {
    if (!std::isfinite(v)) return "null";
    std::ostringstream s;
    s.precision(17);
    s << v;
    return s.str();
}

inline std::string str(const std::string& v) {
    std::string o = "\"";
    for (char c : v) {
        switch (c) {
            case '"': o += "\\\""; break;
            case '\\': o += "\\\\"; break;
            case '\n': o += "\\n"; break;
            case '\r': o += "\\r"; break;
            case '\t': o += "\\t"; break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    o += buf;
                } else {
                    o += c;
                }
        }
    }
    return o + "\"";
}

/** Serialises a parsed value back to JSON text (numbers at full precision). */
inline std::string write(const io::GlbJsonValue& v) {
    switch (v.type) {
        case io::GlbJsonValue::Null: return "null";
        case io::GlbJsonValue::Bool: return v.b ? "true" : "false";
        case io::GlbJsonValue::Number: return numPrecise(v.num);
        case io::GlbJsonValue::String: return str(v.str);
        case io::GlbJsonValue::Array: {
            std::string o = "[";
            for (size_t i = 0; i < v.arr.size(); ++i) o += (i ? "," : "") + write(v.arr[i]);
            return o + "]";
        }
        case io::GlbJsonValue::Object: {
            std::string o = "{";
            for (size_t i = 0; i < v.obj.size(); ++i) o += (i ? "," : "") + str(v.obj[i].first) + ":" + write(v.obj[i].second);
            return o + "}";
        }
    }
    return "null";
}

inline io::GlbJsonValue parse(const std::string& text) {
    io::GlbJsonParser p(text.data(), text.size());
    return p.parse();
}

} // namespace json

// ============================================================================================
// Tile frame (root extras written by the district crawler)
// ============================================================================================

struct TileFrame {
    bool known{false};
    double localToEcef[16]{};  // column-major
    /** The root "extras" object as JSON text, carried unchanged into every output ("null" when absent). */
    std::string extrasJson{"null"};

    struct Geodetic { double lat, lng, h; };

    /** WGS-84 latitude/longitude (degrees) and ellipsoidal height of a point in the tile frame. */
    Geodetic toGeodetic(double x, double y, double z) const {
        const double* m = localToEcef;
        const double X = m[0] * x + m[4] * y + m[8] * z + m[12];
        const double Y = m[1] * x + m[5] * y + m[9] * z + m[13];
        const double Z = m[2] * x + m[6] * y + m[10] * z + m[14];
        const double a = 6378137.0, f = 1.0 / 298.257223563, b = a * (1 - f);
        const double e2 = f * (2 - f), ep2 = (a * a - b * b) / (b * b);
        const double p = std::sqrt(X * X + Y * Y);
        const double th = std::atan2(Z * a, p * b);
        const double lat = std::atan2(Z + ep2 * b * std::pow(std::sin(th), 3), p - e2 * a * std::pow(std::cos(th), 3));
        const double lng = std::atan2(Y, X);
        const double N = a / std::sqrt(1 - e2 * std::sin(lat) * std::sin(lat));
        const double h = p / std::cos(lat) - N;
        return {lat * 180.0 / M_PI, lng * 180.0 / M_PI, h};
    }
};

/** Reads the root extras of a GLB (frame, anchor, localToEcef). A GLB without them yields an unknown frame. */
inline TileFrame readTileFrame(const std::vector<uint8_t>& glb) {
    TileFrame f;
    if (glb.size() < 20) return f;
    uint32_t jsonLength;
    std::memcpy(&jsonLength, glb.data() + 12, 4);
    if (20 + static_cast<size_t>(jsonLength) > glb.size()) return f;
    io::GlbJsonParser parser(reinterpret_cast<const char*>(glb.data() + 20), jsonLength);
    const io::GlbJsonValue root = parser.parse();
    const auto& extras = root["extras"];
    if (extras.type != io::GlbJsonValue::Object) return f;
    f.extrasJson = json::write(extras);
    const auto& m = extras["localToEcef"];
    if (m.arr.size() == 16) {
        bool finite = true;
        for (size_t i = 0; i < 16; ++i) {
            f.localToEcef[i] = m[i].type == io::GlbJsonValue::Number ? m[i].num : std::numeric_limits<double>::quiet_NaN();
            finite = finite && std::isfinite(f.localToEcef[i]);
        }
        f.known = finite;
    }
    return f;
}

inline std::vector<uint8_t> readFileBytes(const std::string& path) {
    std::ifstream in(path, std::ios::binary | std::ios::ate);
    if (!in) throw VegetationError("not_found", "cannot open " + path);
    const std::streamsize n = in.tellg();
    in.seekg(0);
    std::vector<uint8_t> data(static_cast<size_t>(std::max<std::streamsize>(n, 0)));
    if (n > 0 && !in.read(reinterpret_cast<char*>(data.data()), n)) throw VegetationError("not_found", "cannot read " + path);
    return data;
}

// ============================================================================================
// Minimal GLB builder
// ============================================================================================

namespace detail {

struct GlbBuilder {
    std::vector<uint8_t> bin;
    std::vector<std::string> views, accessors;

    int addView(const void* data, size_t bytes, int target) {
        while (bin.size() % 4) bin.push_back(0);
        const size_t offset = bin.size();
        const auto* p = static_cast<const uint8_t*>(data);
        bin.insert(bin.end(), p, p + bytes);
        std::string v = "{\"buffer\":0,\"byteOffset\":" + std::to_string(offset) + ",\"byteLength\":" + std::to_string(bytes);
        if (target) v += ",\"target\":" + std::to_string(target);
        views.push_back(v + "}");
        return static_cast<int>(views.size()) - 1;
    }

    int addFloatAccessor(const std::vector<float>& data, int comps, bool minMax) {
        const int view = addView(data.data(), data.size() * 4, 34962);
        const size_t count = data.size() / static_cast<size_t>(comps);
        std::string a = "{\"bufferView\":" + std::to_string(view) + ",\"componentType\":5126,\"count\":" + std::to_string(count) +
                        ",\"type\":\"" + (comps == 3 ? "VEC3" : comps == 2 ? "VEC2" : "VEC4") + "\"";
        if (minMax && count > 0) {
            std::vector<float> lo(static_cast<size_t>(comps), std::numeric_limits<float>::max()), hi(static_cast<size_t>(comps), -std::numeric_limits<float>::max());
            for (size_t i = 0; i < count; ++i) {
                for (int c = 0; c < comps; ++c) {
                    const float v = data[i * static_cast<size_t>(comps) + static_cast<size_t>(c)];
                    lo[static_cast<size_t>(c)] = std::min(lo[static_cast<size_t>(c)], v);
                    hi[static_cast<size_t>(c)] = std::max(hi[static_cast<size_t>(c)], v);
                }
            }
            a += ",\"min\":[";
            for (int c = 0; c < comps; ++c) a += (c ? "," : "") + json::num(lo[static_cast<size_t>(c)]);
            a += "],\"max\":[";
            for (int c = 0; c < comps; ++c) a += (c ? "," : "") + json::num(hi[static_cast<size_t>(c)]);
            a += "]";
        }
        accessors.push_back(a + "}");
        return static_cast<int>(accessors.size()) - 1;
    }

    int addIndexAccessor(const std::vector<uint32_t>& idx) {
        const int view = addView(idx.data(), idx.size() * 4, 34963);
        accessors.push_back("{\"bufferView\":" + std::to_string(view) + ",\"componentType\":5125,\"count\":" + std::to_string(idx.size()) + ",\"type\":\"SCALAR\"}");
        return static_cast<int>(accessors.size()) - 1;
    }

    static std::string join(const std::vector<std::string>& v) {
        std::string o;
        for (size_t i = 0; i < v.size(); ++i) o += (i ? "," : "") + v[i];
        return o;
    }

    std::vector<uint8_t> finish(std::string jsonText) {
        while (bin.size() % 4) bin.push_back(0);
        while (jsonText.size() % 4) jsonText.push_back(' ');
        std::vector<uint8_t> out;
        auto u32 = [&](uint32_t v) { for (int i = 0; i < 4; ++i) out.push_back(static_cast<uint8_t>((v >> (8 * i)) & 0xFF)); };
        u32(0x46546C67);
        u32(2);
        u32(static_cast<uint32_t>(12 + 8 + jsonText.size() + (bin.empty() ? 0 : 8 + bin.size())));
        u32(static_cast<uint32_t>(jsonText.size()));
        u32(0x4E4F534A);
        out.insert(out.end(), jsonText.begin(), jsonText.end());
        if (!bin.empty()) {
            u32(static_cast<uint32_t>(bin.size()));
            u32(0x004E4942);
            out.insert(out.end(), bin.begin(), bin.end());
        }
        return out;
    }
};

inline uint64_t mix64(uint64_t h) {
    h ^= h >> 33;
    h *= 0xff51afd7ed558ccdull;
    h ^= h >> 33;
    h *= 0xc4ceb9fe1a85ec53ull;
    h ^= h >> 33;
    return h;
}

inline double hashUnit(uint64_t seed, uint64_t a, uint64_t b) {
    return static_cast<double>(mix64(seed ^ mix64(a * 0x9E3779B97F4A7C15ull + b)) >> 11) / 9007199254740992.0;
}

/** Weld key: positions quantised to `q` metres. */
struct WeldKey {
    int64_t x, y, z;
    bool operator==(const WeldKey& o) const { return x == o.x && y == o.y && z == o.z; }
};
struct WeldKeyHash {
    size_t operator()(const WeldKey& k) const {
        return static_cast<size_t>(mix64(static_cast<uint64_t>(k.x) * 73856093ull ^ static_cast<uint64_t>(k.y) * 19349663ull ^ static_cast<uint64_t>(k.z) * 83492791ull));
    }
};

inline void parallelFor(size_t n, int threads, const std::function<void(size_t, size_t, int)>& body) {
    int T = threads > 0 ? threads : static_cast<int>(std::max(1u, std::thread::hardware_concurrency()));
    T = static_cast<int>(std::min<size_t>(static_cast<size_t>(T), std::max<size_t>(1, n / 2048 + 1)));
    if (T <= 1) { body(0, n, 0); return; }
    std::vector<std::thread> pool;
    const size_t chunk = (n + static_cast<size_t>(T) - 1) / static_cast<size_t>(T);
    for (int t = 0; t < T; ++t) {
        const size_t lo = static_cast<size_t>(t) * chunk, hi = std::min(n, lo + chunk);
        if (lo >= hi) break;
        pool.emplace_back([&, lo, hi, t]() { body(lo, hi, t); });
    }
    for (auto& th : pool) th.join();
}

/** Counts undirected edges used by exactly one triangle (vertex ids already welded). */
inline size_t countOpenEdges(const std::vector<uint32_t>& tri) {
    std::vector<uint64_t> keys;
    keys.reserve(tri.size());
    for (size_t t = 0; t + 2 < tri.size(); t += 3) {
        for (int j = 0; j < 3; ++j) {
            uint32_t a = tri[t + static_cast<size_t>(j)], b = tri[t + static_cast<size_t>((j + 1) % 3)];
            if (a == b) continue;
            if (a > b) std::swap(a, b);
            keys.push_back(static_cast<uint64_t>(a) << 32 | b);
        }
    }
    std::sort(keys.begin(), keys.end());
    size_t open = 0;
    for (size_t i = 0; i < keys.size();) {
        size_t j = i;
        while (j < keys.size() && keys[j] == keys[i]) ++j;
        if (j - i == 1) ++open;
        i = j;
    }
    return open;
}

/** Signed area in the x/z plane, positive for loops whose triangles face +y. */
inline double upArea(const std::vector<Vec3>& p, const std::vector<uint32_t>& loop) {
    double a = 0;
    for (size_t i = 0; i < loop.size(); ++i) {
        const Vec3& u = p[loop[i]];
        const Vec3& v = p[loop[(i + 1) % loop.size()]];
        a += static_cast<double>(u.z) * v.x - static_cast<double>(u.x) * v.z;
    }
    return 0.5 * a;
}

inline bool pointInPolygonXZ(const std::vector<Vec3>& p, const std::vector<uint32_t>& loop, double x, double z) {
    bool inside = false;
    for (size_t i = 0, j = loop.size() - 1; i < loop.size(); j = i++) {
        const Vec3& a = p[loop[i]];
        const Vec3& b = p[loop[j]];
        if ((a.z > z) != (b.z > z)) {
            const double xc = a.x + (z - a.z) * (static_cast<double>(b.x) - a.x) / (static_cast<double>(b.z) - a.z);
            if (x < xc) inside = !inside;
        }
    }
    return inside;
}

inline double segmentDistanceXZ(double px, double pz, const Vec3& a, const Vec3& b) {
    const double dx = static_cast<double>(b.x) - a.x, dz = static_cast<double>(b.z) - a.z;
    const double len2 = dx * dx + dz * dz;
    double t = len2 > 0 ? ((px - a.x) * dx + (pz - a.z) * dz) / len2 : 0;
    t = std::clamp(t, 0.0, 1.0);
    const double ex = a.x + t * dx - px, ez = a.z + t * dz - pz;
    return std::sqrt(ex * ex + ez * ez);
}

/** 2D cross product in the up-area convention: positive when (a, b, c) faces +y. */
inline double cross2(const Vec3& a, const Vec3& b, const Vec3& c) {
    return (static_cast<double>(b.z) - a.z) * (static_cast<double>(c.x) - a.x) - (static_cast<double>(b.x) - a.x) * (static_cast<double>(c.z) - a.z);
}

/**
 * Ear clipping of a closed loop (indices into p) in the x/z plane, keeping the loop's orientation. When no clean ear
 * exists (a self-touching or degenerate loop), the most convex vertex is clipped anyway, so every loop edge is used by
 * exactly one triangle and the result never leaves an open edge. Returns the number of forced clips.
 */
inline size_t earClip(const std::vector<Vec3>& p, std::vector<uint32_t> loop, std::vector<uint32_t>& out) {
    size_t forced = 0;
    const double orient = upArea(p, loop) >= 0 ? 1.0 : -1.0;
    while (loop.size() > 3) {
        const size_t n = loop.size();
        long best = -1;
        double bestScore = -std::numeric_limits<double>::infinity();
        long fallback = -1;
        double fallbackScore = -std::numeric_limits<double>::infinity();
        for (size_t i = 0; i < n; ++i) {
            const uint32_t ia = loop[(i + n - 1) % n], ib = loop[i], ic = loop[(i + 1) % n];
            const Vec3 &a = p[ia], &b = p[ib], &c = p[ic];
            const double cr = cross2(a, b, c) * orient;
            const double ab = std::hypot(static_cast<double>(b.x) - a.x, static_cast<double>(b.z) - a.z);
            const double bc = std::hypot(static_cast<double>(c.x) - b.x, static_cast<double>(c.z) - b.z);
            const double ca = std::hypot(static_cast<double>(a.x) - c.x, static_cast<double>(a.z) - c.z);
            const double peri = ab + bc + ca;
            const double quality = peri > 0 ? cr / (peri * peri) : 0.0;
            if (quality > fallbackScore) { fallbackScore = quality; fallback = static_cast<long>(i); }
            if (std::abs(cr) <= 1e-9 * std::max(1.0, peri * peri)) {
                // collinear or a spike: a zero-area ear, harmless and always clean
                if (best < 0 && bestScore < 0.0) { bestScore = -1.0; best = static_cast<long>(i); }
                continue;
            }
            if (cr <= 0) continue;
            bool clean = true;
            for (size_t k = 0; k < n && clean; ++k) {
                const uint32_t iv = loop[k];
                if (iv == ia || iv == ib || iv == ic) continue;
                const Vec3& q = p[iv];
                const double d1 = cross2(a, b, q) * orient, d2 = cross2(b, c, q) * orient, d3 = cross2(c, a, q) * orient;
                if (d1 > 1e-12 && d2 > 1e-12 && d3 > 1e-12) clean = false;
            }
            if (clean && quality > bestScore) { bestScore = quality; best = static_cast<long>(i); }
        }
        if (best < 0) { best = fallback; ++forced; }
        const size_t i = static_cast<size_t>(best);
        out.insert(out.end(), {loop[(i + n - 1) % n], loop[i], loop[(i + 1) % n]});
        loop.erase(loop.begin() + static_cast<long>(i));
    }
    if (loop.size() == 3) out.insert(out.end(), {loop[0], loop[1], loop[2]});
    return forced;
}

} // namespace detail

// ============================================================================================
// strip
// ============================================================================================

struct StripParams {
    double cell{0.5};                // surface model cell (m)
    double terrainCell{4.0};         // terrain model cell (m)
    double terrainRadius{40.0};      // terrain opening radius (m)
    double exgMin{0.06};             // normalised excess green a vegetation triangle must exceed
    double exgrMin{-0.2};            // ExG - ExR a vegetation triangle must exceed (a weak guard against red-dominated hues)
    double darkGuard{0.06};          // mean texture value (0..1) below which chroma is not judged
    double roughnessRadius{1.0};     // neighbourhood radius for normal dispersion (m)
    double roughnessMin{0.015};      // normal dispersion vegetation must have
    double planarAngleDeg{10.0};     // neighbouring faces within this angle ...
    double planarOffset{0.12};       // ... and this far off each other's plane (m) belong to one planar segment
    double planarArea{6.0};          // faces in a planar segment at least this large (m^2) are surfaces (walls, roofs,
                                     // ground): never vegetation, and the removal stops at them
    double canopyMinHeight{2.0};     // canopy height above the terrain model (m)
    double minTreeHeight{3.0};       // apex above the support surface for a crown to be a tree (m)
    double minCrownArea{4.0};        // m^2
    double windowBase{0.6};          // local-maximum window radius = base + slope * canopy height, clamped (m)
    double windowSlope{0.11};
    double windowMin{1.5};
    double windowMax{4.5};
    double climbLimit{1.0};          // a crown never grows more than this far up into a neighbour (m)
    double supportStep{1.0};         // height gap separating candidate support surfaces (m)
    double supportSearch{25.0};      // how far to look through canopy for a surface to stand on (m)
    double footprintDilation{1.0};   // removal reaches this far beyond the crown footprint (m)
    double clearance{0.3};           // removal stops this high above the support (m)
    double skirtMin{0.3};            // boundary points higher than this above the cap get a skirt down (m)
    double capGrid{1.5};             // spacing of interior cap points (m)
    double seamGap{1.0};             // hole boundaries broken by an open tile seam are joined across gaps up to this (m)
    double sampleSpacing{0.7};       // voxel size of the crown surface samples (m)
    int threads{0};
};

struct CrownRecord {
    int id{0};
    std::string status;              // tree | below_min_height | cut_at_boundary
    Vec3 apex;
    double stemX{0}, stemZ{0};
    double supportY{0};
    std::string supportSource;       // surrounding_surface | terrain_model
    double terrainY{0};
    double apexAboveSupport{0};
    double areaM2{0};
    std::array<double, 16> sectorRadii{};
    std::vector<Vec3> samples;
    int cells{0};
    bool hasGeodetic{false};
    TileFrame::Geodetic apexGeo{}, stemGeo{};
};

struct StripStats {
    size_t inputTriangles{0}, outputTriangles{0}, removedTriangles{0}, capTriangles{0}, skirtTriangles{0};
    size_t texturedTriangles{0}, chromaVegetationTriangles{0}, vegetationTriangles{0}, surfaceTriangles{0};
    size_t images{0};
    size_t openEdgesBefore{0}, openEdgesAfter{0};
    size_t loops{0}, openChains{0}, linkedChains{0}, holesBridged{0}, forcedEars{0}, capInteriorPoints{0}, capFacingDown{0}, capDegenerate{0}, capsReversed{0};
    size_t capFillCells{0};          // footprint cells no loop cap covered (seen from above), filled on the cap surface
    double canopyAreaM2{0}, treeCanopyAreaM2{0};
    size_t crownsTree{0}, crownsLow{0}, crownsCut{0}, crownsTooSmall{0};
    std::array<double, 3> greenDispersionQuartiles{}, otherDispersionQuartiles{};
    std::vector<std::pair<std::string, double>> ms;
};

struct StripResult {
    std::vector<CrownRecord> crowns;
    StripStats stats;
    std::vector<uint8_t> devegetatedGlb;
    texture::ImageBuffer topDown;
    double topDownX0{0}, topDownZ0{0}, topDownCell{1};  // pixel (i, k) covers x0 + i * cell, z0 + k * cell
    TileFrame frame;
};

namespace detail {

inline void sampleTexture(const gltf::SceneMaterial& m, const texture::ImageBuffer& img, Vec2 uv, double rgb[3]) {
    auto wrap = [](double v, int mode) {
        if (mode == 33071) return std::clamp(v, 0.0, 1.0);
        if (mode == 33648) {
            double f = std::fmod(std::abs(v), 2.0);
            return f > 1.0 ? 2.0 - f : f;
        }
        return v - std::floor(v);
    };
    const double u = wrap(uv.x, m.wrapS), v = wrap(uv.y, m.wrapT);
    const int x = std::clamp(static_cast<int>(u * img.width), 0, img.width - 1);
    const int y = std::clamp(static_cast<int>(v * img.height), 0, img.height - 1);
    const size_t o = img.getIndex(x, y);
    for (int c = 0; c < 3; ++c) rgb[c] = img.data[o + static_cast<size_t>(std::min(c, img.channels - 1))] / 255.0;
}

} // namespace detail

class TileVegetation {
public:
    using Clock = std::chrono::steady_clock;

    static StripResult strip(const std::vector<uint8_t>& glb, const StripParams& P, bool wantTopDown) {
        TileVegetation tv(P);
        return tv.run(glb, wantTopDown);
    }

private:
    explicit TileVegetation(const StripParams& p) : P(p) {}

    const StripParams P;
    gltf::GltfScene scene;
    std::vector<Vec3> pos;
    std::vector<uint32_t> idx;
    size_t T{0};
    std::vector<uint32_t> weld;        // per original vertex
    std::vector<Vec3> weldPos;         // per welded vertex
    std::vector<uint32_t> wtri;        // per corner
    std::vector<Vec3> centroid, normal;
    std::vector<float> area;
    std::vector<float> exg, exgr;      // NaN where chroma is not judged
    std::vector<uint8_t> chromaVeg;
    std::vector<float> dispersion;
    std::vector<uint8_t> surface;      // face of a large planar segment
    std::vector<uint8_t> veg;
    // half-edges sorted by undirected key
    struct HalfEdge { uint64_t key; uint32_t tri; uint8_t j; };
    std::vector<HalfEdge> halfEdges;
    std::vector<uint32_t> adjStart, adj; // CSR triangle adjacency across welded edges
    height_field::SurfaceModel surf;
    height_field::Grid dtm;
    StripResult R;
    Clock::time_point t0;

    void lap(const char* name) {
        const auto now = Clock::now();
        R.stats.ms.emplace_back(name, std::chrono::duration<double, std::milli>(now - t0).count());
        t0 = now;
    }

    StripResult run(const std::vector<uint8_t>& glb, bool wantTopDown) {
        t0 = Clock::now();
        R.frame = readTileFrame(glb);
        scene = gltf::GlbSceneReader::parse(glb.data(), glb.size());
        if (!scene.ok) throw VegetationError("bad_input", "cannot read the tile: " + scene.error);
        for (size_t i = 0; i < scene.images.size(); ++i) {
            const auto& im = scene.images[i];
            if (!im.decoded) throw VegetationError("texture_decode", "photo texture " + std::to_string(i) + " could not be decoded: " + (im.error.empty() ? std::string("unknown error") : im.error));
        }
        R.stats.images = scene.images.size();
        pos.resize(scene.mesh.vertices.size());
        for (size_t v = 0; v < pos.size(); ++v) pos[v] = scene.mesh.vertices[v].position;
        idx = scene.mesh.indices;
        T = idx.size() / 3;
        R.stats.inputTriangles = T;
        lap("read");

        weldAndAdjacency();
        lap("weld");
        measureChroma();
        if (R.stats.texturedTriangles == 0) throw VegetationError("no_photo_texture", "the tile has no photo-textured triangles to measure vegetation from");
        lap("chroma");
        measureRoughness();
        lap("roughness");
        measurePlanarSegments();
        lap("planar_segments");
        for (size_t t = 0; t < T; ++t) {
            veg[t] = chromaVeg[t] && dispersion[t] >= P.roughnessMin && !surface[t];
            if (veg[t]) ++R.stats.vegetationTriangles;
        }
        {
            std::vector<float> green, other;
            for (size_t t = 0; t < T; ++t) (chromaVeg[t] ? green : other).push_back(dispersion[t]);
            auto quant = [](std::vector<float>& v, std::array<double, 3>& q) {
                if (v.empty()) return;
                std::sort(v.begin(), v.end());
                for (int i = 0; i < 3; ++i) q[static_cast<size_t>(i)] = v[static_cast<size_t>((0.25 * (i + 1)) * static_cast<double>(v.size() - 1))];
            };
            quant(green, R.stats.greenDispersionQuartiles);
            quant(other, R.stats.otherDispersionQuartiles);
        }
        rasters();
        lap("height_fields");
        segmentCrowns();
        lap("crowns");
        removeAndCap();
        lap("remove_and_cap");
        writeDevegetated();
        lap("write");
        if (wantTopDown) drawTopDown();
        return std::move(R);
    }

    // ---------------------------------------------------------------- weld + adjacency
    void weldAndAdjacency() {
        std::unordered_map<detail::WeldKey, uint32_t, detail::WeldKeyHash> map;
        map.reserve(pos.size());
        weld.resize(pos.size());
        for (size_t v = 0; v < pos.size(); ++v) {
            const detail::WeldKey k{std::llround(pos[v].x * 100.0), std::llround(pos[v].y * 100.0), std::llround(pos[v].z * 100.0)};
            auto it = map.find(k);
            if (it == map.end()) {
                const uint32_t id = static_cast<uint32_t>(weldPos.size());
                map.emplace(k, id);
                weldPos.push_back(pos[v]);
                weld[v] = id;
            } else {
                weld[v] = it->second;
            }
        }
        wtri.resize(idx.size());
        for (size_t c = 0; c < idx.size(); ++c) wtri[c] = weld[idx[c]];
        centroid.resize(T);
        normal.resize(T);
        area.resize(T);
        for (size_t t = 0; t < T; ++t) {
            const Vec3 &A = pos[idx[3 * t]], &B = pos[idx[3 * t + 1]], &C = pos[idx[3 * t + 2]];
            centroid[t] = (A + B + C) * (1.0f / 3.0f);
            const Vec3 n = (B - A).cross(C - A);
            const float len = n.length();
            area[t] = 0.5f * len;
            normal[t] = len > 1e-12f ? n / len : Vec3(0, 0, 0);
        }
        halfEdges.reserve(3 * T);
        for (size_t t = 0; t < T; ++t) {
            for (int j = 0; j < 3; ++j) {
                uint32_t a = wtri[3 * t + static_cast<size_t>(j)], b = wtri[3 * t + static_cast<size_t>((j + 1) % 3)];
                if (a == b) continue;
                if (a > b) std::swap(a, b);
                halfEdges.push_back({static_cast<uint64_t>(a) << 32 | b, static_cast<uint32_t>(t), static_cast<uint8_t>(j)});
            }
        }
        std::sort(halfEdges.begin(), halfEdges.end(), [](const HalfEdge& x, const HalfEdge& y) { return x.key < y.key || (x.key == y.key && x.tri < y.tri); });
        std::vector<uint32_t> degree(T + 1, 0);
        for (size_t i = 0; i < halfEdges.size();) {
            size_t j = i;
            while (j < halfEdges.size() && halfEdges[j].key == halfEdges[i].key) ++j;
            for (size_t a = i; a < j; ++a) degree[halfEdges[a].tri] += static_cast<uint32_t>(j - i - 1);
            i = j;
        }
        adjStart.assign(T + 1, 0);
        for (size_t t = 0; t < T; ++t) adjStart[t + 1] = adjStart[t] + degree[t];
        adj.resize(adjStart[T]);
        std::vector<uint32_t> fill(adjStart.begin(), adjStart.end() - 1);
        for (size_t i = 0; i < halfEdges.size();) {
            size_t j = i;
            while (j < halfEdges.size() && halfEdges[j].key == halfEdges[i].key) ++j;
            for (size_t a = i; a < j; ++a) {
                for (size_t b = i; b < j; ++b) {
                    if (a != b) adj[fill[halfEdges[a].tri]++] = halfEdges[b].tri;
                }
            }
            i = j;
        }
        R.stats.openEdgesBefore = detail::countOpenEdges(wtri);
    }

    // ---------------------------------------------------------------- chroma
    void measureChroma() {
        exg.assign(T, std::numeric_limits<float>::quiet_NaN());
        exgr.assign(T, std::numeric_limits<float>::quiet_NaN());
        chromaVeg.assign(T, 0);
        veg.assign(T, 0);
        std::atomic<size_t> textured{0}, green{0};
        static const float W[7][3] = {{1 / 3.f, 1 / 3.f, 1 / 3.f}, {.6f, .2f, .2f}, {.2f, .6f, .2f}, {.2f, .2f, .6f},
                                      {.45f, .45f, .1f}, {.1f, .45f, .45f}, {.45f, .1f, .45f}};
        detail::parallelFor(T, P.threads, [&](size_t lo, size_t hi, int) {
            size_t tex = 0, gr = 0;
            for (size_t t = lo; t < hi; ++t) {
                const uint32_t m = scene.triangleMaterial[t];
                if (m >= scene.materials.size()) continue;
                const auto& mat = scene.materials[m];
                const int im = mat.baseColorImage;
                if (im < 0 || im >= static_cast<int>(scene.images.size())) continue;
                const auto& img = scene.images[static_cast<size_t>(im)].pixels;
                if (img.empty()) continue;
                ++tex;
                const auto &a = scene.mesh.vertices[idx[3 * t]], &b = scene.mesh.vertices[idx[3 * t + 1]], &c = scene.mesh.vertices[idx[3 * t + 2]];
                double s[3] = {0, 0, 0};
                for (const auto& w : W) {
                    const Vec2 uv(a.uv.x * w[0] + b.uv.x * w[1] + c.uv.x * w[2], a.uv.y * w[0] + b.uv.y * w[1] + c.uv.y * w[2]);
                    double rgb[3];
                    detail::sampleTexture(mat, img, uv, rgb);
                    for (int k = 0; k < 3; ++k) s[k] += rgb[k] / 7.0;
                }
                const double sum = s[0] + s[1] + s[2];
                if (sum / 3.0 < P.darkGuard) continue;
                const double r = s[0] / sum, g = s[1] / sum, bl = s[2] / sum;
                const double eg = 2 * g - r - bl;
                const double er = 1.4 * r - g;
                exg[t] = static_cast<float>(eg);
                exgr[t] = static_cast<float>(eg - er);
                if (eg > P.exgMin && eg - er > P.exgrMin) { chromaVeg[t] = 1; ++gr; }
            }
            textured += tex;
            green += gr;
        });
        R.stats.texturedTriangles = textured;
        R.stats.chromaVegetationTriangles = green;
    }

    // ---------------------------------------------------------------- roughness
    /**
     * Normal dispersion 1 - |sum(a n)| / sum(a) over the welded neighbourhood of each triangle: its first two rings,
     * plus anything further whose centroid lies within roughnessRadius, never beyond twice that radius.
     */
    void measureRoughness() {
        dispersion.assign(T, 0.0f);
        const float r2 = static_cast<float>(P.roughnessRadius * P.roughnessRadius);
        const float far2 = 4.0f * r2;
        int threads = P.threads > 0 ? P.threads : static_cast<int>(std::max(1u, std::thread::hardware_concurrency()));
        std::vector<std::vector<uint32_t>> stamps(static_cast<size_t>(threads) + 1);
        detail::parallelFor(T, threads, [&](size_t lo, size_t hi, int th) {
            auto& stamp = stamps[static_cast<size_t>(th)];
            stamp.assign(T, UINT32_MAX);
            std::vector<std::pair<uint32_t, uint8_t>> queue;
            queue.reserve(256);
            for (size_t t = lo; t < hi; ++t) {
                queue.clear();
                queue.push_back({static_cast<uint32_t>(t), 0});
                stamp[t] = static_cast<uint32_t>(t);
                Vec3 sum(0, 0, 0);
                double asum = 0;
                for (size_t q = 0; q < queue.size() && queue.size() < 192; ++q) {
                    const auto [u, ring] = queue[q];
                    sum += normal[u] * area[u];
                    asum += area[u];
                    for (uint32_t e = adjStart[u]; e < adjStart[u + 1]; ++e) {
                        const uint32_t w = adj[e];
                        if (stamp[w] == t) continue;
                        stamp[w] = static_cast<uint32_t>(t);
                        const float d2 = (centroid[w] - centroid[t]).lengthSquared();
                        if (d2 <= r2 || (ring < 2 && d2 <= far2)) queue.push_back({w, static_cast<uint8_t>(std::min(255, ring + 1))});
                    }
                }
                dispersion[t] = asum > 0 ? static_cast<float>(1.0 - std::min(1.0, static_cast<double>(sum.length()) / asum)) : 0.0f;
            }
        });
    }

    /**
     * Planar segments by region growing against the region's own plane (not pairwise, so a curved or rough surface
     * cannot chain into one segment): seeds are taken flattest first; a neighbour joins when its normal is within
     * planarAngleDeg of the region's area-weighted normal and its centroid within planarOffset of the region's plane
     * (refitted as the region grows). Faces of segments of at least planarArea are surfaces.
     */
    void measurePlanarSegments() {
        std::vector<uint32_t> order(T);
        std::iota(order.begin(), order.end(), 0u);
        std::stable_sort(order.begin(), order.end(), [&](uint32_t a, uint32_t b) { return dispersion[a] < dispersion[b]; });
        const float cosMax = static_cast<float>(std::cos(P.planarAngleDeg * M_PI / 180.0));
        std::vector<int32_t> seg(T, -1);
        std::vector<uint32_t> members;
        surface.assign(T, 0);
        int32_t next = 0;
        for (uint32_t seed : order) {
            if (seg[seed] >= 0 || area[seed] <= 0) continue;
            const int32_t id = next++;
            members.clear();
            members.push_back(seed);
            seg[seed] = id;
            Vec3 nSum = normal[seed] * area[seed];
            Vec3 cSum = centroid[seed] * area[seed];
            double aSum = area[seed];
            Vec3 n = normal[seed];
            Vec3 c = centroid[seed];
            double refitAt = 2.0 * aSum;
            for (size_t q = 0; q < members.size(); ++q) {
                const uint32_t t = members[q];
                for (uint32_t e = adjStart[t]; e < adjStart[t + 1]; ++e) {
                    const uint32_t u = adj[e];
                    if (seg[u] >= 0 || area[u] <= 0) continue;
                    if (normal[u].dot(n) < cosMax) continue;
                    if (std::abs(n.dot(centroid[u] - c)) > P.planarOffset) continue;
                    seg[u] = id;
                    members.push_back(u);
                    nSum += normal[u] * area[u];
                    cSum += centroid[u] * area[u];
                    aSum += area[u];
                    if (aSum >= refitAt) {
                        const float len = nSum.length();
                        if (len > 1e-12f) n = nSum / len;
                        c = cSum / static_cast<float>(aSum);
                        refitAt = 2.0 * aSum;
                    }
                }
            }
            if (aSum >= P.planarArea) {
                for (uint32_t t : members) { surface[t] = 1; ++R.stats.surfaceTriangles; }
            }
        }
    }

    // ---------------------------------------------------------------- rasters
    std::vector<uint8_t> canopy;     // per DSM cell
    std::vector<float> chm, smoothChm;
    std::vector<int> label;          // crown index per cell (-1 none)

    void rasters() {
        const auto& bb = scene.bounds;
        surf = height_field::buildSurfaceModel(pos, idx, bb.min.x, bb.min.z, bb.max.x, bb.max.z, P.cell);
        dtm = height_field::buildTerrainModel(pos, idx, bb.min.x, bb.min.z, bb.max.x, bb.max.z, P.terrainCell, P.terrainRadius);
        const auto& g = surf.top;
        const size_t N = g.size();
        canopy.assign(N, 0);
        chm.assign(N, 0.0f);
        size_t cells = 0;
        for (int k = 0; k < g.nz; ++k) {
            for (int i = 0; i < g.nx; ++i) {
                const size_t c = g.id(i, k);
                const int t = surf.topTriangle[c];
                if (t < 0 || std::isnan(g.h[c])) continue;
                const double hag = g.h[c] - dtm.sample(g.cx(i), g.cz(k));
                chm[c] = static_cast<float>(hag);
                if (veg[static_cast<size_t>(t)] && hag >= P.canopyMinHeight) { canopy[c] = 1; ++cells; }
            }
        }
        // Dark (shadowed) canopy whose chroma could not be judged: a rough cell mostly surrounded by canopy joins it.
        std::vector<uint8_t> add(N, 0);
        for (int k = 1; k < g.nz - 1; ++k) {
            for (int i = 1; i < g.nx - 1; ++i) {
                const size_t c = g.id(i, k);
                const int t = surf.topTriangle[c];
                if (canopy[c] || t < 0 || !std::isnan(exg[static_cast<size_t>(t)])) continue;
                if (dispersion[static_cast<size_t>(t)] < P.roughnessMin || chm[c] < P.canopyMinHeight) continue;
                int n = 0;
                for (int dk = -1; dk <= 1; ++dk) for (int di = -1; di <= 1; ++di) n += canopy[g.id(i + di, k + dk)];
                if (n >= 5) add[c] = 1;
            }
        }
        for (size_t c = 0; c < N; ++c) if (add[c]) { canopy[c] = 1; ++cells; }
        R.stats.canopyAreaM2 = static_cast<double>(cells) * P.cell * P.cell;
        smoothChm.assign(N, 0.0f);
        for (int k = 0; k < g.nz; ++k) {
            for (int i = 0; i < g.nx; ++i) {
                const size_t c = g.id(i, k);
                if (!canopy[c]) continue;
                double s = 0, w = 0;
                for (int dk = -1; dk <= 1; ++dk) {
                    for (int di = -1; di <= 1; ++di) {
                        if (!g.in(i + di, k + dk)) continue;
                        const size_t j = g.id(i + di, k + dk);
                        if (!canopy[j]) continue;
                        const double wt = (di == 0 && dk == 0) ? 4.0 : (di == 0 || dk == 0) ? 2.0 : 1.0;
                        s += wt * chm[j];
                        w += wt;
                    }
                }
                smoothChm[c] = static_cast<float>(s / w);
            }
        }
    }

    // ---------------------------------------------------------------- crowns
    struct CrownWork {
        std::vector<size_t> cells;
        size_t apexCell{0};
        bool cut{false};
        bool tooSmall{false};
        double support{0};
        std::string supportSource;
        bool groundSupported{true};
        int recordIndex{-1};
    };
    std::vector<CrownWork> work;

    double windowRadius(double h) const { return std::clamp(P.windowBase + P.windowSlope * h, P.windowMin, P.windowMax); }

    void segmentCrowns() {
        const auto& g = surf.top;
        const size_t N = g.size();
        // markers: local maxima of the smoothed canopy height model
        std::vector<size_t> tops;
        for (int k = 0; k < g.nz; ++k) {
            for (int i = 0; i < g.nx; ++i) {
                const size_t c = g.id(i, k);
                if (!canopy[c] || smoothChm[c] < P.canopyMinHeight) continue;
                const float h = smoothChm[c];
                const double rad = windowRadius(h);
                const int r = static_cast<int>(std::ceil(rad / P.cell));
                bool peak = true;
                for (int dk = -r; dk <= r && peak; ++dk) {
                    for (int di = -r; di <= r; ++di) {
                        if (di == 0 && dk == 0) continue;
                        if ((di * di + dk * dk) * P.cell * P.cell > rad * rad) continue;
                        if (!g.in(i + di, k + dk)) continue;
                        const size_t j = g.id(i + di, k + dk);
                        if (!canopy[j]) continue;
                        const float v = smoothChm[j];
                        if (v > h || (v == h && j < c)) { peak = false; break; }
                    }
                }
                if (peak) tops.push_back(c);
            }
        }
        // marker-controlled watershed: priority flood from the markers, highest first, with a climb limit
        label.assign(N, -1);
        using Q = std::pair<float, size_t>;
        std::priority_queue<Q> pq;
        for (size_t m = 0; m < tops.size(); ++m) {
            label[tops[m]] = static_cast<int>(m);
            pq.push({smoothChm[tops[m]], tops[m]});
        }
        const int D[4][2] = {{1, 0}, {-1, 0}, {0, 1}, {0, -1}};
        while (!pq.empty()) {
            const auto [h, c] = pq.top();
            pq.pop();
            const int i = static_cast<int>(c % static_cast<size_t>(g.nx)), k = static_cast<int>(c / static_cast<size_t>(g.nx));
            for (const auto& d : D) {
                const int a = i + d[0], b = k + d[1];
                if (!g.in(a, b)) continue;
                const size_t j = g.id(a, b);
                if (!canopy[j] || label[j] >= 0) continue;
                if (smoothChm[j] > smoothChm[c] + P.climbLimit) continue;
                label[j] = label[c];
                pq.push({smoothChm[j], j});
            }
        }
        work.assign(tops.size(), {});
        for (size_t c = 0; c < N; ++c) if (label[c] >= 0) work[static_cast<size_t>(label[c])].cells.push_back(c);
        // fragments smaller than minCrownArea join the neighbouring crown they share the longest border with
        {
            std::vector<size_t> order(work.size());
            std::iota(order.begin(), order.end(), size_t{0});
            std::sort(order.begin(), order.end(), [&](size_t a, size_t b) { return work[a].cells.size() < work[b].cells.size() || (work[a].cells.size() == work[b].cells.size() && a < b); });
            for (size_t m : order) {
                auto& w = work[m];
                if (w.cells.empty() || static_cast<double>(w.cells.size()) * P.cell * P.cell >= P.minCrownArea) continue;
                std::map<int, int> votes;
                for (size_t c : w.cells) {
                    const int i = static_cast<int>(c % static_cast<size_t>(g.nx)), k = static_cast<int>(c / static_cast<size_t>(g.nx));
                    for (const auto& d : D) {
                        const int a = i + d[0], b = k + d[1];
                        if (!g.in(a, b)) continue;
                        const int l = label[g.id(a, b)];
                        if (l >= 0 && l != static_cast<int>(m)) votes[l]++;
                    }
                }
                int best = -1, bestVotes = 0;
                for (const auto& [l, v] : votes) if (v > bestVotes) { bestVotes = v; best = l; }
                if (best < 0) continue;
                for (size_t c : w.cells) label[c] = best;
                auto& into = work[static_cast<size_t>(best)].cells;
                into.insert(into.end(), w.cells.begin(), w.cells.end());
                w.cells.clear();
            }
        }

        // the extraction's outer edge: grid border plus empty cells connected to it
        std::vector<uint8_t> outside(N, 0);
        {
            std::queue<size_t> q;
            auto seed = [&](int i, int k) {
                const size_t c = g.id(i, k);
                if (std::isnan(g.h[c]) && !outside[c]) { outside[c] = 1; q.push(c); }
            };
            for (int i = 0; i < g.nx; ++i) { seed(i, 0); seed(i, g.nz - 1); }
            for (int k = 0; k < g.nz; ++k) { seed(0, k); seed(g.nx - 1, k); }
            while (!q.empty()) {
                const size_t c = q.front();
                q.pop();
                const int i = static_cast<int>(c % static_cast<size_t>(g.nx)), k = static_cast<int>(c / static_cast<size_t>(g.nx));
                for (const auto& d : D) {
                    const int a = i + d[0], b = k + d[1];
                    if (g.in(a, b)) seed(a, b);
                }
            }
        }

        for (size_t m = 0; m < work.size(); ++m) {
            auto& w = work[m];
            const double area = static_cast<double>(w.cells.size()) * P.cell * P.cell;
            w.tooSmall = area < P.minCrownArea;
            float best = -std::numeric_limits<float>::infinity();
            for (size_t c : w.cells) {
                if (g.h[c] > best) { best = g.h[c]; w.apexCell = c; }
                const int i = static_cast<int>(c % static_cast<size_t>(g.nx)), k = static_cast<int>(c / static_cast<size_t>(g.nx));
                for (int dk = -1; dk <= 1 && !w.cut; ++dk) {
                    for (int di = -1; di <= 1; ++di) {
                        const int a = i + di, b = k + dk;
                        if (!g.in(a, b) || outside[g.id(a, b)] || a == 0 || b == 0 || a == g.nx - 1 || b == g.nz - 1) { w.cut = true; break; }
                    }
                }
            }
        }
        for (size_t m = 0; m < work.size(); ++m) {
            auto& w = work[m];
            if (w.cells.empty()) continue;  // merged into a neighbour
            if (w.tooSmall) { ++R.stats.crownsTooSmall; continue; }
            measureCrown(static_cast<int>(m));
        }
    }

    /** The surface a crown stands on, its status, footprint, sector radii and surface samples. */
    void measureCrown(int m) {
        const auto& g = surf.top;
        auto& w = work[static_cast<size_t>(m)];
        CrownRecord rec;
        rec.id = m;
        rec.cells = static_cast<int>(w.cells.size());
        rec.areaM2 = static_cast<double>(w.cells.size()) * P.cell * P.cell;
        const int ai = static_cast<int>(w.apexCell % static_cast<size_t>(g.nx)), ak = static_cast<int>(w.apexCell / static_cast<size_t>(g.nx));
        rec.apex = Vec3(static_cast<float>(g.cx(ai)), g.h[w.apexCell], static_cast<float>(g.cz(ak)));
        // stem: canopy-height-weighted centroid of the upper half of the crown
        const double apexChm = chm[w.apexCell];
        double sx = 0, sz = 0, sw = 0;
        for (size_t c : w.cells) {
            const double wt = std::max(0.0, static_cast<double>(chm[c]) - 0.5 * apexChm);
            const int i = static_cast<int>(c % static_cast<size_t>(g.nx)), k = static_cast<int>(c / static_cast<size_t>(g.nx));
            sx += wt * g.cx(i);
            sz += wt * g.cz(k);
            sw += wt;
        }
        rec.stemX = sw > 0 ? sx / sw : rec.apex.x;
        rec.stemZ = sw > 0 ? sz / sw : rec.apex.z;
        rec.terrainY = dtm.sample(rec.stemX, rec.stemZ);

        // support: the nearest planar surfaces (ground, roofs) around the footprint, reached outward from its edge
        // through anything else (other canopy, rough non-green surfaces), nearest first
        std::vector<float> samples;
        std::unordered_map<size_t, uint8_t> seen;
        seen.reserve(w.cells.size() * 4);
        for (size_t c : w.cells) seen.emplace(c, 1);
        const int D[4][2] = {{1, 0}, {-1, 0}, {0, 1}, {0, -1}};
        std::queue<size_t> frontier;
        for (size_t c : w.cells) frontier.push(c);
        const double reach2 = P.supportSearch * P.supportSearch;
        const size_t wanted = std::max<size_t>(12, std::min<size_t>(64, w.cells.size() / 2));
        while (!frontier.empty() && samples.size() < wanted) {
            const size_t c = frontier.front();
            frontier.pop();
            const int i = static_cast<int>(c % static_cast<size_t>(g.nx)), k = static_cast<int>(c / static_cast<size_t>(g.nx));
            for (const auto& d : D) {
                const int a = i + d[0], b = k + d[1];
                if (!g.in(a, b)) continue;
                const size_t j = g.id(a, b);
                if (seen.count(j)) continue;
                const double dx = g.cx(a) - rec.stemX, dz = g.cz(b) - rec.stemZ;
                if (dx * dx + dz * dz > reach2) continue;
                seen.emplace(j, 1);
                frontier.push(j);
                const int t = surf.topTriangle[j];
                // a surface to stand on is planar and close to level (ground, roofs); steep planar patches are walls or drapes
                if (!canopy[j] && t >= 0 && surface[static_cast<size_t>(t)] && std::abs(normal[static_cast<size_t>(t)].y) >= 0.85f && !std::isnan(g.h[j])) samples.push_back(g.h[j]);
            }
        }
        if (!samples.empty()) {
            std::sort(samples.begin(), samples.end());
            size_t bestLo = 0, bestN = 0, lo = 0;
            for (size_t i = 1; i <= samples.size(); ++i) {
                if (i == samples.size() || samples[i] - samples[i - 1] > P.supportStep) {
                    if (i - lo > bestN) { bestN = i - lo; bestLo = lo; }
                    lo = i;
                }
            }
            rec.supportY = samples[bestLo + bestN / 2];
            rec.supportSource = "surrounding_surface";
        } else {
            rec.supportY = rec.terrainY;
            rec.supportSource = "terrain_model";
        }
        rec.supportY = std::min(rec.supportY, static_cast<double>(rec.apex.y));
        rec.apexAboveSupport = rec.apex.y - rec.supportY;
        w.support = rec.supportY;
        w.supportSource = rec.supportSource;
        w.groundSupported = std::abs(rec.supportY - rec.terrainY) <= 1.5;

        if (w.cut) { rec.status = "cut_at_boundary"; ++R.stats.crownsCut; }
        else if (rec.apexAboveSupport < P.minTreeHeight) { rec.status = "below_min_height"; ++R.stats.crownsLow; }
        else { rec.status = "tree"; ++R.stats.crownsTree; R.stats.treeCanopyAreaM2 += rec.areaM2; }

        // sector radii (16 sectors around the stem) and voxel samples of the crown surface
        rec.sectorRadii.fill(0.0);
        std::unordered_map<uint64_t, std::pair<Vec3, int>> vox;
        for (size_t c : w.cells) {
            const int i = static_cast<int>(c % static_cast<size_t>(g.nx)), k = static_cast<int>(c / static_cast<size_t>(g.nx));
            const double dx = g.cx(i) - rec.stemX, dz = g.cz(k) - rec.stemZ;
            const double ang = std::atan2(dz, dx);
            const int s = static_cast<int>(std::floor((ang + M_PI) / (2 * M_PI) * 16.0)) & 15;
            rec.sectorRadii[static_cast<size_t>(s)] = std::max(rec.sectorRadii[static_cast<size_t>(s)], std::hypot(dx, dz) + 0.5 * P.cell);
            const Vec3 p(static_cast<float>(g.cx(i)), g.h[c], static_cast<float>(g.cz(k)));
            const int64_t vx = static_cast<int64_t>(std::floor(p.x / P.sampleSpacing)), vy = static_cast<int64_t>(std::floor(p.y / P.sampleSpacing)), vz = static_cast<int64_t>(std::floor(p.z / P.sampleSpacing));
            const uint64_t key = (static_cast<uint64_t>(vx & 0x1FFFFF) << 42) | (static_cast<uint64_t>(vy & 0x1FFFFF) << 21) | static_cast<uint64_t>(vz & 0x1FFFFF);
            auto& slot = vox[key];
            slot.first += p;
            slot.second += 1;
        }
        // empty sectors take the mean of their neighbours (the footprint is measured, a gap in it is not a hole)
        for (int pass = 0; pass < 2; ++pass) {
            for (int s = 0; s < 16; ++s) {
                if (rec.sectorRadii[static_cast<size_t>(s)] > 0) continue;
                const double a = rec.sectorRadii[static_cast<size_t>((s + 15) % 16)], b = rec.sectorRadii[static_cast<size_t>((s + 1) % 16)];
                if (a > 0 || b > 0) rec.sectorRadii[static_cast<size_t>(s)] = (a > 0 && b > 0) ? 0.5 * (a + b) : std::max(a, b);
            }
        }
        std::vector<std::pair<uint64_t, Vec3>> ordered;
        ordered.reserve(vox.size());
        for (const auto& [key, slot] : vox) ordered.emplace_back(key, slot.first / static_cast<float>(slot.second));
        std::sort(ordered.begin(), ordered.end(), [](const auto& a, const auto& b) { return a.first < b.first; });
        for (const auto& kv : ordered) rec.samples.push_back(kv.second);
        if (R.frame.known) {
            rec.hasGeodetic = true;
            rec.apexGeo = R.frame.toGeodetic(rec.apex.x, rec.apex.y, rec.apex.z);
            rec.stemGeo = R.frame.toGeodetic(rec.stemX, rec.supportY, rec.stemZ);
        }
        w.recordIndex = static_cast<int>(R.crowns.size());
        R.crowns.push_back(std::move(rec));
    }

    // ---------------------------------------------------------------- removal + cap
    std::vector<int32_t> removedBy;      // crown index (work) per triangle, -1 kept
    std::vector<Vec3> capPos;            // cap/skirt vertices
    std::vector<uint32_t> capTris;       // indices into capPos
    std::vector<uint8_t> capIsSkirt;     // per cap triangle

    double capHeight(int crown, double x, double z) const {
        const auto& w = work[static_cast<size_t>(crown)];
        return w.groundSupported ? dtm.sample(x, z) : w.support;
    }

    void removeAndCap() {
        const auto& g = surf.top;
        const size_t N = g.size();
        removedBy.assign(T, -1);
        // seed and growth masks per cell: dilated footprints of the trees
        std::vector<int> seedMask(N, -1), growMask(N, -1);
        const int rs = static_cast<int>(std::ceil(P.footprintDilation / P.cell));
        const int rg = static_cast<int>(std::ceil(2.0 * P.footprintDilation / P.cell));
        for (size_t m = 0; m < work.size(); ++m) {
            const auto& w = work[m];
            if (w.recordIndex < 0 || R.crowns[static_cast<size_t>(w.recordIndex)].status != "tree") continue;
            for (size_t c : w.cells) {
                const int i = static_cast<int>(c % static_cast<size_t>(g.nx)), k = static_cast<int>(c / static_cast<size_t>(g.nx));
                for (int dk = -rg; dk <= rg; ++dk) {
                    for (int di = -rg; di <= rg; ++di) {
                        if (!g.in(i + di, k + dk)) continue;
                        const int d2 = di * di + dk * dk;
                        const size_t j = g.id(i + di, k + dk);
                        if (d2 <= rg * rg && growMask[j] < 0) growMask[j] = static_cast<int>(m);
                        if (d2 <= rs * rs && seedMask[j] < 0) seedMask[j] = static_cast<int>(m);
                    }
                }
            }
        }
        // canopy that belongs to no kept crown (fragments, cells the watershed did not reach) may be removed with the
        // tree it hangs on; canopy of crowns that stay (low roof vegetation, crowns cut by the boundary) may not
        std::vector<uint8_t> freeCanopy(N, 0);
        {
            std::vector<uint8_t> kept(N, 0);
            for (const auto& w : work) {
                if (w.recordIndex < 0 || R.crowns[static_cast<size_t>(w.recordIndex)].status == "tree") continue;
                for (size_t c : w.cells) {
                    const int i = static_cast<int>(c % static_cast<size_t>(g.nx)), k = static_cast<int>(c / static_cast<size_t>(g.nx));
                    for (int dk = -1; dk <= 1; ++dk) for (int di = -1; di <= 1; ++di) if (g.in(i + di, k + dk)) kept[g.id(i + di, k + dk)] = 1;
                }
            }
            for (size_t c = 0; c < N; ++c) freeCanopy[c] = canopy[c] && !kept[c] && growMask[c] < 0;
        }
        auto cellOf = [&](const Vec3& p) -> long {
            const int i = g.ix(p.x), k = g.iz(p.z);
            return g.in(i, k) ? static_cast<long>(g.id(i, k)) : -1;
        };
        // the highest corner of a triangle: growth takes every non-surface triangle that reaches above the clearance, so
        // the hem where a scanned crown drapes down to the ground goes with the tree instead of standing as a sliver
        auto topY = [&](uint32_t t) {
            return std::max({weldPos[wtri[3 * static_cast<size_t>(t)]].y, weldPos[wtri[3 * static_cast<size_t>(t) + 1]].y, weldPos[wtri[3 * static_cast<size_t>(t) + 2]].y});
        };
        std::queue<uint32_t> q;
        for (size_t t = 0; t < T; ++t) {
            if (!veg[t]) continue;
            const long c = cellOf(centroid[t]);
            if (c < 0 || seedMask[static_cast<size_t>(c)] < 0) continue;
            const int m = seedMask[static_cast<size_t>(c)];
            if (centroid[t].y <= work[static_cast<size_t>(m)].support + P.clearance) continue;
            removedBy[t] = m;
            q.push(static_cast<uint32_t>(t));
        }
        while (!q.empty()) {
            const uint32_t t = q.front();
            q.pop();
            const int m = removedBy[t];
            for (uint32_t e = adjStart[t]; e < adjStart[t + 1]; ++e) {
                const uint32_t u = adj[e];
                if (removedBy[u] >= 0) continue;
                const long c = cellOf(centroid[u]);
                if (c < 0 || (growMask[static_cast<size_t>(c)] != m && !freeCanopy[static_cast<size_t>(c)])) continue;
                if (topY(u) <= work[static_cast<size_t>(m)].support + P.clearance) continue;
                if (surface[u] && !chromaVeg[u]) continue;  // walls, roofs and ground stop it; green planar patches are canopy
                removedBy[u] = m;
                q.push(u);
            }
        }
        for (size_t t = 0; t < T; ++t) if (removedBy[t] >= 0) ++R.stats.removedTriangles;

        // hole edges: an edge of a kept triangle whose other triangles were all removed, reversed
        // (wall: the kept triangle is a steep planar surface, so the hole's edge there hangs on a wall)
        struct HoleEdge { uint32_t a, b; int crown; bool used; bool wall; };
        std::vector<HoleEdge> holes;
        for (size_t i = 0; i < halfEdges.size();) {
            size_t j = i;
            size_t kept = 0, removed = 0;
            int crown = -1;
            long keptAt = -1;
            while (j < halfEdges.size() && halfEdges[j].key == halfEdges[i].key) {
                const uint32_t t = halfEdges[j].tri;
                if (removedBy[t] >= 0) { ++removed; crown = removedBy[t]; }
                else { ++kept; keptAt = static_cast<long>(j); }
                ++j;
            }
            if (kept == 1 && removed >= 1) {
                const auto& he = halfEdges[static_cast<size_t>(keptAt)];
                const uint32_t a = wtri[3 * he.tri + he.j], b = wtri[3 * he.tri + static_cast<size_t>((he.j + 1) % 3)];
                const bool wall = surface[he.tri] && std::abs(normal[he.tri].y) < 0.7f;
                holes.push_back({b, a, crown, false, wall});
            }
            i = j;
        }
        // Walk the hole edges into paths: chains first (from vertices with more outgoing than incoming hole edges),
        // then the remaining cycles. A chain ends where the hole meets a seam that was open before (tile leaves are
        // separate meshes); chains are then joined end to start across such gaps (nearest first, within seamGap).
        std::unordered_map<uint32_t, std::vector<size_t>> out;
        std::unordered_map<uint32_t, int> indeg;
        for (size_t h = 0; h < holes.size(); ++h) { out[holes[h].a].push_back(h); indeg[holes[h].b]++; }
        struct Path { std::vector<uint32_t> v; std::vector<uint8_t> wall; std::map<int, int> votes; bool closed{false}; };
        auto walk = [&](size_t h0) {
            Path p;
            size_t h = h0;
            while (true) {
                holes[h].used = true;
                p.v.push_back(holes[h].a);
                p.wall.push_back(holes[h].wall ? 1 : 0);
                p.votes[holes[h].crown]++;
                const uint32_t next = holes[h].b;
                if (next == holes[h0].a) { p.closed = true; break; }
                auto it = out.find(next);
                long pick = -1;
                if (it != out.end()) {
                    for (size_t cand : it->second) if (!holes[cand].used) { pick = static_cast<long>(cand); break; }
                }
                if (pick < 0) { p.v.push_back(next); break; }
                h = static_cast<size_t>(pick);
            }
            return p;
        };
        std::vector<Path> closedPaths, openPaths;
        for (size_t h = 0; h < holes.size(); ++h) {
            if (holes[h].used) continue;
            const auto in = indeg.find(holes[h].a);
            if ((in == indeg.end() ? 0 : in->second) >= static_cast<int>(out[holes[h].a].size())) continue;
            Path p = walk(h);
            (p.closed ? closedPaths : openPaths).push_back(std::move(p));
        }
        for (size_t h = 0; h < holes.size(); ++h) {
            if (holes[h].used) continue;
            Path p = walk(h);
            (p.closed ? closedPaths : openPaths).push_back(std::move(p));
        }
        R.stats.openChains = openPaths.size();
        std::vector<uint8_t> chainUsed(openPaths.size(), 0);
        for (size_t i = 0; i < openPaths.size(); ++i) {
            if (chainUsed[i]) continue;
            chainUsed[i] = 1;
            Path cycle = std::move(openPaths[i]);
            while (true) {
                const Vec3 end = weldPos[cycle.v.back()];
                const double dSelf = (end - weldPos[cycle.v.front()]).length();
                long best = -1;
                double bestD = std::numeric_limits<double>::infinity();
                for (size_t j = 0; j < openPaths.size(); ++j) {
                    if (chainUsed[j]) continue;
                    const double d = (end - weldPos[openPaths[j].v.front()]).length();
                    if (d < bestD) { bestD = d; best = static_cast<long>(j); }
                }
                if (best < 0 || bestD > P.seamGap || bestD >= dSelf) break;
                Path& nx = openPaths[static_cast<size_t>(best)];
                chainUsed[static_cast<size_t>(best)] = 1;
                const size_t skip = nx.v.front() == cycle.v.back() ? 1 : 0;
                if (!skip) cycle.wall.push_back(0);  // the gap across the seam
                cycle.v.insert(cycle.v.end(), nx.v.begin() + static_cast<long>(skip), nx.v.end());
                cycle.wall.insert(cycle.wall.end(), nx.wall.begin(), nx.wall.end());
                for (const auto& [c, n] : nx.votes) cycle.votes[c] += n;
                ++R.stats.linkedChains;
            }
            if (cycle.v.size() > 1 && cycle.v.front() == cycle.v.back()) cycle.v.pop_back();
            cycle.wall.resize(cycle.v.size(), 0);  // the closing edge
            closedPaths.push_back(std::move(cycle));
        }
        std::vector<std::vector<uint32_t>> loops;   // welded vertex ids
        std::vector<std::vector<uint8_t>> loopWall;  // per edge loop[i] -> loop[i + 1]
        std::vector<int> loopCrown;
        for (auto& p : closedPaths) {
            if (p.v.size() < 3) continue;
            int crown = -1, best = -1;
            for (const auto& [c, n] : p.votes) if (n > best) { best = n; crown = c; }
            p.wall.resize(p.v.size(), 0);
            loops.push_back(std::move(p.v));
            loopWall.push_back(std::move(p.wall));
            loopCrown.push_back(crown);
        }
        R.stats.loops = loops.size();

        // skirts down to the cap surface, then caps
        std::unordered_map<uint32_t, uint32_t> top, dropped;  // welded id -> cap vertex
        auto topVertex = [&](uint32_t wv) {
            auto it = top.find(wv);
            if (it != top.end()) return it->second;
            capPos.push_back(weldPos[wv]);
            const uint32_t id = static_cast<uint32_t>(capPos.size() - 1);
            top.emplace(wv, id);
            return id;
        };
        auto addTri = [&](uint32_t a, uint32_t b, uint32_t c, bool skirt) {
            if (a == b || b == c || a == c) return;
            capTris.insert(capTris.end(), {a, b, c});
            capIsSkirt.push_back(skirt ? 1 : 0);
        };
        std::vector<std::vector<uint32_t>> polys(loops.size());
        for (size_t l = 0; l < loops.size(); ++l) {
            const auto& loop = loops[l];
            const int crown = loopCrown[l];
            std::vector<uint32_t> upper(loop.size()), lower(loop.size());
            for (size_t i = 0; i < loop.size(); ++i) {
                upper[i] = topVertex(loop[i]);
                const Vec3 p = weldPos[loop[i]];
                const double gy = capHeight(crown, p.x, p.z);
                // only points hanging on a wall get a skirt down it; other high points (canopy that stays) are
                // reached by the cap itself
                const bool onWall = loopWall[l][i] || loopWall[l][(i + loop.size() - 1) % loop.size()];
                if (onWall && p.y - gy > P.skirtMin) {
                    auto it = dropped.find(loop[i]);
                    if (it == dropped.end()) {
                        capPos.push_back(Vec3(p.x, static_cast<float>(gy), p.z));
                        it = dropped.emplace(loop[i], static_cast<uint32_t>(capPos.size() - 1)).first;
                    }
                    lower[i] = it->second;
                } else {
                    lower[i] = upper[i];
                }
            }
            for (size_t i = 0; i < loop.size(); ++i) {
                const size_t n = (i + 1) % loop.size();
                if (upper[i] == lower[i] && upper[n] == lower[n]) continue;
                addTri(upper[i], upper[n], lower[n], true);
                addTri(upper[i], lower[n], lower[i], true);
            }
            std::vector<uint32_t> poly;
            for (uint32_t v : lower) if (poly.empty() || poly.back() != v) poly.push_back(v);
            while (poly.size() > 1 && poly.front() == poly.back()) poly.pop_back();
            polys[l] = std::move(poly);
        }
        R.stats.skirtTriangles = capIsSkirt.size();

        // holes in caps: loops facing down that sit inside a loop facing up are bridged into it
        std::vector<double> areas(polys.size());
        for (size_t l = 0; l < polys.size(); ++l) areas[l] = polys[l].size() >= 3 ? detail::upArea(capPos, polys[l]) : 0.0;
        std::vector<long> parent(polys.size(), -1);
        for (size_t l = 0; l < polys.size(); ++l) {
            if (polys[l].size() < 3 || areas[l] >= 0) continue;
            const Vec3& probe = capPos[polys[l][0]];
            double bestArea = std::numeric_limits<double>::infinity();
            for (size_t o = 0; o < polys.size(); ++o) {
                if (o == l || polys[o].size() < 3 || areas[o] <= 0 || areas[o] >= bestArea) continue;
                if (detail::pointInPolygonXZ(capPos, polys[o], probe.x, probe.z)) { bestArea = areas[o]; parent[l] = static_cast<long>(o); }
            }
        }
        std::vector<std::vector<size_t>> children(polys.size());
        for (size_t l = 0; l < polys.size(); ++l) if (parent[l] >= 0) children[static_cast<size_t>(parent[l])].push_back(l);
        for (size_t l = 0; l < polys.size(); ++l) {
            if (polys[l].size() < 3 || parent[l] >= 0) continue;
            std::vector<uint32_t> merged = polys[l];
            // a cap is ground or roof: it faces up even where the loop around it winds the other way
            if (areas[l] < 0) { std::reverse(merged.begin(), merged.end()); ++R.stats.capsReversed; }
            for (size_t c : children[l]) {
                const auto& hole = polys[c];
                ++R.stats.holesBridged;
                // bridge from the hole's vertex with the largest x to the nearest outer vertex
                size_t hi = 0;
                for (size_t i = 1; i < hole.size(); ++i) if (capPos[hole[i]].x > capPos[hole[hi]].x) hi = i;
                size_t oi = 0;
                double bd = std::numeric_limits<double>::infinity();
                for (size_t i = 0; i < merged.size(); ++i) {
                    const double d = (capPos[merged[i]] - capPos[hole[hi]]).lengthSquared();
                    if (d < bd) { bd = d; oi = i; }
                }
                std::vector<uint32_t> next(merged.begin(), merged.begin() + static_cast<long>(oi) + 1);
                for (size_t i = 0; i <= hole.size(); ++i) next.push_back(hole[(hi + i) % hole.size()]);
                next.insert(next.end(), merged.begin() + static_cast<long>(oi), merged.end());
                merged = std::move(next);
            }
            const size_t first = capTris.size();
            R.stats.forcedEars += detail::earClip(capPos, merged, capTris);
            for (size_t k = first / 3; k < capTris.size() / 3; ++k) capIsSkirt.push_back(0);
            // interior points on a grid, each splitting the cap triangle that holds it
            if (areas[l] > P.capGrid * P.capGrid && loopCrown[l] >= 0) {
                double minX = 1e30, maxX = -1e30, minZ = 1e30, maxZ = -1e30;
                for (uint32_t v : polys[l]) {
                    minX = std::min(minX, static_cast<double>(capPos[v].x)); maxX = std::max(maxX, static_cast<double>(capPos[v].x));
                    minZ = std::min(minZ, static_cast<double>(capPos[v].z)); maxZ = std::max(maxZ, static_cast<double>(capPos[v].z));
                }
                const double s = P.capGrid;
                for (double z = std::ceil(minZ / s) * s; z <= maxZ; z += s) {
                    for (double x = std::ceil(minX / s) * s; x <= maxX; x += s) {
                        if (!detail::pointInPolygonXZ(capPos, polys[l], x, z)) continue;
                        bool inHole = false;
                        for (size_t c : children[l]) inHole = inHole || detail::pointInPolygonXZ(capPos, polys[c], x, z);
                        if (inHole) continue;
                        double dmin = std::numeric_limits<double>::infinity();
                        for (size_t i = 0; i < merged.size(); ++i) dmin = std::min(dmin, detail::segmentDistanceXZ(x, z, capPos[merged[i]], capPos[merged[(i + 1) % merged.size()]]));
                        if (dmin < 0.35 * s) continue;
                        const Vec3 q(static_cast<float>(x), static_cast<float>(capHeight(loopCrown[l], x, z)), static_cast<float>(z));
                        for (size_t k = first / 3; k < capTris.size() / 3; ++k) {
                            if (capIsSkirt[k]) continue;
                            const uint32_t a = capTris[3 * k], b = capTris[3 * k + 1], c = capTris[3 * k + 2];
                            const double o = detail::cross2(capPos[a], capPos[b], capPos[c]);
                            if (std::abs(o) < 1e-9) continue;
                            const double sgn = o > 0 ? 1.0 : -1.0;
                            const double d1 = detail::cross2(capPos[a], capPos[b], q) * sgn, d2 = detail::cross2(capPos[b], capPos[c], q) * sgn, d3 = detail::cross2(capPos[c], capPos[a], q) * sgn;
                            if (d1 <= 1e-9 || d2 <= 1e-9 || d3 <= 1e-9) continue;
                            capPos.push_back(q);
                            const uint32_t qi = static_cast<uint32_t>(capPos.size() - 1);
                            capTris[3 * k + 2] = qi;  // (a, b, q)
                            capTris.insert(capTris.end(), {b, c, qi, c, a, qi});
                            capIsSkirt.push_back(0);
                            capIsSkirt.push_back(0);
                            ++R.stats.capInteriorPoints;
                            break;
                        }
                    }
                }
            }
        }
        fillUncoveredCells(growMask);
        R.stats.capTriangles = capIsSkirt.size() - R.stats.skirtTriangles;
        for (size_t k = 0; k < capIsSkirt.size(); ++k) {
            if (capIsSkirt[k]) continue;
            const Vec3 &a = capPos[capTris[3 * k]], &b = capPos[capTris[3 * k + 1]], &c = capPos[capTris[3 * k + 2]];
            const Vec3 n = (b - a).cross(c - a);
            const float len = n.length();
            if (len < 1e-9f) ++R.stats.capDegenerate;
            else if (n.y / len < 0.0f) ++R.stats.capFacingDown;
        }

        // how far interior cap points sit from the surface they were put on (should be ~0)
        // and the open-edge count of the result (welded ids for kept triangles, cap vertices mapped back)
        std::vector<uint32_t> after;
        after.reserve(wtri.size());
        for (size_t t = 0; t < T; ++t) {
            if (removedBy[t] >= 0) continue;
            after.insert(after.end(), {wtri[3 * t], wtri[3 * t + 1], wtri[3 * t + 2]});
        }
        std::vector<uint32_t> capToWeld(capPos.size());
        uint32_t nextId = static_cast<uint32_t>(weldPos.size());
        std::vector<uint8_t> isTop(capPos.size(), 0);
        for (const auto& [wv, ci] : top) { capToWeld[ci] = wv; isTop[ci] = 1; }
        for (size_t ci = 0; ci < capPos.size(); ++ci) if (!isTop[ci]) capToWeld[ci] = nextId++;
        for (uint32_t v : capTris) after.push_back(capToWeld[v]);
        R.stats.openEdgesAfter = detail::countOpenEdges(after);
        R.stats.outputTriangles = after.size() / 3;
    }

    /**
     * Seen from above, every cell of a removed tree's footprint that the scan covered must still be covered. Hole loops
     * broken by tile seams, or folded over themselves, can leave part of a hole uncapped; those cells get a grid patch on
     * the cap surface (one welded patch per run of cells), so the ground under a removed tree is never left open.
     */
    void fillUncoveredCells(const std::vector<int>& growMask) {
        const auto& g = surf.top;
        auto raster = [&](const Vec3& a, const Vec3& b, const Vec3& c, std::vector<uint8_t>& cov) {
            const double d = (static_cast<double>(b.x) - a.x) * (static_cast<double>(c.z) - a.z) - (static_cast<double>(c.x) - a.x) * (static_cast<double>(b.z) - a.z);
            if (std::abs(d) < 1e-12) return;
            const int i0 = std::max(0, g.ix(std::min({a.x, b.x, c.x}))), i1 = std::min(g.nx - 1, g.ix(std::max({a.x, b.x, c.x})));
            const int k0 = std::max(0, g.iz(std::min({a.z, b.z, c.z}))), k1 = std::min(g.nz - 1, g.iz(std::max({a.z, b.z, c.z})));
            for (int k = k0; k <= k1; ++k) {
                for (int i = i0; i <= i1; ++i) {
                    const double x = g.cx(i), z = g.cz(k);
                    const double w1 = ((x - a.x) * (c.z - a.z) - (c.x - a.x) * (z - a.z)) / d;
                    const double w2 = ((b.x - a.x) * (z - a.z) - (x - a.x) * (b.z - a.z)) / d;
                    if (w1 >= -1e-9 && w2 >= -1e-9 && 1 - w1 - w2 >= -1e-9) cov[g.id(i, k)] = 1;
                }
            }
        };
        std::vector<uint8_t> before(g.size(), 0), after(g.size(), 0);
        std::vector<int> cellCrown(g.size(), -1);
        for (size_t t = 0; t < T; ++t) {
            const Vec3 &a = weldPos[wtri[3 * t]], &b = weldPos[wtri[3 * t + 1]], &c = weldPos[wtri[3 * t + 2]];
            raster(a, b, c, before);
            if (removedBy[t] < 0) { raster(a, b, c, after); continue; }
            const int i = g.ix(centroid[t].x), k = g.iz(centroid[t].z);
            if (g.in(i, k)) cellCrown[g.id(i, k)] = removedBy[t];
        }
        for (size_t k = 0; 3 * k + 2 < capTris.size(); ++k) raster(capPos[capTris[3 * k]], capPos[capTris[3 * k + 1]], capPos[capTris[3 * k + 2]], after);
        std::unordered_map<uint64_t, uint32_t> corner;  // grid corner -> cap vertex, so neighbouring fill cells share edges
        auto cornerVertex = [&](int i, int k, int crown) {
            const uint64_t key = (static_cast<uint64_t>(static_cast<uint32_t>(i)) << 32) | static_cast<uint32_t>(k);
            auto it = corner.find(key);
            if (it != corner.end()) return it->second;
            const double x = g.x0 + i * g.cell, z = g.z0 + k * g.cell;
            capPos.push_back(Vec3(static_cast<float>(x), static_cast<float>(capHeight(crown, x, z)), static_cast<float>(z)));
            const uint32_t id = static_cast<uint32_t>(capPos.size() - 1);
            corner.emplace(key, id);
            return id;
        };
        // each uncovered cell takes the crown (cap surface) of the removal it lies in; cells only spanned by large removed
        // triangles take it from the nearest uncovered cell that has one
        std::vector<int> fillCrown(g.size(), -1);
        std::queue<size_t> q;
        for (size_t c = 0; c < g.size(); ++c) {
            if (!before[c] || after[c]) continue;
            fillCrown[c] = growMask[c] >= 0 ? growMask[c] : cellCrown[c];
            if (fillCrown[c] >= 0) q.push(c);
        }
        while (!q.empty()) {
            const size_t c = q.front();
            q.pop();
            const int i = static_cast<int>(c % static_cast<size_t>(g.nx)), k = static_cast<int>(c / static_cast<size_t>(g.nx));
            for (const auto& [di, dk] : {std::pair{1, 0}, std::pair{-1, 0}, std::pair{0, 1}, std::pair{0, -1}}) {
                if (!g.in(i + di, k + dk)) continue;
                const size_t n = g.id(i + di, k + dk);
                if (!before[n] || after[n] || fillCrown[n] >= 0) continue;
                fillCrown[n] = fillCrown[c];
                q.push(n);
            }
        }
        for (int k = 0; k < g.nz; ++k) {
            for (int i = 0; i < g.nx; ++i) {
                const size_t c = g.id(i, k);
                if (!before[c] || after[c]) continue;
                const int crown = fillCrown[c];
                if (crown < 0) continue;
                const uint32_t v00 = cornerVertex(i, k, crown), v10 = cornerVertex(i + 1, k, crown), v01 = cornerVertex(i, k + 1, crown), v11 = cornerVertex(i + 1, k + 1, crown);
                // x = east, z = south: (i, k) -> (i, k + 1) -> (i + 1, k) faces up
                capTris.insert(capTris.end(), {v00, v01, v10, v10, v01, v11});
                capIsSkirt.push_back(0);
                capIsSkirt.push_back(0);
                ++R.stats.capFillCells;
            }
        }
    }

    // ---------------------------------------------------------------- output
    void writeDevegetated() {
        const size_t M = std::max<size_t>(scene.materials.size(), 1);
        struct Prim { std::vector<float> p, n, uv; std::vector<uint32_t> i; std::unordered_map<uint32_t, uint32_t> map; };
        std::vector<Prim> prims(M);
        for (size_t t = 0; t < T; ++t) {
            if (removedBy[t] >= 0) continue;
            const size_t mi = std::min<size_t>(scene.triangleMaterial[t], M - 1);
            Prim& pr = prims[mi];
            for (int j = 0; j < 3; ++j) {
                const uint32_t v = idx[3 * t + static_cast<size_t>(j)];
                auto it = pr.map.find(v);
                if (it == pr.map.end()) {
                    const auto& vx = scene.mesh.vertices[v];
                    pr.p.insert(pr.p.end(), {vx.position.x, vx.position.y, vx.position.z});
                    pr.n.insert(pr.n.end(), {vx.normal.x, vx.normal.y, vx.normal.z});
                    pr.uv.insert(pr.uv.end(), {vx.uv.x, vx.uv.y});
                    it = pr.map.emplace(v, static_cast<uint32_t>(pr.p.size() / 3 - 1)).first;
                }
                pr.i.push_back(it->second);
            }
        }
        // cap primitive: flat-shaded corners
        Prim cap;
        for (size_t k = 0; k < capTris.size() / 3; ++k) {
            const Vec3 &a = capPos[capTris[3 * k]], &b = capPos[capTris[3 * k + 1]], &c = capPos[capTris[3 * k + 2]];
            Vec3 n = (b - a).cross(c - a);
            n = n.lengthSquared() > 1e-20f ? n.normalized() : Vec3(0, 1, 0);
            for (const Vec3* p : {&a, &b, &c}) {
                cap.p.insert(cap.p.end(), {p->x, p->y, p->z});
                cap.n.insert(cap.n.end(), {n.x, n.y, n.z});
                cap.uv.insert(cap.uv.end(), {0.0f, 0.0f});
                cap.i.push_back(static_cast<uint32_t>(cap.p.size() / 3 - 1));
            }
        }

        detail::GlbBuilder gb;
        std::vector<std::string> images, textures, samplers, materials, meshes, nodes, children;
        for (const auto& im : scene.images) {
            const int view = gb.addView(im.encoded.data(), im.encoded.size(), 0);
            images.push_back("{\"mimeType\":" + json::str(im.mimeType.empty() ? "image/jpeg" : im.mimeType) + ",\"bufferView\":" + std::to_string(view) + "}");
        }
        bool anyUnlit = false;
        for (const auto& sm : scene.materials) {
            std::string s = "{\"pbrMetallicRoughness\":{\"baseColorFactor\":[" + json::num(sm.baseColorFactor.x) + "," + json::num(sm.baseColorFactor.y) + "," +
                            json::num(sm.baseColorFactor.z) + "," + json::num(sm.baseColorFactor.w) + "],\"metallicFactor\":" + json::num(sm.metallicFactor) +
                            ",\"roughnessFactor\":" + json::num(sm.roughnessFactor);
            if (sm.baseColorImage >= 0 && sm.baseColorImage < static_cast<int>(scene.images.size())) {
                samplers.push_back("{\"magFilter\":9729,\"minFilter\":9987,\"wrapS\":" + std::to_string(sm.wrapS) + ",\"wrapT\":" + std::to_string(sm.wrapT) + "}");
                textures.push_back("{\"source\":" + std::to_string(sm.baseColorImage) + ",\"sampler\":" + std::to_string(samplers.size() - 1) + "}");
                s += ",\"baseColorTexture\":{\"index\":" + std::to_string(textures.size() - 1) + "}";
            }
            s += "}";
            if (sm.doubleSided) s += ",\"doubleSided\":true";
            if (sm.unlit) { s += ",\"extensions\":{\"KHR_materials_unlit\":{}}"; anyUnlit = true; }
            materials.push_back(s + "}");
        }
        if (materials.empty()) materials.push_back("{\"pbrMetallicRoughness\":{\"metallicFactor\":0,\"roughnessFactor\":1}}");
        const size_t capMaterial = materials.size();
        materials.push_back("{\"name\":\"VegetationRemovedCap\",\"pbrMetallicRoughness\":{\"baseColorFactor\":[0.55,0.57,0.6,1],\"metallicFactor\":0,\"roughnessFactor\":0.85}}");
        auto addPrim = [&](Prim& pr, size_t material, const std::string& name) {
            if (pr.i.empty()) return;
            const int aP = gb.addFloatAccessor(pr.p, 3, true), aN = gb.addFloatAccessor(pr.n, 3, false), aUV = gb.addFloatAccessor(pr.uv, 2, false), aI = gb.addIndexAccessor(pr.i);
            meshes.push_back("{\"name\":" + json::str(name) + ",\"primitives\":[{\"attributes\":{\"POSITION\":" + std::to_string(aP) + ",\"NORMAL\":" + std::to_string(aN) +
                             ",\"TEXCOORD_0\":" + std::to_string(aUV) + "},\"indices\":" + std::to_string(aI) + ",\"material\":" + std::to_string(material) + ",\"mode\":4}]}");
            nodes.push_back("{\"name\":" + json::str(name) + ",\"mesh\":" + std::to_string(meshes.size() - 1) + "}");
            children.push_back(std::to_string(nodes.size()));
        };
        for (size_t mi = 0; mi < M; ++mi) addPrim(prims[mi], mi, "tile_m" + std::to_string(mi));
        addPrim(cap, capMaterial, "vegetation_removed_cap");
        std::string j = "{\"asset\":{\"version\":\"2.0\",\"generator\":\"Scratchbox tile_vegetation strip\"},";
        if (anyUnlit) j += "\"extensionsUsed\":[\"KHR_materials_unlit\"],";
        j += "\"scene\":0,\"scenes\":[{\"nodes\":[0]}],\"nodes\":[{\"name\":\"devegetated_tile\",\"children\":[" + detail::GlbBuilder::join(children) + "]}";
        if (!nodes.empty()) j += "," + detail::GlbBuilder::join(nodes);
        j += "],\"meshes\":[" + detail::GlbBuilder::join(meshes) + "],\"materials\":[" + detail::GlbBuilder::join(materials) + "]";
        if (!textures.empty()) j += ",\"textures\":[" + detail::GlbBuilder::join(textures) + "],\"samplers\":[" + detail::GlbBuilder::join(samplers) + "]";
        if (!images.empty()) j += ",\"images\":[" + detail::GlbBuilder::join(images) + "]";
        j += ",\"accessors\":[" + detail::GlbBuilder::join(gb.accessors) + "],\"bufferViews\":[" + detail::GlbBuilder::join(gb.views) + "]";
        j += ",\"buffers\":[{\"byteLength\":" + std::to_string((gb.bin.size() + 3) & ~static_cast<size_t>(3)) + "}]";
        if (R.frame.extrasJson != "null") j += ",\"extras\":" + R.frame.extrasJson;
        j += "}";
        R.devegetatedGlb = gb.finish(j);
    }

    void drawTopDown() {
        const auto& g = surf.top;
        float hmin = 1e9f, hmax = -1e9f;
        for (float h : g.h) if (!std::isnan(h)) { hmin = std::min(hmin, h); hmax = std::max(hmax, h); }
        texture::ImageBuffer img(g.nx, g.nz, 3, 0);
        std::vector<uint8_t> removedCell(g.size(), 0);
        for (size_t t = 0; t < T; ++t) {
            if (removedBy[t] < 0) continue;
            const int i = g.ix(centroid[t].x), k = g.iz(centroid[t].z);
            if (g.in(i, k)) removedCell[g.id(i, k)] = 1;
        }
        for (int k = 0; k < g.nz; ++k) {
            for (int i = 0; i < g.nx; ++i) {
                const size_t c = g.id(i, k);
                const float h = g.h[c];
                const uint8_t v = std::isnan(h) ? 0 : static_cast<uint8_t>(40 + 180 * (h - hmin) / (hmax - hmin + 1e-6f));
                uint8_t r = v, gg = v, b = v;
                if (canopy[c]) { r = static_cast<uint8_t>(v * 0.3); gg = static_cast<uint8_t>(std::min(255, 80 + static_cast<int>(v * 0.8))); b = static_cast<uint8_t>(v * 0.3); }
                if (removedCell[c]) { r = static_cast<uint8_t>(std::min(255, r + 60)); b = static_cast<uint8_t>(std::min(255, b + 120)); }
                if (label[c] >= 0) {
                    for (const auto& d : {std::pair{1, 0}, std::pair{0, 1}}) {
                        const int a = i + d.first, bb = k + d.second;
                        if (g.in(a, bb) && label[g.id(a, bb)] != label[c]) { r = 255; gg = 255; b = 0; }
                    }
                }
                const size_t o = img.getIndex(i, k);
                img.data[o] = r; img.data[o + 1] = gg; img.data[o + 2] = b;
            }
        }
        for (const auto& rec : R.crowns) {
            const int ai = g.ix(rec.apex.x), ak = g.iz(rec.apex.z);
            uint8_t cr = 255, cg = 0, cb = 0;
            if (rec.status == "below_min_height") { cr = 255; cg = 140; cb = 0; }
            if (rec.status == "cut_at_boundary") { cr = 255; cg = 0; cb = 255; }
            for (int dk = -2; dk <= 2; ++dk) {
                for (int di = -2; di <= 2; ++di) {
                    if (!g.in(ai + di, ak + dk)) continue;
                    const size_t o = img.getIndex(ai + di, ak + dk);
                    img.data[o] = cr; img.data[o + 1] = cg; img.data[o + 2] = cb;
                }
            }
        }
        R.topDown = std::move(img);
        R.topDownX0 = g.x0;
        R.topDownZ0 = g.z0;
        R.topDownCell = g.cell;
    }
};

// ============================================================================================
// crowns.json
// ============================================================================================

inline std::string crownsJson(const StripResult& r, const StripParams& P) {
    std::ostringstream s;
    auto v3 = [](const Vec3& v) { return "[" + json::num(v.x) + "," + json::num(v.y) + "," + json::num(v.z) + "]"; };
    s << "{\n\"version\":1,\n\"frame\":" << r.frame.extrasJson << ",\n";
    s << "\"params\":{\"cell\":" << json::num(P.cell) << ",\"minTreeHeight\":" << json::num(P.minTreeHeight) << ",\"minCrownArea\":" << json::num(P.minCrownArea)
      << ",\"sampleSpacing\":" << json::num(P.sampleSpacing) << "},\n\"crowns\":[";
    for (size_t i = 0; i < r.crowns.size(); ++i) {
        const auto& c = r.crowns[i];
        s << (i ? ",\n" : "\n") << "{\"id\":" << c.id << ",\"status\":" << json::str(c.status) << ",\"apex\":" << v3(c.apex)
          << ",\"stem\":[" << json::num(c.stemX) << "," << json::num(c.stemZ) << "],\"supportY\":" << json::num(c.supportY)
          << ",\"supportSource\":" << json::str(c.supportSource) << ",\"terrainY\":" << json::num(c.terrainY)
          << ",\"apexAboveSupport\":" << json::num(c.apexAboveSupport) << ",\"areaM2\":" << json::num(c.areaM2) << ",\"sectorRadii\":[";
        for (size_t k = 0; k < 16; ++k) s << (k ? "," : "") << json::num(c.sectorRadii[k]);
        s << "],\"footprint\":[";
        for (size_t k = 0; k < 16; ++k) {
            const double ang = -M_PI + (k + 0.5) * (2 * M_PI / 16.0);
            s << (k ? "," : "") << "[" << json::num(c.stemX + c.sectorRadii[k] * std::cos(ang)) << "," << json::num(c.stemZ + c.sectorRadii[k] * std::sin(ang)) << "]";
        }
        s << "]";
        if (c.hasGeodetic) {
            s << ",\"apexLatLng\":[" << json::numPrecise(c.apexGeo.lat) << "," << json::numPrecise(c.apexGeo.lng) << "],\"apexEllipsoidalHeightM\":" << json::num(c.apexGeo.h)
              << ",\"stemLatLng\":[" << json::numPrecise(c.stemGeo.lat) << "," << json::numPrecise(c.stemGeo.lng) << "]";
        }
        s << ",\"samples\":[";
        for (size_t k = 0; k < c.samples.size(); ++k) s << (k ? "," : "") << v3(c.samples[k]);
        s << "]}";
    }
    s << "\n]\n}\n";
    return s.str();
}

inline std::string stripStatsJson(const StripResult& r) {
    const auto& st = r.stats;
    std::ostringstream s;
    s << "{\n  \"ok\": true,\n  \"triangles\": {\"input\": " << st.inputTriangles << ", \"output\": " << st.outputTriangles << ", \"removed\": " << st.removedTriangles
      << ", \"cap\": " << st.capTriangles << ", \"skirt\": " << st.skirtTriangles << ", \"textured\": " << st.texturedTriangles
      << ", \"chromaVegetation\": " << st.chromaVegetationTriangles << ", \"vegetation\": " << st.vegetationTriangles << ", \"planarSurface\": " << st.surfaceTriangles << "},\n";
    s << "  \"images\": " << st.images << ",\n";
    s << "  \"openEdges\": {\"before\": " << st.openEdgesBefore << ", \"after\": " << st.openEdgesAfter << "},\n";
    s << "  \"holes\": {\"loops\": " << st.loops << ", \"openChains\": " << st.openChains << ", \"linkedChains\": " << st.linkedChains << ", \"holesBridged\": " << st.holesBridged << ", \"forcedEars\": " << st.forcedEars << ", \"capInteriorPoints\": " << st.capInteriorPoints << ", \"capFacingDown\": " << st.capFacingDown << ", \"capDegenerate\": " << st.capDegenerate << ", \"capsReversed\": " << st.capsReversed << ", \"capFillCells\": " << st.capFillCells << "},\n";
    s << "  \"canopyAreaM2\": " << json::num(st.canopyAreaM2) << ",\n  \"treeCanopyAreaM2\": " << json::num(st.treeCanopyAreaM2) << ",\n";
    s << "  \"crowns\": {\"tree\": " << st.crownsTree << ", \"belowMinHeight\": " << st.crownsLow << ", \"cutAtBoundary\": " << st.crownsCut << ", \"tooSmall\": " << st.crownsTooSmall << "},\n";
    auto q3 = [](const std::array<double, 3>& q) { return "[" + json::num(q[0]) + ", " + json::num(q[1]) + ", " + json::num(q[2]) + "]"; };
    s << "  \"dispersionQuartiles\": {\"green\": " << q3(st.greenDispersionQuartiles) << ", \"other\": " << q3(st.otherDispersionQuartiles) << "},\n";
    if (!r.topDown.empty()) s << "  \"topDown\": {\"x0\": " << json::num(r.topDownX0) << ", \"z0\": " << json::num(r.topDownZ0) << ", \"cell\": " << json::num(r.topDownCell) << ", \"width\": " << r.topDown.width << ", \"height\": " << r.topDown.height << "},\n";
    s << "  \"frameKnown\": " << (r.frame.known ? "true" : "false") << ",\n";
    s << "  \"stagesMs\": {";
    double total = 0;
    for (size_t i = 0; i < st.ms.size(); ++i) { s << (i ? ", " : "") << json::str(st.ms[i].first) << ": " << json::num(st.ms[i].second); total += st.ms[i].second; }
    s << "},\n  \"totalMs\": " << json::num(total) << "\n}\n";
    return s.str();
}

// ============================================================================================
// plant
// ============================================================================================

struct PlantParams {
    double triangleBudget{0};        // total triangles for all trees (required, > 0)
    double minTrianglesPerTree{120};
    double crownBaseRatio{0.35};     // crown base = support + ratio * (apex - support): not observed, inferred
    double trunkRadiusPerHeight{0.016}; // trunk radius = ratio * height: not observed, inferred
    double woodShare{0.4};
    double shellDepth{0.8};          // share of each surface sample's height above the crown base that the crown fills
    uint64_t seed{0};
    double supportTolerance{0.3};    // isolate: the trunk base must hit the support mesh within this (m)
    int threads{0};
};

struct PlantedTree {
    int crownId{0};
    uint32_t seed{0};
    size_t budget{0};
    nature::TreeBudgetReport report;
    geometry::Mesh wood, foliage;
    double heightAboveSupport{0}, crownBaseY{0}, trunkRadius{0};
    const io::GlbJsonValue* crown{nullptr};
};

struct PlantResult {
    std::vector<PlantedTree> trees;
    std::vector<std::pair<int, std::string>> skipped;  // crown id, reason
    size_t triangles{0};
    double ms{0};
    std::vector<uint8_t> glb;
};

namespace detail {

inline Vec3 vec3Of(const io::GlbJsonValue& v) {
    return Vec3(static_cast<float>(v[0].num), static_cast<float>(v[1].num), static_cast<float>(v[2].num));
}

/** Heights at which a vertical line through (x, z) meets a mesh. */
struct VerticalProbe {
    double x0{0}, z0{0}, cell{2.0};
    int nx{0}, nz{0};
    std::vector<std::vector<uint32_t>> buckets;
    const std::vector<Vec3>* p{nullptr};
    const std::vector<uint32_t>* idx{nullptr};

    void build(const std::vector<Vec3>& positions, const std::vector<uint32_t>& indices) {
        p = &positions;
        idx = &indices;
        double minX = 1e30, minZ = 1e30, maxX = -1e30, maxZ = -1e30;
        for (const auto& v : positions) { minX = std::min(minX, static_cast<double>(v.x)); maxX = std::max(maxX, static_cast<double>(v.x)); minZ = std::min(minZ, static_cast<double>(v.z)); maxZ = std::max(maxZ, static_cast<double>(v.z)); }
        x0 = minX; z0 = minZ;
        nx = std::max(1, static_cast<int>(std::ceil((maxX - minX) / cell)) + 1);
        nz = std::max(1, static_cast<int>(std::ceil((maxZ - minZ) / cell)) + 1);
        buckets.assign(static_cast<size_t>(nx) * static_cast<size_t>(nz), {});
        for (size_t t = 0; t + 2 < indices.size(); t += 3) {
            const Vec3 &a = positions[indices[t]], &b = positions[indices[t + 1]], &c = positions[indices[t + 2]];
            const int i0 = std::clamp(static_cast<int>(std::floor((std::min({a.x, b.x, c.x}) - x0) / cell)), 0, nx - 1);
            const int i1 = std::clamp(static_cast<int>(std::floor((std::max({a.x, b.x, c.x}) - x0) / cell)), 0, nx - 1);
            const int k0 = std::clamp(static_cast<int>(std::floor((std::min({a.z, b.z, c.z}) - z0) / cell)), 0, nz - 1);
            const int k1 = std::clamp(static_cast<int>(std::floor((std::max({a.z, b.z, c.z}) - z0) / cell)), 0, nz - 1);
            for (int k = k0; k <= k1; ++k) for (int i = i0; i <= i1; ++i) buckets[static_cast<size_t>(k) * static_cast<size_t>(nx) + static_cast<size_t>(i)].push_back(static_cast<uint32_t>(t / 3));
        }
    }

    std::vector<double> heightsAt(double x, double z) const {
        std::vector<double> out;
        const int i = static_cast<int>(std::floor((x - x0) / cell)), k = static_cast<int>(std::floor((z - z0) / cell));
        if (i < 0 || k < 0 || i >= nx || k >= nz) return out;
        for (uint32_t t : buckets[static_cast<size_t>(k) * static_cast<size_t>(nx) + static_cast<size_t>(i)]) {
            const Vec3 &A = (*p)[(*idx)[3 * t]], &B = (*p)[(*idx)[3 * t + 1]], &C = (*p)[(*idx)[3 * t + 2]];
            const double d = (static_cast<double>(B.x) - A.x) * (static_cast<double>(C.z) - A.z) - (static_cast<double>(C.x) - A.x) * (static_cast<double>(B.z) - A.z);
            if (std::abs(d) < 1e-12) continue;
            const double w1 = ((x - A.x) * (C.z - A.z) - (C.x - A.x) * (z - A.z)) / d;
            const double w2 = ((B.x - A.x) * (z - A.z) - (x - A.x) * (B.z - A.z)) / d;
            const double w0 = 1 - w1 - w2;
            if (w0 < -1e-9 || w1 < -1e-9 || w2 < -1e-9) continue;
            out.push_back(w0 * A.y + w1 * B.y + w2 * C.y);
        }
        return out;
    }
};

} // namespace detail

/**
 * Grows one tree per crown with status "tree". `supportMesh` (optional, isolate requests) keeps only crowns whose
 * trunk base lies on that mesh within supportTolerance of the measured support.
 */
inline PlantResult plant(const io::GlbJsonValue& crownsDoc, const PlantParams& P,
                         const std::vector<Vec3>* supportPositions = nullptr, const std::vector<uint32_t>* supportIndices = nullptr) {
    const auto t0 = std::chrono::steady_clock::now();
    if (!(P.triangleBudget > 0)) throw VegetationError("bad_request", "plant needs a triangle budget greater than 0");
    const auto& crowns = crownsDoc["crowns"];
    if (crowns.type != io::GlbJsonValue::Array) throw VegetationError("bad_input", "crowns.json has no crowns array");
    detail::VerticalProbe probe;
    if (supportPositions && supportIndices) {
        if (supportIndices->empty()) throw VegetationError("bad_input", "the support mesh has no triangles");
        probe.build(*supportPositions, *supportIndices);
    }
    PlantResult R;
    std::vector<const io::GlbJsonValue*> chosen;
    for (const auto& c : crowns.arr) {
        if (c["status"].asString() != "tree") continue;
        const int id = c["id"].asInt(-1);
        if (c["samples"].arr.size() < 3) throw VegetationError("bad_input", "crown " + std::to_string(id) + " has fewer than 3 surface samples");
        if (probe.p) {
            const double sx = c["stem"][0].num, sz = c["stem"][1].num, sy = c["supportY"].num;
            bool on = false;
            for (double h : probe.heightsAt(sx, sz)) on = on || std::abs(h - sy) <= P.supportTolerance;
            if (!on) { R.skipped.emplace_back(id, "not_on_support_mesh"); continue; }
        }
        chosen.push_back(&c);
    }
    const size_t n = chosen.size();
    if (n > 0 && P.triangleBudget < P.minTrianglesPerTree * static_cast<double>(n)) {
        std::ostringstream m;
        m << "a triangle budget of " << static_cast<size_t>(P.triangleBudget) << " cannot hold " << n << " trees at " << static_cast<size_t>(P.minTrianglesPerTree) << " triangles each";
        throw VegetationError("budget_too_small", m.str());
    }
    double areaSum = 0;
    for (const auto* c : chosen) areaSum += std::max(0.0, (*c)["areaM2"].num);
    const double spare = P.triangleBudget - P.minTrianglesPerTree * static_cast<double>(n);
    R.trees.resize(n);
    std::atomic<size_t> next{0};
    std::vector<std::string> errors(n);
    auto worker = [&]() {
        while (true) {
            const size_t i = next.fetch_add(1);
            if (i >= n) return;
            const auto& c = *chosen[i];
            PlantedTree& tr = R.trees[i];
            try {
                tr.crown = chosen[i];
                tr.crownId = c["id"].asInt(-1);
                const double share = areaSum > 0 ? std::max(0.0, c["areaM2"].num) / areaSum : 1.0 / static_cast<double>(n);
                tr.budget = static_cast<size_t>(std::floor(P.minTrianglesPerTree + spare * share));
                tr.seed = static_cast<uint32_t>(detail::mix64(P.seed ^ detail::mix64(static_cast<uint64_t>(tr.crownId) + 0x5BD1E995ull)) & 0xFFFFFFFFull);
                const Vec3 apex = detail::vec3Of(c["apex"]);
                const double stemX = c["stem"][0].num, stemZ = c["stem"][1].num, support = c["supportY"].num;
                const double H = std::max(0.5, static_cast<double>(apex.y) - support);
                tr.heightAboveSupport = H;
                tr.crownBaseY = support + P.crownBaseRatio * H;
                tr.trunkRadius = P.trunkRadiusPerHeight * H;
                // attractors: the crown volume under the measured surface, from each surface sample down by shellDepth
                // of its height above the (inferred) crown base, on a voxel grid scaled to the crown
                double radius = 0;
                for (const auto& r : c["sectorRadii"].arr) radius += r.num / 16.0;
                // attractor spacing: fine enough for the crown's width and for its depth (a wide flat crown needs fine layers)
                const double voxel = std::clamp(std::min(radius / 6.0, (static_cast<double>(apex.y) - tr.crownBaseY) / 4.0), 0.4, 1.6);
                std::vector<Vec3> attractors;
                std::unordered_map<uint64_t, size_t> occupied;
                auto addAttractor = [&](double x, double y, double z) {
                    const int64_t a = static_cast<int64_t>(std::floor(x / voxel)), b = static_cast<int64_t>(std::floor(y / voxel)), d = static_cast<int64_t>(std::floor(z / voxel));
                    const uint64_t key = (static_cast<uint64_t>(a & 0x1FFFFF) << 42) | (static_cast<uint64_t>(b & 0x1FFFFF) << 21) | static_cast<uint64_t>(d & 0x1FFFFF);
                    if (occupied.emplace(key, attractors.size()).second) attractors.push_back(Vec3(static_cast<float>(x), static_cast<float>(y), static_cast<float>(z)));
                };
                const auto& samples = c["samples"].arr;
                for (size_t k = 0; k < samples.size(); ++k) {
                    const Vec3 s = detail::vec3Of(samples[k]);
                    // the scan drapes the crown's edge down towards the ground; below the crown base it is not crown
                    if (s.y < tr.crownBaseY) continue;
                    addAttractor(s.x, s.y, s.z);
                    const double bottom = s.y - std::max(0.0, static_cast<double>(s.y) - tr.crownBaseY) * P.shellDepth;
                    int layer = 1;
                    for (double y = s.y - voxel; y >= bottom; y -= voxel, ++layer) {
                        const double jx = (detail::hashUnit(tr.seed, k, static_cast<uint64_t>(layer) * 3) - 0.5) * voxel;
                        const double jy = (detail::hashUnit(tr.seed, k, static_cast<uint64_t>(layer) * 3 + 1) - 0.5) * voxel;
                        const double jz = (detail::hashUnit(tr.seed, k, static_cast<uint64_t>(layer) * 3 + 2) - 0.5) * voxel;
                        addAttractor(s.x + jx, y + jy, s.z + jz);
                    }
                }
                if (attractors.size() < 3) throw VegetationError("plant_failed", "crown " + std::to_string(tr.crownId) + " has no measured surface above its crown base");
                Vec3 lo(1e9f, 1e9f, 1e9f), hi(-1e9f, -1e9f, -1e9f);
                for (const auto& a : attractors) { lo.x = std::min(lo.x, a.x); lo.y = std::min(lo.y, a.y); lo.z = std::min(lo.z, a.z); hi.x = std::max(hi.x, a.x); hi.y = std::max(hi.y, a.y); hi.z = std::max(hi.z, a.z); }
                nature::SpaceColonizationConfig cfg;
                cfg.customAttractors = attractors;
                cfg.attractorCount = static_cast<int>(attractors.size());
                cfg.rootAnchor = Vec3(static_cast<float>(stemX), static_cast<float>(support), static_cast<float>(stemZ));
                cfg.crownCenter = (lo + hi) * 0.5f;
                cfg.crownExtents = Vec3(std::max(0.5f, (hi.x - lo.x) * 0.5f), std::max(0.5f, (hi.y - lo.y) * 0.5f), std::max(0.5f, (hi.z - lo.z) * 0.5f));
                cfg.clearTrunkHeight = static_cast<float>(tr.crownBaseY - support);
                cfg.baseRadius = static_cast<float>(tr.trunkRadius);
                const float step = static_cast<float>(std::clamp(H / 40.0, 0.2, 0.6));
                cfg.branchStepLength = step;
                cfg.perceptionRadius = static_cast<float>(std::max(5.5 * step, 3.0 * voxel));
                cfg.killRadius = static_cast<float>(std::max(1.6 * step, 0.9 * voxel));
                cfg.maxIterations = static_cast<int>(std::min(400.0, std::ceil(3.0 * (H + radius) / step)));
                cfg.rootFlareHeight = static_cast<float>(std::min(0.8, 0.06 * H));
                cfg.seed = tr.seed;
                cfg.triangleBudget = static_cast<float>(tr.budget);
                cfg.woodBudgetShare = static_cast<float>(P.woodShare);
                auto [wood, foliage] = nature::SpaceColonizationTreeGenerator::generateTreeComponents(cfg, &tr.report);
                tr.wood = std::move(wood);
                tr.foliage = std::move(foliage);
                // a tree that never grew into its measured crown is not the tree that was measured
                float top = -std::numeric_limits<float>::infinity();
                for (const auto& v : tr.foliage.vertices) top = std::max(top, v.y);
                if (tr.foliage.indices.empty() || top < tr.crownBaseY + 0.35 * (apex.y - tr.crownBaseY)) {
                    throw VegetationError("plant_failed", "crown " + std::to_string(tr.crownId) + " did not grow into its measured crown");
                }
            } catch (const std::exception& e) {
                errors[i] = e.what();
            }
        }
    };
    int threads = P.threads > 0 ? P.threads : static_cast<int>(std::max(1u, std::thread::hardware_concurrency()));
    threads = static_cast<int>(std::min<size_t>(static_cast<size_t>(threads), std::max<size_t>(1, n)));
    std::vector<std::thread> pool;
    for (int t = 0; t < threads; ++t) pool.emplace_back(worker);
    for (auto& th : pool) th.join();
    for (size_t i = 0; i < n; ++i) if (!errors[i].empty()) throw VegetationError("plant_failed", errors[i]);
    for (const auto& tr : R.trees) R.triangles += (tr.wood.indices.size() + tr.foliage.indices.size()) / 3;
    if (static_cast<double>(R.triangles) > P.triangleBudget) throw VegetationError("budget_exceeded", "trees used " + std::to_string(R.triangles) + " triangles, over the budget");
    R.ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
    return R;
}

/** One node per tree (measurements in extras), studio clay, in the tile frame; root extras carry the tile frame. */
inline std::vector<uint8_t> writeTreesGlb(const PlantResult& R, const io::GlbJsonValue& crownsDoc, const PlantParams& P) {
    detail::GlbBuilder gb;
    std::vector<std::string> meshes, nodes, children;
    for (const auto& tr : R.trees) {
        std::vector<std::string> prims;
        for (const geometry::Mesh* m : {&tr.wood, &tr.foliage}) {
            if (m->indices.empty()) continue;
            std::vector<float> p, nrm;
            p.reserve(m->vertices.size() * 3);
            nrm.reserve(m->vertices.size() * 3);
            for (size_t v = 0; v < m->vertices.size(); ++v) {
                p.insert(p.end(), {m->vertices[v].x, m->vertices[v].y, m->vertices[v].z});
                const Vec3 n = v < m->normals.size() ? m->normals[v] : Vec3(0, 1, 0);
                nrm.insert(nrm.end(), {n.x, n.y, n.z});
            }
            const int aP = gb.addFloatAccessor(p, 3, true), aN = gb.addFloatAccessor(nrm, 3, false), aI = gb.addIndexAccessor(m->indices);
            prims.push_back("{\"attributes\":{\"POSITION\":" + std::to_string(aP) + ",\"NORMAL\":" + std::to_string(aN) + "},\"indices\":" + std::to_string(aI) + ",\"material\":0,\"mode\":4}");
        }
        if (prims.empty()) continue;
        const std::string name = "sb_veggie_crown_" + std::to_string(tr.crownId);
        meshes.push_back("{\"name\":" + json::str(name) + ",\"primitives\":[" + detail::GlbBuilder::join(prims) + "]}");
        const auto& c = *tr.crown;
        std::ostringstream ex;
        ex << "{\"crownId\":" << tr.crownId << ",\"apex\":" << json::write(c["apex"]) << ",\"stem\":" << json::write(c["stem"])
           << ",\"supportY\":" << json::num(c["supportY"].num) << ",\"supportSource\":" << json::write(c["supportSource"])
           << ",\"heightAboveSupportM\":" << json::num(tr.heightAboveSupport) << ",\"crownAreaM2\":" << json::num(c["areaM2"].num)
           << ",\"sectorRadiiM\":" << json::write(c["sectorRadii"]);
        if (c.has("stemLatLng")) ex << ",\"stemLatLng\":" << json::write(c["stemLatLng"]) << ",\"apexLatLng\":" << json::write(c["apexLatLng"]);
        ex << ",\"inferred\":{\"crownBaseY\":" << json::num(tr.crownBaseY) << ",\"crownBaseRatio\":" << json::num(P.crownBaseRatio)
           << ",\"trunkRadiusM\":" << json::num(tr.trunkRadius) << ",\"trunkRadiusPerHeight\":" << json::num(P.trunkRadiusPerHeight) << "}"
           << ",\"triangles\":" << (tr.wood.indices.size() + tr.foliage.indices.size()) / 3 << ",\"triangleBudget\":" << tr.budget
           << ",\"woodTriangles\":" << tr.report.woodTriangles << ",\"foliageTriangles\":" << tr.report.foliageTriangles
           << ",\"foliageClumps\":" << tr.report.foliageClumps << ",\"seed\":" << tr.seed << "}";
        nodes.push_back("{\"name\":" + json::str(name) + ",\"mesh\":" + std::to_string(meshes.size() - 1) + ",\"extras\":" + ex.str() + "}");
        children.push_back(std::to_string(nodes.size()));
    }
    std::string j = "{\"asset\":{\"version\":\"2.0\",\"generator\":\"Scratchbox SB-Veggie (space colonisation, tile_vegetation plant)\"},";
    j += "\"scene\":0,\"scenes\":[{\"nodes\":[0]}],\"nodes\":[{\"name\":\"sb_veggie_trees\"";
    if (!children.empty()) j += ",\"children\":[" + detail::GlbBuilder::join(children) + "]";
    j += "}";
    if (!nodes.empty()) j += "," + detail::GlbBuilder::join(nodes);
    j += "]";
    if (!meshes.empty()) j += ",\"meshes\":[" + detail::GlbBuilder::join(meshes) + "]";
    j += ",\"materials\":[{\"name\":\"Mat_StudioGreyClay\",\"pbrMetallicRoughness\":{\"baseColorFactor\":[0.55,0.57,0.6,1],\"metallicFactor\":0,\"roughnessFactor\":0.85},\"doubleSided\":false}]";
    if (!gb.accessors.empty()) {
        j += ",\"accessors\":[" + detail::GlbBuilder::join(gb.accessors) + "],\"bufferViews\":[" + detail::GlbBuilder::join(gb.views) + "]";
        j += ",\"buffers\":[{\"byteLength\":" + std::to_string((gb.bin.size() + 3) & ~static_cast<size_t>(3)) + "}]";
    }
    // root extras: the tile frame (as the extraction wrote it) plus what was planted
    const auto& frame = crownsDoc["frame"];
    std::string extras = "{";
    if (frame.type == io::GlbJsonValue::Object) {
        for (const auto& kv : frame.obj) {
            if (kv.first == "sbVeggie") continue;
            extras += json::str(kv.first) + ":" + json::write(kv.second) + ",";
        }
    }
    extras += "\"sbVeggie\":{\"trees\":" + std::to_string(R.trees.size()) + ",\"triangles\":" + std::to_string(R.triangles) +
              ",\"triangleBudget\":" + std::to_string(static_cast<size_t>(P.triangleBudget)) + ",\"generator\":\"space colonisation\"}}";
    j += ",\"extras\":" + extras + "}";
    return gb.finish(j);
}

} // namespace tile_vegetation
} // namespace scratchbox

#endif // SCRATCHBOX_TILE_VEGETATION_HPP
