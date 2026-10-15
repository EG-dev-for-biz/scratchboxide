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
 *   other canopy when it touches none. Crowns at least minTreeHeight above that surface are trees; a tree whose crown
 *   runs to the extraction's edge is still a tree when its apex (its local-maximum window) lies inside, and is measured
 *   up to the edge. A crown whose apex window reaches the edge is cut: its top and trunk may lie outside. Every tree is
 *   then regrown (growCrown) before anything is removed: a tree the regrown SB-Veggie tree does not fill stays as
 *   scanned (not_regrowable, with the reason), like a crown with no measured ground. Each tree that is removed goes
 *   with the scanned drape around it (the photogrammetric curtain from crown to ground, planar or not, out to
 *   drapeReach) and with pieces of its scan left hanging in the air beside it, never with walls, roofs, paving or
 *   crowns that stay. Cut canopy stays as scanned unless its side would be left standing over a hole: then it goes with
 *   the trees it joins, is reported, and is not replanted. The ground under a tree is rebuilt on the surface it stood
 *   on (level paving or roof, or ground that slopes: a hillside's slope is measured from the surfaces around the
 *   crown): every hole loop is lowered onto that surface and capped there, so no cap face climbs to where the tree
 *   was and no hole opens; a tile with no tree is left as it is, whatever its ground. Where the hole edge stands off
 *   that surface (a wall or building side the tree hid, the side of a low planting or a tree that stays) a vertical skirt
 *   continues it down, and its area and height are reported by what it continues. Lower roof vegetation stays in the
 *   scan untouched. Writes the devegetated tile (textures kept; cap and skirt are untextured primitives of their own),
 *   and a crown list with apex, stem, support (height and slope), footprint, sector radii and voxel samples of the
 *   crown surface, in the tile frame and as lat/lng (the list stays in the cache; plant writes no geodetic data).
 *
 * plant: grows one SB-Veggie tree per measured crown with the space-colonisation generator
 *   (nature::SpaceColonizationTreeGenerator), attracted to the crown's own measured samples (the same trees strip
 *   grew), meshed in studio clay within its share of the caller's triangle budget or, without one, a target from its
 *   crown's size within a scene cap. What the scan does not observe (crown base, trunk radius) comes from explicit
 *   ratios and is reported as inferred.
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
#include <set>
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

/**
 * Lawson edge flips in the x/z plane over triangles [from, to) of `tri` (all facing up): an edge two of them share flips
 * when the quad they form is convex and the far vertex lies inside the other triangle's circumcircle, so the fans and
 * slivers of ear clipping become well-shaped triangles. Edges used by one triangle (the polygon's boundary) never move.
 * Returns the number of flips.
 */
inline size_t delaunayFlips(const std::vector<Vec3>& p, std::vector<uint32_t>& tri, size_t from, size_t to) {
    auto edgeKey = [](uint32_t a, uint32_t b) { return a < b ? (static_cast<uint64_t>(a) << 32 | b) : (static_cast<uint64_t>(b) << 32 | a); };
    size_t flips = 0;
    for (int pass = 0; pass < 32; ++pass) {
        std::unordered_map<uint64_t, std::array<long, 2>> edges;
        edges.reserve(3 * (to - from));
        for (size_t k = from; k < to; ++k) {
            for (int j = 0; j < 3; ++j) {
                auto& slot = edges.try_emplace(edgeKey(tri[3 * k + static_cast<size_t>(j)], tri[3 * k + static_cast<size_t>((j + 1) % 3)]), std::array<long, 2>{-1, -1}).first->second;
                const long corner = static_cast<long>(3 * k) + j;
                if (slot[0] == -1) slot[0] = corner;
                else if (slot[1] == -1) slot[1] = corner;
                else slot = {-2, -2};  // used three times or more: never flipped
            }
        }
        std::vector<std::pair<uint64_t, std::array<long, 2>>> ordered(edges.begin(), edges.end());
        std::sort(ordered.begin(), ordered.end(), [](const auto& x, const auto& y) { return x.first < y.first; });
        std::vector<uint8_t> touched(to - from, 0);
        size_t passFlips = 0;
        for (const auto& [key, slot] : ordered) {
            if (slot[0] < 0 || slot[1] < 0) continue;
            const size_t k0 = static_cast<size_t>(slot[0]) / 3, k1 = static_cast<size_t>(slot[1]) / 3;
            if (k0 == k1 || touched[k0 - from] || touched[k1 - from]) continue;
            const size_t j0 = static_cast<size_t>(slot[0]) % 3, j1 = static_cast<size_t>(slot[1]) % 3;
            const uint32_t a = tri[3 * k0 + j0], b = tri[3 * k0 + (j0 + 1) % 3], c = tri[3 * k0 + (j0 + 2) % 3];
            if (tri[3 * k1 + j1] != b || tri[3 * k1 + (j1 + 1) % 3] != a) continue;  // the pair is not consistently wound
            const uint32_t d = tri[3 * k1 + (j1 + 2) % 3];
            if (c == d || cross2(p[a], p[b], p[c]) <= 0 || cross2(p[b], p[a], p[d]) <= 0) continue;
            if (cross2(p[c], p[a], p[d]) <= 1e-12 || cross2(p[d], p[b], p[c]) <= 1e-12) continue;  // not convex
            // d inside the circumcircle of (a, b, c), which winds clockwise in (x, z)
            const double adx = static_cast<double>(p[a].x) - p[d].x, adz = static_cast<double>(p[a].z) - p[d].z;
            const double bdx = static_cast<double>(p[b].x) - p[d].x, bdz = static_cast<double>(p[b].z) - p[d].z;
            const double cdx = static_cast<double>(p[c].x) - p[d].x, cdz = static_cast<double>(p[c].z) - p[d].z;
            const double det = (adx * adx + adz * adz) * (bdx * cdz - cdx * bdz) - (bdx * bdx + bdz * bdz) * (adx * cdz - cdx * adz) + (cdx * cdx + cdz * cdz) * (adx * bdz - bdx * adz);
            const double scale = (adx * adx + adz * adz + bdx * bdx + bdz * bdz + cdx * cdx + cdz * cdz);
            if (det >= -1e-9 * scale * scale) continue;
            tri[3 * k0] = c; tri[3 * k0 + 1] = a; tri[3 * k0 + 2] = d;
            tri[3 * k1] = d; tri[3 * k1 + 1] = b; tri[3 * k1 + 2] = c;
            touched[k0 - from] = touched[k1 - from] = 1;
            ++passFlips;
        }
        flips += passFlips;
        if (passFlips == 0) break;
    }
    return flips;
}

} // namespace detail

// ============================================================================================
// regrowth: one SB-Veggie tree grown into one measured crown
// ============================================================================================
//
// strip grows every crown it measures as a tree before it removes anything, and keeps as scanned (status
// not_regrowable, with the reason) each crown the regrown tree does not fill; plant grows the same trees again, from the
// same crown values, parameters and seed, and meshes them. Both run growCrown, so what strip removed plant rebuilds.

/** How a measured crown is regrown. What the scan does not observe (crown base, trunk radius) is inferred from ratios. */
struct GrowthParams {
    double crownBaseRatio{0.35};        // crown base = support + ratio * (apex - support): not observed, inferred
    double trunkRadiusPerHeight{0.016}; // trunk radius = ratio * height: not observed, inferred
    double shellDepth{0.8};             // share of each surface sample's height above the crown base the crown fills
    double minSurfaceReached{0.9};      // share of the measured crown surface the regrown tree's leaves must reach
    uint64_t seed{0};                   // mixed with each crown id
};

/** A measured crown, as crowns.json carries it (strip writes these values at full precision, so plant reads them back exactly). */
struct CrownShape {
    int id{0};
    Vec3 apex;
    double stemX{0}, stemZ{0}, supportY{0}, areaM2{0};
    std::array<double, 16> sectorRadii{};
    std::vector<Vec3> samples;
};

/** One crown regrown: the skeleton, how it was grown, and whether it fills the measured crown (and if not, why not). */
struct CrownGrowth {
    uint32_t seed{0};
    double heightAboveSupport{0}, crownBaseY{0}, trunkRadius{0};
    double attractorSpacing{0};         // voxel of the attractor cloud (m)
    nature::SpaceColonizationConfig cfg;
    std::vector<nature::ColonizationNode> skeleton;
    nature::ColonizationReport colonisation;
    size_t surfaceSamples{0};           // measured crown surface samples above the crown base
    size_t surfaceReached{0};           // ... with a leaf anchor of the regrown tree within reachRadius
    double reachRadius{0};              // a node reaches what lies within its kill reach; a sample, one voxel or sample spacing beyond (m)
    double leafTopY{-std::numeric_limits<double>::infinity()};
    std::string failureCode;            // diagnostic label (an open string): empty when the tree fills its crown
    std::string failure;                // why the regrown tree is not the measured one, in words
    std::string colonisationSummary;    // how colonisation went, in words (attractors reached, iterations, why it stopped)
    bool ok() const { return failure.empty(); }
    double surfaceShare() const { return surfaceSamples ? static_cast<double>(surfaceReached) / static_cast<double>(surfaceSamples) : 0.0; }
};

namespace detail {

inline uint32_t crownSeed(uint64_t seed, int crownId) {
    return static_cast<uint32_t>(mix64(seed ^ mix64(static_cast<uint64_t>(crownId) + 0x5BD1E995ull)) & 0xFFFFFFFFull);
}

/** Runs fn(i) for i in [0, n) on a pool of threads taking the next index as each finishes (crowns differ in cost). */
inline void forEachIndex(size_t n, int threads, const std::function<void(size_t)>& fn) {
    int T = threads > 0 ? threads : static_cast<int>(std::max(1u, std::thread::hardware_concurrency()));
    T = static_cast<int>(std::min<size_t>(static_cast<size_t>(T), std::max<size_t>(1, n)));
    std::atomic<size_t> next{0};
    auto worker = [&]() {
        for (size_t i = next.fetch_add(1); i < n; i = next.fetch_add(1)) fn(i);
    };
    if (T <= 1) { worker(); return; }
    std::vector<std::thread> pool;
    for (int t = 0; t < T; ++t) pool.emplace_back(worker);
    for (auto& th : pool) th.join();
}

inline std::string fixed(double v, int digits) {
    std::ostringstream s;
    s.setf(std::ios::fixed);
    s.precision(digits);
    s << v;
    return s.str();
}

} // namespace detail

/**
 * Grows one SB-Veggie tree (space colonisation) into a measured crown and checks that it fills it.
 *
 * Attractors are the crown volume under the measured surface: each surface sample above the (inferred) crown base and,
 * below it, layers down by shellDepth of its height above the crown base, on a voxel grid scaled to the crown (fine
 * enough for its width and its depth, never finer than the measurement's sample spacing calls for). Every growth
 * distance follows from the crown and that spacing: the step from the tree's height, the perception radius from the
 * step and the attractor spacing (a node must see across the gap between neighbouring attractors), the kill radius
 * likewise; the trunk grows on past the inferred crown base until the measured crown is in sight (a tall crown seen only
 * from above can begin well above it), and colonisation stops when it has reached every attractor, sees none, or has
 * reached none for as many iterations as it takes to cross the perception radius twice.
 *
 * The tree fills its crown when its leaves (foliageAnchors: the tips, twigs and branches through the crown that the
 * meshing puts leaves on at any budget) lie within reachRadius of at least minSurfaceReached of the measured surface
 * samples above the crown base, and reach the apex height to within reachRadius. This is measured on the grown
 * skeleton, not on a meshed foliage that a budget coarsens (and that is kept inside the crown's box whether or not
 * anything grew there).
 */
inline CrownGrowth growCrown(const CrownShape& c, const GrowthParams& G, double sampleSpacing) {
    CrownGrowth g;
    g.seed = detail::crownSeed(G.seed, c.id);
    const double support = c.supportY;
    const double H = std::max(0.5, static_cast<double>(c.apex.y) - support);
    g.heightAboveSupport = H;
    g.crownBaseY = support + G.crownBaseRatio * H;
    g.trunkRadius = G.trunkRadiusPerHeight * H;
    double radius = 0;
    for (double r : c.sectorRadii) radius += r / 16.0;
    const double spacing = sampleSpacing > 0 ? sampleSpacing : 0.7;
    const double depth = static_cast<double>(c.apex.y) - g.crownBaseY;
    // attractor voxel: fine enough for the crown's width and depth (a wide flat crown needs fine layers), no finer than
    // 0.6 of the sample spacing, no coarser than 2.3 of it
    const double voxel = std::clamp(std::min(radius / 6.0, depth / 4.0), 0.6 * spacing, 2.3 * spacing);
    g.attractorSpacing = voxel;
    std::vector<Vec3> attractors;
    std::unordered_map<uint64_t, size_t> occupied;
    auto addAttractor = [&](double x, double y, double z) {
        const int64_t a = static_cast<int64_t>(std::floor(x / voxel)), b = static_cast<int64_t>(std::floor(y / voxel)), d = static_cast<int64_t>(std::floor(z / voxel));
        const uint64_t key = (static_cast<uint64_t>(a & 0x1FFFFF) << 42) | (static_cast<uint64_t>(b & 0x1FFFFF) << 21) | static_cast<uint64_t>(d & 0x1FFFFF);
        if (occupied.emplace(key, attractors.size()).second) attractors.push_back(Vec3(static_cast<float>(x), static_cast<float>(y), static_cast<float>(z)));
    };
    std::vector<Vec3> surface;
    for (size_t k = 0; k < c.samples.size(); ++k) {
        const Vec3 s = c.samples[k];
        // the scan drapes the crown's edge down towards the ground; below the crown base it is not crown
        if (s.y < g.crownBaseY) continue;
        surface.push_back(s);
        addAttractor(s.x, s.y, s.z);
        const double bottom = s.y - std::max(0.0, static_cast<double>(s.y) - g.crownBaseY) * G.shellDepth;
        int layer = 1;
        for (double y = s.y - voxel; y >= bottom; y -= voxel, ++layer) {
            const double jx = (detail::hashUnit(g.seed, k, static_cast<uint64_t>(layer) * 3) - 0.5) * voxel;
            const double jy = (detail::hashUnit(g.seed, k, static_cast<uint64_t>(layer) * 3 + 1) - 0.5) * voxel;
            const double jz = (detail::hashUnit(g.seed, k, static_cast<uint64_t>(layer) * 3 + 2) - 0.5) * voxel;
            addAttractor(s.x + jx, y + jy, s.z + jz);
        }
    }
    g.surfaceSamples = surface.size();
    if (attractors.size() < 3) {
        g.failureCode = "no_crown_above_base";
        g.failure = (surface.empty() ? "none of its " + std::to_string(c.samples.size()) + " measured surface samples lies"
                                     : "only " + std::to_string(surface.size()) + " of its " + std::to_string(c.samples.size()) + " measured surface samples lie") +
                    " above its inferred crown base at " + detail::fixed(g.crownBaseY - support, 1) + " m above its ground, too few to grow a crown into";
        return g;
    }
    Vec3 lo(1e9f, 1e9f, 1e9f), hi(-1e9f, -1e9f, -1e9f);
    for (const auto& a : attractors) { lo.x = std::min(lo.x, a.x); lo.y = std::min(lo.y, a.y); lo.z = std::min(lo.z, a.z); hi.x = std::max(hi.x, a.x); hi.y = std::max(hi.y, a.y); hi.z = std::max(hi.z, a.z); }
    nature::SpaceColonizationConfig& cfg = g.cfg;
    cfg.customAttractors = attractors;
    cfg.attractorCount = static_cast<int>(attractors.size());
    cfg.rootAnchor = Vec3(static_cast<float>(c.stemX), static_cast<float>(support), static_cast<float>(c.stemZ));
    cfg.crownCenter = (lo + hi) * 0.5f;
    cfg.crownExtents = Vec3(std::max(0.5f, (hi.x - lo.x) * 0.5f), std::max(0.5f, (hi.y - lo.y) * 0.5f), std::max(0.5f, (hi.z - lo.z) * 0.5f));
    cfg.clearTrunkHeight = static_cast<float>(g.crownBaseY - support);
    cfg.baseRadius = static_cast<float>(g.trunkRadius);
    const double step = std::clamp(H / 40.0, 0.2, 0.6);
    cfg.branchStepLength = static_cast<float>(step);
    cfg.perceptionRadius = static_cast<float>(std::max(5.5 * step, 3.0 * g.attractorSpacing));
    cfg.killRadius = static_cast<float>(std::max(1.6 * step, 0.9 * g.attractorSpacing));
    // long enough to cross the crown three times over (height plus its widest reach)
    double widest = 0;
    for (double r : c.sectorRadii) widest = std::max(widest, r);
    cfg.maxIterations = static_cast<int>(std::ceil(3.0 * (H + widest) / step));
    cfg.stallIterations = static_cast<int>(std::ceil(2.0 * cfg.perceptionRadius / step)) + 2;
    cfg.trunkSeeksCrown = true;
    cfg.leavesOnCrownBranches = true;
    cfg.rootFlareHeight = static_cast<float>(std::min(0.8, 0.06 * H));
    cfg.seed = g.seed;
    std::mt19937 rng(cfg.seed);
    g.skeleton = nature::SpaceColonizationTreeGenerator::growSkeleton(cfg, rng, &g.colonisation);

    // does it fill the measured crown? leaves (tips, twigs, branches through the crown) near the measured surface, up to
    // the apex: a node reaches
    // the attractors within its kill reach, and a surface sample lies within one voxel (or one sample spacing) of one
    g.reachRadius = 1.25 * cfg.killRadius + std::max(voxel, spacing);
    const std::vector<Vec3> leaves = nature::SpaceColonizationTreeGenerator::foliageAnchors(cfg, g.skeleton);
    for (const auto& p : leaves) g.leafTopY = std::max(g.leafTopY, static_cast<double>(p.y));
    {
        const double cell = g.reachRadius;
        std::unordered_map<uint64_t, std::vector<uint32_t>> grid;
        auto key = [&](int64_t a, int64_t b, int64_t d) { return (static_cast<uint64_t>(a & 0x1FFFFF) << 42) | (static_cast<uint64_t>(b & 0x1FFFFF) << 21) | static_cast<uint64_t>(d & 0x1FFFFF); };
        for (uint32_t i = 0; i < leaves.size(); ++i) {
            grid[key(static_cast<int64_t>(std::floor(leaves[i].x / cell)), static_cast<int64_t>(std::floor(leaves[i].y / cell)), static_cast<int64_t>(std::floor(leaves[i].z / cell)))].push_back(i);
        }
        const double r2 = g.reachRadius * g.reachRadius;
        for (const auto& s : surface) {
            const int64_t a = static_cast<int64_t>(std::floor(s.x / cell)), b = static_cast<int64_t>(std::floor(s.y / cell)), d = static_cast<int64_t>(std::floor(s.z / cell));
            bool reached = false;
            for (int64_t dz = -1; dz <= 1 && !reached; ++dz) {
                for (int64_t dy = -1; dy <= 1 && !reached; ++dy) {
                    for (int64_t dx = -1; dx <= 1 && !reached; ++dx) {
                        auto it = grid.find(key(a + dx, b + dy, d + dz));
                        if (it == grid.end()) continue;
                        for (uint32_t i : it->second) {
                            if (static_cast<double>((leaves[i] - s).lengthSquared()) <= r2) { reached = true; break; }
                        }
                    }
                }
            }
            g.surfaceReached += reached ? 1 : 0;
        }
    }
    const auto& col = g.colonisation;
    g.colonisationSummary = std::to_string(col.attractorsReached) + " of " + std::to_string(col.attractors) + " attractors reached in " +
                            std::to_string(col.iterations) + " iterations, stopped: " + col.stop;
    if (g.surfaceShare() < G.minSurfaceReached) {
        g.failureCode = "crown_not_reached";
        g.failure = "the regrown tree's leaves reach " + detail::fixed(100.0 * g.surfaceShare(), 0) + "% of its measured crown surface (" +
                    std::to_string(g.surfaceReached) + " of " + std::to_string(g.surfaceSamples) + " samples within " + detail::fixed(g.reachRadius, 1) +
                    " m; " + detail::fixed(100.0 * G.minSurfaceReached, 0) + "% needed)";
    } else if (g.leafTopY + g.reachRadius < static_cast<double>(c.apex.y)) {
        g.failureCode = "apex_not_reached";
        g.failure = "the regrown tree's leaves reach " + detail::fixed(g.leafTopY - support, 1) + " m above its ground, short of its measured " +
                    detail::fixed(H, 1) + " m";
    }
    return g;
}

/** A crown as crowns.json carries it (plant). */
inline CrownShape crownShapeFromJson(const io::GlbJsonValue& c) {
    CrownShape s;
    s.id = c["id"].asInt(-1);
    s.apex = Vec3(static_cast<float>(c["apex"][0].num), static_cast<float>(c["apex"][1].num), static_cast<float>(c["apex"][2].num));
    s.stemX = c["stem"][0].num;
    s.stemZ = c["stem"][1].num;
    s.supportY = c["supportY"].num;
    s.areaM2 = c["areaM2"].num;
    const auto& radii = c["sectorRadii"].arr;
    for (size_t k = 0; k < 16 && k < radii.size(); ++k) s.sectorRadii[k] = radii[k].num;
    s.samples.reserve(c["samples"].arr.size());
    for (const auto& v : c["samples"].arr) s.samples.push_back(Vec3(static_cast<float>(v[0].num), static_cast<float>(v[1].num), static_cast<float>(v[2].num)));
    return s;
}

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
    double footprintDilation{1.0};   // everything under the apex this far beyond the crown footprint goes with the tree (m)
    double drapeReach{10.0};          // the scanned drape connected to a tree goes with it out to this far from its crown (m)
    double clearance{0.3};           // removal stops this high above the support (m)
    double supportBand{1.5};         // a tree's cap never lies further than this from its measured support (m)
    double skirtMin{0.3};            // boundary points higher than this above the cap get a skirt down (m)
    double fragmentMaxArea{300.0};   // a kept piece left hanging beside a removal, touching neither ground nor a wall or
                                     // roof, goes with the tree when it is no larger than this (m^2)
    double capGrid{1.5};             // spacing of interior cap points (m)
    double seamGap{1.0};             // hole boundaries broken by an open tile seam are joined across gaps up to this (m)
    double sampleSpacing{0.7};       // voxel size of the crown surface samples (m)
    GrowthParams growth;             // how each tree crown is regrown before anything is removed (see growCrown)
    int threads{0};
};

struct CrownRecord {
    int id{0};
    // tree | below_min_height | no_measured_ground (no standable surface around it, kept as scanned) | not_regrowable
    // (a tree the regrown SB-Veggie tree does not fill, kept as scanned) | cut_at_boundary (kept as scanned) |
    // cut_at_boundary_removed (taken with the trees it joins, not replanted)
    std::string status;
    bool reachesBoundary{false};     // a tree whose crown runs to the extraction's edge: measured (and rebuilt) up to it
    Vec3 apex;
    double stemX{0}, stemZ{0};
    double supportY{0};              // the support surface's height at the stem
    double tiltX{0}, tiltZ{0};       // its gradient (dy/dx, dy/dz) around the crown
    std::string supportSource;       // surrounding_surface | none (no standable surface around it: not measured)
    double terrainY{0};
    double apexAboveSupport{0};
    double areaM2{0};
    std::array<double, 16> sectorRadii{};
    std::vector<Vec3> samples;
    int cells{0};
    bool hasGeodetic{false};
    TileFrame::Geodetic apexGeo{}, stemGeo{};
    // the regrowth check (trees and not_regrowable crowns): how much of the measured surface the regrown leaves reach
    bool regrowthChecked{false};
    double regrowthSurfaceShare{0}, regrowthReachM{0}, regrowthLeafTopY{0};
    size_t regrowthSurfaceSamples{0}, regrowthSurfaceReached{0};
    std::string regrowthFailureCode, regrowthFailure, regrowthColonisation;
};

struct StripStats {
    size_t inputTriangles{0}, outputTriangles{0}, removedTriangles{0}, capTriangles{0}, skirtTriangles{0};
    size_t texturedTriangles{0}, chromaVegetationTriangles{0}, vegetationTriangles{0}, surfaceTriangles{0};
    size_t images{0};
    size_t openEdgesBefore{0}, openEdgesAfter{0};
    size_t loops{0}, openChains{0}, linkedChains{0}, holesBridged{0}, forcedEars{0}, capInteriorPoints{0}, capTurnedUp{0}, capDegenerate{0}, capsReversed{0};
    size_t capFillCells{0};          // footprint cells no loop cap covered (seen from above), filled on the cap surface
    size_t capFlips{0};              // Delaunay edge flips that reshaped ear-clipped cap triangles
    double capMaxRiseM{0};           // largest height difference across one cap face (the cap follows its support; it never climbs)
    // hole boundary points, and those standing more than skirtMin off the cap surface (skirted), by what they hang on
    size_t boundaryPoints{0}, skirtedPoints{0};
    double skirtAreaOnWallsM2{0}, skirtAreaOnLevelSurfacesM2{0}, skirtAreaOnKeptCanopyM2{0}, skirtAreaOnOtherM2{0}, skirtMaxHeightM{0};
    // tallest skirt by what it hangs on (walls, level surfaces, canopy that stays, anything else)
    double skirtMaxOnWallsM{0}, skirtMaxOnLevelSurfacesM{0}, skirtMaxOnKeptCanopyM{0}, skirtMaxOnOtherM{0};
    double canopyTakenWithTreesM2{0}; // canopy outside the tree crowns removed with them (their drape, fragments): not replanted
    size_t fragmentsTaken{0};        // pieces of a tree's scan left hanging in the air beside its removal, taken with it
    double fragmentAreaTakenM2{0};
    size_t drapeSheets{0};           // planar sheets of the drape taken with the trees (not walls: nothing planar at their top)
    double drapeSheetAreaM2{0};
    double canopyAreaM2{0}, treeCanopyAreaM2{0};
    size_t crownsTree{0}, crownsLow{0}, crownsCut{0}, crownsCutRemoved{0}, crownsTooSmall{0}, crownsNoGround{0};
    size_t crownsNotRegrowable{0};   // trees the regrown SB-Veggie tree does not fill: kept as scanned (see growCrown)
    size_t treesReachingBoundary{0}; // trees whose crown runs to the extraction's edge (their apex is inside it)
    double cutCanopyRemovedM2{0};    // canopy of cut crowns taken with the trees it joined (not replanted)
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
    std::vector<int32_t> segOf;        // planar segment per face (index into segments, -1 when not a surface)
    struct Segment { double area{0}; Vec3 normal; float minY{0}, maxY{0}; float lowX{0}, lowZ{0}; std::vector<uint32_t> faces; };
    std::vector<Segment> segments;
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
        checkRegrowth();
        lap("regrowth");
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
        segOf.assign(T, -1);
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
                Segment sg;
                sg.area = aSum;
                const float len = nSum.length();
                sg.normal = len > 1e-12f ? nSum / len : n;
                sg.minY = std::numeric_limits<float>::infinity();
                sg.maxY = -std::numeric_limits<float>::infinity();
                for (uint32_t t : members) {
                    surface[t] = 1;
                    ++R.stats.surfaceTriangles;
                    segOf[t] = static_cast<int32_t>(segments.size());
                    for (int j = 0; j < 3; ++j) {
                        const Vec3& v = weldPos[wtri[3 * static_cast<size_t>(t) + static_cast<size_t>(j)]];
                        if (v.y < sg.minY) { sg.minY = v.y; sg.lowX = v.x; sg.lowZ = v.z; }
                        sg.maxY = std::max(sg.maxY, v.y);
                    }
                }
                sg.faces = members;
                segments.push_back(std::move(sg));
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
        bool cut{false};             // the apex is not measured: its local-maximum window reaches the extraction's edge
        bool reachesBoundary{false}; // the footprint touches the extraction's edge
        bool tooSmall{false};
        double support{0};           // the support surface's height at the stem
        double tiltX{0}, tiltZ{0};   // its gradient (dy/dx, dy/dz): the ground a tree stands on may slope
        double stemX{0}, stemZ{0};
        std::string supportSource;
        int recordIndex{-1};
    };
    std::vector<CrownWork> work;
    std::vector<int> edgeDist;       // per cell: distance (cells, 4-connected) from the extraction's outer edge

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

        // distance (cells, 4-connected) of every cell from the extraction's edge
        edgeDist.assign(N, std::numeric_limits<int>::max());
        {
            std::queue<size_t> q;
            for (int k = 0; k < g.nz; ++k) {
                for (int i = 0; i < g.nx; ++i) {
                    const size_t c = g.id(i, k);
                    if (outside[c] || i == 0 || k == 0 || i == g.nx - 1 || k == g.nz - 1) { edgeDist[c] = 0; q.push(c); }
                }
            }
            while (!q.empty()) {
                const size_t c = q.front();
                q.pop();
                const int i = static_cast<int>(c % static_cast<size_t>(g.nx)), k = static_cast<int>(c / static_cast<size_t>(g.nx));
                for (const auto& d : D) {
                    const int a = i + d[0], b = k + d[1];
                    if (!g.in(a, b)) continue;
                    const size_t j = g.id(a, b);
                    if (edgeDist[j] <= edgeDist[c] + 1) continue;
                    edgeDist[j] = edgeDist[c] + 1;
                    q.push(j);
                }
            }
        }
        // A crown whose footprint touches the edge reaches it. Its apex is measured only when the local-maximum window
        // around it lies inside the extraction; otherwise the top of the tree (and its trunk) may lie outside, and the
        // crown is cut.
        for (size_t m = 0; m < work.size(); ++m) {
            auto& w = work[m];
            const double area = static_cast<double>(w.cells.size()) * P.cell * P.cell;
            w.tooSmall = area < P.minCrownArea;
            float best = -std::numeric_limits<float>::infinity();
            for (size_t c : w.cells) {
                if (g.h[c] > best) { best = g.h[c]; w.apexCell = c; }
                if (edgeDist[c] <= 1) w.reachesBoundary = true;
            }
            if (w.cells.empty()) continue;
            const double window = windowRadius(smoothChm[w.apexCell]);
            const int r = static_cast<int>(std::ceil(window / P.cell));
            const int ai = static_cast<int>(w.apexCell % static_cast<size_t>(g.nx)), ak = static_cast<int>(w.apexCell / static_cast<size_t>(g.nx));
            for (int dk = -r; dk <= r && !w.cut; ++dk) {
                for (int di = -r; di <= r; ++di) {
                    if ((di * di + dk * dk) * P.cell * P.cell > window * window) continue;
                    if (!g.in(ai + di, ak + dk) || edgeDist[g.id(ai + di, ak + dk)] == 0) { w.cut = true; break; }
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

    /**
     * Grows every crown measured as a tree (growCrown, from the values crowns.json carries, so plant grows the same tree)
     * before anything is removed. A crown the regrown tree does not fill is not that tree: it stays as scanned (status
     * not_regrowable, with the reason), exactly as a crown with no measured ground does, and nothing is removed, capped
     * or planted for it.
     */
    void checkRegrowth() {
        std::vector<size_t> trees;
        for (size_t i = 0; i < R.crowns.size(); ++i) {
            if (R.crowns[i].status == "tree") trees.push_back(i);
        }
        detail::forEachIndex(trees.size(), P.threads, [&](size_t k) {
            CrownRecord& rec = R.crowns[trees[k]];
            CrownShape shape;
            shape.id = rec.id;
            shape.apex = rec.apex;
            shape.stemX = rec.stemX;
            shape.stemZ = rec.stemZ;
            shape.supportY = rec.supportY;
            shape.areaM2 = rec.areaM2;
            shape.sectorRadii = rec.sectorRadii;
            shape.samples = rec.samples;
            const CrownGrowth g = growCrown(shape, P.growth, P.sampleSpacing);
            rec.regrowthChecked = true;
            rec.regrowthSurfaceSamples = g.surfaceSamples;
            rec.regrowthSurfaceReached = g.surfaceReached;
            rec.regrowthSurfaceShare = g.surfaceShare();
            rec.regrowthReachM = g.reachRadius;
            rec.regrowthLeafTopY = g.leafTopY;
            rec.regrowthFailureCode = g.failureCode;
            rec.regrowthFailure = g.failure;
            rec.regrowthColonisation = g.colonisationSummary;
        });
        for (size_t i : trees) {
            CrownRecord& rec = R.crowns[i];
            if (rec.regrowthFailure.empty()) continue;
            rec.status = "not_regrowable";
            --R.stats.crownsTree;
            ++R.stats.crownsNotRegrowable;
            R.stats.treeCanopyAreaM2 -= rec.areaM2;
            if (rec.reachesBoundary) --R.stats.treesReachingBoundary;
        }
    }

    bool removedStatus(const std::string& status) const { return status == "tree" || status == "cut_at_boundary_removed"; }
    /** Crowns the strip removes: the trees (replanted) and the cut canopy joined to them (not replanted). */
    bool removesCrown(size_t m) const {
        const auto& w = work[m];
        return w.recordIndex >= 0 && removedStatus(R.crowns[static_cast<size_t>(w.recordIndex)].status);
    }

    /** A surface a tree can stand on is planar and within ~32 degrees of level (ground, roofs; not walls or drapes). */
    static constexpr float kStandableNormalY = 0.85f;
    /** Level: within ~14 degrees (paving, roofs, terraces; not the tilted fringe where a scan climbs onto canopy). */
    static constexpr float kLevelNormalY = 0.97f;

    /** A support surface is never steeper than the surfaces it is measured from. */
    static void clampTilt(CrownRecord& rec) {
        const double maxGrade = std::sqrt(1.0 - static_cast<double>(kStandableNormalY) * kStandableNormalY) / kStandableNormalY;
        const double grade = std::hypot(rec.tiltX, rec.tiltZ);
        if (grade > maxGrade) { rec.tiltX *= maxGrade / grade; rec.tiltZ *= maxGrade / grade; }
    }

    /** Height of the surface a crown stands on at (x, z): its height at the stem continued along its slope. */
    double supportAt(int crown, double x, double z) const {
        const auto& w = work[static_cast<size_t>(crown)];
        return w.support + w.tiltX * (x - w.stemX) + w.tiltZ * (z - w.stemZ);
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

        // support: the nearest level planar surfaces (ground, roofs) around the footprint, reached outward from its edge
        // through anything else (other canopy, rough non-green surfaces), nearest first
        struct SupportSample { float x, y, z; Vec3 n; };
        std::vector<SupportSample> samples;
        std::unordered_map<size_t, uint8_t> seen;
        seen.reserve(w.cells.size() * 4);
        for (size_t c : w.cells) seen.emplace(c, 1);
        const int D[4][2] = {{1, 0}, {-1, 0}, {0, 1}, {0, -1}};
        std::queue<size_t> frontier;
        for (size_t c : w.cells) frontier.push(c);
        const double reach2 = P.supportSearch * P.supportSearch;
        const size_t wanted = std::max<size_t>(24, std::min<size_t>(64, w.cells.size() / 2));
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
                if (!canopy[j] && t >= 0 && surface[static_cast<size_t>(t)] && std::abs(normal[static_cast<size_t>(t)].y) >= kStandableNormalY && !std::isnan(g.h[j])) {
                    // the slope of the planar surface this sample lies on (its segment's normal, facing up)
                    Vec3 n = segments[static_cast<size_t>(segOf[static_cast<size_t>(t)])].normal;
                    if (n.y < 0) n = n * -1.0f;
                    samples.push_back({static_cast<float>(g.cx(a)), g.h[j], static_cast<float>(g.cz(b)), n});
                }
            }
        }
        if (!samples.empty()) {
            // height clusters of the surrounding surfaces; the tree stands on the lowest one that holds at least a quarter
            // of them (a street tree under an awning or beside a kiosk stands on the street; a roof garden sees only roof)
            std::sort(samples.begin(), samples.end(), [](const SupportSample& a, const SupportSample& b) { return a.y < b.y; });
            size_t bestLo = 0, bestN = 0, lo = 0;
            for (size_t i = 1; i <= samples.size(); ++i) {
                if (i == samples.size() || samples[i].y - samples[i - 1].y > P.supportStep) {
                    if (bestN == 0 && 4 * (i - lo) >= samples.size()) { bestN = i - lo; bestLo = lo; }
                    lo = i;
                }
            }
            // That surface may slope (a hillside, a street on a grade). Its gradient is the median gradient of the planar
            // surfaces the samples lie on, whatever the grade: steps between level surfaces (curbs, stairs, a raised plaza
            // within supportStep) have no gradient themselves, so they do not tilt it. (Calling a surface level whenever
            // most samples were within ~14 degrees left the cap of a 2-14 degree street in steps up to 0.75 m off it.)
            // Its height at the stem is the median of the samples with that slope taken out.
            std::vector<double> gx, gz;
            gx.reserve(bestN);
            gz.reserve(bestN);
            for (size_t i = bestLo; i < bestLo + bestN; ++i) {
                const Vec3& n = samples[i].n;
                gx.push_back(-static_cast<double>(n.x) / n.y);
                gz.push_back(-static_cast<double>(n.z) / n.y);
            }
            std::nth_element(gx.begin(), gx.begin() + static_cast<long>(bestN / 2), gx.end());
            std::nth_element(gz.begin(), gz.begin() + static_cast<long>(bestN / 2), gz.end());
            rec.tiltX = gx[bestN / 2];
            rec.tiltZ = gz[bestN / 2];
            clampTilt(rec);
            std::vector<double> level;
            level.reserve(bestN);
            for (size_t i = bestLo; i < bestLo + bestN; ++i) level.push_back(samples[i].y - rec.tiltX * (samples[i].x - rec.stemX) - rec.tiltZ * (samples[i].z - rec.stemZ));
            std::nth_element(level.begin(), level.begin() + static_cast<long>(bestN / 2), level.end());
            rec.supportY = level[bestN / 2];
            rec.supportSource = "surrounding_surface";
        }
        // Nothing standable around it within supportSearch (ground steeper than the standable limit, or all canopy): the
        // ground it stands on is not measured. The terrain model is a morphological opening of the scan and reads low on
        // slopes, convex ground and near the extraction's edge, so it is not taken as that ground: the crown is kept as
        // scanned and reported (status no_measured_ground), and nothing is removed, capped or planted for it.
        const bool groundMeasured = !samples.empty();
        if (groundMeasured) {
            rec.supportY = std::min(rec.supportY, static_cast<double>(rec.apex.y));
            rec.apexAboveSupport = rec.apex.y - rec.supportY;
        } else {
            rec.supportY = std::numeric_limits<double>::quiet_NaN();
            rec.apexAboveSupport = std::numeric_limits<double>::quiet_NaN();
            rec.supportSource = "none";
        }
        // (the work record keeps a number for the drape checks that may look at a kept crown's surroundings)
        w.support = groundMeasured ? rec.supportY : rec.terrainY;
        w.tiltX = rec.tiltX;
        w.tiltZ = rec.tiltZ;
        w.stemX = rec.stemX;
        w.stemZ = rec.stemZ;
        w.supportSource = rec.supportSource;

        rec.reachesBoundary = w.reachesBoundary;
        if (w.cut) { rec.status = "cut_at_boundary"; ++R.stats.crownsCut; }
        else if (!groundMeasured) { rec.status = "no_measured_ground"; ++R.stats.crownsNoGround; }
        else if (rec.apexAboveSupport < P.minTreeHeight) { rec.status = "below_min_height"; ++R.stats.crownsLow; }
        else {
            rec.status = "tree";
            ++R.stats.crownsTree;
            R.stats.treeCanopyAreaM2 += rec.areaM2;
            if (w.reachesBoundary) ++R.stats.treesReachingBoundary;
        }

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

    /**
     * The surfaces things stand on, which the ground under a removed tree is rebuilt on: the lowest and the highest
     * level planar surface (ground, paving, roofs, terraces; not the drape) in each cell of the surface model, filled
     * where none was scanned (under canopy) from the nearest scanned ones, each filled cell remembering where its value
     * came from.
     * A crown's cap takes whichever of the two lies nearer its measured support surface (so a cell on a wall line gives
     * a roof tree the roof and a street tree the street), continued from where it was scanned along that support's
     * slope; where neither lies within supportBand of the support, the support itself (the street beside a roof is not
     * what a roof tree stands on, nor is the roof beside a street tree; on a hillside with no level surface near, the
     * ground is the sloping support measured around the crown). Unlike the terrain model, a lower envelope that drops
     * into every stair well and light well, this meets the scanned ground or roof around the crown.
     */
    height_field::Grid supportLow, supportHigh, lowFromX, lowFromZ, highFromX, highFromZ;
    bool haveLevelSurface{false};

    void buildSupportSurface() {
        const auto& g = surf.top;
        supportLow.init(g.x0, g.z0, g.x0 + g.nx * g.cell, g.z0 + g.nz * g.cell, g.cell);
        supportHigh = supportLow;
        std::vector<uint32_t> level;
        for (size_t t = 0; t < T; ++t) {
            if (!isArchitecture(t) || normal[t].y < kLevelNormalY) continue;
            level.insert(level.end(), {wtri[3 * t], wtri[3 * t + 1], wtri[3 * t + 2]});
        }
        haveLevelSurface = !level.empty();
        if (!haveLevelSurface) return;
        height_field::rasterizeTriangles(supportLow, weldPos, level, [&](size_t c, float y, size_t) {
            float& lo = supportLow.h[c];
            float& hi = supportHigh.h[c];
            if (std::isnan(lo) || y < lo) lo = y;
            if (std::isnan(hi) || y > hi) hi = y;
        });
        height_field::fillEmpty(supportLow, &lowFromX, &lowFromZ);
        height_field::fillEmpty(supportHigh, &highFromX, &highFromZ);
    }

    double capHeight(int crown, double x, double z) const {
        const auto& w = work[static_cast<size_t>(crown)];
        const double s = supportAt(crown, x, z);
        if (!haveLevelSurface) return s;
        const double lo = supportLow.sample(x, z) + w.tiltX * (x - lowFromX.sample(x, z)) + w.tiltZ * (z - lowFromZ.sample(x, z));
        const double hi = supportHigh.sample(x, z) + w.tiltX * (x - highFromX.sample(x, z)) + w.tiltZ * (z - highFromZ.sample(x, z));
        const double pick = std::abs(hi - s) < std::abs(lo - s) ? hi : lo;
        return std::abs(pick - s) <= P.supportBand ? pick : s;
    }

    /** How far the highest corner of a triangle rises above a crown's cap surface. */
    double riseAboveCap(int crown, size_t t) const {
        double r = -std::numeric_limits<double>::infinity();
        for (int j = 0; j < 3; ++j) {
            const Vec3& v = weldPos[wtri[3 * t + static_cast<size_t>(j)]];
            r = std::max(r, static_cast<double>(v.y) - capHeight(crown, v.x, v.z));
        }
        return r;
    }

    /**
     * Faces of large planar segments that are not green: walls, roofs, paving. Removal never takes them, except planar
     * sheets of the drape around a tree (see classifyDrapeSurfaces).
     */
    std::vector<uint8_t> drapeFace;
    bool isArchitecture(size_t t) const { return surface[t] && !chromaVeg[t] && !(drapeFace.size() == T && drapeFace[t]); }

    /**
     * Planar sheets of the photogrammetric drape around a tree, told apart from walls and roofs by what they meet: a
     * wall carries a roof or another wall along its top rim, a roof is edged by walls or parapets; a sheet the scan
     * hangs from a crown down to the ground (or a tile-seam curtain under canopy) meets canopy or nothing at its top,
     * and a flat patch or underside of a coarse canopy mesh is edged by canopy. Only sheets near a tree, entirely below
     * the trees around it and (for flat ones and undersides) standing above its ground count; they go with the tree.
     * Repeated until nothing changes, since a curtain may hang from a flat canopy patch.
     */
    void classifyDrapeSurfaces(const std::vector<int>& drapeOwner, const std::vector<float>& regionApex) {
        const auto& g = surf.top;
        drapeFace.assign(T, 0);
        struct Candidate { size_t seg; int owner; bool wholeRim; };
        std::vector<Candidate> candidates;
        for (size_t si = 0; si < segments.size(); ++si) {
            const auto& sg = segments[si];
            int owner = -1;
            float apexY = -std::numeric_limits<float>::infinity();
            for (uint32_t t : sg.faces) {
                const int i = g.ix(centroid[t].x), k = g.iz(centroid[t].z);
                if (!g.in(i, k) || drapeOwner[g.id(i, k)] < 0) continue;
                if (owner < 0) owner = drapeOwner[g.id(i, k)];
                apexY = std::max(apexY, regionApex[g.id(i, k)]);
            }
            if (owner < 0 || sg.maxY > apexY + P.clearance) continue;
            // flat sheets and undersides are judged by their whole edge, and must stand off the surface the tree stands on
            // as high as canopy does (a roof garden's roof is the trees' support, not part of them)
            const bool wholeRim = sg.normal.y >= 0.85f || sg.normal.y <= -0.3f;
            if (wholeRim && sg.minY - supportAt(owner, sg.lowX, sg.lowZ) < P.canopyMinHeight) continue;
            candidates.push_back({si, owner, wholeRim});
        }
        for (int pass = 0; pass < 8; ++pass) {
            size_t changed = 0;
            for (const auto& cand : candidates) {
                const auto& sg = segments[cand.seg];
                if (drapeFace[sg.faces.front()]) continue;
                double rimSurface = 0, rimOther = 0;
                for (uint32_t t : sg.faces) {
                    for (int j = 0; j < 3; ++j) {
                        const uint32_t a = wtri[3 * static_cast<size_t>(t) + static_cast<size_t>(j)], b = wtri[3 * static_cast<size_t>(t) + static_cast<size_t>((j + 1) % 3)];
                        if (a == b) continue;
                        const float edgeY = 0.5f * (weldPos[a].y + weldPos[b].y);
                        if (!cand.wholeRim && edgeY < sg.maxY - 1.0f) continue;
                        const double len = (weldPos[a] - weldPos[b]).length();
                        const uint64_t key = a < b ? (static_cast<uint64_t>(a) << 32 | b) : (static_cast<uint64_t>(b) << 32 | a);
                        auto it = std::lower_bound(halfEdges.begin(), halfEdges.end(), key, [](const HalfEdge& h, uint64_t k) { return h.key < k; });
                        bool inner = false, across = false;
                        for (; it != halfEdges.end() && it->key == key; ++it) {
                            if (it->tri == t) continue;
                            if (segOf[it->tri] == static_cast<int32_t>(cand.seg)) { inner = true; continue; }
                            across = true;
                            // a steep sheet's top rim is what lies over its top (a roof, a coping, canopy); a sheet beside
                            // it (lower than the edge) is not
                            if (!cand.wholeRim && centroid[it->tri].y < edgeY - 0.1f) continue;
                            if (isArchitecture(it->tri)) rimSurface += len; else rimOther += len;
                        }
                        if (!inner && !across) rimOther += len;  // an open edge: the sheet ends in the air
                    }
                }
                // a wall or roof meets architecture over its top rim; a sheet that meets canopy, or nothing, is drape
                if (rimSurface > 0 && rimSurface >= rimOther) continue;
                for (uint32_t t : sg.faces) drapeFace[t] = 1;
                ++R.stats.drapeSheets;
                R.stats.drapeSheetAreaM2 += sg.area;
                ++changed;
            }
            if (changed == 0) break;
        }
    }

    /**
     * Removes each tree down to the surface it stands on and closes the ground under it.
     *
     * Removal, everything rising more than `clearance` above the crown's cap surface and below the apex of the trees
     * around it: the tree's vegetation in its footprint (dilated by footprintDilation); everything else in that
     * footprint that is not architecture (the drape under and around the crown, connected to it or not); then the drape
     * connected to that, out to drapeReach from the crowns (beyond twice the dilation, next to walls only what is
     * green, so a facade's relief stays). Architecture is planar surfaces except the drape sheets classifyDrapeSurfaces
     * finds. Pieces of the scan the removal leaves hanging in the air beside it go too (takeFloatingFragments). Crowns
     * that stay (low roof vegetation, cut crowns no removal stands beside) and their rim are never taken; cut canopy
     * that would be left standing over a hole goes with the trees it joins (removeAndCap).
     *
     * Closing: every hole loop is lowered onto its crown's cap surface (a loop inside another uses the outer loop's
     * crown). A loop point within skirtMin of the cap surface is used as it is; a higher (or lower) one gets a copy on
     * the cap surface, joined to it by a vertical skirt along the hole edge (never across a seam gap), so walls and
     * building sides the tree hid continue down to the ground and a low planting that stays gets its side closed. The cap is the lowered loop, ear-clipped, split at
     * interior points on the cap surface and Delaunay-flipped, so no cap face reaches up to where the tree was. Cap
     * faces face up. Footprint cells still uncovered seen from above get patches on the cap surface.
     */
    std::vector<uint8_t> keptCell;   // canopy of crowns that stay, and its rim: never removed
    std::vector<int> keptOwner;      // the staying crown each kept cell belongs to (its own cell first, else a rim)
    std::vector<int> growMask;       // per cell: the removed crown whose (twice dilated) footprint holds it

    void removeAndCap() {
        // Canopy of a crown the extraction cut (its apex, and so its trunk, outside) can stay as scanned only where
        // nothing is removed beside it. Where its side would be left standing over a hole, more than canopyMinHeight
        // above the ground rebuilt there, only a wall nobody scanned could close it: it goes with the trees it joins
        // instead (reported, not replanted), and the removal is redone, until no cut canopy stands over a hole.
        size_t cutCrowns = 0;
        for (const auto& rec : R.crowns) cutCrowns += rec.status == "cut_at_boundary";
        for (size_t pass = 0; pass <= cutCrowns; ++pass) {
            removeCrowns();
            if (!takeCutCanopyOverHoles()) break;
        }
        closeHoles();
    }

    /** Hole edges hanging on cut canopy too high above the removed crown's ground: that canopy is taken. */
    bool takeCutCanopyOverHoles() {
        const auto& g = surf.top;
        std::set<int> take;
        for (size_t i = 0; i < halfEdges.size();) {
            size_t j = i, kept = 0;
            int crown = -1;
            long keptAt = -1;
            while (j < halfEdges.size() && halfEdges[j].key == halfEdges[i].key) {
                const uint32_t t = halfEdges[j].tri;
                if (removedBy[t] >= 0) crown = removedBy[t];
                else { ++kept; keptAt = static_cast<long>(j); }
                ++j;
            }
            i = j;
            if (kept != 1 || crown < 0) continue;
            const auto& he = halfEdges[static_cast<size_t>(keptAt)];
            if (isArchitecture(he.tri)) continue;
            const int ci = g.ix(centroid[he.tri].x), ck = g.iz(centroid[he.tri].z);
            if (!g.in(ci, ck)) continue;
            const size_t c = g.id(ci, ck);
            if (!keptCell[c] || keptOwner[c] < 0) continue;
            const auto& owner = work[static_cast<size_t>(keptOwner[c])];
            if (owner.recordIndex < 0 || R.crowns[static_cast<size_t>(owner.recordIndex)].status != "cut_at_boundary") continue;
            const Vec3 &a = weldPos[wtri[3 * he.tri + he.j]], &b = weldPos[wtri[3 * he.tri + static_cast<size_t>((he.j + 1) % 3)]];
            const double rise = std::max(a.y - capHeight(crown, a.x, a.z), b.y - capHeight(crown, b.x, b.z));
            if (rise > P.canopyMinHeight) take.insert(keptOwner[c]);
        }
        for (int m : take) {
            auto& rec = R.crowns[static_cast<size_t>(work[static_cast<size_t>(m)].recordIndex)];
            rec.status = "cut_at_boundary_removed";
            --R.stats.crownsCut;
            ++R.stats.crownsCutRemoved;
            R.stats.cutCanopyRemovedM2 += rec.areaM2;
        }
        return !take.empty();
    }

    /** The removal (removedBy) for the crowns removed now; see removeAndCap. */
    void removeCrowns() {
        const auto& g = surf.top;
        const size_t N = g.size();
        removedBy.assign(T, -1);
        R.stats.removedTriangles = 0;
        R.stats.canopyTakenWithTreesM2 = 0;
        R.stats.drapeSheets = 0;
        R.stats.drapeSheetAreaM2 = 0;
        R.stats.fragmentsTaken = 0;
        R.stats.fragmentAreaTakenM2 = 0;
        // seed and growth masks per cell: dilated footprints of the trees
        std::vector<int> seedMask(N, -1);
        growMask.assign(N, -1);
        const int rs = static_cast<int>(std::ceil(P.footprintDilation / P.cell));
        const int rg = static_cast<int>(std::ceil(2.0 * P.footprintDilation / P.cell));
        for (size_t m = 0; m < work.size(); ++m) {
            const auto& w = work[m];
            if (!removesCrown(m)) continue;
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
        // canopy of crowns that stay (low roof vegetation, cut crowns joined to no removed tree) and its rim is never
        // removed; canopy that belongs to no kept crown (fragments, cells the watershed did not reach) may go with the
        // tree it hangs on
        keptCell.assign(N, 0);
        keptOwner.assign(N, -1);
        std::vector<uint8_t> freeCanopy(N, 0);
        for (size_t m = 0; m < work.size(); ++m) {
            const auto& w = work[m];
            if (w.recordIndex < 0 || removesCrown(m)) continue;
            for (size_t c : w.cells) {
                const int i = static_cast<int>(c % static_cast<size_t>(g.nx)), k = static_cast<int>(c / static_cast<size_t>(g.nx));
                for (int dk = -1; dk <= 1; ++dk) {
                    for (int di = -1; di <= 1; ++di) {
                        if (!g.in(i + di, k + dk)) continue;
                        const size_t j = g.id(i + di, k + dk);
                        keptCell[j] = 1;
                        if (keptOwner[j] < 0 || label[j] == static_cast<int>(m)) keptOwner[j] = static_cast<int>(m);
                    }
                }
            }
        }
        for (size_t c = 0; c < N; ++c) freeCanopy[c] = canopy[c] && !keptCell[c] && growMask[c] < 0;
        auto cellOf = [&](const Vec3& p) -> long {
            const int i = g.ix(p.x), k = g.iz(p.z);
            return g.in(i, k) ? static_cast<long>(g.id(i, k)) : -1;
        };
        // reach of the drape: the nearest tree crown of every cell within drapeReach of one (multi-source breadth-first,
        // 4-connected, in cells), and the highest apex of the trees within reach of each cell
        std::vector<int> drapeOwner(N, -1);
        std::vector<float> regionApex(N, -std::numeric_limits<float>::infinity());
        {
            const int reachCells = static_cast<int>(std::ceil(P.drapeReach / P.cell));
            std::vector<int> stamp(N, -1), sd(N, 0);
            for (size_t m = 0; m < work.size(); ++m) {
                const auto& w = work[m];
                if (!removesCrown(m)) continue;
                const float apexY = R.crowns[static_cast<size_t>(w.recordIndex)].apex.y;
                std::queue<size_t> sq;
                for (size_t c : w.cells) { stamp[c] = static_cast<int>(m); sd[c] = 0; sq.push(c); }
                while (!sq.empty()) {
                    const size_t c = sq.front();
                    sq.pop();
                    regionApex[c] = std::max(regionApex[c], apexY);
                    if (sd[c] >= reachCells) continue;
                    const int i = static_cast<int>(c % static_cast<size_t>(g.nx)), k = static_cast<int>(c / static_cast<size_t>(g.nx));
                    for (const auto& [di, dk] : {std::pair{1, 0}, std::pair{-1, 0}, std::pair{0, 1}, std::pair{0, -1}}) {
                        if (!g.in(i + di, k + dk)) continue;
                        const size_t n = g.id(i + di, k + dk);
                        if (stamp[n] == static_cast<int>(m)) continue;
                        stamp[n] = static_cast<int>(m);
                        sd[n] = sd[c] + 1;
                        sq.push(n);
                    }
                }
            }
        }
        {
            std::vector<int> dist(N, -1);
            std::queue<size_t> bq;
            for (size_t m = 0; m < work.size(); ++m) {
                const auto& w = work[m];
                if (!removesCrown(m)) continue;
                for (size_t c : w.cells) if (dist[c] < 0) { dist[c] = 0; drapeOwner[c] = static_cast<int>(m); bq.push(c); }
            }
            const int reach = static_cast<int>(std::ceil(P.drapeReach / P.cell));
            while (!bq.empty()) {
                const size_t c = bq.front();
                bq.pop();
                if (dist[c] >= reach) continue;
                const int i = static_cast<int>(c % static_cast<size_t>(g.nx)), k = static_cast<int>(c / static_cast<size_t>(g.nx));
                for (const auto& [di, dk] : {std::pair{1, 0}, std::pair{-1, 0}, std::pair{0, 1}, std::pair{0, -1}}) {
                    if (!g.in(i + di, k + dk)) continue;
                    const size_t n = g.id(i + di, k + dk);
                    if (dist[n] >= 0) continue;
                    dist[n] = dist[c] + 1;
                    drapeOwner[n] = drapeOwner[c];
                    bq.push(n);
                }
            }
        }
        classifyDrapeSurfaces(drapeOwner, regionApex);
        bool removesAny = false;
        for (size_t m = 0; m < work.size() && !removesAny; ++m) removesAny = removesCrown(m);
        // no tree to take out: no ground to rebuild (a tile without trees, on a hillside or not, is left as it is)
        if (removesAny) buildSupportSurface();
        // cells on or next to a wall (a steep planar surface): there, beyond the tree's own vegetation, only green goes,
        // so the relief of a facade a crown leans on stays
        std::vector<uint8_t> nearWall(N, 0);
        for (size_t t = 0; t < T; ++t) {
            if (!isArchitecture(t) || std::abs(normal[t].y) >= 0.7f) continue;
            for (int j = 0; j < 3; ++j) {
                const Vec3& v = weldPos[wtri[3 * t + static_cast<size_t>(j)]];
                const int i = g.ix(v.x), k = g.iz(v.z);
                for (int dk = -1; dk <= 1; ++dk) for (int di = -1; di <= 1; ++di) if (g.in(i + di, k + dk)) nearWall[g.id(i + di, k + dk)] = 1;
            }
            const long c = cellOf(centroid[t]);
            if (c >= 0) nearWall[static_cast<size_t>(c)] = 1;
        }
        // nothing above the trees standing around it is part of them
        auto underApex = [&](size_t t) {
            const long c = cellOf(centroid[t]);
            if (c < 0) return false;
            return std::min({weldPos[wtri[3 * t]].y, weldPos[wtri[3 * t + 1]].y, weldPos[wtri[3 * t + 2]].y}) <= regionApex[static_cast<size_t>(c)];
        };
        std::queue<uint32_t> q;
        // 1. the tree's vegetation
        for (size_t t = 0; t < T; ++t) {
            if (!veg[t]) continue;
            const long c = cellOf(centroid[t]);
            if (c < 0 || seedMask[static_cast<size_t>(c)] < 0 || keptCell[static_cast<size_t>(c)]) continue;
            const int m = seedMask[static_cast<size_t>(c)];
            if (centroid[t].y - capHeight(m, centroid[t].x, centroid[t].z) <= P.clearance) continue;
            removedBy[t] = m;
            q.push(static_cast<uint32_t>(t));
        }
        // 2. everything else standing in the footprint under the apex that is not a planar surface (the scanned drape
        //    under and around the crown), connected to the crown or not
        for (size_t t = 0; t < T; ++t) {
            if (removedBy[t] >= 0 || isArchitecture(t)) continue;
            const long c = cellOf(centroid[t]);
            if (c < 0 || seedMask[static_cast<size_t>(c)] < 0 || keptCell[static_cast<size_t>(c)]) continue;
            if (nearWall[static_cast<size_t>(c)] && !chromaVeg[t]) continue;
            const int m = seedMask[static_cast<size_t>(c)];
            if (riseAboveCap(m, t) <= P.clearance || !underApex(t)) continue;
            removedBy[t] = m;
            q.push(static_cast<uint32_t>(t));
        }
        // 3. the drape that hangs on it, out to drapeReach from the crowns (free canopy at any distance), down to the
        //    ground, walls, roofs and the crowns that stay
        while (!q.empty()) {
            const uint32_t t = q.front();
            q.pop();
            for (uint32_t e = adjStart[t]; e < adjStart[t + 1]; ++e) {
                const uint32_t u = adj[e];
                if (removedBy[u] >= 0 || isArchitecture(u)) continue;
                const long cl = cellOf(centroid[u]);
                if (cl < 0) continue;
                const size_t c = static_cast<size_t>(cl);
                if (keptCell[c]) continue;
                const int m = growMask[c] >= 0 ? growMask[c] : drapeOwner[c] >= 0 ? drapeOwner[c] : freeCanopy[c] ? removedBy[t] : -1;
                if (m < 0) continue;
                if (nearWall[c] && !chromaVeg[u] && growMask[c] < 0) continue;
                if (riseAboveCap(m, u) <= P.clearance || !underApex(u)) continue;
                removedBy[u] = m;
                q.push(u);
            }
        }
        takeFloatingFragments();
        for (size_t t = 0; t < T; ++t) if (removedBy[t] >= 0) ++R.stats.removedTriangles;
        for (size_t c = 0; c < N; ++c) {
            if (!canopy[c] || surf.topTriangle[c] < 0 || removedBy[static_cast<size_t>(surf.topTriangle[c])] < 0) continue;
            const int l = label[c];
            if (!(l >= 0 && removesCrown(static_cast<size_t>(l)))) R.stats.canopyTakenWithTreesM2 += P.cell * P.cell;
        }
    }

    /**
     * What a removal leaves hanging in the air beside it: kept pieces that are not walls, roofs, ground or canopy that
     * stays (a shadowed bough the chroma did not judge green, a scrap of the scan's curtain), standing more than
     * canopyMinHeight over the removed tree's ground and connected (through other such pieces) to neither the ground,
     * nor a wall or roof, nor kept canopy, within fragmentMaxArea. They are part of that tree's scan and go with it;
     * left standing, only a wall nobody scanned could close the ground under them.
     */
    void takeFloatingFragments() {
        const auto& g = surf.top;
        auto keptCanopyAt = [&](uint32_t t) {
            const int i = g.ix(centroid[t].x), k = g.iz(centroid[t].z);
            return g.in(i, k) && keptCell[g.id(i, k)];
        };
        std::vector<uint8_t> anchored(T, 0);
        std::vector<uint32_t> stamp(T, 0);
        uint32_t run = 0;
        for (int pass = 0; pass < 8; ++pass) {
            std::vector<std::pair<uint32_t, int>> starts;
            for (size_t t = 0; t < T; ++t) {
                if (removedBy[t] < 0) continue;
                for (uint32_t e = adjStart[t]; e < adjStart[t + 1]; ++e) {
                    const uint32_t u = adj[e];
                    if (removedBy[u] >= 0 || anchored[u] || isArchitecture(u) || keptCanopyAt(u)) continue;
                    if (riseAboveCap(removedBy[t], u) <= P.canopyMinHeight) continue;
                    starts.emplace_back(u, removedBy[t]);
                }
            }
            size_t taken = 0;
            for (const auto& [start, m] : starts) {
                if (removedBy[start] >= 0 || anchored[start]) continue;
                ++run;
                std::vector<uint32_t> piece{start};
                stamp[start] = run;
                double pieceArea = 0;
                bool held = false;
                for (size_t qi = 0; qi < piece.size() && !held; ++qi) {
                    const uint32_t t = piece[qi];
                    pieceArea += area[t];
                    // it reaches the ground (within the support band of the surface the tree stood on), or it is large
                    double low = std::numeric_limits<double>::infinity();
                    for (int j = 0; j < 3; ++j) {
                        const Vec3& v = weldPos[wtri[3 * t + static_cast<size_t>(j)]];
                        low = std::min(low, static_cast<double>(v.y) - capHeight(m, v.x, v.z));
                    }
                    if (low <= P.supportBand || pieceArea > P.fragmentMaxArea) { held = true; break; }
                    for (uint32_t e = adjStart[t]; e < adjStart[t + 1]; ++e) {
                        const uint32_t u = adj[e];
                        if (removedBy[u] >= 0 || stamp[u] == run) continue;
                        if (anchored[u] || isArchitecture(u) || keptCanopyAt(u)) { held = true; break; }
                        stamp[u] = run;
                        piece.push_back(u);
                    }
                }
                if (held) {
                    for (uint32_t t : piece) anchored[t] = 1;
                    continue;
                }
                for (uint32_t t : piece) removedBy[t] = m;
                taken += piece.size();
                ++R.stats.fragmentsTaken;
                R.stats.fragmentAreaTakenM2 += pieceArea;
            }
            if (taken == 0) break;
        }
    }

    /** Closes every hole the removal opened; see removeAndCap. */
    void closeHoles() {
        const auto& g = surf.top;
        auto cellOf = [&](const Vec3& p) -> long {
            const int i = g.ix(p.x), k = g.iz(p.z);
            return g.in(i, k) ? static_cast<long>(g.id(i, k)) : -1;
        };
        // hole edges: an edge of a kept triangle whose other triangles were all removed, reversed
        struct HoleEdge { uint32_t a, b; int crown; uint32_t keptTri; bool used; };
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
                holes.push_back({b, a, crown, he.tri, false});
            }
            i = j;
        }
        // Walk the hole edges into paths: chains first (from vertices with more outgoing than incoming hole edges),
        // then the remaining cycles. A chain ends where the hole meets a seam that was open before (tile leaves are
        // separate meshes); chains are then joined end to start across such gaps (nearest first, within seamGap).
        // Per path edge: the kept triangle it hangs on, or -1 for a gap (a seam crossing or the closing edge).
        std::unordered_map<uint32_t, std::vector<size_t>> out;
        std::unordered_map<uint32_t, int> indeg;
        for (size_t h = 0; h < holes.size(); ++h) { out[holes[h].a].push_back(h); indeg[holes[h].b]++; }
        struct Path { std::vector<uint32_t> v; std::vector<int64_t> kept; std::map<int, int> votes; bool closed{false}; };
        auto walk = [&](size_t h0) {
            Path p;
            size_t h = h0;
            while (true) {
                holes[h].used = true;
                p.v.push_back(holes[h].a);
                p.kept.push_back(holes[h].keptTri);
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
                // the chain's last point has no edge of its own yet: it leads across the seam gap (or nowhere)
                if (!skip) cycle.kept.push_back(-1);
                cycle.v.insert(cycle.v.end(), nx.v.begin() + static_cast<long>(skip), nx.v.end());
                cycle.kept.insert(cycle.kept.end(), nx.kept.begin(), nx.kept.end());
                for (const auto& [c, n] : nx.votes) cycle.votes[c] += n;
                ++R.stats.linkedChains;
            }
            if (cycle.v.size() > 1 && cycle.v.front() == cycle.v.back()) cycle.v.pop_back();
            cycle.kept.resize(cycle.v.size(), -1);  // the closing edge
            closedPaths.push_back(std::move(cycle));
        }
        std::vector<std::vector<uint32_t>> loops;   // welded vertex ids
        std::vector<std::vector<int64_t>> loopKept; // per edge loop[i] -> loop[i + 1]: kept triangle, -1 for a gap
        std::vector<int> loopCrown;
        for (auto& p : closedPaths) {
            if (p.v.size() < 3) continue;
            int crown = -1, best = -1;
            for (const auto& [c, n] : p.votes) if (c >= 0 && n > best) { best = n; crown = c; }
            if (crown < 0) continue;
            p.kept.resize(p.v.size(), -1);
            loops.push_back(std::move(p.v));
            loopKept.push_back(std::move(p.kept));
            loopCrown.push_back(crown);
        }
        R.stats.loops = loops.size();
        // a loop inside another (an island left standing in a removal: a wall stub, a kiosk) is closed on the cap of the
        // loop around it, so one cap never mixes two crowns' surfaces
        {
            std::vector<double> xzArea(loops.size());
            for (size_t l = 0; l < loops.size(); ++l) xzArea[l] = detail::upArea(weldPos, loops[l]);
            std::vector<long> outer(loops.size(), -1);
            for (size_t l = 0; l < loops.size(); ++l) {
                if (xzArea[l] >= 0) continue;
                const Vec3& probe = weldPos[loops[l][0]];
                double bestArea = std::numeric_limits<double>::infinity();
                for (size_t o = 0; o < loops.size(); ++o) {
                    if (o == l || xzArea[o] <= 0 || xzArea[o] >= bestArea) continue;
                    if (detail::pointInPolygonXZ(weldPos, loops[o], probe.x, probe.z)) { bestArea = xzArea[o]; outer[l] = static_cast<long>(o); }
                }
            }
            for (size_t l = 0; l < loops.size(); ++l) if (outer[l] >= 0) loopCrown[l] = loopCrown[static_cast<size_t>(outer[l])];
        }

        // lower every loop onto the cap surface: skirts along the hole edges where the loop stands off it
        std::unordered_map<uint32_t, uint32_t> top;        // welded id -> cap vertex (the kept point itself)
        std::unordered_map<uint64_t, uint32_t> lowered;    // (welded id, crown) -> its copy on that crown's cap surface
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
                ++R.stats.boundaryPoints;
                if (std::abs(p.y - gy) <= P.skirtMin) { lower[i] = upper[i]; continue; }
                ++R.stats.skirtedPoints;
                const uint64_t key = (static_cast<uint64_t>(loop[i]) << 32) | static_cast<uint32_t>(crown);
                auto it = lowered.find(key);
                if (it == lowered.end()) {
                    capPos.push_back(Vec3(p.x, static_cast<float>(gy), p.z));
                    it = lowered.emplace(key, static_cast<uint32_t>(capPos.size() - 1)).first;
                }
                lower[i] = it->second;
            }
            for (size_t i = 0; i < loop.size(); ++i) {
                const size_t n = (i + 1) % loop.size();
                if (loopKept[l][i] < 0) continue;  // no kept edge to hang a skirt on (seam gap, closing edge)
                if (upper[i] == lower[i] && upper[n] == lower[n]) continue;
                const size_t before = capIsSkirt.size();
                addTri(upper[i], upper[n], lower[n], true);
                addTri(upper[i], lower[n], lower[i], true);
                // what the skirt hangs on (for the report): a wall, a roof or terrace, canopy that stays, anything else
                const size_t t = static_cast<size_t>(loopKept[l][i]);
                const long c = cellOf(centroid[t]);
                const bool wall = isArchitecture(t) && std::abs(normal[t].y) < 0.7f, level = isArchitecture(t) && !wall;
                const bool onCanopy = !isArchitecture(t) && c >= 0 && keptCell[static_cast<size_t>(c)];
                double& bucket = wall ? R.stats.skirtAreaOnWallsM2 : level ? R.stats.skirtAreaOnLevelSurfacesM2 : onCanopy ? R.stats.skirtAreaOnKeptCanopyM2 : R.stats.skirtAreaOnOtherM2;
                double& tallest = wall ? R.stats.skirtMaxOnWallsM : level ? R.stats.skirtMaxOnLevelSurfacesM : onCanopy ? R.stats.skirtMaxOnKeptCanopyM : R.stats.skirtMaxOnOtherM;
                for (size_t k = before; k < capIsSkirt.size(); ++k) {
                    const Vec3 &a = capPos[capTris[3 * k]], &b = capPos[capTris[3 * k + 1]], &cc = capPos[capTris[3 * k + 2]];
                    bucket += 0.5 * static_cast<double>((b - a).cross(cc - a).length());
                    const double span = static_cast<double>(std::max({a.y, b.y, cc.y}) - std::min({a.y, b.y, cc.y}));
                    tallest = std::max(tallest, span);
                    R.stats.skirtMaxHeightM = std::max(R.stats.skirtMaxHeightM, span);
                }
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
            if (std::abs(areas[l]) > P.capGrid * P.capGrid) {
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
                        const Vec3 qp(static_cast<float>(x), static_cast<float>(capHeight(loopCrown[l], x, z)), static_cast<float>(z));
                        for (size_t k = first / 3; k < capTris.size() / 3; ++k) {
                            if (capIsSkirt[k]) continue;
                            const uint32_t a = capTris[3 * k], b = capTris[3 * k + 1], c = capTris[3 * k + 2];
                            const double o = detail::cross2(capPos[a], capPos[b], capPos[c]);
                            if (std::abs(o) < 1e-9) continue;
                            const double sgn = o > 0 ? 1.0 : -1.0;
                            const double d1 = detail::cross2(capPos[a], capPos[b], qp) * sgn, d2 = detail::cross2(capPos[b], capPos[c], qp) * sgn, d3 = detail::cross2(capPos[c], capPos[a], qp) * sgn;
                            if (d1 <= 1e-9 || d2 <= 1e-9 || d3 <= 1e-9) continue;
                            capPos.push_back(qp);
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
            R.stats.capFlips += detail::delaunayFlips(capPos, capTris, first / 3, capTris.size() / 3);
        }
        fillUncoveredCells();
        R.stats.capTriangles = capIsSkirt.size() - R.stats.skirtTriangles;
        // cap faces are ground or roof: where a folded loop (seen from above) clipped an ear facing down, turn it up
        for (size_t k = 0; k < capIsSkirt.size(); ++k) {
            if (capIsSkirt[k]) continue;
            const Vec3 &a = capPos[capTris[3 * k]], &b = capPos[capTris[3 * k + 1]], &c = capPos[capTris[3 * k + 2]];
            const Vec3 n = (b - a).cross(c - a);
            const float len = n.length();
            if (len < 1e-9f) { ++R.stats.capDegenerate; continue; }
            if (n.y < 0.0f) { std::swap(capTris[3 * k + 1], capTris[3 * k + 2]); ++R.stats.capTurnedUp; }
            R.stats.capMaxRiseM = std::max(R.stats.capMaxRiseM, static_cast<double>(std::max({a.y, b.y, c.y}) - std::min({a.y, b.y, c.y})));
        }

        // the open-edge count of the result (welded ids for kept triangles, cap vertices mapped back)
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
     * broken by tile seams, or folded over themselves, can leave part of a hole uncapped (along a seam, a sliver
     * narrower than a cell); every cell where any of 4 x 4 sample points the scan covered is no longer covered gets a
     * grid patch on the cap surface (one welded patch per run of cells), so the ground under a removed tree is never
     * left open.
     */
    void fillUncoveredCells() {
        const auto& g = surf.top;
        constexpr int F = 4;  // sample points per cell side
        const int sx = g.nx * F, sz = g.nz * F;
        const double sub = g.cell / F;
        auto raster = [&](const Vec3& a, const Vec3& b, const Vec3& c, std::vector<uint8_t>& cov) {
            const double d = (static_cast<double>(b.x) - a.x) * (static_cast<double>(c.z) - a.z) - (static_cast<double>(c.x) - a.x) * (static_cast<double>(b.z) - a.z);
            if (std::abs(d) < 1e-12) return;
            const int i0 = std::max(0, static_cast<int>(std::floor((std::min({a.x, b.x, c.x}) - g.x0) / sub))), i1 = std::min(sx - 1, static_cast<int>(std::floor((std::max({a.x, b.x, c.x}) - g.x0) / sub)));
            const int k0 = std::max(0, static_cast<int>(std::floor((std::min({a.z, b.z, c.z}) - g.z0) / sub))), k1 = std::min(sz - 1, static_cast<int>(std::floor((std::max({a.z, b.z, c.z}) - g.z0) / sub)));
            for (int k = k0; k <= k1; ++k) {
                for (int i = i0; i <= i1; ++i) {
                    const double x = g.x0 + (i + 0.5) * sub, z = g.z0 + (k + 0.5) * sub;
                    const double w1 = ((x - a.x) * (c.z - a.z) - (c.x - a.x) * (z - a.z)) / d;
                    const double w2 = ((b.x - a.x) * (z - a.z) - (x - a.x) * (b.z - a.z)) / d;
                    if (w1 >= -1e-9 && w2 >= -1e-9 && 1 - w1 - w2 >= -1e-9) cov[static_cast<size_t>(k) * static_cast<size_t>(sx) + static_cast<size_t>(i)] = 1;
                }
            }
        };
        std::vector<uint8_t> beforeSub(static_cast<size_t>(sx) * static_cast<size_t>(sz), 0), afterSub(beforeSub.size(), 0);
        std::vector<int> cellCrown(g.size(), -1);
        for (size_t t = 0; t < T; ++t) {
            const Vec3 &a = weldPos[wtri[3 * t]], &b = weldPos[wtri[3 * t + 1]], &c = weldPos[wtri[3 * t + 2]];
            raster(a, b, c, beforeSub);
            if (removedBy[t] < 0) { raster(a, b, c, afterSub); continue; }
            const int i = g.ix(centroid[t].x), k = g.iz(centroid[t].z);
            if (g.in(i, k)) cellCrown[g.id(i, k)] = removedBy[t];
        }
        for (size_t k = 0; 3 * k + 2 < capTris.size(); ++k) raster(capPos[capTris[3 * k]], capPos[capTris[3 * k + 1]], capPos[capTris[3 * k + 2]], afterSub);
        // per cell: covered before (any sample), and still covered after (every sample the scan covered). Along the
        // extraction's outer edge a removed crown may have overhung the edge of the ground; what it covered there is
        // the extraction's edge, not a hole, so those cells are not patched.
        std::vector<uint8_t> before(g.size(), 0), after(g.size(), 1);
        for (int k = 0; k < sz; ++k) {
            for (int i = 0; i < sx; ++i) {
                const size_t s0 = static_cast<size_t>(k) * static_cast<size_t>(sx) + static_cast<size_t>(i);
                if (!beforeSub[s0]) continue;
                const size_t c = g.id(i / F, k / F);
                before[c] = 1;
                if (!afterSub[s0] && edgeDist[c] > 1) after[c] = 0;
            }
        }
        std::unordered_map<uint64_t, uint32_t> corner;  // grid corner -> cap vertex, so neighbouring fill cells share edges
        auto cornerVertex = [&](int i, int k, int crown) {
            const uint64_t key = ((static_cast<uint64_t>(static_cast<uint32_t>(i)) << 40) | (static_cast<uint64_t>(static_cast<uint32_t>(k)) << 20)) ^ static_cast<uint64_t>(static_cast<uint32_t>(crown));
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
        // cap (ground or roof where a tree stood) and skirt (vertical, along the hole edges) primitives: flat-shaded corners
        Prim cap, skirt;
        for (size_t k = 0; k < capTris.size() / 3; ++k) {
            Prim& pr = capIsSkirt[k] ? skirt : cap;
            const Vec3 &a = capPos[capTris[3 * k]], &b = capPos[capTris[3 * k + 1]], &c = capPos[capTris[3 * k + 2]];
            Vec3 n = (b - a).cross(c - a);
            n = n.lengthSquared() > 1e-20f ? n.normalized() : Vec3(0, 1, 0);
            for (const Vec3* p : {&a, &b, &c}) {
                pr.p.insert(pr.p.end(), {p->x, p->y, p->z});
                pr.n.insert(pr.n.end(), {n.x, n.y, n.z});
                pr.uv.insert(pr.uv.end(), {0.0f, 0.0f});
                pr.i.push_back(static_cast<uint32_t>(pr.p.size() / 3 - 1));
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
        addPrim(skirt, capMaterial, "vegetation_removed_skirt");
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
            if (rec.status == "cut_at_boundary_removed") { cr = 40; cg = 90; cb = 255; }
            if (rec.status == "no_measured_ground") { cr = 255; cg = 255; cb = 0; }
            if (rec.status == "not_regrowable") { cr = 255; cg = 255; cb = 255; }
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
      << ",\"sampleSpacing\":" << json::numPrecise(P.sampleSpacing) << "},\n";
    // how the trees were regrown to decide which to remove: plant grows them again with exactly these
    char seedHex[17];
    std::snprintf(seedHex, sizeof(seedHex), "%016llx", static_cast<unsigned long long>(P.growth.seed));
    s << "\"growth\":{\"seed\":" << json::str(seedHex) << ",\"crownBaseRatio\":" << json::numPrecise(P.growth.crownBaseRatio)
      << ",\"trunkRadiusPerHeight\":" << json::numPrecise(P.growth.trunkRadiusPerHeight) << ",\"shellDepth\":" << json::numPrecise(P.growth.shellDepth)
      << ",\"minSurfaceReached\":" << json::numPrecise(P.growth.minSurfaceReached) << "},\n\"crowns\":[";
    for (size_t i = 0; i < r.crowns.size(); ++i) {
        const auto& c = r.crowns[i];
        s << (i ? ",\n" : "\n") << "{\"id\":" << c.id << ",\"status\":" << json::str(c.status) << ",\"reachesBoundary\":" << (c.reachesBoundary ? "true" : "false") << ",\"apex\":" << v3(c.apex)
          << ",\"stem\":[" << json::numPrecise(c.stemX) << "," << json::numPrecise(c.stemZ) << "],\"supportY\":" << json::numPrecise(c.supportY)
          << ",\"supportTilt\":[" << json::num(c.tiltX) << "," << json::num(c.tiltZ) << "]"
          << ",\"supportSource\":" << json::str(c.supportSource) << ",\"terrainY\":" << json::num(c.terrainY)
          << ",\"apexAboveSupport\":" << json::num(c.apexAboveSupport) << ",\"areaM2\":" << json::numPrecise(c.areaM2) << ",\"sectorRadii\":[";
        for (size_t k = 0; k < 16; ++k) s << (k ? "," : "") << json::numPrecise(c.sectorRadii[k]);
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
        if (c.regrowthChecked) {
            // what growing the tree into this crown gave (see growCrown); a not_regrowable crown says why it stays as scanned
            s << ",\"regrowth\":{\"surfaceSamples\":" << c.regrowthSurfaceSamples << ",\"surfaceReached\":" << c.regrowthSurfaceReached
              << ",\"surfaceShare\":" << json::num(c.regrowthSurfaceShare) << ",\"reachM\":" << json::num(c.regrowthReachM)
              << ",\"leafTopY\":" << json::num(c.regrowthLeafTopY);
            if (!c.regrowthFailure.empty()) s << ",\"reasonCode\":" << json::str(c.regrowthFailureCode) << ",\"reason\":" << json::str(c.regrowthFailure);
            s << ",\"colonisation\":" << json::str(c.regrowthColonisation) << "}";
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
    s << "  \"holes\": {\"loops\": " << st.loops << ", \"openChains\": " << st.openChains << ", \"linkedChains\": " << st.linkedChains << ", \"holesBridged\": " << st.holesBridged << ", \"forcedEars\": " << st.forcedEars << ", \"capInteriorPoints\": " << st.capInteriorPoints << ", \"capTurnedUp\": " << st.capTurnedUp << ", \"capDegenerate\": " << st.capDegenerate << ", \"capsReversed\": " << st.capsReversed << ", \"capFillCells\": " << st.capFillCells << ", \"capFlips\": " << st.capFlips << ", \"capMaxRiseM\": " << json::num(st.capMaxRiseM) << "},\n";
    s << "  \"skirts\": {\"boundaryPoints\": " << st.boundaryPoints << ", \"skirtedPoints\": " << st.skirtedPoints << ", \"areaM2\": {\"onWalls\": " << json::num(st.skirtAreaOnWallsM2)
      << ", \"onLevelSurfaces\": " << json::num(st.skirtAreaOnLevelSurfacesM2) << ", \"onKeptCanopy\": " << json::num(st.skirtAreaOnKeptCanopyM2) << ", \"onOther\": " << json::num(st.skirtAreaOnOtherM2)
      << "}, \"maxHeightM\": " << json::num(st.skirtMaxHeightM) << ", \"maxHeightByHangM\": {\"onWalls\": " << json::num(st.skirtMaxOnWallsM)
      << ", \"onLevelSurfaces\": " << json::num(st.skirtMaxOnLevelSurfacesM) << ", \"onKeptCanopy\": " << json::num(st.skirtMaxOnKeptCanopyM)
      << ", \"onOther\": " << json::num(st.skirtMaxOnOtherM) << "}},\n";
    s << "  \"drape\": {\"sheets\": " << st.drapeSheets << ", \"sheetAreaM2\": " << json::num(st.drapeSheetAreaM2) << ", \"canopyTakenWithTreesM2\": " << json::num(st.canopyTakenWithTreesM2)
      << ", \"fragmentsTaken\": " << st.fragmentsTaken << ", \"fragmentAreaTakenM2\": " << json::num(st.fragmentAreaTakenM2) << "},\n";
    s << "  \"canopyAreaM2\": " << json::num(st.canopyAreaM2) << ",\n  \"treeCanopyAreaM2\": " << json::num(st.treeCanopyAreaM2) << ",\n";
    s << "  \"crowns\": {\"tree\": " << st.crownsTree << ", \"treesReachingBoundary\": " << st.treesReachingBoundary << ", \"belowMinHeight\": " << st.crownsLow
      << ", \"cutAtBoundary\": " << st.crownsCut << ", \"cutAtBoundaryRemoved\": " << st.crownsCutRemoved << ", \"tooSmall\": " << st.crownsTooSmall
      << ", \"noMeasuredGround\": " << st.crownsNoGround << ", \"notRegrowable\": " << st.crownsNotRegrowable << "},\n";
    // trees the regrown SB-Veggie tree does not fill, kept as scanned, each with the reason
    s << "  \"notRegrowable\": [";
    {
        size_t n = 0;
        for (const auto& c : r.crowns) {
            if (c.status != "not_regrowable") continue;
            s << (n++ ? ", " : "") << "{\"crownId\": " << c.id << ", \"reasonCode\": " << json::str(c.regrowthFailureCode) << ", \"reason\": " << json::str(c.regrowthFailure)
              << ", \"colonisation\": " << json::str(c.regrowthColonisation) << ", \"areaM2\": " << json::num(c.areaM2) << ", \"heightM\": " << json::num(c.apexAboveSupport) << "}";
        }
    }
    s << "],\n";
    s << "  \"cutCanopyRemovedM2\": " << json::num(st.cutCanopyRemovedM2) << ",\n";
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
    // Total triangles all trees may use together (> 0): the caller's own budget, spread over the trees in proportion to
    // their targets. 0: the budget comes from the measured trees: each tree's target (trianglesPerCrownM2 of its crown
    // envelope, never below minTrianglesPerTree), all of them within sceneTriangleCap (the caller's viewport cap for
    // the trees of one scene; tile-vegetation-service.ts SCENE_TREE_TRIANGLE_CAP says why it is what it is).
    double triangleBudget{0};
    double sceneTriangleCap{0};
    double minTrianglesPerTree{120};
    // A tree's target: about one 20-triangle leaf mass per 3 m x 3 m of its crown envelope (the measured footprint
    // plus the side, mean radius x 2 pi x crown depth), with the wood's 40 % on top: 20 / 9 / 0.6 = 3.7, rounded to 4.
    double trianglesPerCrownM2{4.0};
    GrowthParams growth;             // the measurement's own (crowns.json "growth") when it recorded them
    double woodShare{0.4};
    double supportTolerance{0.3};    // isolate: the trunk base must hit the support mesh within this (m)
    int threads{0};
};

struct PlantedTree {
    int crownId{0};
    uint32_t seed{0};
    size_t target{0};                // triangles this crown's size asks for
    size_t budget{0};                // triangles it was given
    nature::TreeBudgetReport report;
    nature::ColonizationReport colonisation;
    geometry::Mesh wood, foliage;
    double heightAboveSupport{0}, crownBaseY{0}, trunkRadius{0};
    double surfaceShare{0}, leafTopY{0};
    const io::GlbJsonValue* crown{nullptr};
};

struct PlantResult {
    std::vector<PlantedTree> trees;
    std::vector<std::pair<int, std::string>> skipped;  // crown id, reason
    size_t triangles{0};
    double triangleBudget{0};        // what all trees were given together
    std::string budgetSource;        // explicit | crown_targets | crown_targets_capped (a label; nothing branches on it)
    size_t targetTriangles{0};       // sum of the per-tree targets
    double ms{0};
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

inline std::string thousands(double v) {
    std::string d = std::to_string(static_cast<long long>(std::llround(v)));
    std::string o;
    const size_t lead = d.size() % 3 == 0 ? 3 : d.size() % 3;
    for (size_t i = 0; i < d.size(); ++i) {
        if (i >= lead && i > 0 && (i - lead) % 3 == 0) o += ',';
        o += d[i];
    }
    return o;
}

} // namespace detail

/** The triangles a crown's size asks for (see PlantParams::trianglesPerCrownM2), never fewer than minTrianglesPerTree. */
inline size_t crownTriangleTarget(const CrownShape& c, const PlantParams& P) {
    double r = 0;
    for (double v : c.sectorRadii) r += v / 16.0;
    const double depth = std::max(0.0, (1.0 - P.growth.crownBaseRatio) * (static_cast<double>(c.apex.y) - c.supportY));
    const double envelope = std::max(0.0, c.areaM2) + 2.0 * M_PI * r * depth;
    return static_cast<size_t>(std::max(P.minTrianglesPerTree, std::ceil(P.trianglesPerCrownM2 * envelope)));
}

/**
 * Grows one tree per crown with status "tree" (growCrown, the same trees strip grew to decide what to remove) and meshes
 * each within its share of the triangle budget. `supportMesh` (optional, isolate requests) keeps only crowns whose trunk
 * base lies on that mesh within supportTolerance of the measured support.
 *
 * Budget: an explicit triangleBudget is spread over the trees in proportion to their targets (and fails when it cannot
 * give each minTrianglesPerTree); without one, each tree gets its target, scaled down to fit sceneTriangleCap, and the
 * call fails only when the minimum over all trees exceeds that cap.
 *
 * Every crown that does not regrow into its measured crown is collected; the call then fails naming each one and why.
 * (A crown strip removed is one it regrew with these parameters and seed; a failure here means plant was given others.)
 */
inline PlantResult plant(const io::GlbJsonValue& crownsDoc, const PlantParams& P,
                         const std::vector<Vec3>* supportPositions = nullptr, const std::vector<uint32_t>* supportIndices = nullptr) {
    const auto t0 = std::chrono::steady_clock::now();
    if (!(P.triangleBudget > 0) && !(P.sceneTriangleCap > 0)) throw VegetationError("bad_request", "plant needs a triangle budget, or a scene triangle cap to size one from the crowns, greater than 0");
    if (!(P.minTrianglesPerTree >= 1)) throw VegetationError("bad_request", "minTrianglesPerTree must be at least 1");
    const auto& crowns = crownsDoc["crowns"];
    if (crowns.type != io::GlbJsonValue::Array) throw VegetationError("bad_input", "crowns.json has no crowns array");
    const auto& params = crownsDoc["params"];
    const double sampleSpacing = params.type == io::GlbJsonValue::Object && params.has("sampleSpacing") && params["sampleSpacing"].type == io::GlbJsonValue::Number ? params["sampleSpacing"].num : 0.7;
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
    std::vector<CrownShape> shapes(n);
    std::vector<size_t> targets(n);
    double targetSum = 0;
    for (size_t i = 0; i < n; ++i) {
        shapes[i] = crownShapeFromJson(*chosen[i]);
        targets[i] = crownTriangleTarget(shapes[i], P);
        targetSum += static_cast<double>(targets[i]);
    }
    R.targetTriangles = static_cast<size_t>(targetSum);
    const double minTotal = P.minTrianglesPerTree * static_cast<double>(n);
    double total;
    if (P.triangleBudget > 0) {
        if (n > 0 && P.triangleBudget < minTotal) {
            std::ostringstream m;
            m << "a triangle budget of " << detail::thousands(P.triangleBudget) << " cannot hold " << detail::thousands(static_cast<double>(n)) << " trees at "
              << detail::thousands(P.minTrianglesPerTree) << " triangles each (they need at least " << detail::thousands(std::ceil(minTotal)) << ")";
            throw VegetationError("budget_too_small", m.str());
        }
        total = P.triangleBudget;
        R.budgetSource = "explicit";
    } else {
        if (n > 0 && minTotal > P.sceneTriangleCap) {
            std::ostringstream m;
            m << "the " << detail::thousands(static_cast<double>(n)) << " measured trees need at least " << detail::thousands(std::ceil(minTotal)) << " triangles at "
              << detail::thousands(P.minTrianglesPerTree) << " each, more than the scene's cap of " << detail::thousands(P.sceneTriangleCap) << " triangles for trees";
            throw VegetationError("budget_too_small", m.str());
        }
        total = std::min(targetSum, P.sceneTriangleCap);
        R.budgetSource = targetSum > P.sceneTriangleCap ? "crown_targets_capped" : "crown_targets";
    }
    R.triangleBudget = total;
    // per-tree budgets: the targets, plus a share of any budget beyond them; or, under them, the minimum plus a share of
    // what is left, in proportion to what each target asks above the minimum
    std::vector<size_t> budgets(n);
    {
        double extraSum = 0;
        for (size_t t : targets) extraSum += static_cast<double>(t) - P.minTrianglesPerTree;
        for (size_t i = 0; i < n; ++i) {
            if (total >= targetSum) {
                budgets[i] = targets[i] + static_cast<size_t>(std::floor((total - targetSum) * static_cast<double>(targets[i]) / std::max(1.0, targetSum)));
            } else {
                const double share = extraSum > 0 ? (static_cast<double>(targets[i]) - P.minTrianglesPerTree) / extraSum : 1.0 / static_cast<double>(n);
                budgets[i] = static_cast<size_t>(std::floor(P.minTrianglesPerTree + (total - minTotal) * share));
            }
        }
    }
    R.trees.resize(n);
    std::vector<std::string> errors(n);
    detail::forEachIndex(n, P.threads, [&](size_t i) {
        PlantedTree& tr = R.trees[i];
        try {
            tr.crown = chosen[i];
            tr.crownId = shapes[i].id;
            tr.target = targets[i];
            tr.budget = budgets[i];
            CrownGrowth g = growCrown(shapes[i], P.growth, sampleSpacing);
            tr.seed = g.seed;
            tr.heightAboveSupport = g.heightAboveSupport;
            tr.crownBaseY = g.crownBaseY;
            tr.trunkRadius = g.trunkRadius;
            tr.surfaceShare = g.surfaceShare();
            tr.leafTopY = g.leafTopY;
            tr.colonisation = g.colonisation;
            if (!g.ok()) {
                errors[i] = "crown " + std::to_string(tr.crownId) + ": " + g.failure + " (colonisation: " + g.colonisationSummary + ")";
                return;
            }
            g.cfg.triangleBudget = static_cast<float>(tr.budget);
            g.cfg.woodBudgetShare = static_cast<float>(P.woodShare);
            auto [wood, foliage] = nature::SpaceColonizationTreeGenerator::meshGrownSkeleton(g.cfg, g.skeleton, &tr.report);
            tr.wood = std::move(wood);
            tr.foliage = std::move(foliage);
            if (tr.foliage.indices.empty()) {
                errors[i] = "crown " + std::to_string(tr.crownId) + ": its budget of " + std::to_string(tr.budget) + " triangles holds its wood (" +
                            std::to_string(tr.report.woodTriangles) + " triangles) and no leaves";
            }
        } catch (const std::exception& e) {
            errors[i] = "crown " + std::to_string(tr.crownId) + ": " + e.what();
        }
    });
    std::vector<std::string> failed;
    for (size_t i = 0; i < n; ++i) if (!errors[i].empty()) failed.push_back(errors[i]);
    if (!failed.empty()) {
        std::ostringstream m;
        m << failed.size() << " of " << n << " trees did not regrow into their measured crowns: ";
        for (size_t k = 0; k < failed.size(); ++k) m << (k ? "; " : "") << failed[k];
        const auto& growth = crownsDoc["growth"];
        if (growth.type == io::GlbJsonValue::Object && growth["seed"].type == io::GlbJsonValue::String) {
            char seedHex[17];
            std::snprintf(seedHex, sizeof(seedHex), "%016llx", static_cast<unsigned long long>(P.growth.seed));
            if (growth["seed"].str != seedHex) m << " (the measurement kept every tree it could not regrow with seed " << growth["seed"].str << " as scanned; these were planted with seed " << seedHex << ")";
        }
        throw VegetationError("plant_failed", m.str());
    }
    for (const auto& tr : R.trees) R.triangles += (tr.wood.indices.size() + tr.foliage.indices.size()) / 3;
    if (static_cast<double>(R.triangles) > total) throw VegetationError("budget_exceeded", "trees used " + std::to_string(R.triangles) + " triangles, over the budget of " + std::to_string(static_cast<size_t>(total)));
    R.ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
    return R;
}

/**
 * One node per tree (measurements in extras, in the tile frame), studio clay. The root extras name the frame's axes, the
 * crown list's label (when it has one) and what was planted; nothing geodetic is written (no lat/lng, no localToEcef): the trees are positioned only relative to
 * the tile they were measured in, and the geodetic crown list stays in the strip's cache entry (crowns.json).
 */
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
        ex << ",\"inferred\":{\"crownBaseY\":" << json::num(tr.crownBaseY) << ",\"crownBaseRatio\":" << json::num(P.growth.crownBaseRatio)
           << ",\"trunkRadiusM\":" << json::num(tr.trunkRadius) << ",\"trunkRadiusPerHeight\":" << json::num(P.growth.trunkRadiusPerHeight) << "}"
           << ",\"crownSurfaceReached\":" << json::num(tr.surfaceShare)
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
    // root extras: the frame's axes (as the extraction named them), the request's free-text label (a top-level string
    // of the crown list; it names the trees, it never changes them) and what was planted
    const auto& frame = crownsDoc["frame"];
    std::string extras = "{";
    if (frame.type == io::GlbJsonValue::Object && frame.has("frame") && frame["frame"].type == io::GlbJsonValue::String) {
        extras += "\"frame\":" + json::write(frame["frame"]) + ",";
    }
    if (crownsDoc.has("label") && crownsDoc["label"].type == io::GlbJsonValue::String) {
        extras += "\"label\":" + json::write(crownsDoc["label"]) + ",";
    }
    extras += "\"sbVeggie\":{\"trees\":" + std::to_string(R.trees.size()) + ",\"triangles\":" + std::to_string(R.triangles) +
              ",\"triangleBudget\":" + std::to_string(static_cast<size_t>(R.triangleBudget)) + ",\"generator\":\"space colonisation\"}}";
    j += ",\"extras\":" + extras + "}";
    return gb.finish(j);
}

} // namespace tile_vegetation
} // namespace scratchbox

#endif // SCRATCHBOX_TILE_VEGETATION_HPP
