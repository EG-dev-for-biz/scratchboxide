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
 * strip: reads a photo-textured tile (x = east, y = up, z = south, metres) and measures where its tree crowns are, from
 *   three continuous kinds of evidence per triangle: photo chroma (normalised excess green ExG and ExG - ExR over
 *   texture samples, with a dark-pixel guard), local roughness (area-weighted normal dispersion over welded neighbours
 *   within a radius) and height above the terrain model. Crowns are local maxima of the canopy height model with a
 *   window that grows with height, grown by a marker-controlled watershed with a climb limit. Each crown is measured
 *   against the surface it stands on (roof or ground): the surface it touches around its footprint, reached through
 *   other canopy when it touches none. Where that surface is contradicted by the scan (much of the crown hangs below
 *   it, or under the stem the scan has nothing standable between the crown and the ground where the terrain model has
 *   it: in a continuous canopy the nearest level patches can be flat canopy tops), the crown stands on what the scan
 *   has under its stem below it, and with nothing there its ground is not measured. Crowns at least minTreeHeight above
 *   that surface are trees; a tree whose crown runs to the extraction's edge is still a tree when its apex (its
 *   local-maximum window) lies inside, and is measured up to the edge. A crown whose apex window reaches the edge is
 *   cut: its top and trunk may lie outside. Every tree is then regrown (growCrown) and meshed within its own budget
 *   before anything is removed: a tree the regrown SB-Veggie tree's delivered leaves do not fill stays as scanned
 *   (not_regrowable, with the reason), like a crown with no measured ground. Each tree that is removed goes with the
 *   scanned drape around it (the photogrammetric curtain from crown to ground, planar or not, out to drapeReach) and
 *   with pieces of its scan left hanging in the air beside it, never with walls, roofs, paving or crowns that stay. Cut
 *   canopy stays as scanned unless its side would be left standing over a hole: then it goes with the trees it joins,
 *   is reported, and is not replanted. The ground under a tree is rebuilt on the surface it stood on (level paving or
 *   roof, or ground that slopes: a hillside's slope is measured from the surfaces around the crown): every hole loop is
 *   lowered onto that surface and capped there, so no cap face climbs to where the tree was and no hole opens; a tile
 *   with no tree is left as it is, whatever its ground. Where the hole edge stands off that surface (a wall or building
 *   side the tree hid, the side of a low planting or a tree that stays) a vertical skirt continues it down, and its
 *   area and height are reported by what it continues (and, on a crown that stays, on that crown). A skirt on
 *   architecture is kept off the real wall: where the scan has a surface behind it the skirt is cut down to the part
 *   above that surface or not built (skirtDropBacked; the decisions are reported by category). Caps and skirts carry
 *   photo-inferred texels of their own (scratchbox_strip_fill.hpp: the kept scan's photo of the surface around each
 *   piece, carried across it from the nearest real texel, with a confidence that falls with the distance carried;
 *   a piece with no real neighbour takes the tile's mean colour of such surfaces and is labelled generated), never
 *   flat clay (fill false: the legacy clay primitives). Lower roof vegetation stays in the scan untouched. Writes the
 *   devegetated tile (textures kept; the fill atlas as a texture of its own, its material marked photoInferredFill so
 *   consumers that bake or measure the scan's photo do not count it), and a crown list with apex, stem, support
 *   (height, slope and where it was measured),
 *   footprint, sector radii and voxel samples of the crown surface, in the tile frame and as lat/lng (the list stays in
 *   the cache; plant writes no geodetic data).
 *
 * plant: grows one SB-Veggie tree per measured crown with the space-colonisation generator
 *   (nature::SpaceColonizationTreeGenerator), attracted to the crown's own measured samples (the same trees strip
 *   grew), meshed in studio clay within its share of the caller's triangle budget or, without one, its own budget
 *   within a scene cap. Each tree's delivered leaf masses are measured against its measured crown, and each trunk base
 *   against the model the trees are mounted on when one is given; shortfalls are reported by crown. What the scan does
 *   not observe (crown base, trunk radius) comes from explicit ratios and is reported as inferred.
 *
 * Every failure is a VegetationError with a code; nothing is substituted.
 */

#include "scratchbox_gltf_scene.hpp"
#include "scratchbox_height_field.hpp"
#include "scratchbox_io.hpp"
#include "scratchbox_nature.hpp"
#include "scratchbox_staged_glb.hpp"
#include "scratchbox_png.hpp"
#include "scratchbox_strip_fill.hpp"
#include "scratchbox_tree_lod.hpp"
#include "scratchbox_tree_species.hpp"
#include "scratchbox_tree_textures.hpp"
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
#include <memory>
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

inline uint64_t mix64(uint64_t h) { return tree_lod::mix64(h); }

inline double hashUnit(uint64_t seed, uint64_t a, uint64_t b) { return tree_lod::hashUnit(seed, a, b); }

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
// strip grows every crown it measures as a tree before it removes anything, meshes it within its own budget, and keeps
// as scanned (status not_regrowable, with the reason) each crown the regrown tree's delivered leaves do not fill; plant
// grows the same trees again, from the same crown values, parameters and seed, and meshes them within the budget it is
// given, measuring what each delivers. Both run growCrown, so what strip removed plant rebuilds.

/** How a measured crown is regrown. What the scan does not observe (crown base, trunk radius) is inferred from ratios. */
struct GrowthParams {
    double crownBaseRatio{0.35};        // crown base = support + ratio * (apex - support): not observed, inferred
    double trunkRadiusPerHeight{0.016}; // trunk radius = ratio * height: not observed, inferred
    // The caller gave crownBaseRatio (or trunkRadiusPerHeight) itself, so a matched species entry's own ratio does not
    // override it (growCrownAttempt): a caller that asks for a crown base past what any real tree can fill is asking to
    // see that failure, not to have species quietly substitute a ratio that fills it.
    bool crownBaseRatioExplicit{false};
    bool trunkRadiusPerHeightExplicit{false};
    double shellDepth{0.8};             // share of each surface sample's height above the crown base the crown fills
    double minSurfaceReached{0.9};      // share of the measured crown surface the regrown tree's leaves must reach
    // Buildings win over trees: a crown is grown no closer than this to the scanned walls it met (CrownShape::walls,
    // measured by strip): attractors and surface samples behind a wall's plane or within this of it are left out, so the
    // regrown crown stands off the facade instead of filling the building (m; 0: no clipping). 1 m: a leaf cluster's reach,
    // measured on a crown pressed to a wall (0.5 m left 0.12 % of its triangles 0.32 m into the building; 1 m none).
    double wallClearance{1.0};
    uint64_t seed{0};                   // mixed with each crown id
    // Seeded per crown (a hash of seed and crown id: the same crown grows the same tree, no two alike):
    double crownBaseSpread{0.10};       // the crown base ratio varies by +/- this, so trunks do not all fork at the same relative height
    int attempts{4};                    // trees tried (the seed varied) for a crown the first does not fill
    double trunkLeanShare{0.45};        // the trunk has leaned this share of the way to the measured apex's offset by the crown's height
    // How the tree grows and carries its leaves (continuous; no tree classes): apicalDominance sets a branch's momentum, the
    // branch angle's mean and spread the scaffold limbs' angle from the leader (the spread by +/- between crowns, by +/- half of
    // it between limbs), internodeLengthM the step along a shoot (0: from the tree's height); the rest (leaf distribution,
    // divergence, blade outline) shapes the leaf clusters plant writes.
    sb_veggie::SbVeggieMorphology morphology;
    // How firmly a crown's leader holds its course to the apex (nature::SpaceColonizationConfig::leaderHold): smoothstep of
    // the apical dominance it grows with over excurrentApical (the species library's conifers, birch, ginkgo and eucalyptus
    // at 0.6 hold fully, linden at 0.55 by 0.74, honey locust and Scots pine at 0.5 by 0.26, plane, maple, oak, olive and
    // the palms not at all: their trunks fork at the crown break). How excurrent it grows besides
    // (SpaceColonizationConfig::excurrence: laterals at the species' branch angle along the leader): (1 - smoothstep of its
    // measured top share over excurrentTopShare) x the leader hold. A pointed crown (a cone's top share is about 0.12, a
    // dome's about 0.58; the species library's conifers lie at 0.12-0.20, its broadleaves at 0.35 and over) whose leader
    // holds grows a straight stem with its laterals along it; a rounded one whose leader holds grows a stem through the
    // crown with its laterals spreading as colonisation leads them.
    double excurrentTopShareLo{0.15}, excurrentTopShareHi{0.30};
    double excurrentApicalLo{0.45}, excurrentApicalHi{0.60};
    // The tree species library (scratchbox_tree_species.hpp; null: none): each crown grows with the proportions of the
    // entry nearest its measurements (crown base, trunk radius, stems, scaffold limbs and their angle, the leader's
    // momentum, the leaf the textures are chosen by) instead of the ratios above; a crown far from every entry grows
    // with them. strip and plant must use the same library (crowns.json records which).
    std::shared_ptr<const tree_species::Library> species;
    std::string speciesIndex;           // where the library was read from, as given (recorded in crowns.json and the trees' root extras)
    tree_species::ChoiceParams speciesChoice;
    // This build's own |latitude| (CLI --lat-abs-deg; NaN when not given): costs a species entry whose own
    // latAbsRangeDeg does not reach it (scratchbox_tree_species.hpp), so a crown measured in New York does not match
    // a palm's shape alone and grow one - the climate a species needs is a measurement too, not just its proportions.
    double latAbsDeg{std::numeric_limits<double>::quiet_NaN()};
};

/**
 * A scanned wall a crown met (strip: kept wall triangles the crown's removed triangles touched, clustered by plane):
 * a point on it, its outward normal (towards the crown) and its area. The crown is regrown on the crown's side of it.
 */
struct CrownWall {
    Vec3 point, normal;
    Vec3 tangent;                 // unit, horizontal, in the wall's plane
    double halfAlongM{0}, halfUpM{0};  // the wall's extent about `point` along the tangent and up (half widths)
    double areaM2{0};
};

/** A measured crown, as crowns.json carries it (strip writes these values at full precision, so plant reads them back exactly). */
struct CrownShape {
    int id{0};
    Vec3 apex;
    double stemX{0}, stemZ{0}, supportY{0}, areaM2{0};
    std::array<double, 16> sectorRadii{};
    std::vector<Vec3> samples;
    // a crown base ratio given for this crown (a photo-inferred correction, CrownCorrection): used as is, instead of the
    // growth's ratio varied by its seeded spread; NaN: none given
    double crownBaseRatio{std::numeric_limits<double>::quiet_NaN()};
    // a trunk radius per height given for this crown (a described crown, scratchbox_sb_veggie_grove.hpp): used instead of
    // the growth's or the species entry's ratio; NaN: none given
    double trunkRadiusPerHeight{std::numeric_limits<double>::quiet_NaN()};
    // its colour in the tile's photo (measured; the species choice reads its hue), when strip measured one
    bool colourKnown{false};
    std::array<double, 3> colourMean{};
    std::vector<CrownWall> walls;   // the scanned walls it met (GrowthParams::wallClearance keeps the regrown crown off them)
};

/**
 * A correction of one measured crown's size from photos (scratchbox.crown-correction/1, written by the Street View crown
 * check, tree-crown-photo-check.ts): the tiles see a crown from above, so its top is measured but its width (where canopies
 * touch, the split between crowns) and its base (under the canopy) are not. widthScale scales the crown horizontally about
 * its centre (its surface samples' centroid); crownBaseRatio places its base at that share of its height. Provenance
 * photo-inferred; `source` says whether the tree's own photos gave it or the district median did.
 */
struct CrownCorrection {
    double widthScale{1.0};
    double crownBaseRatio{std::numeric_limits<double>::quiet_NaN()};
    std::string source;
};

/** Applies a crown correction to a measured crown: samples and sector radii about the crown's centre, area by the square. */
inline void applyCrownCorrection(CrownShape& c, const CrownCorrection& k) {
    const double s = std::clamp(k.widthScale, 0.25, 4.0);
    if (std::abs(s - 1.0) > 1e-9 && !c.samples.empty()) {
        double cx = 0, cz = 0;
        for (const auto& p : c.samples) { cx += p.x; cz += p.z; }
        cx /= static_cast<double>(c.samples.size());
        cz /= static_cast<double>(c.samples.size());
        for (auto& p : c.samples) {
            p.x = static_cast<float>(cx + (p.x - cx) * s);
            p.z = static_cast<float>(cz + (p.z - cz) * s);
        }
        c.apex.x = static_cast<float>(cx + (c.apex.x - cx) * s);
        c.apex.z = static_cast<float>(cz + (c.apex.z - cz) * s);
        for (auto& r : c.sectorRadii) r *= s;
        c.areaM2 *= s * s;
    }
    if (std::isfinite(k.crownBaseRatio)) c.crownBaseRatio = std::clamp(k.crownBaseRatio, 0.0, 0.95);
}

/** One crown regrown: the skeleton, how it was grown, and whether it fills the measured crown (and if not, why not). */
struct CrownGrowth {
    uint32_t seed{0};
    double heightAboveSupport{0}, crownBaseY{0}, trunkRadius{0};
    double crownBaseRatio{0};           // this crown's (the ratio varied by the seeded spread)
    double trunkRadiusPerHeight{0};     // the ratio its trunk radius came from (the species entry's, else the growth's)
    double attractorSpacing{0};         // voxel of the attractor cloud (m)
    // the species entry it grew with (GrowthParams::species): hasSpecies false without a library; species.matched false
    // when the crown is far from every entry (grown with the growth's own ratios, the measurements still recorded)
    bool hasSpecies{false};
    tree_species::Choice species;
    int stems{1};                       // stems leaving the ground (more than one: grown as a shrub)
    double topShare{0};                 // its measured crown's top share (tree_species::describeCrown)
    double excurrence{0};               // how excurrent it grew (GrowthParams::excurrentTopShare / excurrentApical)
    double leaderHold{0};               // how firmly its leader held its course to the apex (GrowthParams::excurrentApical)
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
    std::vector<Vec3> surface;          // the measured surface samples above the crown base (what the leaves must reach)
    size_t surfaceMassesNeeded{0};      // leaf masses the meshing needs to bring all of it it can within reachRadius
    // buildings win over trees (GrowthParams::wallClearance): walls the crown was kept off, and the attractors and
    // surface samples that lay behind them or within the clearance, left out of the growth
    size_t wallsClipped{0}, attractorsClipped{0}, attractorsTotal{0}, surfaceClipped{0};
    // the height the leaves must reach: the measured apex, or, when the clip took the surface samples at the apex (the
    // crown's top lay against the wall), the top of the surface samples that remain
    double apexTargetY{0};
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

/**
 * `,"species":{...}` of a crown (crowns.json) or a tree (its extras): the crown's measured descriptors, the species entry
 * chosen by them (none when the crown is far from every entry) and the proportions it grew with. Nothing without a library.
 */
inline std::string crownSpeciesMembers(bool hasSpecies, const tree_species::Choice& ch, int stems, double crownBaseRatio, double trunkRadiusPerHeight, const GrowthParams& G) {
    if (!hasSpecies || !G.species) return std::string();
    const auto& d = ch.measured;
    std::string o = ",\"species\":{\"measured\":{\"heightM\":" + json::num(d.heightM) + ",\"meanRadiusM\":" + json::num(d.meanRadiusM) + ",\"aspect\":" + json::num(d.aspect) +
                    ",\"topShare\":" + json::num(d.topShare) + ",\"depthM\":" + json::num(d.depthM) + ",\"samples\":" + std::to_string(d.samples) +
                    (d.colourKnown ? ",\"hueDeg\":" + json::num(d.hueDeg) + ",\"saturation\":" + json::num(d.saturation) : std::string()) + ",\"provenance\":\"measured\"}";
    if (ch.matched) {
        const auto& e = G.species->entries[ch.entry];
        o += ",\"entry\":" + json::str(e.id) + ",\"label\":" + json::str(e.label) + ",\"cost\":" + json::num(ch.cost) + ",\"provenance\":\"library\"";
    } else {
        o += ",\"entry\":null,\"cost\":" + json::num(ch.cost) + ",\"provenance\":\"unmatched\"";
    }
    return o + ",\"grownWith\":{\"stems\":" + std::to_string(stems) + ",\"crownBaseRatio\":" + json::num(crownBaseRatio) + ",\"trunkRadiusPerHeight\":" + json::num(trunkRadiusPerHeight) + "}}";
}


} // namespace detail

/**
 * Grows one SB-Veggie tree (space colonisation) into a measured crown and checks that it fills it.
 *
 * Attractors are the crown volume under the measured surface: each surface sample above the (inferred) crown base and,
 * below it, layers down by shellDepth of its height above the crown base, on a voxel grid scaled to the crown (fine
 * enough for its width and its depth, never finer than the measurement's sample spacing calls for). Every growth
 * distance follows from the crown and that spacing: the step from the tree's height, the kill radius from the step and
 * the attractor spacing, the perception radius from the step and the attractor spacing plus the kill reach (a node that
 * reached an attractor must still see across the gap to its neighbours); the trunk grows on past the inferred crown
 * base until the measured crown is in sight (a tall crown seen only from above can begin well above it), and
 * colonisation stops when it has reached every attractor, sees none, or has reached none for as many iterations as it
 * takes to cross the perception radius twice.
 *
 * The tree grew into its crown when its leaf nodes (foliageAnchors: the tips, twigs and branches through the crown the
 * meshing has at any budget) lie within reachRadius of at least minSurfaceReached of the measured surface samples above
 * the crown base, and reach the apex height to within reachRadius. That is the skeleton; what its meshed leaves reach
 * within a budget is measured on the mesh (meshCrown), and strip removes a tree only when both do.
 */
inline CrownGrowth growCrownAttempt(const CrownShape& c, const GrowthParams& G, double sampleSpacing, int attempt) {
    CrownGrowth g;
    g.seed = detail::crownSeed(G.seed ^ (static_cast<uint64_t>(attempt) * 0x9E3779B97F4A7C15ull), c.id);
    const double support = c.supportY;
    const double H = std::max(0.5, static_cast<double>(c.apex.y) - support);
    g.heightAboveSupport = H;
    // the proportions it grows with: the growth's ratios, or the species entry nearest its measurements (the choice is
    // seeded by the crown alone, so every attempt grows the same species)
    double baseRatio = G.crownBaseRatio, trunkPerHeight = G.trunkRadiusPerHeight;
    double apical = G.morphology.apicalDominance, branchAngle = G.morphology.branchAngleMeanRad;
    int scaffold = 0;
    if (G.species) {
        auto d = tree_species::describeCrown(c.apex, support, c.sectorRadii, c.samples, c.colourKnown ? &c.colourMean : nullptr, G.speciesChoice);
        d.latAbsDeg = G.latAbsDeg;
        g.hasSpecies = true;
        g.species = tree_species::choose(*G.species, d, detail::crownSeed(G.seed, c.id), G.speciesChoice);
        if (g.species.matched) {
            const auto& e = G.species->entries[g.species.entry];
            if (!G.crownBaseRatioExplicit) baseRatio = e.crownBaseRatio;
            if (!G.trunkRadiusPerHeightExplicit) trunkPerHeight = e.trunkRadiusPerHeight;
            apical = e.apicalDominance;
            branchAngle = e.branchAngleRad;
            scaffold = e.scaffoldBranches;
            g.stems = e.stems;
        }
    }
    if (std::isfinite(c.trunkRadiusPerHeight)) trunkPerHeight = c.trunkRadiusPerHeight;
    g.crownBaseRatio = std::isfinite(c.crownBaseRatio) ? c.crownBaseRatio
                                                       : std::clamp(baseRatio + G.crownBaseSpread * (2.0 * detail::hashUnit(g.seed, 9001, 1) - 1.0), 0.0, 0.9999);
    g.crownBaseY = support + g.crownBaseRatio * H;
    g.trunkRadiusPerHeight = trunkPerHeight;
    g.trunkRadius = trunkPerHeight * H;
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
    g.attractorsTotal = attractors.size();
    if (G.wallClearance > 0 && !c.walls.empty()) {
        // buildings win over trees: nothing of the crown is grown behind a scanned wall it met, or within the clearance of
        // it, over the wall's own extent (grown by the clearance): a low garden wall or a short return clips what stands
        // against it, not the whole crown
        auto behind = [&](const Vec3& q) {
            for (const auto& w : c.walls) {
                const Vec3 d = q - w.point;
                if (static_cast<double>(d.dot(w.normal)) >= G.wallClearance) continue;
                if (std::abs(static_cast<double>(d.dot(w.tangent))) > w.halfAlongM + G.wallClearance) continue;
                if (std::abs(static_cast<double>(d.y)) > w.halfUpM + G.wallClearance) continue;
                return true;
            }
            return false;
        };
        std::vector<Vec3> keptA, keptS;
        for (const auto& a : attractors) { if (behind(a)) ++g.attractorsClipped; else keptA.push_back(a); }
        for (const auto& v : surface) { if (behind(v)) ++g.surfaceClipped; else keptS.push_back(v); }
        if (g.attractorsClipped || g.surfaceClipped) g.wallsClipped = c.walls.size();
        attractors.swap(keptA);
        surface.swap(keptS);
    }
    g.apexTargetY = c.apex.y;
    if (g.surfaceClipped && !surface.empty()) {
        double top = -std::numeric_limits<double>::infinity();
        for (const auto& v : surface) top = std::max(top, static_cast<double>(v.y));
        g.apexTargetY = std::min(g.apexTargetY, top);
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
    // a narrow crown (mean radius under a quarter of its height) gets proportionally finer growth: with the step, kill and
    // perception radii a wider crown needs, its attractors lie inside the trunk's own reach and the tree is a bare pole
    const double narrow = std::clamp(radius / (0.25 * H), 0.4, 1.0);
    const double step = std::max(0.12, (G.morphology.internodeLengthM > 0.0f ? static_cast<double>(G.morphology.internodeLengthM) : std::clamp(H / 40.0, 0.2, 0.6)) * narrow);
    cfg.branchStepLength = static_cast<float>(step);
    cfg.trunkLeanToward = c.apex;
    cfg.trunkLeanShare = static_cast<float>(G.trunkLeanShare);
    cfg.scaffoldBranchCount = scaffold > 0 ? scaffold : 2 + static_cast<int>(std::floor(detail::hashUnit(g.seed, 9002, 1) * 3.0));
    cfg.scaffoldAngleFromLeaderRad = static_cast<float>(branchAngle) + static_cast<float>(G.morphology.branchAngleSpreadRad * (2.0 * detail::hashUnit(g.seed, 9003, 1) - 1.0));
    cfg.scaffoldAngleSpreadRad = 0.5f * G.morphology.branchAngleSpreadRad;
    cfg.growthMomentumFactor = 0.76f * static_cast<float>(apical);
    {
        // a tree whose leader holds (its apical dominance) grows its leader on through the crown to the apex; a pointed
        // crown's grows excurrent besides, the laterals along it at the species' angle
        auto smooth = [](double lo, double hi, double x) { const double t = std::clamp((x - lo) / std::max(1e-9, hi - lo), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); };
        g.topShare = tree_species::describeCrown(c.apex, support, c.sectorRadii, c.samples, nullptr, G.speciesChoice).topShare;
        g.leaderHold = smooth(G.excurrentApicalLo, G.excurrentApicalHi, apical);
        g.excurrence = (1.0 - smooth(G.excurrentTopShareLo, G.excurrentTopShareHi, g.topShare)) * g.leaderHold;
        cfg.leaderHold = static_cast<float>(g.leaderHold);
        cfg.excurrence = static_cast<float>(g.excurrence);
        cfg.leaderTopY = static_cast<float>(g.apexTargetY);
    }
    // stems from the ground: the trunk forks just above the root collar and the scaffold limbs are the stems
    cfg.isShrub = g.stems > 1;
    if (cfg.isShrub) cfg.scaffoldBranchCount = std::max(cfg.scaffoldBranchCount, g.stems);
    // A node that reaches an attractor (comes within the kill reach, 1.25 x the kill radius, of it) must still see the
    // attractors next to that one: the gap between neighbouring attractors (the link) plus the kill reach. With the
    // link alone, a branch that reached an attractor could lose sight of the ones beyond it and colonisation stop with
    // reachable attractors left, on some seeds and not others (Central Park crown 1139: 21 attractors stranded inside
    // one connected cloud with the tile's seed, none with five other seeds).
    cfg.killRadius = static_cast<float>(std::max(1.6 * step, 0.9 * g.attractorSpacing));
    cfg.perceptionRadius = static_cast<float>(std::max(5.5 * step, 3.0 * g.attractorSpacing) + 1.25 * cfg.killRadius);
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
    // the meshing puts its first leaf masses where they bring this surface within the same reach (meshCrown)
    g.surface = std::move(surface);
    cfg.foliageSurface = g.surface;
    cfg.foliageSurfaceReach = static_cast<float>(g.reachRadius);
    cfg.foliageTop = static_cast<float>(g.apexTargetY);
    g.surfaceMassesNeeded = nature::SpaceColonizationTreeGenerator::surfaceMassesNeeded(cfg, g.skeleton);
    if (g.surfaceShare() < G.minSurfaceReached) {
        g.failureCode = "crown_not_reached";
        g.failure = "the regrown tree's leaves reach " + detail::fixed(100.0 * g.surfaceShare(), 0) + "% of its measured crown surface (" +
                    std::to_string(g.surfaceReached) + " of " + std::to_string(g.surfaceSamples) + " samples within " + detail::fixed(g.reachRadius, 1) +
                    " m; " + detail::fixed(100.0 * G.minSurfaceReached, 0) + "% needed)";
    } else if (g.leafTopY + g.reachRadius < g.apexTargetY) {
        g.failureCode = "apex_not_reached";
        g.failure = "the regrown tree's leaves reach " + detail::fixed(g.leafTopY - support, 1) + " m above its ground, short of its measured " +
                    detail::fixed(H, 1) + " m";
    }
    return g;
}

/**
 * Grows the tree of a crown: the seeded growth of growCrownAttempt, and when it does not fill the measured crown, up to
 * GrowthParams::attempts - 1 more with the seed varied (a different tree of the same crown, still a pure function of the
 * crown, the seed and the parameters, so strip and plant grow the same one). The first that fills the crown is the tree; when
 * none does, the one that reached most of it, whose failure says why.
 */
inline CrownGrowth growCrown(const CrownShape& c, const GrowthParams& G, double sampleSpacing) {
    CrownGrowth best = growCrownAttempt(c, G, sampleSpacing, 0);
    for (int attempt = 1; attempt < std::max(1, G.attempts) && !best.ok() && best.failureCode != "no_crown_above_base"; ++attempt) {
        CrownGrowth next = growCrownAttempt(c, G, sampleSpacing, attempt);
        if (next.ok() || next.surfaceShare() > best.surfaceShare()) best = std::move(next);
    }
    return best;
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
    // a described crown (scratchbox_sb_veggie_grove.hpp) carries the crown base and trunk ratio its description gave
    if (c["crownBaseRatio"].type == io::GlbJsonValue::Number) s.crownBaseRatio = std::clamp(c["crownBaseRatio"].num, 0.0, 0.95);
    if (c["trunkRadiusPerHeight"].type == io::GlbJsonValue::Number && c["trunkRadiusPerHeight"].num > 0) s.trunkRadiusPerHeight = c["trunkRadiusPerHeight"].num;
    const auto& col = c["colour"]["meanLinearRgb"];
    if (col.type == io::GlbJsonValue::Array && col.arr.size() == 3 && col[0].type == io::GlbJsonValue::Number) {
        s.colourKnown = true;
        for (size_t k = 0; k < 3; ++k) s.colourMean[k] = std::max(0.0, col[k].num);
    }
    for (const auto& w : c["walls"].arr) {
        if (w["point"].arr.size() != 3 || w["normal"].arr.size() != 3 || w["tangent"].arr.size() != 3) continue;
        CrownWall cw;
        cw.point = Vec3(static_cast<float>(w["point"][0].num), static_cast<float>(w["point"][1].num), static_cast<float>(w["point"][2].num));
        cw.normal = Vec3(static_cast<float>(w["normal"][0].num), static_cast<float>(w["normal"][1].num), static_cast<float>(w["normal"][2].num));
        cw.tangent = Vec3(static_cast<float>(w["tangent"][0].num), static_cast<float>(w["tangent"][1].num), static_cast<float>(w["tangent"][2].num));
        cw.halfAlongM = w["halfAlongM"].asFloat(0.0f);
        cw.halfUpM = w["halfUpM"].asFloat(0.0f);
        cw.areaM2 = w["areaM2"].asFloat(0.0f);
        s.walls.push_back(cw);
    }
    return s;
}

// ============================================================================================
// meshing a regrown tree within a budget, and what its delivered leaves reach
// ============================================================================================

struct PlantParams {
    // Total triangles all trees may use together (> 0): the caller's own budget, spread over the trees (see plant). 0: the
    // budget comes from the measured trees: each tree's own budget (crownOwnBudget), all of them within sceneTriangleCap
    // (the caller's viewport cap for the trees of one scene; tile-vegetation-service.ts SCENE_TREE_TRIANGLE_CAP says why
    // it is what it is).
    double triangleBudget{0};
    double sceneTriangleCap{0};
    double minTrianglesPerTree{120};
    // A tree's target: about one 20-triangle leaf mass per 3 m x 3 m of its crown envelope (the measured footprint
    // plus the side, mean radius x 2 pi x crown depth), with the wood's 40 % on top: 20 / 9 / 0.6 = 3.7, rounded to 4.
    double trianglesPerCrownM2{4.0};
    GrowthParams growth;             // the measurement's own (crowns.json "growth") when it recorded them
    double woodShare{0.4};
    double supportTolerance{0.3};    // isolate: the trunk base must hit the support mesh within this (m)
    double groundTolerance{0.5};     // with a ground mesh: a trunk base further than this from it is reported (m)
    int threads{0};
    // the trees GLB: KHR_mesh_quantization (positions to within maxQuantizationErrorM, measured on the written file; see
    // scratchbox_staged_glb.hpp), and the staged-build stage key written into its root extras (run-independent: the
    // caller's cache key for this planting)
    bool quantize{true};
    double maxQuantizationErrorM{0.01};
    std::string stageKey;
    // each tree's growth order on its vertices (`_REVEAL`); off, the meshes are the same and carry no attribute
    bool reveal{true};
    // Level of detail (scratchbox_tree_lod.hpp): every tree is written at four levels on its one skeleton, 0 near (wood with
    // the whole budget, twigs and leaf clusters instanced), 1 near-mid (the same wood without twigs, the same cluster positions,
    // a share of the leaves with the near outline, each larger), 2 mid (the same cluster positions, fewer larger leaves as
    // cards), 3 far (the blob masses meshCrown builds, whose budget decides what strip removes). Off, a tree is the blob level alone.
    bool lod{true};
    double psiSeason{1.0};           // 0 bare .. 1 full summer: scales leaf density at every level
    tree_lod::LodParams treeLod;     // leaf size, cluster and station parameters (psiSeason is copied in)
    // The distances (m from the camera) at which a viewport changes level, per tree, each a multiple of its height within a
    // range: near up to lodNearPerHeight x height (within [lodNearMinM, lodNearMaxM]), near-mid up to lodNearMidPerHeight x
    // height (within [lodNearMidMinM, lodNearMidMaxM]), mid up to lodFarPerHeight x height (within [lodFarMinM, lodFarMaxM]),
    // far beyond. Stretched 2026-10-21 (user decision: high-quality trees across the whole scene, not just close up) past the
    // leaf-resolvability edges this file used to hold to (a leaf dropping under 3-4 px at a 1,000 px focal length, 12-30 m for
    // 8-14 cm blades): the near-mid and mid (crown-card) levels already read as full trees from a distance at a fraction of
    // near's triangle cost, so the stretch leans on them, holding the true high-poly near level to a more modest reach.
    // fadeM is the width of the band over which two levels dither into each other.
    double lodNearPerHeight{1.15}, lodNearMinM{14.0}, lodNearMaxM{35.0};
    double lodNearMidPerHeight{6.5}, lodNearMidMinM{30.0}, lodNearMidMaxM{120.0};
    double lodFarPerHeight{9.0}, lodFarMinM{100.0}, lodFarMaxM{190.0};
    double lodFadeM{7.0};
    double lodNearMidFadeShare{0.2}; // the near-mid to mid handover dissolves over this share of its distance (at least lodFadeM)
    double lodFarFadeShare{0.25};    // the mid to far handover dissolves over this share of its distance (at least lodFadeM)
    /**
     * A tree whose stem lies inside this polygon (tile frame, x east z south, metres; fewer than 3 points: no hero area,
     * the default) ignores the near/near-mid/mid distance bands above and holds full (near) quality at any distance a
     * staged scene's camera realistically reaches (heroFullQualityM). The viewport's own GPU-adaptive triangle budget is
     * untouched and stays free to demote it under real load like any other tree: this removes the authored distance
     * cutoff only, never the runtime performance safety net.
     */
    std::vector<std::array<double, 2>> heroPolygon;
    double heroFullQualityM{3000.0};
    // The tree texture library (scratchbox_tree_textures.hpp; null: none): each tree's leaf set and bark are chosen from it
    // by appearance, its wood carries UVs in the chosen bark's tiles, and the choice and tints are in its extras.
    std::shared_ptr<const tree_textures::Library> textures;
    std::string textureIndex;        // where the library was read from, as given (written to the root extras)
    tree_textures::ChoiceParams textureChoice;
    // Photo-inferred crown corrections by crown id (CrownCorrection), applied to each crown before it is grown; empty: none.
    std::unordered_map<int, CrownCorrection> crownCorrections;
    std::string crownCorrectionMethod;   // how they were made (written into each corrected tree's extras)
};

/** The triangles a crown's size asks for (see PlantParams::trianglesPerCrownM2), never fewer than minTrianglesPerTree. */
inline size_t crownTriangleTarget(const CrownShape& c, const PlantParams& P) {
    double r = 0;
    for (double v : c.sectorRadii) r += v / 16.0;
    const double baseRatio = std::isfinite(c.crownBaseRatio) ? c.crownBaseRatio : P.growth.crownBaseRatio;
    const double depth = std::max(0.0, (1.0 - baseRatio) * (static_cast<double>(c.apex.y) - c.supportY));
    const double envelope = std::max(0.0, c.areaM2) + 2.0 * M_PI * r * depth;
    return static_cast<size_t>(std::max(P.minTrianglesPerTree, std::ceil(P.trianglesPerCrownM2 * envelope)));
}

/** Triangles a tree's budget needs for its foliage (at least 1 - woodShare of it) to hold `masses` 20-triangle leaf masses. */
inline size_t trianglesForLeafMasses(size_t masses, double woodShare) {
    return static_cast<size_t>(std::ceil(20.0 * static_cast<double>(masses) / std::max(0.05, 1.0 - woodShare)));
}

/**
 * The triangles a regrown tree is meshed within when no budget is given (its own budget): its crown's target, and never
 * fewer than its leaf masses on the measured surface need (CrownGrowth::surfaceMassesNeeded). strip checks every tree it
 * removes at this budget, so plant, given no budget and room under its cap, delivers the tree strip checked.
 */
inline size_t crownOwnBudget(const CrownShape& c, const CrownGrowth& g, const PlantParams& P) {
    return std::max(crownTriangleTarget(c, P), std::max(static_cast<size_t>(std::ceil(P.minTrianglesPerTree)), trianglesForLeafMasses(g.surfaceMassesNeeded, P.woodShare)));
}

/** What a meshed tree's leaf masses reach of its measured crown surface, and how high they go. */
struct FoliageReach {
    size_t samples{0}, reached{0};
    double topY{-std::numeric_limits<double>::infinity()};
    double share() const { return samples ? static_cast<double>(reached) / static_cast<double>(samples) : 0.0; }
};

namespace detail {

/**
 * The height cluster a tree stands on, from the heights of the surfaces around it sorted ascending (clusters split where
 * two neighbouring heights differ by more than `step`): the lowest cluster that holds at least a quarter of them, else
 * (when they spread over more clusters than that, none holding a quarter) the largest, the lowest of equals. Returns
 * [first index, count]; the count is 0 only when there are no heights.
 */
inline std::pair<size_t, size_t> supportCluster(const std::vector<float>& sortedY, double step) {
    size_t quarterLo = 0, quarterN = 0, bigLo = 0, bigN = 0, lo = 0;
    for (size_t i = 1; i <= sortedY.size(); ++i) {
        if (i == sortedY.size() || sortedY[i] - sortedY[i - 1] > step) {
            const size_t n = i - lo;
            if (quarterN == 0 && 4 * n >= sortedY.size()) { quarterN = n; quarterLo = lo; }
            if (n > bigN) { bigN = n; bigLo = lo; }
            lo = i;
        }
    }
    return quarterN > 0 ? std::pair<size_t, size_t>{quarterLo, quarterN} : std::pair<size_t, size_t>{bigLo, bigN};
}

/** Distance from p to triangle abc (closest point). */
inline double pointTriangleDistance(const Vec3& p, const Vec3& a, const Vec3& b, const Vec3& c) { return tree_lod::pointTriangleDistance(p, a, b, c); }

/** Ray o + t d (t > 0) against triangle abc: t at the hit, or -1. */
inline double rayTriangle(const Vec3& o, const Vec3& d, const Vec3& a, const Vec3& b, const Vec3& c) {
    const Vec3 e1 = b - a, e2 = c - a, pv = d.cross(e2);
    const float det = e1.dot(pv);
    if (std::abs(det) < 1e-12f) return -1;
    const float inv = 1.0f / det;
    const Vec3 tv = o - a;
    const float u = tv.dot(pv) * inv;
    if (u < -1e-6f || u > 1.0f + 1e-6f) return -1;
    const Vec3 qv = tv.cross(e1);
    const float v = d.dot(qv) * inv;
    if (v < -1e-6f || u + v > 1.0f + 1e-6f) return -1;
    const float t = e2.dot(qv) * inv;
    return t > 0 ? t : -1;
}

} // namespace detail

/**
 * Measures delivered foliage: `foliage` holds `masses` leaf masses of equal vertex and triangle count, one after the
 * other (as the budgeted meshing writes them; each a star around its vertices' centroid). A surface sample is reached
 * when it lies inside a mass (along the ray from that centroid) or within `reach` of one of its triangles.
 */
inline FoliageReach measureFoliage(const geometry::Mesh& foliage, size_t masses, const std::vector<Vec3>& surface, double reach) {
    FoliageReach out;
    out.samples = surface.size();
    if (masses == 0 || foliage.vertices.empty() || foliage.vertices.size() % masses != 0 || foliage.indices.size() % (3 * masses) != 0) return out;
    const size_t vpc = foliage.vertices.size() / masses, tpc = foliage.indices.size() / 3 / masses;
    std::vector<Vec3> centre(masses);
    std::vector<float> extent(masses, 0.0f);
    float largest = 0.0f;
    for (size_t k = 0; k < masses; ++k) {
        Vec3 c(0, 0, 0);
        for (size_t v = 0; v < vpc; ++v) c += foliage.vertices[k * vpc + v];
        centre[k] = c / static_cast<float>(vpc);
        for (size_t v = 0; v < vpc; ++v) {
            const Vec3& p = foliage.vertices[k * vpc + v];
            extent[k] = std::max(extent[k], (p - centre[k]).length());
            out.topY = std::max(out.topY, static_cast<double>(p.y));
        }
        largest = std::max(largest, extent[k]);
    }
    const double cell = std::max(1e-3, static_cast<double>(largest) + reach);
    auto key = [&](const Vec3& p, int dx, int dy, int dz) {
        const int64_t a = static_cast<int64_t>(std::floor(p.x / cell)) + dx, b = static_cast<int64_t>(std::floor(p.y / cell)) + dy, c = static_cast<int64_t>(std::floor(p.z / cell)) + dz;
        return (static_cast<uint64_t>(a & 0x1FFFFF) << 42) | (static_cast<uint64_t>(b & 0x1FFFFF) << 21) | static_cast<uint64_t>(c & 0x1FFFFF);
    };
    std::unordered_map<uint64_t, std::vector<uint32_t>> grid;
    for (uint32_t k = 0; k < masses; ++k) grid[key(centre[k], 0, 0, 0)].push_back(k);
    for (const auto& s : surface) {
        bool reached = false;
        for (int dz = -1; dz <= 1 && !reached; ++dz) {
            for (int dy = -1; dy <= 1 && !reached; ++dy) {
                for (int dx = -1; dx <= 1 && !reached; ++dx) {
                    auto it = grid.find(key(s, dx, dy, dz));
                    if (it == grid.end()) continue;
                    for (uint32_t k : it->second) {
                        if (static_cast<double>((s - centre[k]).length()) > static_cast<double>(extent[k]) + reach) continue;
                        double nearest = std::numeric_limits<double>::infinity(), along = -1.0;
                        for (size_t t = 0; t < tpc; ++t) {
                            const uint32_t* id = &foliage.indices[(k * tpc + t) * 3];
                            const Vec3 &a = foliage.vertices[id[0]], &b = foliage.vertices[id[1]], &c = foliage.vertices[id[2]];
                            nearest = std::min(nearest, detail::pointTriangleDistance(s, a, b, c));
                            along = std::max(along, detail::rayTriangle(centre[k], s - centre[k], a, b, c));
                        }
                        if (nearest <= reach || along >= 1.0) { reached = true; break; }
                    }
                }
            }
        }
        out.reached += reached ? 1 : 0;
    }
    return out;
}

/** A regrown tree meshed within a budget, and what its delivered leaves reach of its measured crown. */
struct MeshedCrown {
    geometry::Mesh wood, foliage;
    nature::TreeBudgetReport report;
    FoliageReach reach;
    /** Its leaves reach minSurfaceReached of the measured crown surface, and the apex height to within the reach. */
    bool fills(const CrownGrowth& g, const CrownShape& c, double minSurfaceReached) const {
        return reach.share() >= minSurfaceReached && reach.topY + g.reachRadius >= static_cast<double>(c.apex.y);
    }
    /** Why it does not (empty when it does). */
    std::string shortfall(const CrownGrowth& g, const CrownShape& c, double minSurfaceReached, size_t budget) const {
        std::ostringstream m;
        if (foliage.indices.empty()) {
            m << "its budget of " << budget << " triangles holds its wood (" << report.woodTriangles << " triangles) and no leaves";
        } else if (reach.share() < minSurfaceReached) {
            m << "within its budget of " << budget << " triangles its " << report.foliageClumps << (report.foliageClumps == 1 ? " leaf mass reaches " : " leaf masses reach ")
              << detail::fixed(std::floor(1000.0 * reach.share()) / 10.0, 1)
              << "% of its measured crown surface (" << reach.reached << " of " << reach.samples << " samples within " << detail::fixed(g.reachRadius, 1) << " m; "
              << detail::fixed(100.0 * minSurfaceReached, 0) << "% needed; " << report.surfaceMasses << " of the " << report.surfaceMassesNeeded
              << " masses that reach it fit)";
        } else if (reach.topY + g.reachRadius < g.apexTargetY) {
            m << "within its budget of " << budget << " triangles its leaves reach " << detail::fixed(reach.topY - c.supportY, 1) << " m above its ground, "
              << detail::fixed(g.apexTargetY - reach.topY, 1) << " m short of its measured " << detail::fixed(g.apexTargetY - c.supportY, 1) << " m"
              << (g.surfaceClipped ? " (the crown's top against the wall left out)" : "");
        }
        return m.str();
    }
};

/**
 * Meshes a regrown tree (growCrown) within `budget` triangles and measures what its delivered leaves reach. With `growth`,
 * also when each vertex grew (nature::MeshGrowth); the meshes are the same with or without it.
 */
inline MeshedCrown meshCrown(const CrownGrowth& g, size_t budget, double woodShare, nature::MeshGrowth* growth = nullptr) {
    MeshedCrown m;
    nature::SpaceColonizationConfig cfg = g.cfg;
    cfg.triangleBudget = static_cast<float>(budget);
    cfg.woodBudgetShare = static_cast<float>(woodShare);
    auto [wood, foliage] = nature::SpaceColonizationTreeGenerator::meshGrownSkeleton(cfg, g.skeleton, &m.report, growth);
    m.wood = std::move(wood);
    m.foliage = std::move(foliage);
    m.reach = measureFoliage(m.foliage, m.report.foliageClumps, g.surface, g.reachRadius);
    return m;
}

// ============================================================================================
// strip
// ============================================================================================

struct StripParams {
    double cell{0.5};                // surface model cell (m)
    double terrainCell{4.0};         // terrain model cell (m)
    double terrainRadius{40.0};      // terrain opening radius (m)
    double crownColourTrim{0.1};     // a crown's colour leaves out this share of its darkest and of its brightest cells
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
    // Two touching crowns are one when the lower one's top rises less than this above the highest saddle between them
    // (one crown's surface with two bumps, not two trees) (m).
    double minTopProminence{0.5};
    double supportStep{1.0};         // height gap separating candidate support surfaces (m)
    double supportSearch{25.0};      // how far to look through canopy for a surface to stand on (m)
    // A crown more of whose measured surface than this share lies over supportStep below the surface measured around it
    // hangs below that surface: it is not what the tree stands on (in a continuous canopy the nearest level patches can be
    // flat canopy tops), so its ground is not measured and it is kept as scanned (no_measured_ground).
    double maxCrownBelowSupport{0.1};
    // A crown at a raised level whose footprint shows no surface there is regrown from a lower surface only while the bare
    // trunk that needs stays within this many crown depths (a street tree beside a terrace); longer, it would pass through
    // the structure (a roof garden over a hollow building mesh) and the crown is kept as scanned.
    double maxBareTrunkPerCrownDepth{3.0};
    // A standable surface under a crown's stem within this of the terrain model is the ground (m).
    double groundTerrainBand{2.0};
    // A surface the scan shows under a crown is its ground only when at least this share of the vertical lines through
    // its footprint meet it, one of them in the inner half of the footprint (around the stem).
    double minSupportEvidence{0.2};
    // After the ground under the removed trees is rebuilt, a trunk base further than this from the surface rebuilt (or
    // kept) under its stem is off the ground the trees are mounted on (m): within supportBand it stands on that surface
    // (re-checked: it must still regrow into its crown), beyond it its support is undecided and it stays as scanned.
    double groundTolerance{0.5};
    int groundPasses{6};             // removal passes at most while trees are kept as scanned between them
    // Where trees may be measured and regrown (a polygon in the tile frame, x east and z south; empty: everywhere). A tree
    // whose stem lies outside it is neither regrown nor removed: its canopy stays as scanned (status outside_roi).
    std::vector<std::array<double, 2>> roi;
    // The structure the caller isolates, as a cell raster in the tile frame (empty: none): its raised, roofed cells that
    // are not canopy. Removal treats every triangle standing on them as architecture, so taking a tree out beside a
    // building never takes the building's roof or walls with it as drape (the structure the pick decided stays as scanned).
    struct KeepCells { double x0{0}, z0{0}, cell{1}; int nx{0}, nz{0}; std::vector<uint8_t> flags; } keep;
    double footprintDilation{1.0};  // everything under the apex this far beyond the crown footprint goes with the tree (m)
    double drapeReach{10.0};          // the scanned drape connected to a tree goes with it out to this far from its crown (m)
    double clearance{0.3};           // removal stops this high above the support (m)
    double supportBand{1.5};         // a tree's cap never lies further than this from its measured support (m)
    double skirtMin{0.3};            // boundary points higher than this above the cap get a skirt down (m)
    double fragmentMaxArea{300.0};   // a kept piece left hanging beside a removal, touching neither ground nor a wall or
                                     // roof, goes with the tree when it is no larger than this (m^2)
    double capGrid{1.5};             // spacing of interior cap points (m)
    // Photo-inferred fill of the caps and skirts (scratchbox_strip_fill.hpp). fill false: the legacy flat clay primitives.
    bool fill{true};
    double fillTexel{0.1};           // texel of the fill (m); coarser only to keep the atlas within fillAtlasMaxPx
    int fillAtlasMaxPx{4096};        // longest side of the fill atlas
    double fillContext{2.0};         // the real scan is read this far beyond a piece (m)
    double fillSurfaceTol{0.35};     // a kept surface within this of a texel's place is the real surface there (m) ...
    double fillNormalCos{0.6};       // ... when it faces the way the piece does (|n . n of the piece| at least this)
    double fillConfidenceScale{3.0}; // carried this far from a real texel the fill's confidence is 1/e (m)
    // A skirt hanging on architecture (a wall, the edge of a roof) is a panel pasted over a real wall where the scan has a
    // surface behind it: a kept, not-vegetation surface facing like the skirt within skirtBackedReach of its plane. Where
    // that surface rises from the skirt's foot (a band backed in every column, at least skirtMin tall), the skirt is cut
    // down to the part above it; a skirt backed to within skirtMin of its top, or over at least skirtBackedShare of its face
    // with no such band, is not built. One with nothing real behind it is kept whole and filled.
    bool skirtDropBacked{true};
    double skirtBackedReach{0.4};    // m
    double skirtBackedShare{0.5};
    // Buildings win over trees: a triangle the removal would take that lies on a kept building surface (within
    // facadeGuard of the plane of a kept wall or level surface it touches, facing like it, |cos| at least facadeGuardCos)
    // is building, whatever the classifier called it, and stays; the cut stops at the facade. 0: off.
    double facadeGuard{0.15};
    double facadeGuardCos{0.9};      // (walls only: level surfaces are measured, not put back; see guardBuildings)
    double seamGap{1.0};             // hole boundaries broken by an open tile seam are joined across gaps up to this (m)
    double sampleSpacing{0.7};       // voxel size of the crown surface samples (m)
    GrowthParams growth;             // how each tree crown is regrown before anything is removed (see growCrown)
    int threads{0};
};

/**
 * One surface the scan shows under a crown, below every measured sample of it, facing up and not canopy (not vegetation,
 * and smoother than the tile's own vegetation): where a trunk could stand. Heights are taken to the stem along the slope of the
 * surface measured around the crown (level when none was).
 */
struct UnderSurface {
    double yAtStem{0};            // median height of its hits, continued to the stem
    double lo{0}, hi{0};          // the range of those heights
    size_t probes{0};             // footprint probes with a hit on it
    size_t innerProbes{0};        // ... of them in the inner half of the footprint (around the stem)
    double coverage{0};           // probes / every probe
    double tiltX{0}, tiltZ{0};    // its gradient (median of its hit triangles')
    bool stemHit{false};          // the vertical line through the stem meets it
};

/** What the scan shows under a crown: vertical lines through its footprint (its cells, subsampled, and its stem). */
struct SupportEvidence {
    size_t probes{0}, innerProbes{0};
    std::vector<UnderSurface> surfaces;   // ascending height
};

struct CrownRecord {
    int id{0};
    // tree | below_min_height | no_measured_ground (no standable surface around it, or one its own crown hangs below:
    // kept as scanned) | not_regrowable (a tree the regrown SB-Veggie tree does not fill, kept as scanned) |
    // cut_at_boundary (kept as scanned) | cut_at_boundary_removed (taken with the trees it joins, not replanted) |
    // outside_roi (a tree whose stem lies outside the strip's region of interest: not regrown, kept as scanned)
    std::string status;
    std::string groundReasonCode, groundReason;  // no_measured_ground: why (diagnostic label, and in words)
    bool reachesBoundary{false};     // a tree whose crown runs to the extraction's edge: measured (and rebuilt) up to it
    Vec3 apex;
    double stemX{0}, stemZ{0};
    double supportY{0};              // the support surface's height at the stem
    double tiltX{0}, tiltZ{0};       // its gradient (dy/dx, dy/dz) around the crown
    std::string supportSource;       // surrounding_surface | under_footprint (shown under it, agreeing with the surface around it) |
                                     // under_stem (shown under it instead of the surface around it) | none (not measured) |
                                     // undecided (the ground rebuilt under its stem did not hold its trunk: kept as scanned)
    std::string supportNote;         // under_stem: why the surrounding surface was not taken
    SupportEvidence evidence;        // what the scan shows under the crown (footprint and stem)
    double surroundingY{std::numeric_limits<double>::quiet_NaN()};  // the surface measured around it at the stem (NaN: none)
    // after the ground under removed trees is rebuilt: the rebuilt (or kept) surface at the stem the trunk stands on
    bool groundChecked{false};
    double groundAtStemY{std::numeric_limits<double>::quiet_NaN()};
    double supportMovedM{0};          // the support was moved this far onto the surface rebuilt under the stem (within supportBand)
    double terrainY{0};
    double apexAboveSupport{0};
    double areaM2{0};
    std::array<double, 16> sectorRadii{};
    std::vector<Vec3> samples;
    int cells{0};
    // the crown's colour in the tile's photo (measureCrownColour): linear sRGB mean and spread of its trimmed cells, and
    // the season cues (share of green cells, hue and chroma of the mean)
    bool colourKnown{false};
    std::array<double, 3> colourMean{}, colourSpread{};
    size_t colourSamples{0}, colourCells{0};
    double greenShare{std::numeric_limits<double>::quiet_NaN()}, hueDeg{0}, chroma{0};
    bool hasGeodetic{false};
    TileFrame::Geodetic apexGeo{}, stemGeo{};
    // the regrowth check (trees and not_regrowable crowns): how much of the measured surface the regrown leaves reach
    bool regrowthChecked{false};
    double regrowthSurfaceShare{0}, regrowthReachM{0}, regrowthLeafTopY{0};
    size_t regrowthSurfaceSamples{0}, regrowthSurfaceReached{0};
    std::string regrowthFailureCode, regrowthFailure, regrowthColonisation;
    // the species entry the regrowth chose by the crown's measurements (GrowthParams::species), and the proportions it grew with
    bool hasSpecies{false};
    tree_species::Choice species;
    int regrowthStems{1};
    double regrowthCrownBaseRatio{0}, regrowthTrunkRadiusPerHeight{0};
    // ... and the tree meshed within its own budget (crownOwnBudget): what its delivered leaf masses reach
    bool regrowthMeshed{false};
    size_t regrowthBudget{0}, regrowthLeafMasses{0}, regrowthSurfaceMasses{0}, regrowthSurfaceMassesNeeded{0}, regrowthLeavesReached{0};
    double regrowthLeavesShare{0}, regrowthLeavesTopY{0};
    std::vector<CrownWall> walls;    // the scanned walls its removed triangles touched (measureCrownWalls); plant keeps the regrown crown off them
    // a crown kept as scanned beside removed trees: its side over their rebuilt ground, closed down to it (skirt triangles
    // hung on its canopy, not in the scan)
    double keptSkirtAreaM2{0}, keptSkirtTopY{-std::numeric_limits<double>::infinity()}, keptSkirtBottomY{std::numeric_limits<double>::infinity()};
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
    // what each skirt category (walls, level surfaces, kept canopy, other: as skirtArea*) did with its skirts: built whole
    // (kept), cut down to the part the real scan has no surface behind (shortened: the area taken off), or not built because
    // the real scan has the surface behind it (dropped, skirtDropBacked), by count of skirt quads (one per hole-edge segment)
    // and area; and the open edges the dropped ones leave on the kept triangles above them. skirtArea* above count what was
    // built.
    struct SkirtDecision { size_t count{0}; double areaM2{0}; };
    std::array<SkirtDecision, 4> skirtKept{}, skirtShortened{}, skirtDropped{};
    size_t openEdgesAtDroppedSkirts{0};
    double capAreaM2{0};             // what the caps cover (m^2, their own faces)
    // The fill of caps and skirts (StripParams::fill): what each kind covered, and how its texels were sourced
    struct FillKind { size_t pieces{0}, piecesUnsourced{0}, piecesWidened{0}; double areaM2{0}, areaUnsourcedM2{0}, areaWidenedM2{0}; strip_fill::FillCounts counts; };
    struct FillDegradation { std::string code, kind, reason; double areaM2{0}; std::array<double, 3> centre{}; };
    bool fillEnabled{false};
    FillKind fillCap, fillSkirt;
    double fillTexelM{0};
    int fillAtlasW{0}, fillAtlasH{0};
    size_t fillPngBytes{0};
    double fillGeneratedColourRgb[3]{0, 0, 0};   // the colour of pieces with no real neighbour (sRGB 0..1)
    std::vector<FillDegradation> fillDegradations;
    // Buildings win over trees (guardBuildings): triangles the removal took that lie on a kept building surface (on a
    // wall, on a level surface), before and after the guard put them back, what it put back, and the removed triangles
    // that only meet a kept surface along an edge (the crease where a crown meets a wall, roof or anything else: crown, not
    // building; counted so the join is visible)
    struct GuardCounts { size_t onWalls{0}, onLevelSurfaces{0}; };
    GuardCounts guardBefore, guardAfter;
    double guardM{0}, guardCos{0};
    size_t guardKeptAsBuilding{0};
    double guardKeptAsBuildingM2{0};
    size_t creaseOnWalls{0}, creaseOnLevelSurfaces{0}, creaseOnOther{0};
    size_t crownsWithWalls{0}, crownWalls{0};  // crowns whose removed triangles touched scanned walls, and the walls measured (CrownRecord::walls)
    double canopyTakenWithTreesM2{0}; // canopy outside the tree crowns removed with them (their drape, fragments): not replanted
    size_t fragmentsTaken{0};        // pieces of a tree's scan left hanging in the air beside its removal, taken with it
    double fragmentAreaTakenM2{0};
    size_t drapeSheets{0};           // planar sheets of the drape taken with the trees (not walls: nothing planar at their top)
    double drapeSheetAreaM2{0};
    double canopyAreaM2{0}, treeCanopyAreaM2{0};
    size_t crownsTree{0}, crownsLow{0}, crownsCut{0}, crownsCutRemoved{0}, crownsTooSmall{0}, crownsNoGround{0};
    size_t crownsNotRegrowable{0};   // trees the regrown SB-Veggie tree does not fill: kept as scanned (see growCrown)
    size_t crownsHangingBelowSupport{0}; // of crownsNoGround: those whose crown hangs below the surface measured around it
    size_t crownsRaisedLevelNotShown{0}; // of crownsNoGround: a crown at a raised level (a roof) the scan does not show under it
    size_t crownsSupportedUnderStem{0};  // trees standing on the surface the scan shows under their footprint and stem, not the one around them
    size_t crownsSupportedUnderFootprint{0}; // trees standing on the surface shown under their footprint, which agrees with the one around them
    size_t crownsOutsideRoi{0};          // trees whose stem lies outside the region of interest: not regrown, kept as scanned
    size_t crownsSupportUndecided{0};    // of crownsNoGround: trees whose trunk base the rebuilt ground under the stem did not hold (kept as scanned)
    size_t groundPasses{0};              // removal passes run (trunks re-stood or trees kept between them)
    size_t trunksRestood{0};             // trunks stood on the ground rebuilt under their stem (within supportBand of their support)
    size_t trunksOffRebuiltGround{0};    // after the last pass: removed trees whose trunk base is further than groundTolerance from it
    size_t treesReachingBoundary{0}; // trees whose crown runs to the extraction's edge (their apex is inside it)
    double cutCanopyRemovedM2{0};    // canopy of cut crowns taken with the trees it joined (not replanted)
    size_t keepCells{0};             // cells of the structure the caller keeps (P.keep)
    size_t keptStructureTriangles{0}; // triangles on them that removal would not otherwise treat as architecture: kept as the structure's
    std::array<double, 3> greenDispersionQuartiles{}, otherDispersionQuartiles{};
    std::vector<std::pair<std::string, double>> ms;
};

struct StripResult {
    std::vector<CrownRecord> crowns;
    StripStats stats;
    std::vector<uint8_t> devegetatedGlb;
    // what the removal took, as scanned, one node per crown that took it (staged trees layer l5x): mounted when the tree
    // stage fails, so the scanned trees are put back rather than leaving their ground empty
    std::vector<uint8_t> removedGlb;
    size_t removedNodes{0};
    texture::ImageBuffer topDown;
    double topDownX0{0}, topDownZ0{0}, topDownCell{1};  // pixel (i, k) covers x0 + i * cell, z0 + k * cell
    TileFrame frame;
};

/**
 * strip's canopy classification (CanopyMask in staged-location-contracts.ts): cell (i, k) covers
 * [x0 + i cellM, x0 + (i + 1) cellM) x [z0 + k cellM, z0 + (k + 1) cellM) of the tile frame; mask row-major (k * nx + i).
 */
struct CanopyMaskResult {
    double cellM{0}, x0{0}, z0{0};
    int nx{0}, nz{0};
    std::vector<uint8_t> mask;
    size_t canopyCells{0};
    double ms{0};
};

/** CanopyMask JSON: the mask as run lengths over k * nx + i, alternating not canopy / canopy, the first run not canopy. */
inline std::string canopyMaskJson(const CanopyMaskResult& m) {
    std::ostringstream s;
    s << "{\"schema\":\"scratchbox.canopy-mask/1\",\"cellM\":" << json::numPrecise(m.cellM) << ",\"x0\":" << json::numPrecise(m.x0) << ",\"z0\":" << json::numPrecise(m.z0)
      << ",\"nx\":" << m.nx << ",\"nz\":" << m.nz << ",\"runs\":[";
    uint8_t current = 0;
    size_t run = 0, k = 0;
    for (uint8_t c : m.mask) {
        const uint8_t v = c ? 1 : 0;
        if (v != current) { s << (k++ ? "," : "") << run; run = 0; current = v; }
        ++run;
    }
    s << (k++ ? "," : "") << run << "],\"canopyCells\":" << m.canopyCells << ",\"ms\":" << json::num(m.ms) << "}\n";
    return s.str();
}

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
        for (const auto& h : hitsAt(x, z)) out.push_back(h.first);
        return out;
    }

    /** Each surface the vertical line meets: its height and the triangle (index / 3 into the indices). */
    std::vector<std::pair<double, uint32_t>> hitsAt(double x, double z) const {
        std::vector<std::pair<double, uint32_t>> out;
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
            out.emplace_back(w0 * A.y + w1 * B.y + w2 * C.y, t);
        }
        return out;
    }
};

} // namespace detail

class TileVegetation {
public:
    using Clock = std::chrono::steady_clock;

    static StripResult strip(const std::vector<uint8_t>& glb, const StripParams& P, bool wantTopDown) {
        TileVegetation tv(P);
        return tv.run(glb, wantTopDown);
    }

    /**
     * The cells strip's own classifier calls canopy (read, weld, chroma, roughness, planar segments, height fields: the
     * stages strip runs before it measures a crown), on the surface model at P.cell; nothing is regrown or removed.
     */
    static CanopyMaskResult canopyMask(const std::vector<uint8_t>& glb, const StripParams& P) {
        TileVegetation tv(P);
        return tv.runCanopy(glb);
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
    std::vector<std::array<float, 3>> triRgb;  // the photo's mean colour over the triangle (linear sRGB; NaN where untextured)
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
    detail::VerticalProbe weldProbe;   // the welded scan under a vertical line (built when a crown's support needs it)
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
        removeAndCapOnGround();
        lap("remove_and_cap");
        measureCrownWalls();
        buildFill();
        lap("fill");
        writeDevegetated();
        writeRemoved();
        lap("write");
        if (wantTopDown) drawTopDown();
        return std::move(R);
    }

    CanopyMaskResult runCanopy(const std::vector<uint8_t>& glb) {
        const auto start = Clock::now();
        t0 = start;
        scene = gltf::GlbSceneReader::parse(glb.data(), glb.size());
        if (!scene.ok) throw VegetationError("bad_input", "cannot read the tile: " + scene.error);
        for (size_t i = 0; i < scene.images.size(); ++i) {
            const auto& im = scene.images[i];
            if (!im.decoded) throw VegetationError("texture_decode", "photo texture " + std::to_string(i) + " could not be decoded: " + (im.error.empty() ? std::string("unknown error") : im.error));
        }
        pos.resize(scene.mesh.vertices.size());
        for (size_t v = 0; v < pos.size(); ++v) pos[v] = scene.mesh.vertices[v].position;
        idx = scene.mesh.indices;
        T = idx.size() / 3;
        weldAndAdjacency();
        measureChroma();
        if (R.stats.texturedTriangles == 0) throw VegetationError("no_photo_texture", "the tile has no photo-textured triangles to measure vegetation from");
        measureRoughness();
        measurePlanarSegments();
        for (size_t t = 0; t < T; ++t) veg[t] = chromaVeg[t] && dispersion[t] >= P.roughnessMin && !surface[t];
        rasters();
        CanopyMaskResult out;
        const auto& g = surf.top;
        out.cellM = g.cell;
        out.x0 = g.x0;
        out.z0 = g.z0;
        out.nx = g.nx;
        out.nz = g.nz;
        out.mask = canopy;
        for (uint8_t c : canopy) out.canopyCells += c ? 1 : 0;
        out.ms = std::chrono::duration<double, std::milli>(Clock::now() - start).count();
        return out;
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
        triRgb.assign(T, {std::numeric_limits<float>::quiet_NaN(), 0.0f, 0.0f});
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
                {
                    // the triangle's colour, decoded to linear light (the photo is sRGB-encoded)
                    auto lin = [](double c) { return c <= 0.04045 ? c / 12.92 : std::pow((c + 0.055) / 1.055, 2.4); };
                    triRgb[t] = {static_cast<float>(lin(s[0])), static_cast<float>(lin(s[1])), static_cast<float>(lin(s[2]))};
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

    /**
     * The crown's colour in the tile's photo: the colours (linear sRGB) of the top triangles over its footprint cells, the
     * darkest and brightest crownColourTrim of them by luminance left out (deep shadow, glints), their mean and standard
     * deviation; and the season cues they imply: the share of its cells whose chroma passes the vegetation test (green
     * leaf cover), the mean's hue and chroma.
     */
    void measureCrownColour(const CrownWork& w, CrownRecord& rec) const {
        const auto& g = surf.top;
        std::vector<std::array<float, 3>> cols;
        size_t green = 0, judged = 0;
        for (size_t c : w.cells) {
            const int t = surf.topTriangle[c];
            if (t < 0 || std::isnan(triRgb[static_cast<size_t>(t)][0])) continue;
            cols.push_back(triRgb[static_cast<size_t>(t)]);
            if (!std::isnan(exg[static_cast<size_t>(t)])) { ++judged; green += chromaVeg[static_cast<size_t>(t)] ? 1 : 0; }
        }
        (void)g;
        if (cols.size() < 3) return;
        auto Y = [](const std::array<float, 3>& c) { return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
        std::sort(cols.begin(), cols.end(), [&](const auto& a, const auto& b) { return Y(a) < Y(b); });
        const size_t cut = static_cast<size_t>(std::floor(P.crownColourTrim * static_cast<double>(cols.size())));
        const size_t lo = std::min(cut, cols.size() / 2 - 1), hi = cols.size() - lo;
        double m[3] = {0, 0, 0}, v[3] = {0, 0, 0};
        for (size_t i = lo; i < hi; ++i) for (int k = 0; k < 3; ++k) m[k] += cols[i][static_cast<size_t>(k)];
        const double n = static_cast<double>(hi - lo);
        for (int k = 0; k < 3; ++k) m[k] /= n;
        for (size_t i = lo; i < hi; ++i) for (int k = 0; k < 3; ++k) v[k] += (cols[i][static_cast<size_t>(k)] - m[k]) * (cols[i][static_cast<size_t>(k)] - m[k]);
        rec.colourKnown = true;
        for (int k = 0; k < 3; ++k) { rec.colourMean[static_cast<size_t>(k)] = m[k]; rec.colourSpread[static_cast<size_t>(k)] = std::sqrt(v[k] / n); }
        rec.colourSamples = hi - lo;
        rec.colourCells = cols.size();
        rec.greenShare = judged ? static_cast<double>(green) / static_cast<double>(judged) : std::numeric_limits<double>::quiet_NaN();
        // hue (degrees, 0 red, 120 green) and chroma of the mean, in linear light
        const double mx = std::max({m[0], m[1], m[2]}), mn = std::min({m[0], m[1], m[2]}), d = mx - mn;
        double h = 0;
        if (d > 1e-9) {
            if (mx == m[0]) h = 60.0 * std::fmod((m[1] - m[2]) / d, 6.0);
            else if (mx == m[1]) h = 60.0 * ((m[2] - m[0]) / d + 2.0);
            else h = 60.0 * ((m[0] - m[1]) / d + 4.0);
            if (h < 0) h += 360.0;
        }
        rec.hueDeg = h;
        rec.chroma = mx > 1e-9 ? d / mx : 0.0;
    }

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
        // A fixed local-maximum window gives one crown two markers when its top has two bumps further apart than the
        // window: touching crowns whose lower top rises less than minTopProminence above their highest saddle are one
        // crown whose lower top rises less than minTopProminence above their highest saddle are one crown
        {
            const size_t M = tops.size();
            std::vector<int> root(M);
            std::iota(root.begin(), root.end(), 0);
            std::function<int(int)> find = [&](int x) { while (root[x] != x) x = root[x] = root[root[x]]; return x; };
            std::vector<float> top(M);
            for (size_t m = 0; m < M; ++m) top[m] = smoothChm[tops[m]];
            std::map<std::pair<int, int>, float> saddle;  // highest min(height) over cells of the two crowns that touch
            for (int k = 0; k < g.nz; ++k) {
                for (int i = 0; i < g.nx; ++i) {
                    const size_t c = g.id(i, k);
                    if (label[c] < 0) continue;
                    for (int s = 0; s < 2; ++s) {  // right and down neighbours cover every touching pair once
                        const int a = i + (s == 0), b = k + (s == 1);
                        if (!g.in(a, b)) continue;
                        const size_t j = g.id(a, b);
                        if (label[j] < 0 || label[j] == label[c]) continue;
                        const std::pair<int, int> key = std::minmax(label[c], label[j]);
                        const float h = std::min(smoothChm[c], smoothChm[j]);
                        auto it = saddle.find(key);
                        if (it == saddle.end() || h > it->second) saddle[key] = h;
                    }
                }
            }
            std::vector<std::pair<float, std::pair<int, int>>> edges;
            for (const auto& [key, h] : saddle) edges.push_back({h, key});
            std::sort(edges.begin(), edges.end(), [](const auto& x, const auto& y) { return x.first > y.first || (x.first == y.first && x.second < y.second); });
            for (const auto& [h, key] : edges) {
                int ra = find(key.first), rb = find(key.second);
                if (ra == rb) continue;
                if (top[ra] < top[rb] || (top[ra] == top[rb] && ra > rb)) std::swap(ra, rb);  // ra holds the higher top
                if (top[rb] - h < P.minTopProminence) root[rb] = ra;
            }
            for (size_t c = 0; c < N; ++c) if (label[c] >= 0) label[c] = find(label[c]);
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
     * and meshes it within its own budget (crownOwnBudget: what plant gives it without a budget of the caller's) before
     * anything is removed. A crown the regrown tree's leaf nodes, or its delivered leaf masses, do not fill is not that
     * tree: it stays as scanned (status not_regrowable, with the reason), exactly as a crown with no measured ground
     * does, and nothing is removed, capped or planted for it.
     */
    void checkRegrowth() {
        std::vector<size_t> trees;
        for (size_t i = 0; i < R.crowns.size(); ++i) {
            if (R.crowns[i].status == "tree") trees.push_back(i);
        }
        regrowAndDemote(trees);
    }

    /** Regrows the given crowns (record indices) and keeps as scanned each one the regrown tree does not fill. */
    void regrowAndDemote(const std::vector<size_t>& trees) {
        detail::forEachIndex(trees.size(), P.threads, [&](size_t k) {
            CrownRecord& rec = R.crowns[trees[k]];
            rec.regrowthMeshed = false;
            rec.regrowthFailureCode.clear();
            rec.regrowthFailure.clear();
            CrownShape shape;
            shape.id = rec.id;
            shape.apex = rec.apex;
            shape.stemX = rec.stemX;
            shape.stemZ = rec.stemZ;
            shape.supportY = rec.supportY;
            shape.areaM2 = rec.areaM2;
            shape.sectorRadii = rec.sectorRadii;
            shape.samples = rec.samples;
            shape.colourKnown = rec.colourKnown;
            shape.colourMean = rec.colourMean;
            const CrownGrowth g = growCrown(shape, P.growth, P.sampleSpacing);
            rec.regrowthChecked = true;
            rec.hasSpecies = g.hasSpecies;
            rec.species = g.species;
            rec.regrowthStems = g.stems;
            rec.regrowthCrownBaseRatio = g.crownBaseRatio;
            rec.regrowthTrunkRadiusPerHeight = g.trunkRadiusPerHeight;
            rec.regrowthSurfaceSamples = g.surfaceSamples;
            rec.regrowthSurfaceReached = g.surfaceReached;
            rec.regrowthSurfaceShare = g.surfaceShare();
            rec.regrowthReachM = g.reachRadius;
            rec.regrowthLeafTopY = g.leafTopY;
            rec.regrowthFailureCode = g.failureCode;
            rec.regrowthFailure = g.failure;
            rec.regrowthColonisation = g.colonisationSummary;
            rec.regrowthSurfaceMassesNeeded = g.surfaceMassesNeeded;
            if (!g.ok()) return;
            // the tree as plant delivers it without a budget of the caller's: meshed within its own budget, its leaf masses
            // must reach the crown as its leaf nodes do
            PlantParams sizing;
            sizing.growth = P.growth;
            const size_t budget = crownOwnBudget(shape, g, sizing);
            const MeshedCrown m = meshCrown(g, budget, sizing.woodShare);
            rec.regrowthMeshed = true;
            rec.regrowthBudget = budget;
            rec.regrowthLeafMasses = m.report.foliageClumps;
            rec.regrowthSurfaceMasses = m.report.surfaceMasses;
            rec.regrowthLeavesReached = m.reach.reached;
            rec.regrowthLeavesShare = m.reach.share();
            rec.regrowthLeavesTopY = m.reach.topY;
            if (!m.fills(g, shape, P.growth.minSurfaceReached)) {
                rec.regrowthFailureCode = "leaves_short_of_crown";
                rec.regrowthFailure = "the regrown tree's leaves reach its crown, but " + m.shortfall(g, shape, P.growth.minSurfaceReached, budget);
            }
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

    /** Whether (x, z) lies inside the strip's region of interest (always, without one). */
    bool insideRoi(double x, double z) const {
        const auto& poly = P.roi;
        if (poly.size() < 3) return true;
        bool inside = false;
        for (size_t i = 0, j = poly.size() - 1; i < poly.size(); j = i++) {
            const double xi = poly[i][0], zi = poly[i][1], xj = poly[j][0], zj = poly[j][1];
            if ((zi > z) != (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
        }
        return inside;
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

    /**
     * What the scan shows under a crown: vertical lines through its footprint (its cells, every k-th so at most
     * kEvidenceProbes, and its stem) meet the welded scan. A hit counts when it lies below every measured sample of the
     * crown, faces up within the standable limit (an underside, such as the bottom of a canopy shell or a deck, faces
     * down) and is not canopy (not a vegetation face, and smoother than the tile's own vegetation: below its lower
     * normal-dispersion quartile; a level patch inside a canopy is as rough as the canopy). Hits are taken to the stem along
     * the slope of the surface measured around the crown (`tilted`: level otherwise) and grouped into surfaces where they
     * lie within supportStep of each other; each surface says what share of the lines meet it, how many of them in the
     * inner half of the footprint, and whether the line through the stem does.
     */
    static constexpr size_t kEvidenceProbes = 96;
    SupportEvidence measureSupportEvidence(const CrownWork& w, const CrownRecord& rec, bool tilted) {
        const auto& g = surf.top;
        SupportEvidence ev;
        if (!weldProbe.p) weldProbe.build(weldPos, wtri);
        float lowest = std::numeric_limits<float>::infinity();
        for (const auto& s : rec.samples) lowest = std::min(lowest, s.y);
        std::vector<size_t> cells(w.cells.begin(), w.cells.end());
        std::sort(cells.begin(), cells.end());
        const size_t stride = std::max<size_t>(1, (cells.size() + kEvidenceProbes - 1) / kEvidenceProbes);
        struct ProbePoint { double x, z; bool inner, stem; };
        std::vector<ProbePoint> pts;
        pts.push_back({rec.stemX, rec.stemZ, true, true});
        for (size_t k = 0; k < cells.size(); k += stride) {
            const size_t c = cells[k];
            const int i = static_cast<int>(c % static_cast<size_t>(g.nx)), kk = static_cast<int>(c / static_cast<size_t>(g.nx));
            const double x = g.cx(i), z = g.cz(kk);
            const double dx = x - rec.stemX, dz = z - rec.stemZ;
            const int s = static_cast<int>(std::floor((std::atan2(dz, dx) + M_PI) / (2 * M_PI) * 16.0)) & 15;
            pts.push_back({x, z, std::hypot(dx, dz) <= 0.5 * rec.sectorRadii[static_cast<size_t>(s)], false});
        }
        const double tx = tilted ? rec.tiltX : 0.0, tz = tilted ? rec.tiltZ : 0.0;
        const double smoothLimit = std::max(P.roughnessMin, R.stats.greenDispersionQuartiles[0]);
        struct Hit { double y; uint32_t probe; uint32_t tri; };
        std::vector<Hit> hits;
        for (uint32_t pi = 0; pi < pts.size(); ++pi) {
            const auto& pp = pts[pi];
            ev.probes += 1;
            ev.innerProbes += pp.inner ? 1 : 0;
            for (const auto& [y, t] : weldProbe.hitsAt(pp.x, pp.z)) {
                if (!(y < static_cast<double>(lowest))) continue;
                if (normal[t].y < kStandableNormalY) continue;
                // smoother than this tile's own vegetation (its lower roughness quartile): canopy is never ground, however
                // level and planar a patch of it looks
                if (veg[t] || !(dispersion[t] < smoothLimit)) continue;
                hits.push_back({y - tx * (pp.x - rec.stemX) - tz * (pp.z - rec.stemZ), pi, t});
            }
        }
        std::sort(hits.begin(), hits.end(), [](const Hit& a, const Hit& b) { return a.y < b.y || (a.y == b.y && (a.probe < b.probe || (a.probe == b.probe && a.tri < b.tri))); });
        for (size_t i = 0; i < hits.size();) {
            size_t j = i + 1;
            while (j < hits.size() && hits[j].y - hits[j - 1].y <= P.supportStep) ++j;
            UnderSurface s;
            s.lo = hits[i].y;
            s.hi = hits[j - 1].y;
            std::vector<double> ys, gx, gz;
            std::vector<uint8_t> seen(pts.size(), 0);
            for (size_t k = i; k < j; ++k) {
                ys.push_back(hits[k].y);
                const Vec3& n = normal[hits[k].tri];
                gx.push_back(-static_cast<double>(n.x) / n.y);
                gz.push_back(-static_cast<double>(n.z) / n.y);
                if (seen[hits[k].probe]) continue;
                seen[hits[k].probe] = 1;
                ++s.probes;
                s.innerProbes += pts[hits[k].probe].inner ? 1 : 0;
                s.stemHit = s.stemHit || pts[hits[k].probe].stem;
            }
            auto median = [](std::vector<double>& v) {
                std::nth_element(v.begin(), v.begin() + static_cast<long>(v.size() / 2), v.end());
                return v[v.size() / 2];
            };
            s.yAtStem = median(ys);
            s.tiltX = median(gx);
            s.tiltZ = median(gz);
            s.coverage = static_cast<double>(s.probes) / static_cast<double>(pts.size());
            ev.surfaces.push_back(s);
            i = j;
        }
        return ev;
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
            std::vector<float> ys(samples.size());
            for (size_t i = 0; i < samples.size(); ++i) ys[i] = samples[i].y;
            const auto [bestLo, bestN] = detail::supportCluster(ys, P.supportStep);
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
        // sector radii (16 sectors around the stem) and voxel samples of the crown surface
        measureCrownColour(w, rec);
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

        // What the scan shows under this crown (its footprint and its stem): the surfaces a trunk could stand on, below
        // every measured sample of the crown, facing up and not canopy, with the share of the footprint that shows each.
        rec.evidence = measureSupportEvidence(w, rec, !samples.empty());
        // The surface the footprint shows (minSupportEvidence of its lines, one of them in its inner half) that the trunk
        // stands on: the surface measured around the crown, where the footprint shows it continuing under the crown (a
        // roof garden over the street a hollow building mesh still holds under the roof, a plaza); otherwise the one under
        // the stem, else the one most of the footprint shows (a crown over canopy tops, a mound above the path around it).
        const UnderSurface* shown = nullptr;
        if (!samples.empty()) {
            for (const auto& s : rec.evidence.surfaces) {
                if (s.innerProbes < 1 || s.coverage < P.minSupportEvidence || std::abs(s.yAtStem - rec.supportY) > P.supportBand) continue;
                if (!shown || std::abs(s.yAtStem - rec.supportY) < std::abs(shown->yAtStem - rec.supportY)) shown = &s;
            }
        }
        if (!shown) {
            for (const auto& s : rec.evidence.surfaces) {
                if (s.innerProbes < 1 || s.coverage < P.minSupportEvidence) continue;
                if (!shown || (s.stemHit != shown->stemHit ? s.stemHit : (s.coverage != shown->coverage ? s.coverage > shown->coverage : s.yAtStem > shown->yAtStem))) shown = &s;
            }
        }
        // `instead`: the surface around it was not what it stands on (or there was none); otherwise the surface shown under
        // it agrees with the one around it within supportBand and only says more exactly where the trunk stands
        auto standOnShown = [&](const UnderSurface& s, const std::string& why, bool instead) {
            rec.supportY = s.yAtStem;
            rec.tiltX = s.tiltX;
            rec.tiltZ = s.tiltZ;
            clampTilt(rec);
            rec.supportSource = instead ? "under_stem" : "under_footprint";
            rec.supportNote = why + "; it stands on the surface the scan shows under " + detail::fixed(100.0 * s.coverage, 0) + "% of its footprint" +
                              (s.stemHit ? " and under its stem" : " and around its stem") + ", below its crown, at " + detail::fixed(s.yAtStem, 1) + " m";
            if (instead) ++R.stats.crownsSupportedUnderStem; else ++R.stats.crownsSupportedUnderFootprint;
        };

        // Nothing standable around it within supportSearch (ground steeper than the standable limit, or all canopy) and
        // nothing shown under it: the ground it stands on is not measured. The terrain model is a morphological opening of
        // the scan and reads low on slopes, convex ground and near the extraction's edge, so it is not taken as that
        // ground: the crown is kept as scanned and reported (status no_measured_ground), and nothing is removed, capped or
        // planted for it.
        bool groundMeasured = !samples.empty();
        if (!groundMeasured) {
            if (shown) {
                groundMeasured = true;
                standOnShown(*shown, "no surface gentle enough to stand on lies within " + detail::fixed(P.supportSearch, 0) + " m around it", true);
            } else {
                rec.groundReasonCode = "no_standable_surface";
                rec.groundReason = "no surface gentle enough to stand on within " + detail::fixed(P.supportSearch, 0) + " m of it, and none shown under its crown";
            }
        } else {
            rec.supportY = std::min(rec.supportY, static_cast<double>(rec.apex.y));
            rec.surroundingY = rec.supportY;
            // A crown does not hang below the ground it stands on. When much of it does, the surfaces measured around it
            // are not that ground (in a continuous canopy the nearest level patches can be flat canopy tops).
            float lowest = std::numeric_limits<float>::infinity();
            size_t below = 0;
            for (const auto& smp : rec.samples) {
                lowest = std::min(lowest, smp.y);
                below += smp.y < rec.supportY - P.supportStep ? 1 : 0;
            }
            const double hangs = rec.samples.empty() ? 0.0 : static_cast<double>(below) / static_cast<double>(rec.samples.size());
            // The trunk stands on what the scan shows under this crown's footprint and stem. When the surface measured
            // around it is not what lies under it (a canopy top, a path below a mound, a street beside a terrace), the
            // surface shown under it is its ground; when they agree within the support band, the surface around it is.
            // A crown standing at the level of the raised surface around it (it does not hang below it) whose footprint
            // shows no surface at that level, only one so far below that the bare trunk would be more than
            // maxBareTrunkPerCrownDepth crown depths (a roof garden whose roof the scan replaced with the planting, over a
            // hollow building mesh), is not regrown from that lower surface: the trunk would pass through the structure.
            // It is kept as scanned, with the reason.
            const double crownDepth = static_cast<double>(rec.apex.y) - static_cast<double>(lowest);
            if (shown && hangs <= P.maxCrownBelowSupport && shown->yAtStem < rec.supportY - P.supportBand &&
                static_cast<double>(lowest) - shown->yAtStem > P.maxBareTrunkPerCrownDepth * crownDepth) {
                groundMeasured = false;
                rec.groundReasonCode = "raised_level_not_under_it";
                rec.groundReason = "its crown stands at the level of the surface measured around it (" + detail::fixed(rec.supportY, 1) + " m), but the scan shows no surface at that level under it, only one at " +
                                   detail::fixed(shown->yAtStem, 1) + " m, " + detail::fixed(static_cast<double>(lowest) - shown->yAtStem, 1) + " m below its crown (more than " + detail::fixed(P.maxBareTrunkPerCrownDepth, 0) + " times its crown's depth, " +
                                   detail::fixed(crownDepth, 1) + " m): a trunk to that surface would pass through the structure it stands on, so it is kept as scanned";
                ++R.stats.crownsRaisedLevelNotShown;
            } else if (shown) {
                const std::string why = std::abs(shown->yAtStem - rec.supportY) <= P.supportBand
                    ? "the surface measured around it lies at " + detail::fixed(rec.supportY, 1) + " m"
                    : hangs > P.maxCrownBelowSupport
                    ? detail::fixed(100.0 * hangs, 0) + "% of its measured crown lies more than " + detail::fixed(P.supportStep, 1) + " m below the surface measured around it (at " +
                          detail::fixed(rec.supportY, 1) + " m; its crown reaches down to " + detail::fixed(lowest, 1) + " m), so that surface is not its ground"
                    : "the surface measured around it (at " + detail::fixed(rec.supportY, 1) + " m) is not the one under it";
                standOnShown(*shown, why, std::abs(shown->yAtStem - rec.supportY) > P.supportBand);
            } else if (hangs > P.maxCrownBelowSupport && !shown) {
                // the highest ground-like surface under the stem (the first the trunk meets going down), if any
                const std::string why = detail::fixed(100.0 * hangs, 0) + "% of its measured crown lies more than " + detail::fixed(P.supportStep, 1) +
                                        " m below the surface measured around it (at " + detail::fixed(rec.supportY, 1) + " m; its crown reaches down to " +
                                        detail::fixed(lowest, 1) + " m), so that surface is not its ground";
                const UnderSurface* atStem = nullptr;
                for (const auto& s : rec.evidence.surfaces) if (s.stemHit && (!atStem || s.yAtStem > atStem->yAtStem)) atStem = &s;
                if (atStem) {
                    standOnShown(*atStem, why, true);
                } else {
                    groundMeasured = false;
                    rec.groundReasonCode = "crown_below_support";
                    rec.groundReason = why + ", and the scan shows no surface it could stand on under its stem below its crown";
                    ++R.stats.crownsHangingBelowSupport;
                }
            } else if (!shown) {
                // Its crown sits on the surfaces around it and its footprint shows nothing else, but under its stem the scan
                // has one surface it could stand on, the ground (where the terrain model has it), below them: those surfaces
                // were canopy tops around it, not a roof or terrace it stands on (a roof would lie between).
                size_t atStemCount = 0;
                const UnderSurface* atStem = nullptr;
                for (const auto& s : rec.evidence.surfaces) if (s.stemHit) { ++atStemCount; atStem = &s; }
                if (atStemCount == 1 && std::abs(atStem->yAtStem - rec.terrainY) <= P.groundTerrainBand && atStem->yAtStem < rec.supportY - P.supportBand) {
                    standOnShown(*atStem, "the surfaces around it stand at " + detail::fixed(rec.supportY, 1) + " m, but under its stem the scan has nothing it could stand on between its crown and the ground (the terrain model reads " +
                                              detail::fixed(rec.terrainY, 1) + " m there)", true);
                }
            }
        }
        if (groundMeasured) {
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
        else if (!insideRoi(rec.stemX, rec.stemZ)) { rec.status = "outside_roi"; ++R.stats.crownsOutsideRoi; }
        else {
            rec.status = "tree";
            ++R.stats.crownsTree;
            R.stats.treeCanopyAreaM2 += rec.areaM2;
            if (w.reachesBoundary) ++R.stats.treesReachingBoundary;
        }
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
    std::vector<int> capTriCrown;        // per cap triangle: the crown (work index) whose cap surface it lies on
    // One skirt per hole-edge segment that was built (see closeHoles): the four cap vertices, what it hangs on, and the
    // run (consecutive segments of one hole loop) it is laid out on for its fill; skirtTriQuad maps each skirt triangle to it
    struct SkirtQuad {
        uint32_t upperI{0}, upperN{0}, lowerI{0}, lowerN{0};
        size_t keptTri{0};
        int crown{-1}, loop{-1}, category{3};
        double areaM2{0};
        long run{-1};
        int runVertex{0};
    };
    std::vector<SkirtQuad> skirtQuads;
    std::vector<uint32_t> skirtTriQuad;

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
    /** Triangles standing on the caller's structure cells (P.keep): architecture whatever their shape or colour. */
    std::vector<uint8_t> keepTri;
    std::vector<uint8_t> keptAsBuilding;  // per triangle: the removal would have taken it, guardBuildings kept it as building (kept across passes)
    std::vector<uint32_t> guardSeed;      // per guarded triangle: the scanned building triangle whose plane it was measured against
    bool isArchitecture(size_t t) const {
        return (keepTri.size() == T && keepTri[t]) || (keptAsBuilding.size() == T && keptAsBuilding[t]) || (surface[t] && !chromaVeg[t] && !(drapeFace.size() == T && drapeFace[t]));
    }

    /** Marks the triangles whose centroid stands on a P.keep cell (once; the mesh does not change between passes). */
    void markKeep() {
        if (keepTri.size() == T) return;
        keepTri.assign(T, 0);
        const auto& K = P.keep;
        R.stats.keepCells = 0;
        R.stats.keptStructureTriangles = 0;
        if (K.nx <= 0 || K.nz <= 0 || K.flags.size() != static_cast<size_t>(K.nx) * static_cast<size_t>(K.nz)) return;
        for (uint8_t f : K.flags) R.stats.keepCells += f ? 1 : 0;
        for (size_t t = 0; t < T; ++t) {
            const double fi = std::floor((centroid[t].x - K.x0) / K.cell), fk = std::floor((centroid[t].z - K.z0) / K.cell);
            if (fi < 0 || fk < 0 || fi >= K.nx || fk >= K.nz) continue;
            if (!K.flags[static_cast<size_t>(fk) * static_cast<size_t>(K.nx) + static_cast<size_t>(fi)]) continue;
            if (!(surface[t] && !chromaVeg[t])) ++R.stats.keptStructureTriangles;
            keepTri[t] = 1;
        }
    }

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

    /** Clears what one removal-and-cap pass builds and counts, so the next pass starts from the scan. */
    void resetCapState() {
        capPos.clear();
        capTris.clear();
        capIsSkirt.clear();
        capTriCrown.clear();
        skirtQuads.clear();
        skirtTriQuad.clear();
        auto& s = R.stats;
        s.loops = s.openChains = s.linkedChains = s.holesBridged = s.forcedEars = s.capInteriorPoints = 0;
        s.capTurnedUp = s.capDegenerate = s.capsReversed = s.capFillCells = s.capFlips = 0;
        s.capMaxRiseM = 0;
        s.boundaryPoints = s.skirtedPoints = 0;
        s.skirtAreaOnWallsM2 = s.skirtAreaOnLevelSurfacesM2 = s.skirtAreaOnKeptCanopyM2 = s.skirtAreaOnOtherM2 = s.skirtMaxHeightM = 0;
        s.skirtMaxOnWallsM = s.skirtMaxOnLevelSurfacesM = s.skirtMaxOnKeptCanopyM = s.skirtMaxOnOtherM = 0;
        s.skirtTriangles = s.capTriangles = 0;
        s.skirtKept = {};
        s.skirtShortened = {};
        s.skirtDropped = {};
        s.openEdgesAtDroppedSkirts = 0;
        for (auto& c : R.crowns) {
            c.keptSkirtAreaM2 = 0;
            c.keptSkirtTopY = -std::numeric_limits<double>::infinity();
            c.keptSkirtBottomY = std::numeric_limits<double>::infinity();
        }
    }

    /**
     * Removes the trees and rebuilds their ground, then measures every removed tree's trunk base against the surface the
     * result has under its stem (what the trees are mounted on, before remeshing). A base within groundTolerance of it
     * stands on it. Within supportBand, the trunk is stood on that surface (the ground the removal rebuilt or kept there,
     * which the scan's level surfaces or its measured support gave), and the tree is regrown on it to check it still
     * fills its crown. Further off, or with nothing under the stem, what the tree stands on is undecided: it stays as
     * scanned (no_measured_ground, support_undecided, with the heights). Either change redoes the removal; at most
     * groundPasses passes, after which every remaining gap is reported by the trees' planting (offGround), not hidden.
     */
    void removeAndCapOnGround() {
        const int passes = std::max(1, P.groundPasses);
        for (int pass = 0; pass < passes; ++pass) {
            resetCapState();
            removeAndCap();
            R.stats.groundPasses = static_cast<size_t>(pass + 1);
            if (!checkTrunksOnGround(pass + 1 == passes)) break;
        }
    }

    /** Whether a crown regrows into itself standing on `supportY` (growCrown, then meshed within its own budget). */
    bool fillsOn(const CrownRecord& rec, double supportY) const {
        CrownShape shape;
        shape.id = rec.id;
        shape.apex = rec.apex;
        shape.stemX = rec.stemX;
        shape.stemZ = rec.stemZ;
        shape.supportY = supportY;
        shape.areaM2 = rec.areaM2;
        shape.sectorRadii = rec.sectorRadii;
        shape.samples = rec.samples;
        shape.colourKnown = rec.colourKnown;
        shape.colourMean = rec.colourMean;
        const CrownGrowth g = growCrown(shape, P.growth, P.sampleSpacing);
        if (!g.ok()) return false;
        PlantParams sizing;
        sizing.growth = P.growth;
        const MeshedCrown m = meshCrown(g, crownOwnBudget(shape, g, sizing), sizing.woodShare);
        return m.fills(g, shape, P.growth.minSurfaceReached);
    }

    /**
     * See removeAndCapOnGround. Moves (re-stands) trunks onto the rebuilt ground under their stem; outside the last pass,
     * keeps as scanned each tree whose support is undecided (or which does not regrow on the ground under it). Returns
     * whether a tree was kept, which needs the removal redone; a move does not (the result already has that ground under
     * the stem). In the last pass nothing is kept: what remains off its ground is counted, and the planting reports it.
     */
    bool checkTrunksOnGround(bool last) {
        // the result: kept scan triangles and the cap, welded
        std::vector<Vec3> rp(weldPos.begin(), weldPos.end());
        std::vector<uint32_t> ri;
        ri.reserve(wtri.size());
        for (size_t t = 0; t < T; ++t) {
            if (removedBy[t] >= 0) continue;
            ri.insert(ri.end(), {wtri[3 * t], wtri[3 * t + 1], wtri[3 * t + 2]});
        }
        const uint32_t base = static_cast<uint32_t>(rp.size());
        rp.insert(rp.end(), capPos.begin(), capPos.end());
        for (size_t k = 0; k < capIsSkirt.size(); ++k) {
            if (capIsSkirt[k]) continue;  // a skirt is a wall, never ground
            ri.insert(ri.end(), {base + capTris[3 * k], base + capTris[3 * k + 1], base + capTris[3 * k + 2]});
        }
        detail::VerticalProbe result;
        result.build(rp, ri);
        struct Candidate { size_t m; double nearest, gap; bool shown; bool fills{false}; };
        std::vector<Candidate> off;
        for (size_t m = 0; m < work.size(); ++m) {
            const auto& w = work[m];
            if (w.recordIndex < 0) continue;
            CrownRecord& rec = R.crowns[static_cast<size_t>(w.recordIndex)];
            if (rec.status != "tree") continue;
            double nearest = std::numeric_limits<double>::quiet_NaN();
            for (const auto& [h, t] : result.hitsAt(rec.stemX, rec.stemZ)) {
                // the ground faces up: a downward-facing hit is the underside of something kept over the stem
                const Vec3 a = rp[ri[3 * t]], b = rp[ri[3 * t + 1]], c = rp[ri[3 * t + 2]];
                if ((b - a).cross(c - a).y <= 0.0f) continue;
                if (!std::isfinite(nearest) || std::abs(h - rec.supportY) < std::abs(nearest - rec.supportY)) nearest = h;
            }
            rec.groundChecked = true;
            rec.groundAtStemY = nearest;
            const double gap = std::isfinite(nearest) ? rec.supportY - nearest : std::numeric_limits<double>::infinity();
            if (std::abs(gap) <= P.groundTolerance) continue;
            // the rebuilt ground under the stem lies within supportBand of the support, or is a surface the scan shows under
            // this crown (any share of its footprint) or the surface measured around it, within supportBand
            bool shown = std::isfinite(nearest) && std::abs(gap) <= P.supportBand;
            shown = shown || (std::isfinite(rec.surroundingY) && std::isfinite(nearest) && std::abs(rec.surroundingY - nearest) <= P.supportBand);
            for (const auto& u : rec.evidence.surfaces) shown = shown || (std::isfinite(nearest) && std::abs(u.yAtStem - nearest) <= P.supportBand);
            off.push_back({m, nearest, gap, shown});
        }
        // does each tree regrow into its crown standing on that ground?
        detail::forEachIndex(off.size(), P.threads, [&](size_t k) {
            auto& c = off[k];
            if (c.shown) c.fills = fillsOn(R.crowns[static_cast<size_t>(work[c.m].recordIndex)], c.nearest);
        });
        std::vector<size_t> moved;
        bool keptAny = false;
        size_t remaining = 0;
        for (const auto& c : off) {
            CrownRecord& rec = R.crowns[static_cast<size_t>(work[c.m].recordIndex)];
            if (c.shown && c.fills) {
                rec.supportMovedM += -c.gap;
                rec.supportY = c.nearest;
                rec.apexAboveSupport = rec.apex.y - rec.supportY;
                rec.supportNote = (rec.supportNote.empty() ? std::string() : rec.supportNote + "; ") + "its trunk was stood " + detail::fixed(std::abs(c.gap), 2) +
                                  " m " + (c.gap > 0 ? "lower" : "higher") + ", on the ground rebuilt under its stem at " + detail::fixed(c.nearest, 2) + " m";
                work[c.m].support = c.nearest;
                if (R.frame.known) rec.stemGeo = R.frame.toGeodetic(rec.stemX, rec.supportY, rec.stemZ);
                moved.push_back(static_cast<size_t>(work[c.m].recordIndex));
                continue;
            }
            if (last) { ++remaining; continue; }
            rec.status = "no_measured_ground";
            rec.supportSource = "undecided";  // supportY keeps the height its trunk would have stood at
            rec.groundReasonCode = "support_undecided";
            if (c.shown) {
                rec.groundReason = "with the trees around it removed the ground under its stem lies at " + detail::fixed(c.nearest, 1) + " m (" + detail::fixed(std::abs(c.gap), 1) + " m " +
                                   (c.gap > 0 ? "below" : "above") + " the " + detail::fixed(rec.supportY, 1) + " m it would stand at), and a tree standing there does not regrow into its measured crown, so what it stands on is undecided";
            } else if (std::isfinite(c.nearest)) {
                rec.groundReason = "its trunk would stand at " + detail::fixed(rec.supportY, 1) + " m, but with the trees around it removed the ground under its stem lies at " +
                                   detail::fixed(c.nearest, 1) + " m (" + detail::fixed(std::abs(c.gap), 1) + " m " + (c.gap > 0 ? "below" : "above") + " it), which the scan does not show under its crown, so what it stands on is undecided";
            } else {
                rec.groundReason = "its trunk would stand at " + detail::fixed(rec.supportY, 1) + " m, but with the trees around it removed nothing lies under its stem, so what it stands on is undecided";
            }
            --R.stats.crownsTree;
            ++R.stats.crownsNoGround;
            ++R.stats.crownsSupportUndecided;
            R.stats.treeCanopyAreaM2 -= rec.areaM2;
            if (rec.reachesBoundary) --R.stats.treesReachingBoundary;
            keptAny = true;
        }
        R.stats.trunksOffRebuiltGround = remaining;
        if (!moved.empty()) {
            R.stats.trunksRestood += moved.size();
            regrowAndDemote(moved);  // refreshes what crowns.json says of their regrowth; each was just checked to fill
        }
        return keptAny;
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
        markKeep();
        const int rs = static_cast<int>(std::ceil(P.footprintDilation / P.cell));
        const int rg = static_cast<int>(std::ceil(2.0 * P.footprintDilation / P.cell));
        // a crown's own footprint is its own: what stands in it is measured against its own ground, never a neighbour's
        // dilation (a neighbour standing lower would take the ground this tree stands on as its drape)
        for (size_t m = 0; m < work.size(); ++m) {
            if (!removesCrown(m)) continue;
            for (size_t c : work[m].cells) { seedMask[c] = static_cast<int>(m); growMask[c] = static_cast<int>(m); }
        }
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
            if (!veg[t] || keepTri[t]) continue;
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
        guardBuildings();
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

    // ---------------------------------------------------------------- buildings win over trees
    /** 0: a kept wall, 1: a kept level surface (both building), 2: another kept not-vegetation surface, -1: kept vegetation or removed. */
    int keptSurfaceCategory(size_t k) const {
        if (removedBy[k] >= 0 || veg[k]) return -1;
        if (isArchitecture(k)) return std::abs(normal[k].y) < 0.7f ? 0 : 1;
        return 2;
    }

    /** Whether removed triangle t lies on the surface of kept triangle k: within facadeGuard of its plane, facing like it. */
    bool onKeptSurface(size_t t, size_t k) const {
        if (std::abs(static_cast<double>(normal[t].dot(normal[k]))) < P.facadeGuardCos) return false;
        return std::abs(static_cast<double>((centroid[t] - centroid[k]).dot(normal[k]))) <= P.facadeGuard;
    }

    /**
     * Buildings win over trees: a triangle the removal took that lies on a kept wall it touches (across a welded edge,
     * within facadeGuard of the wall's plane, facing like it) is facade whatever the classifier called it, and is put
     * back; the wave runs along the facade from the kept wall into the cut, so the cut stops at the facade and the scan's
     * own wall stays. Level surfaces are measured (removedOnBuilding) but not put back: the drape hem a crown lays on the
     * paving around it, and a crown top beside a flat roof, are the crown's, and the ground under a removed tree is
     * rebuilt from the surfaces around it.
     */
    void guardBuildings() {
        auto& st = R.stats;
        if (keptAsBuilding.size() != T) { keptAsBuilding.assign(T, 0); guardSeed.assign(T, 0); }
        st.guardM = P.facadeGuard;
        st.guardCos = P.facadeGuardCos;
        // every triangle put back is measured against the plane of a scanned building triangle (the seed the wave started
        // from), never against a neighbour already put back: the wave cannot creep over a rounded crown
        auto seedOf = [&](uint32_t k) { return keptAsBuilding[k] ? guardSeed[k] : k; };
        auto countOn = [&](StripStats::GuardCounts& out) {
            out = {};
            for (size_t t = 0; t < T; ++t) {
                if (removedBy[t] < 0) continue;
                int best = -1;
                for (uint32_t e = adjStart[t]; e < adjStart[t + 1]; ++e) {
                    const uint32_t k = adj[e];
                    const int cat = keptSurfaceCategory(k);
                    if (cat < 0 || cat > 1 || !onKeptSurface(t, seedOf(k))) continue;
                    best = best < 0 ? cat : std::min(best, cat);
                }
                if (best == 0) ++out.onWalls;
                else if (best == 1) ++out.onLevelSurfaces;
            }
        };
        countOn(st.guardBefore);
        if (P.facadeGuard > 0) {
            std::vector<uint32_t> queue;
            for (size_t t = 0; t < T; ++t) {
                if (removedBy[t] < 0) continue;
                for (uint32_t e = adjStart[t]; e < adjStart[t + 1]; ++e) {
                    if (keptSurfaceCategory(adj[e]) == 0) { queue.push_back(static_cast<uint32_t>(t)); break; }
                }
            }
            while (!queue.empty()) {
                const uint32_t t = queue.back();
                queue.pop_back();
                if (removedBy[t] < 0) continue;
                bool building = false;
                for (uint32_t e = adjStart[t]; e < adjStart[t + 1] && !building; ++e) {
                    const uint32_t k = adj[e];
                    if (keptSurfaceCategory(k) != 0) continue;
                    const uint32_t seed = seedOf(k);
                    if (onKeptSurface(t, seed)) { building = true; guardSeed[t] = seed; }
                }
                if (!building) continue;
                removedBy[t] = -1;
                keptAsBuilding[t] = 1;
                veg[t] = 0;
                for (uint32_t e = adjStart[t]; e < adjStart[t + 1]; ++e) if (removedBy[adj[e]] >= 0) queue.push_back(adj[e]);
            }
        }
        countOn(st.guardAfter);
        // what the guard holds as building over every pass (a triangle put back stays building in the passes after)
        st.guardKeptAsBuilding = 0;
        st.guardKeptAsBuildingM2 = 0;
        for (size_t t = 0; t < T; ++t) if (keptAsBuilding[t]) { ++st.guardKeptAsBuilding; st.guardKeptAsBuildingM2 += static_cast<double>(area[t]); }
        st.creaseOnWalls = st.creaseOnLevelSurfaces = st.creaseOnOther = 0;
        for (size_t t = 0; t < T; ++t) {
            if (removedBy[t] < 0) continue;
            int best = -1;
            for (uint32_t e = adjStart[t]; e < adjStart[t + 1]; ++e) {
                const int cat = keptSurfaceCategory(adj[e]);
                if (cat >= 0) best = best < 0 ? cat : std::min(best, cat);
            }
            if (best == 0) ++st.creaseOnWalls;
            else if (best == 1) ++st.creaseOnLevelSurfaces;
            else if (best == 2) ++st.creaseOnOther;
        }
    }

    /**
     * The scanned walls each removed crown touched: kept wall triangles across a welded edge from its removed triangles,
     * clustered by plane (normals within 25 degrees, within 0.5 m of the plane), each an area-weighted point and normal
     * turned towards the crown. Written to crowns.json (CrownRecord::walls); plant grows the tree on the crown's side.
     */
    void measureCrownWalls() {
        auto& st = R.stats;
        st.crownsWithWalls = st.crownWalls = 0;
        for (auto& c : R.crowns) c.walls.clear();
        struct Cluster { Vec3 pointSum, normalSum; double area{0}; Vec3 seedPoint, seedNormal; std::vector<uint32_t> tris; };
        std::unordered_map<int, std::vector<Cluster>> byCrown;
        std::unordered_map<int, std::pair<Vec3, size_t>> crownCentre;  // sum of removed centroids, count
        std::vector<uint8_t> seen(T, 0);
        for (size_t t = 0; t < T; ++t) {
            const int m = removedBy[t];
            if (m < 0) continue;
            auto& cc = crownCentre[m];
            cc.first = cc.first + centroid[t];
            ++cc.second;
            for (uint32_t e = adjStart[t]; e < adjStart[t + 1]; ++e) {
                const uint32_t k = adj[e];
                if (seen[k] || keptSurfaceCategory(k) != 0) continue;
                seen[k] = 1;
                auto& clusters = byCrown[m];
                Cluster* home = nullptr;
                for (auto& cl : clusters) {
                    if (std::abs(static_cast<double>(normal[k].dot(cl.seedNormal))) < 0.9) continue;
                    if (std::abs(static_cast<double>((centroid[k] - cl.seedPoint).dot(cl.seedNormal))) > 0.5) continue;
                    home = &cl;
                    break;
                }
                if (!home) { clusters.push_back({}); home = &clusters.back(); home->seedPoint = centroid[k]; home->seedNormal = normal[k]; }
                const Vec3 n = normal[k].dot(home->seedNormal) < 0 ? normal[k] * -1.0f : normal[k];
                home->pointSum = home->pointSum + centroid[k] * area[k];
                home->normalSum = home->normalSum + n * area[k];
                home->area += static_cast<double>(area[k]);
                home->tris.push_back(k);
            }
        }
        for (auto& [m, clusters] : byCrown) {
            const int ri = m >= 0 && static_cast<size_t>(m) < work.size() ? work[static_cast<size_t>(m)].recordIndex : -1;
            if (ri < 0) continue;
            auto& rec = R.crowns[static_cast<size_t>(ri)];
            const auto& cc = crownCentre[m];
            const Vec3 crown = cc.second ? cc.first * (1.0f / static_cast<float>(cc.second)) : Vec3(0, 0, 0);
            for (const auto& cl : clusters) {
                if (cl.area < 1.0) continue;
                CrownWall w;
                w.point = cl.pointSum * (1.0f / static_cast<float>(cl.area));
                const float len = cl.normalSum.length();
                if (len < 1e-9f) continue;
                w.normal = cl.normalSum / len;
                // turned towards the crown: the regrown tree lives on the crown's side of the wall
                if ((crown - w.point).dot(w.normal) < 0) w.normal = w.normal * -1.0f;
                w.areaM2 = cl.area;
                // its extent: the wall triangles' corners along the horizontal tangent and up, about the point
                Vec3 tg(-w.normal.z, 0.0f, w.normal.x);
                const float tl = tg.length();
                w.tangent = tl > 1e-6f ? tg / tl : Vec3(1, 0, 0);
                double uLo = 1e30, uHi = -1e30, yLo = 1e30, yHi = -1e30;
                for (uint32_t k : cl.tris) {
                    for (int j = 0; j < 3; ++j) {
                        const Vec3 d = pos[idx[3 * k + static_cast<size_t>(j)]] - w.point;
                        const double u = d.dot(w.tangent);
                        uLo = std::min(uLo, u); uHi = std::max(uHi, u); yLo = std::min(yLo, static_cast<double>(d.y)); yHi = std::max(yHi, static_cast<double>(d.y));
                    }
                }
                // re-centre the point on the extent so the half widths are symmetric
                w.point = w.point + w.tangent * static_cast<float>(0.5 * (uLo + uHi)) + Vec3(0.0f, static_cast<float>(0.5 * (yLo + yHi)), 0.0f);
                w.halfAlongM = 0.5 * (uHi - uLo);
                w.halfUpM = 0.5 * (yHi - yLo);
                rec.walls.push_back(w);
            }
            if (!rec.walls.empty()) { ++st.crownsWithWalls; st.crownWalls += rec.walls.size(); }
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
        auto addTri = [&](uint32_t a, uint32_t b, uint32_t c, bool skirt, int crownOf, uint32_t quadOf) {
            if (a == b || b == c || a == c) return;
            capTris.insert(capTris.end(), {a, b, c});
            capIsSkirt.push_back(skirt ? 1 : 0);
            capTriCrown.push_back(crownOf);
            if (skirt) skirtTriQuad.push_back(quadOf);
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
                // what the skirt hangs on (for the report): a wall, a roof or terrace, canopy that stays, anything else
                const size_t t = static_cast<size_t>(loopKept[l][i]);
                const long c = cellOf(centroid[t]);
                const bool wall = isArchitecture(t) && std::abs(normal[t].y) < 0.7f, level = isArchitecture(t) && !wall;
                const bool onCanopy = !isArchitecture(t) && c >= 0 && keptCell[static_cast<size_t>(c)];
                const int category = wall ? 0 : level ? 1 : onCanopy ? 2 : 3;
                // the skirt's own faces (a triangle with two corners on one vertex is not built)
                auto faceArea = [&](uint32_t a, uint32_t b, uint32_t cc) {
                    if (a == b || b == cc || a == cc) return 0.0;
                    return 0.5 * static_cast<double>((capPos[b] - capPos[a]).cross(capPos[cc] - capPos[a]).length());
                };
                double quadArea = faceArea(upper[i], upper[n], lower[n]) + faceArea(upper[i], lower[n], lower[i]);
                uint32_t footI = lower[i], footN = lower[n];
                // a skirt on architecture is a panel pasted over a real wall where the scan has a surface behind it: cut
                // down to the part above that surface, or not built at all
                if (P.skirtDropBacked && category <= 1 && quadArea > 0) {
                    const SkirtBacking bk = skirtBacking(capPos[upper[i]], capPos[upper[n]], capPos[lower[i]], capPos[lower[n]]);
                    const double topY = std::min(capPos[upper[i]].y, capPos[upper[n]].y), footY = std::max(capPos[lower[i]].y, capPos[lower[n]].y);
                    const bool drop = (bk.band && bk.bandTopY >= topY - P.skirtMin) || (!bk.band && bk.share >= P.skirtBackedShare);
                    if (drop) {
                        ++R.stats.skirtDropped[static_cast<size_t>(category)].count;
                        R.stats.skirtDropped[static_cast<size_t>(category)].areaM2 += quadArea;
                        ++R.stats.openEdgesAtDroppedSkirts;
                        continue;
                    }
                    if (bk.band && bk.bandTopY - footY >= P.skirtMin) {
                        // the foot rises to the top of the real surface; the quad's own foot vertices (its neighbours keep theirs)
                        const Vec3 &pI = capPos[lower[i]], &pN = capPos[lower[n]];
                        capPos.push_back(Vec3(pI.x, static_cast<float>(bk.bandTopY), pI.z));
                        footI = static_cast<uint32_t>(capPos.size() - 1);
                        capPos.push_back(Vec3(pN.x, static_cast<float>(bk.bandTopY), pN.z));
                        footN = static_cast<uint32_t>(capPos.size() - 1);
                        const double shortArea = faceArea(upper[i], upper[n], footN) + faceArea(upper[i], footN, footI);
                        ++R.stats.skirtShortened[static_cast<size_t>(category)].count;
                        R.stats.skirtShortened[static_cast<size_t>(category)].areaM2 += std::max(0.0, quadArea - shortArea);
                        quadArea = shortArea;
                    } else {
                        ++R.stats.skirtKept[static_cast<size_t>(category)].count;
                        R.stats.skirtKept[static_cast<size_t>(category)].areaM2 += quadArea;
                    }
                } else {
                    ++R.stats.skirtKept[static_cast<size_t>(category)].count;
                    R.stats.skirtKept[static_cast<size_t>(category)].areaM2 += quadArea;
                }
                const size_t before = capIsSkirt.size();
                SkirtQuad q;
                q.upperI = upper[i]; q.upperN = upper[n]; q.lowerI = footI; q.lowerN = footN;
                q.keptTri = t; q.crown = crown; q.loop = static_cast<int>(l); q.category = category; q.areaM2 = quadArea;
                skirtQuads.push_back(q);
                const uint32_t qi = static_cast<uint32_t>(skirtQuads.size() - 1);
                addTri(upper[i], upper[n], footN, true, crown, qi);
                addTri(upper[i], footN, footI, true, crown, qi);
                double& bucket = wall ? R.stats.skirtAreaOnWallsM2 : level ? R.stats.skirtAreaOnLevelSurfacesM2 : onCanopy ? R.stats.skirtAreaOnKeptCanopyM2 : R.stats.skirtAreaOnOtherM2;
                double& tallest = wall ? R.stats.skirtMaxOnWallsM : level ? R.stats.skirtMaxOnLevelSurfacesM : onCanopy ? R.stats.skirtMaxOnKeptCanopyM : R.stats.skirtMaxOnOtherM;
                // canopy that stays: the crown it belongs to carries the skirt on its record (a tree kept as scanned beside
                // removed trees has its side closed down to their ground, and says so)
                CrownRecord* keptCrown = nullptr;
                if (onCanopy && keptOwner[static_cast<size_t>(c)] >= 0) {
                    const int ri = work[static_cast<size_t>(keptOwner[static_cast<size_t>(c)])].recordIndex;
                    if (ri >= 0) keptCrown = &R.crowns[static_cast<size_t>(ri)];
                }
                for (size_t k = before; k < capIsSkirt.size(); ++k) {
                    const Vec3 &a = capPos[capTris[3 * k]], &b = capPos[capTris[3 * k + 1]], &cc = capPos[capTris[3 * k + 2]];
                    const double area = 0.5 * static_cast<double>((b - a).cross(cc - a).length());
                    bucket += area;
                    const double span = static_cast<double>(std::max({a.y, b.y, cc.y}) - std::min({a.y, b.y, cc.y}));
                    tallest = std::max(tallest, span);
                    R.stats.skirtMaxHeightM = std::max(R.stats.skirtMaxHeightM, span);
                    if (keptCrown) {
                        keptCrown->keptSkirtAreaM2 += area;
                        keptCrown->keptSkirtTopY = std::max(keptCrown->keptSkirtTopY, static_cast<double>(std::max({a.y, b.y, cc.y})));
                        keptCrown->keptSkirtBottomY = std::min(keptCrown->keptSkirtBottomY, static_cast<double>(std::min({a.y, b.y, cc.y})));
                    }
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
            for (size_t k = first / 3; k < capTris.size() / 3; ++k) { capIsSkirt.push_back(0); capTriCrown.push_back(loopCrown[l]); }
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
                            capTriCrown.push_back(loopCrown[l]);
                            capTriCrown.push_back(loopCrown[l]);
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
                capTriCrown.push_back(crown);
                capTriCrown.push_back(crown);
                ++R.stats.capFillCells;
            }
        }
    }

    // ---------------------------------------------------------------- fill (caps and skirts carry photo-inferred texels)
    strip_fill::TriangleIndex fillIndex;
    bool fillIndexBuilt{false};

    void ensureFillIndex() {
        if (fillIndexBuilt) return;
        fillIndex.build(pos, idx, 1.0);
        fillIndexBuilt = true;
    }

    /** The scan's photo at barycentric w of triangle t (sRGB 0..255); a triangle with no photo gives its flat colour. */
    void photoAt(size_t t, const double w[3], double rgb[3]) const {
        const uint32_t m = scene.triangleMaterial[t];
        const gltf::SceneMaterial* mat = m < scene.materials.size() ? &scene.materials[m] : nullptr;
        const int im = mat ? mat->baseColorImage : -1;
        if (!mat || im < 0 || im >= static_cast<int>(scene.images.size()) || scene.images[static_cast<size_t>(im)].pixels.empty()) {
            const double f[3] = {mat ? mat->baseColorFactor.x : 0.7, mat ? mat->baseColorFactor.y : 0.7, mat ? mat->baseColorFactor.z : 0.7};
            for (int k = 0; k < 3; ++k) rgb[k] = std::clamp(f[k], 0.0, 1.0) * 255.0;
            return;
        }
        const auto& img = scene.images[static_cast<size_t>(im)].pixels;
        const auto &a = scene.mesh.vertices[idx[3 * t]].uv, &b = scene.mesh.vertices[idx[3 * t + 1]].uv, &c = scene.mesh.vertices[idx[3 * t + 2]].uv;
        const double u = w[0] * a.x + w[1] * b.x + w[2] * c.x, v = w[0] * a.y + w[1] * b.y + w[2] * c.y;
        auto wrap = [](double x, int mode) {
            if (mode == 33071) return std::clamp(x, 0.0, 1.0);
            if (mode == 33648) { const double f = std::fmod(std::abs(x), 2.0); return f > 1.0 ? 2.0 - f : f; }
            return x - std::floor(x);
        };
        const double fx = wrap(u, mat->wrapS) * img.width - 0.5, fy = wrap(v, mat->wrapT) * img.height - 0.5;
        const int x0 = static_cast<int>(std::floor(fx)), y0 = static_cast<int>(std::floor(fy));
        const double tx = fx - x0, ty = fy - y0;
        auto texel = [&](int x, int y, int ch) {
            const int xx = std::clamp(x, 0, img.width - 1), yy = std::clamp(y, 0, img.height - 1);
            return static_cast<double>(img.data[img.getIndex(xx, yy) + static_cast<size_t>(std::min(ch, img.channels - 1))]);
        };
        for (int ch = 0; ch < 3; ++ch) {
            const double top = texel(x0, y0, ch) * (1 - tx) + texel(x0 + 1, y0, ch) * tx, bot = texel(x0, y0 + 1, ch) * (1 - tx) + texel(x0 + 1, y0 + 1, ch) * tx;
            rgb[ch] = top * (1 - ty) + bot * ty;
        }
    }

    /** Whether a photo colour (sRGB 0..255) is the colour of vegetation, by the same chroma test the classifier uses. */
    bool vegetationColour(const double rgb[3]) const {
        const double s0 = rgb[0] / 255.0, s1 = rgb[1] / 255.0, s2 = rgb[2] / 255.0, sum = s0 + s1 + s2;
        if (sum / 3.0 < P.darkGuard) return false;
        const double r = s0 / sum, g = s1 / sum, bl = s2 / sum;
        const double eg = 2 * g - r - bl, er = 1.4 * r - g;
        return eg > P.exgMin && eg - er > P.exgrMin;
    }

    static double pointSegmentDistance(const Vec3& q, const Vec3& a, const Vec3& b) {
        const Vec3 ab = b - a;
        const double l2 = static_cast<double>(ab.lengthSquared());
        const double t = l2 < 1e-18 ? 0.0 : std::clamp(static_cast<double>((q - a).dot(ab)) / l2, 0.0, 1.0);
        return static_cast<double>((q - (a + ab * static_cast<float>(t))).length());
    }

    /** What the real scan has behind a skirt quad (skirtBacking). */
    struct SkirtBacking {
        double share{0};          // share of the sample points over its face with a real surface behind them
        double bandTopY{-std::numeric_limits<double>::infinity()};  // top of the backed band rising from its foot (the lowest over its columns)
        bool band{false};         // every column is backed from its foot up to bandTopY
    };

    /**
     * What a skirt (sample points over its face) has behind it: a kept, not-vegetation triangle within skirtBackedReach of
     * the skirt's plane that faces like it, straight behind the sample (its closest point stands off the sample no further
     * sideways or up than a fraction of the sample spacing: a wall beside the skirt, or one ending within it, is not
     * behind it, nor is anything touching the hole edge itself; the triangle the skirt hangs on counts where it does stand
     * behind, as the scanned wall under a crown's underside does). Besides the share,
     * the band of backed samples rising from the foot in every column: the real surface the skirt would be pasted over.
     */
    SkirtBacking skirtBacking(const Vec3& U0, const Vec3& U1, const Vec3& L0, const Vec3& L1) {
        SkirtBacking out;
        ensureFillIndex();
        const double dx = static_cast<double>(U1.x) - U0.x, dz = static_cast<double>(U1.z) - U0.z, len = std::hypot(dx, dz);
        if (len < 1e-6) return out;
        const double nx = -dz / len, nz = dx / len;
        const double span = std::max(std::abs(static_cast<double>(U0.y) - L0.y), std::abs(static_cast<double>(U1.y) - L1.y));
        if (span < 1e-6) return out;
        double step = std::max(0.1, 2.5 * P.fillTexel);
        while ((len / step + 1) * (span / step + 1) > 2000) step *= 1.5;
        const int na = std::max(1, static_cast<int>(std::ceil(len / step))), nb = std::max(1, static_cast<int>(std::ceil(span / step)));
        const double lateral = 0.4 * step;   // how far sideways or up the backing surface's closest point may stand off a sample
        int hits = 0;
        bool band = true;
        double bandTop = std::numeric_limits<double>::infinity();
        for (int ia = 0; ia < na; ++ia) {
            const double a = (ia + 0.5) / na;
            const Vec3 up = U0 + (U1 - U0) * static_cast<float>(a), lo = L0 + (L1 - L0) * static_cast<float>(a);
            int fromFoot = 0;   // backed rows counted up from the foot, until the first that is not
            bool broken = false;
            for (int ib = nb - 1; ib >= 0; --ib) {
                const double b = (ib + 0.5) / nb;
                const Vec3 q = up + (lo - up) * static_cast<float>(b);
                strip_fill::TriangleIndex::Hit hit;
                const bool found = fillIndex.closest(q, P.skirtBackedReach, [&](uint32_t t, const strip_fill::TriangleIndex::Hit& h) {
                    if (removedBy[t] >= 0 || veg[t]) return false;
                    if (std::abs(static_cast<double>(normal[t].x) * nx + static_cast<double>(normal[t].z) * nz) < P.fillNormalCos) return false;
                    // not the hole edge itself: the surface point must stand off the edge segment
                    const Vec3 &A = pos[idx[3 * t]], &B = pos[idx[3 * t + 1]], &C = pos[idx[3 * t + 2]];
                    const Vec3 Q = A * static_cast<float>(h.w[0]) + B * static_cast<float>(h.w[1]) + C * static_cast<float>(h.w[2]);
                    // straight behind the sample: not beside it along the skirt, not above or below it
                    const double along = ((static_cast<double>(Q.x) - q.x) * dx + (static_cast<double>(Q.z) - q.z) * dz) / len;
                    if (std::abs(along) > lateral || std::abs(static_cast<double>(Q.y) - q.y) > lateral) return false;
                    return pointSegmentDistance(Q, U0, U1) > 0.1;
                }, hit);
                hits += found ? 1 : 0;
                if (found && !broken) ++fromFoot;
                else broken = true;
            }
            if (fromFoot == 0) band = false;
            // the band's top in this column: the foot plus the backed rows' share of the column
            bandTop = std::min(bandTop, static_cast<double>(lo.y) + (static_cast<double>(up.y) - lo.y) * (static_cast<double>(fromFoot) / nb));
        }
        out.share = static_cast<double>(hits) / static_cast<double>(na * nb);
        out.band = band;
        out.bandTopY = band ? bandTop : -std::numeric_limits<double>::infinity();
        return out;
    }

    struct FillPiece {
        bool cap{true};
        std::vector<size_t> tris;          // the piece's triangles, indices into capTris / 3
        std::vector<size_t> quads;         // skirt: skirtQuads indices of the run, in order
        int crown{-1};
        int category{3};
        bool allowVegetation{false};
        double u0{0}, v0{0};               // window origin: cap x, z; skirt s (arc along the run), y (the window's top)
        int W{0}, H{0};
        std::vector<double> sAt;           // skirt: arc length at each run vertex
        std::vector<std::array<double, 2>> xz;
        std::vector<double> yUp, yLow;     // skirt: upper and lower heights at each run vertex
        strip_fill::Patch patch;
        strip_fill::FillCounts counts;
        double areaM2{0};
        std::array<double, 3> centre{};
        strip_fill::PackRect rect;
        bool sourced{false};
        bool widened{false};           // its real texels were found only with the widened surface tolerance
    };
    std::vector<FillPiece> fillPieces;
    texture::ImageBuffer fillAtlas;
    std::vector<uint8_t> fillAtlasPng;
    std::vector<float> capTriUv;           // 6 floats per cap/skirt triangle (the atlas coordinates of its corners)
    std::vector<uint8_t> capTriSourced;    // per cap/skirt triangle: its piece has real texels to carry (else generated flat)

    /** Mean photo colour (sRGB 0..1) of kept, not-vegetation triangles chosen by `pick`, weighted by area; false when none. */
    bool meanPhotoColour(const std::function<bool(size_t)>& pick, std::array<double, 3>& out) const {
        double sum[3] = {0, 0, 0}, wsum = 0;
        for (size_t t = 0; t < T; ++t) {
            if (removedBy[t] >= 0 || veg[t] || std::isnan(triRgb[t][0]) || !pick(t)) continue;
            for (int k = 0; k < 3; ++k) sum[k] += static_cast<double>(triRgb[t][static_cast<size_t>(k)]) * static_cast<double>(area[t]);
            wsum += static_cast<double>(area[t]);
        }
        if (wsum <= 0) return false;
        for (int k = 0; k < 3; ++k) {
            const double lin = sum[k] / wsum;
            out[static_cast<size_t>(k)] = lin <= 0.0031308 ? 12.92 * lin : 1.055 * std::pow(lin, 1.0 / 2.4) - 0.055;
        }
        return true;
    }

    /** Lays the cap and skirt pieces out, finds their real neighbours in the scan, fills the rest, and packs the atlas. */
    void buildFill() {
        auto& st = R.stats;
        fillPieces.clear();
        capTriUv.assign(capTris.size() / 3 * 6, 0.0f);
        capTriSourced.assign(capTris.size() / 3, 0);
        st.fillEnabled = P.fill;
        st.fillCap = {};
        st.fillSkirt = {};
        st.fillDegradations.clear();
        st.capAreaM2 = 0;
        for (size_t k = 0; k < capIsSkirt.size(); ++k) {
            const Vec3 &a = capPos[capTris[3 * k]], &b = capPos[capTris[3 * k + 1]], &c = capPos[capTris[3 * k + 2]];
            if (!capIsSkirt[k]) st.capAreaM2 += 0.5 * static_cast<double>((b - a).cross(c - a).length());
        }
        if (!P.fill || capTris.empty()) return;
        ensureFillIndex();
        const double ctx = std::max(P.fillContext, 2.0 * P.fillTexel);

        // ---- pieces: a cap is a connected set of cap triangles, a skirt is a run of consecutive skirt segments
        {
            const size_t nCap = capPos.size();
            std::vector<uint32_t> parent(nCap);
            for (size_t i = 0; i < nCap; ++i) parent[i] = static_cast<uint32_t>(i);
            std::function<uint32_t(uint32_t)> find = [&](uint32_t x) { while (parent[x] != x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
            for (size_t k = 0; k < capIsSkirt.size(); ++k) {
                if (capIsSkirt[k]) continue;
                const uint32_t a = find(capTris[3 * k]), b = find(capTris[3 * k + 1]), c = find(capTris[3 * k + 2]);
                parent[b] = a;
                parent[find(c)] = a;
            }
            std::map<uint32_t, size_t> pieceOf;
            for (size_t k = 0; k < capIsSkirt.size(); ++k) {
                if (capIsSkirt[k]) continue;
                const uint32_t root = find(capTris[3 * k]);
                auto it = pieceOf.find(root);
                if (it == pieceOf.end()) {
                    it = pieceOf.emplace(root, fillPieces.size()).first;
                    FillPiece pc;
                    pc.cap = true;
                    pc.crown = capTriCrown[k];
                    fillPieces.push_back(std::move(pc));
                }
                fillPieces[it->second].tris.push_back(k);
            }
            for (size_t qi = 0; qi < skirtQuads.size();) {
                size_t qj = qi + 1;
                while (qj < skirtQuads.size() && skirtQuads[qj].loop == skirtQuads[qi].loop && skirtQuads[qj].category == skirtQuads[qi].category &&
                       skirtQuads[qj].upperI == skirtQuads[qj - 1].upperN && skirtQuads[qj].lowerI == skirtQuads[qj - 1].lowerN) ++qj;
                FillPiece pc;
                pc.cap = false;
                pc.crown = skirtQuads[qi].crown;
                pc.category = skirtQuads[qi].category;
                pc.allowVegetation = pc.category == 2;
                const size_t run = fillPieces.size();
                for (size_t q = qi; q < qj; ++q) {
                    pc.quads.push_back(q);
                    skirtQuads[q].run = static_cast<long>(run);
                    skirtQuads[q].runVertex = static_cast<int>(q - qi);
                }
                auto pushVertex = [&](uint32_t upper, uint32_t lower) {
                    const Vec3& u = capPos[upper];
                    if (pc.sAt.empty()) pc.sAt.push_back(0.0);
                    else pc.sAt.push_back(pc.sAt.back() + std::hypot(static_cast<double>(u.x) - pc.xz.back()[0], static_cast<double>(u.z) - pc.xz.back()[1]));
                    pc.xz.push_back({static_cast<double>(u.x), static_cast<double>(u.z)});
                    pc.yUp.push_back(static_cast<double>(u.y));
                    pc.yLow.push_back(static_cast<double>(capPos[lower].y));
                };
                for (size_t q = qi; q < qj; ++q) pushVertex(skirtQuads[q].upperI, skirtQuads[q].lowerI);
                pushVertex(skirtQuads[qj - 1].upperN, skirtQuads[qj - 1].lowerN);
                fillPieces.push_back(std::move(pc));
                qi = qj;
            }
            for (size_t k = 0; k < capIsSkirt.size(); ++k) {
                if (capIsSkirt[k]) fillPieces[static_cast<size_t>(skirtQuads[skirtTriQuad[k]].run)].tris.push_back(k);
            }
        }

        // ---- windows: each piece's bounding frame plus the context, at one texel size that keeps the atlas within its limit
        const int gutter = 2;
        const int maxPx = std::max(256, P.fillAtlasMaxPx);
        double ts = P.fillTexel;
        int atlasW = 0, atlasH = 0;
        for (int attempt = 0; attempt < 64; ++attempt) {
            double texelsTotal = 0;
            std::vector<strip_fill::PackRect> rects(fillPieces.size());
            for (size_t i = 0; i < fillPieces.size(); ++i) {
                FillPiece& pc = fillPieces[i];
                if (pc.cap) {
                    double lo0 = 1e30, hi0 = -1e30, lo1 = 1e30, hi1 = -1e30;
                    for (size_t k : pc.tris) {
                        for (int j = 0; j < 3; ++j) {
                            const Vec3& p = capPos[capTris[3 * k + static_cast<size_t>(j)]];
                            lo0 = std::min(lo0, static_cast<double>(p.x)); hi0 = std::max(hi0, static_cast<double>(p.x));
                            lo1 = std::min(lo1, static_cast<double>(p.z)); hi1 = std::max(hi1, static_cast<double>(p.z));
                        }
                    }
                    pc.u0 = lo0 - ctx;
                    pc.v0 = lo1 - ctx;
                    pc.W = std::max(1, static_cast<int>(std::ceil((hi0 - lo0 + 2 * ctx) / ts)));
                    pc.H = std::max(1, static_cast<int>(std::ceil((hi1 - lo1 + 2 * ctx) / ts)));
                } else {
                    double ylo = 1e30, yhi = -1e30;
                    for (size_t j = 0; j < pc.sAt.size(); ++j) { ylo = std::min({ylo, pc.yUp[j], pc.yLow[j]}); yhi = std::max({yhi, pc.yUp[j], pc.yLow[j]}); }
                    pc.u0 = -ctx;
                    pc.v0 = yhi + ctx;
                    pc.W = std::max(1, static_cast<int>(std::ceil((pc.sAt.back() + 2 * ctx) / ts)));
                    pc.H = std::max(1, static_cast<int>(std::ceil((yhi - ylo + ctx) / ts)));
                }
                rects[i].w = pc.W;
                rects[i].h = pc.H;
                texelsTotal += double(pc.W + 2 * gutter) * double(pc.H + 2 * gutter);
            }
            int w = 256;
            while (w < maxPx && double(w) * double(w) < texelsTotal * 1.25) w *= 2;
            const int h = strip_fill::shelfPack(rects, w, gutter);
            if (h <= maxPx) {
                for (size_t i = 0; i < fillPieces.size(); ++i) fillPieces[i].rect = rects[i];
                atlasW = w;
                atlasH = h;
                break;
            }
            ts *= 1.2;
            if (attempt == 63) throw VegetationError("failed", "the fill of the strip's caps and skirts does not fit an atlas of " + std::to_string(maxPx) + " px");
        }
        st.fillTexelM = ts;
        st.fillAtlasW = atlasW;
        st.fillAtlasH = atlasH;

        // ---- colours for pieces with no real neighbour at all (generated, and said so)
        std::array<double, 3> capGenerated{0.5, 0.5, 0.5}, skirtGenerated{0.5, 0.5, 0.5};
        {
            std::array<double, 3> all{0.5, 0.5, 0.5};
            const bool haveAll = meanPhotoColour([](size_t) { return true; }, all);
            if (!meanPhotoColour([&](size_t t) { return normal[t].y >= 0.7f; }, capGenerated)) capGenerated = all;
            if (!meanPhotoColour([&](size_t t) { return std::abs(normal[t].y) < 0.5f && isArchitecture(t); }, skirtGenerated)) skirtGenerated = all;
            if (!haveAll) st.fillDegradations.push_back({"no_photo_colour", "tile", "the tile has no photographed kept triangle to take a colour from: pieces with no real neighbour are mid grey", 0.0, {0, 0, 0}});
            for (int k = 0; k < 3; ++k) st.fillGeneratedColourRgb[k] = capGenerated[static_cast<size_t>(k)];
        }

        // ---- raster each piece, find its real texels in the scan, carry the rest
        for (FillPiece& pc : fillPieces) {
            strip_fill::Patch& pt = pc.patch;
            pt.init(pc.W, pc.H, ts);
            auto rasterTri = [&](double ax, double ay, double bx, double by, double cx, double cy) {
                const double d = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
                if (std::abs(d) < 1e-12) return;
                const int i0 = std::max(0, static_cast<int>(std::floor(std::min({ax, bx, cx}) - 0.5))), i1 = std::min(pt.W - 1, static_cast<int>(std::ceil(std::max({ax, bx, cx}))));
                const int k0 = std::max(0, static_cast<int>(std::floor(std::min({ay, by, cy}) - 0.5))), k1 = std::min(pt.H - 1, static_cast<int>(std::ceil(std::max({ay, by, cy}))));
                for (int k = k0; k <= k1; ++k) {
                    for (int i = i0; i <= i1; ++i) {
                        const double x = i + 0.5, y = k + 0.5;
                        const double w1 = ((x - ax) * (cy - ay) - (cx - ax) * (y - ay)) / d, w2 = ((bx - ax) * (y - ay) - (x - ax) * (by - ay)) / d;
                        if (w1 >= -1e-9 && w2 >= -1e-9 && 1 - w1 - w2 >= -1e-9) pt.target[static_cast<size_t>(k) * static_cast<size_t>(pt.W) + static_cast<size_t>(i)] = 1;
                    }
                }
            };
            std::array<double, 3> sum{0, 0, 0};
            for (size_t k : pc.tris) {
                const Vec3 &a = capPos[capTris[3 * k]], &b = capPos[capTris[3 * k + 1]], &c = capPos[capTris[3 * k + 2]];
                sum = {sum[0] + (a.x + b.x + c.x) / 3, sum[1] + (a.y + b.y + c.y) / 3, sum[2] + (a.z + b.z + c.z) / 3};
                if (pc.cap) {
                    rasterTri((a.x - pc.u0) / ts, (a.z - pc.v0) / ts, (b.x - pc.u0) / ts, (b.z - pc.v0) / ts, (c.x - pc.u0) / ts, (c.z - pc.v0) / ts);
                    pc.areaM2 += 0.5 * static_cast<double>((b - a).cross(c - a).length());
                }
            }
            if (!pc.cap) {
                for (size_t j = 0; j + 1 < pc.sAt.size(); ++j) {
                    const double sI = (pc.sAt[j] - pc.u0) / ts, sN = (pc.sAt[j + 1] - pc.u0) / ts;
                    const double uI = (pc.v0 - pc.yUp[j]) / ts, uN = (pc.v0 - pc.yUp[j + 1]) / ts, lI = (pc.v0 - pc.yLow[j]) / ts, lN = (pc.v0 - pc.yLow[j + 1]) / ts;
                    rasterTri(sI, uI, sN, uN, sN, lN);
                    rasterTri(sI, uI, sN, lN, sI, lI);
                }
                for (size_t q : pc.quads) pc.areaM2 += skirtQuads[q].areaM2;
            }
            if (!pc.tris.empty()) pc.centre = {sum[0] / static_cast<double>(pc.tris.size()), sum[1] / static_cast<double>(pc.tris.size()), sum[2] / static_cast<double>(pc.tris.size())};

            // the texels to ask the scan about: every texel within the context of the piece
            const int rad = std::max(1, static_cast<int>(std::ceil(ctx / ts)));
            std::vector<uint8_t> wanted(pt.texels(), 0), tmp(pt.texels(), 0);
            for (int k = 0; k < pt.H; ++k) {
                int last = -1000000;
                for (int i = 0; i < pt.W; ++i) { if (pt.target[static_cast<size_t>(k) * pt.W + i]) last = i; if (i - last <= rad) tmp[static_cast<size_t>(k) * pt.W + i] = 1; }
                last = 1000000;
                for (int i = pt.W - 1; i >= 0; --i) { if (pt.target[static_cast<size_t>(k) * pt.W + i]) last = i; if (last - i <= rad) tmp[static_cast<size_t>(k) * pt.W + i] = 1; }
            }
            for (int i = 0; i < pt.W; ++i) {
                int last = -1000000;
                for (int k = 0; k < pt.H; ++k) { if (tmp[static_cast<size_t>(k) * pt.W + i]) last = k; if (k - last <= rad) wanted[static_cast<size_t>(k) * pt.W + i] = 1; }
                last = 1000000;
                for (int k = pt.H - 1; k >= 0; --k) { if (tmp[static_cast<size_t>(k) * pt.W + i]) last = k; if (last - k <= rad) wanted[static_cast<size_t>(k) * pt.W + i] = 1; }
            }
            std::vector<uint32_t> query;
            for (size_t i = 0; i < wanted.size(); ++i) if (wanted[i]) query.push_back(static_cast<uint32_t>(i));

            // skirt: where on the run's polyline a texel's arc length falls
            auto segmentAt = [&](double s) {
                size_t j = 0;
                while (j + 2 < pc.sAt.size() && s > pc.sAt[j + 1]) ++j;
                return j;
            };
            auto realAt = [&](uint32_t texelIndex, double surfaceTol) {
                const int col = static_cast<int>(texelIndex % static_cast<uint32_t>(pt.W)), row = static_cast<int>(texelIndex / static_cast<uint32_t>(pt.W));
                Vec3 q;
                double nx = 0, nz = 0;  // skirt: the horizontal normal of the run's segment
                const double u = pc.u0 + (col + 0.5) * ts;
                if (pc.cap) {
                    const double z = pc.v0 + (row + 0.5) * ts;
                    q = Vec3(static_cast<float>(u), static_cast<float>(capHeight(pc.crown, u, z)), static_cast<float>(z));
                } else {
                    const double y = pc.v0 - (row + 0.5) * ts;
                    const size_t j = segmentAt(u);
                    const double segLen = std::max(1e-9, pc.sAt[j + 1] - pc.sAt[j]);
                    const double t = (u - pc.sAt[j]) / segLen;  // beyond the run's ends the end segments continue straight
                    const double x = pc.xz[j][0] + (pc.xz[j + 1][0] - pc.xz[j][0]) * t, z = pc.xz[j][1] + (pc.xz[j + 1][1] - pc.xz[j][1]) * t;
                    nx = -(pc.xz[j + 1][1] - pc.xz[j][1]) / segLen;
                    nz = (pc.xz[j + 1][0] - pc.xz[j][0]) / segLen;
                    q = Vec3(static_cast<float>(x), static_cast<float>(y), static_cast<float>(z));
                }
                strip_fill::TriangleIndex::Hit hit;
                strip_fill::Rgb8 out;
                const bool found = fillIndex.closest(q, surfaceTol, [&](uint32_t t, const strip_fill::TriangleIndex::Hit&) {
                    if (removedBy[t] >= 0 || (veg[t] && !pc.allowVegetation)) return false;
                    if (pc.cap) return std::abs(static_cast<double>(normal[t].y)) >= P.fillNormalCos;
                    return std::abs(static_cast<double>(normal[t].x) * nx + static_cast<double>(normal[t].z) * nz) >= P.fillNormalCos;
                }, hit);
                if (!found) return std::make_pair(false, out);
                double rgb[3];
                photoAt(hit.tri, hit.w, rgb);
                if (!pc.allowVegetation && vegetationColour(rgb)) return std::make_pair(false, out);
                out.r = static_cast<uint8_t>(std::clamp(rgb[0] + 0.5, 0.0, 255.0));
                out.g = static_cast<uint8_t>(std::clamp(rgb[1] + 0.5, 0.0, 255.0));
                out.b = static_cast<uint8_t>(std::clamp(rgb[2] + 0.5, 0.0, 255.0));
                return std::make_pair(true, out);
            };
            auto findReal = [&](double surfaceTol) {
                std::atomic<size_t> found{0};
                detail::parallelFor(query.size(), P.threads, [&](size_t lo, size_t hi, int) {
                    size_t n = 0;
                    for (size_t i = lo; i < hi; ++i) {
                        const auto r = realAt(query[i], surfaceTol);
                        if (r.first) { pt.real[query[i]] = 1; pt.rgb[query[i]] = r.second; ++n; }
                    }
                    found += n;
                });
                return found.load();
            };
            // a piece standing off every facing surface around it (a cap on a raised level whose ring is lower, a
            // skirt beside a wall set back) is read again with a wider surface tolerance before it is given up:
            // texels from further off, at half the confidence, said so
            const double widenedTol = std::max(4.0 * P.fillSurfaceTol, 2.0);
            if (findReal(P.fillSurfaceTol) == 0 && findReal(widenedTol) > 0) pc.widened = true;
            pc.counts = strip_fill::fillFromNearest(pt, P.fillConfidenceScale);
            if (pc.widened) {
                pc.counts.confidenceSum *= 0.5;
                st.fillDegradations.push_back({"widened_surface_tolerance", pc.cap ? "cap" : "skirt",
                    std::string("no kept photographed surface facing the same way lies within ") + json::num(P.fillSurfaceTol) + " m of this " + (pc.cap ? "cap" : "skirt") +
                    ": its texels are read from such surfaces up to " + json::num(widenedTol) + " m off (a lower or higher level around it), at half the confidence",
                    pc.areaM2, pc.centre});
            }
            pc.sourced = pc.counts.sourced();
            if (!pc.sourced) {
                const auto& g = pc.cap ? capGenerated : skirtGenerated;
                strip_fill::Rgb8 c;
                c.r = static_cast<uint8_t>(std::clamp(g[0] * 255.0 + 0.5, 0.0, 255.0));
                c.g = static_cast<uint8_t>(std::clamp(g[1] * 255.0 + 0.5, 0.0, 255.0));
                c.b = static_cast<uint8_t>(std::clamp(g[2] * 255.0 + 0.5, 0.0, 255.0));
                std::fill(pt.rgb.begin(), pt.rgb.end(), c);
                st.fillDegradations.push_back({"no_real_neighbour", pc.cap ? "cap" : "skirt",
                    std::string("no kept photographed surface facing the same way lies within ") + json::num(ctx) + " m of this " + (pc.cap ? "cap" : "skirt") +
                    ": its texels are the tile's mean photo colour of such surfaces (generated, not sampled from the scan)",
                    pc.areaM2, pc.centre});
            }
            auto& kind = pc.cap ? st.fillCap : st.fillSkirt;
            ++kind.pieces;
            kind.areaM2 += pc.areaM2;
            kind.counts.targetTexels += pc.counts.targetTexels;
            kind.counts.realTexels += pc.counts.realTexels;
            kind.counts.carriedTexels += pc.counts.carriedTexels;
            kind.counts.unsourcedTexels += pc.counts.unsourcedTexels;
            kind.counts.carriedSumM += pc.counts.carriedSumM;
            kind.counts.carriedMaxM = std::max(kind.counts.carriedMaxM, pc.counts.carriedMaxM);
            kind.counts.confidenceSum += pc.counts.confidenceSum;
            if (!pc.sourced) { ++kind.piecesUnsourced; kind.areaUnsourcedM2 += pc.areaM2; }
            if (pc.widened) { ++kind.piecesWidened; kind.areaWidenedM2 += pc.areaM2; }
        }

        // ---- the atlas and the corners' coordinates
        fillAtlas = texture::ImageBuffer(atlasW, atlasH, 3, 0);
        for (int y = 0; y < atlasH; ++y) {
            for (int x = 0; x < atlasW; ++x) {
                const size_t o = fillAtlas.getIndex(x, y);
                fillAtlas.data[o] = static_cast<uint8_t>(std::clamp(capGenerated[0] * 255.0, 0.0, 255.0));
                fillAtlas.data[o + 1] = static_cast<uint8_t>(std::clamp(capGenerated[1] * 255.0, 0.0, 255.0));
                fillAtlas.data[o + 2] = static_cast<uint8_t>(std::clamp(capGenerated[2] * 255.0, 0.0, 255.0));
            }
        }
        for (const FillPiece& pc : fillPieces) {
            const strip_fill::Patch& pt = pc.patch;
            for (int y = -gutter; y < pt.H + gutter; ++y) {
                for (int x = -gutter; x < pt.W + gutter; ++x) {
                    const int sx = std::clamp(x, 0, pt.W - 1), sy = std::clamp(y, 0, pt.H - 1);
                    const strip_fill::Rgb8 c = pt.rgb[static_cast<size_t>(sy) * static_cast<size_t>(pt.W) + static_cast<size_t>(sx)];
                    const size_t o = fillAtlas.getIndex(pc.rect.x + x, pc.rect.y + y);
                    fillAtlas.data[o] = c.r; fillAtlas.data[o + 1] = c.g; fillAtlas.data[o + 2] = c.b;
                }
            }
        }
        auto setUv = [&](size_t tri, int corner, const FillPiece& pc, double col, double row) {
            capTriUv[6 * tri + 2 * static_cast<size_t>(corner)] = static_cast<float>((pc.rect.x + col) / atlasW);
            capTriUv[6 * tri + 2 * static_cast<size_t>(corner) + 1] = static_cast<float>((pc.rect.y + row) / atlasH);
        };
        for (const FillPiece& pc : fillPieces) {
            for (size_t k : pc.tris) {
                capTriSourced[k] = pc.sourced ? 1 : 0;
                for (int j = 0; j < 3; ++j) {
                    const uint32_t id = capTris[3 * k + static_cast<size_t>(j)];
                    const Vec3& p = capPos[id];
                    if (pc.cap) { setUv(k, j, pc, (p.x - pc.u0) / ts, (p.z - pc.v0) / ts); continue; }
                    const SkirtQuad& q = skirtQuads[skirtTriQuad[k]];
                    const size_t jv = static_cast<size_t>(q.runVertex);
                    const bool atI = id == q.upperI || id == q.lowerI;
                    setUv(k, j, pc, (pc.sAt[atI ? jv : jv + 1] - pc.u0) / ts, (pc.v0 - p.y) / ts);
                }
            }
        }
        fillAtlasPng = png::encode(fillAtlas, 6);
        if (fillAtlasPng.empty()) throw VegetationError("failed", "the fill atlas could not be encoded as PNG");
        st.fillPngBytes = fillAtlasPng.size();
    }

    // ---------------------------------------------------------------- output
    /**
     * The scan the removal took, as scanned (clay, no texture), one node per crown that took it, in crown order: the
     * removed trees, their drape and fragments, and cut canopy taken with them. Provenance "as-scanned"; positions are
     * quantised (KHR_mesh_quantization) with the error measured on the file.
     */
    void writeRemoved() {
        std::map<int, std::vector<size_t>> byCrown;  // record index -> triangles
        for (size_t t = 0; t < T; ++t) {
            if (removedBy[t] < 0) continue;
            const int ri = work[static_cast<size_t>(removedBy[t])].recordIndex;
            if (ri >= 0) byCrown[ri].push_back(t);
        }
        std::vector<staged_glb::StagedNode> nodes;
        size_t rank = 0;
        for (const auto& [ri, tris] : byCrown) {
            const CrownRecord& rec = R.crowns[static_cast<size_t>(ri)];
            staged_glb::StagedPrimitive pr;
            std::unordered_map<uint32_t, uint32_t> map;
            for (size_t t : tris) {
                for (int j = 0; j < 3; ++j) {
                    const uint32_t v = wtri[3 * t + static_cast<size_t>(j)];
                    auto it = map.find(v);
                    if (it == map.end()) { it = map.emplace(v, static_cast<uint32_t>(pr.positions.size())).first; pr.positions.push_back(weldPos[v]); }
                    pr.indices.push_back(it->second);
                }
            }
            staged_glb::StagedNode node;
            node.name = "scanned_crown_" + std::to_string(rec.id);
            node.primitives.push_back(std::move(pr));
            nodes.push_back(std::move(node));
            ++rank;
        }
        // extras once the count is known
        for (size_t k = 0; k < nodes.size(); ++k) {
            const auto& c = R.crowns[static_cast<size_t>(std::next(byCrown.begin(), static_cast<long>(k))->first)];
            staged_glb::NodeExtras sb;
            sb.stage = "trees";
            sb.provenance.label = "as-scanned";
            sb.provenance.measuredGeometry = true;
            sb.provenance.method = "the photo tiles' triangles the tree removal took for this crown (its canopy, drape and fragments), as scanned";
            sb.provenance.sources.push_back({"tile-extraction", "crown-" + std::to_string(c.id), "tile_vegetation strip"});
            sb.provenance.note = "put back as scanned when the trees are not rebuilt; crown status " + c.status;
            sb.buildOrder = static_cast<long long>(k);
            sb.buildCount = static_cast<long long>(nodes.size());
            sb.revealKind = "appear";
            sb.crownId = c.id;
            sb.vertices = static_cast<long long>(nodes[k].primitives[0].positions.size());
            sb.triangles = static_cast<long long>(nodes[k].primitives[0].indices.size() / 3);
            nodes[k].extrasJson = sb.toJson("\"crownId\":" + std::to_string(c.id));
        }
        staged_glb::WriteOptions opt;
        opt.generator = "Scratchbox tile_vegetation strip (the scanned trees it removed)";
        opt.rootName = "scanned_trees";
        opt.quantize = true;
        std::string members;
        std::string frameName = "tile frame: x east, y up, z south (metres)";
        if (R.frame.known) members = "\"frame\":\"x = east, y = up, z = south (metres)\"";
        opt.rootExtrasJson = staged_glb::rootExtrasJson("trees", "", frameName, std::string(), members);
        try {
            R.removedGlb = staged_glb::write(nodes, opt);
        } catch (const staged_glb::StagedGlbError& e) {
            throw VegetationError("failed", std::string("the removed trees could not be written: ") + e.what());
        }
        R.removedNodes = nodes.size();
    }

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
        // cap (ground or roof where a tree stood) and skirt (vertical, along the hole edges) primitives: flat-shaded corners.
        // With fill, their texels come from the atlas, and pieces with no real neighbour at all are kept apart (generated).
        Prim cap, skirt, capGenerated, skirtGenerated;
        for (size_t k = 0; k < capTris.size() / 3; ++k) {
            const bool generated = P.fill && !capTriSourced[k];
            Prim& pr = capIsSkirt[k] ? (generated ? skirtGenerated : skirt) : (generated ? capGenerated : cap);
            const Vec3 &a = capPos[capTris[3 * k]], &b = capPos[capTris[3 * k + 1]], &c = capPos[capTris[3 * k + 2]];
            Vec3 n = (b - a).cross(c - a);
            n = n.lengthSquared() > 1e-20f ? n.normalized() : Vec3(0, 1, 0);
            int corner = 0;
            for (const Vec3* p : {&a, &b, &c}) {
                pr.p.insert(pr.p.end(), {p->x, p->y, p->z});
                pr.n.insert(pr.n.end(), {n.x, n.y, n.z});
                if (P.fill) pr.uv.insert(pr.uv.end(), {capTriUv[6 * k + 2 * static_cast<size_t>(corner)], capTriUv[6 * k + 2 * static_cast<size_t>(corner) + 1]});
                else pr.uv.insert(pr.uv.end(), {0.0f, 0.0f});
                ++corner;
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
        // the legacy flat clay of caps and skirts (fill off)
        const size_t capMaterial = materials.size();
        if (!P.fill) materials.push_back("{\"name\":\"VegetationRemovedCap\",\"pbrMetallicRoughness\":{\"baseColorFactor\":[0.55,0.57,0.6,1],\"metallicFactor\":0,\"roughnessFactor\":0.85}}");
        // the fill atlas: a texture of its own, laid like the tile's own materials (the one most of the kept tile uses)
        if (P.fill) {
            size_t proto = 0;
            for (size_t mi = 1; mi < M; ++mi) if (prims[mi].i.size() > prims[proto].i.size()) proto = mi;
            const gltf::SceneMaterial protoMat = proto < scene.materials.size() ? scene.materials[proto] : gltf::SceneMaterial{};
            const int view = gb.addView(fillAtlasPng.data(), fillAtlasPng.size(), 0);
            images.push_back("{\"mimeType\":\"image/png\",\"bufferView\":" + std::to_string(view) + "}");
            samplers.push_back("{\"magFilter\":9729,\"minFilter\":9729,\"wrapS\":33071,\"wrapT\":33071}");
            textures.push_back("{\"source\":" + std::to_string(images.size() - 1) + ",\"sampler\":" + std::to_string(samplers.size() - 1) + "}");
            std::string s = "{\"name\":\"VegetationFill\",\"pbrMetallicRoughness\":{\"baseColorFactor\":[1,1,1,1],\"baseColorTexture\":{\"index\":" + std::to_string(textures.size() - 1) +
                            "},\"metallicFactor\":" + json::num(protoMat.metallicFactor) + ",\"roughnessFactor\":" + json::num(protoMat.roughnessFactor) + "}";
            if (protoMat.doubleSided) s += ",\"doubleSided\":true";
            if (protoMat.unlit) { s += ",\"extensions\":{\"KHR_materials_unlit\":{}}"; anyUnlit = true; }
            s += ",\"extras\":{\"scratchbox\":{\"photoInferredFill\":true}}}";
            materials.push_back(s);
        }
        const size_t fillMaterial = materials.size() - 1;
        // provenance of a fill primitive: what its pieces were sourced from, with the confidence the carry distance leaves
        auto fillExtras = [&](bool isCap, bool sourced) -> std::string {
            if (!P.fill) return std::string();
            strip_fill::FillCounts fc;
            size_t pieces = 0, widened = 0;
            double areaM2 = 0;
            for (const auto& pc : fillPieces) {
                if (pc.cap != isCap || pc.sourced != sourced) continue;
                ++pieces;
                if (pc.widened) ++widened;
                areaM2 += pc.areaM2;
                fc.targetTexels += pc.counts.targetTexels; fc.realTexels += pc.counts.realTexels; fc.carriedTexels += pc.counts.carriedTexels;
                fc.unsourcedTexels += pc.counts.unsourcedTexels; fc.carriedSumM += pc.counts.carriedSumM; fc.carriedMaxM = std::max(fc.carriedMaxM, pc.counts.carriedMaxM);
                fc.confidenceSum += pc.counts.confidenceSum;
            }
            staged_glb::Provenance pv;
            pv.measuredGeometry = false;
            pv.sources.push_back({"tile-extraction", isCap ? "hole-ring" : "hole-edge-surface", "tile_vegetation strip"});
            if (sourced) {
                pv.label = "photo-inferred";
                pv.confidence = fc.meanConfidence();
                pv.method = isCap ? "the ground or roof under a removed tree: texels sampled from the kept scan's own photo of the surface around the hole (nadir), carried across it from the nearest real texel"
                                  : "the wall or side a removed tree hid: texels sampled from the kept scan's own photo of the surface the skirt continues, carried down from the nearest real texel";
                pv.note = std::to_string(fc.realTexels) + " texels with a real photo of their own, " + std::to_string(fc.carriedTexels) + " carried (mean " + json::num(fc.meanCarriedM()) +
                          " m, at most " + json::num(fc.carriedMaxM) + " m from a real texel; confidence exp(-d / " + json::num(P.fillConfidenceScale) + " m))" +
                          (widened ? "; " + std::to_string(widened) + " of " + std::to_string(pieces) + " pieces read from surfaces up to " + json::num(std::max(4.0 * P.fillSurfaceTol, 2.0)) + " m off their own level, at half the confidence" : "");
            } else {
                pv.label = "generated";
                pv.confidence = 0.0;
                pv.method = "no kept photographed surface facing the same way lies near: the tile's mean photo colour of such surfaces, not sampled from the surface itself";
                pv.note = std::to_string(pieces) + " pieces with no real neighbour";
            }
            std::string e = "{\"scratchbox\":{\"stripFill\":{\"kind\":" + json::str(isCap ? "cap" : "skirt") + ",\"pieces\":" + std::to_string(pieces) + ",\"areaM2\":" + json::num(areaM2) +
                            ",\"texels\":{\"target\":" + std::to_string(fc.targetTexels) + ",\"real\":" + std::to_string(fc.realTexels) + ",\"carried\":" + std::to_string(fc.carriedTexels) +
                            ",\"unsourced\":" + std::to_string(fc.unsourcedTexels) + "},\"texelM\":" + json::num(R.stats.fillTexelM) + ",\"provenance\":" + pv.toJson() + "}}}";
            return e;
        };
        auto addPrim = [&](Prim& pr, size_t material, const std::string& name, const std::string& extras = std::string()) {
            if (pr.i.empty()) return;
            const int aP = gb.addFloatAccessor(pr.p, 3, true), aN = gb.addFloatAccessor(pr.n, 3, false), aUV = gb.addFloatAccessor(pr.uv, 2, false), aI = gb.addIndexAccessor(pr.i);
            meshes.push_back("{\"name\":" + json::str(name) + ",\"primitives\":[{\"attributes\":{\"POSITION\":" + std::to_string(aP) + ",\"NORMAL\":" + std::to_string(aN) +
                             ",\"TEXCOORD_0\":" + std::to_string(aUV) + "},\"indices\":" + std::to_string(aI) + ",\"material\":" + std::to_string(material) + ",\"mode\":4}]}");
            nodes.push_back("{\"name\":" + json::str(name) + ",\"mesh\":" + std::to_string(meshes.size() - 1) + (extras.empty() ? std::string() : ",\"extras\":" + extras) + "}");
            children.push_back(std::to_string(nodes.size()));
        };
        for (size_t mi = 0; mi < M; ++mi) addPrim(prims[mi], mi, "tile_m" + std::to_string(mi));
        const size_t stripMaterial = P.fill ? fillMaterial : capMaterial;
        addPrim(cap, stripMaterial, "vegetation_removed_cap", fillExtras(true, true));
        addPrim(skirt, stripMaterial, "vegetation_removed_skirt", fillExtras(false, true));
        addPrim(capGenerated, stripMaterial, "vegetation_removed_cap_generated", fillExtras(true, false));
        addPrim(skirtGenerated, stripMaterial, "vegetation_removed_skirt_generated", fillExtras(false, false));
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
      << ",\"sampleSpacing\":" << json::numPrecise(P.sampleSpacing) << ",\"supportBand\":" << json::num(P.supportBand)
      << ",\"minSupportEvidence\":" << json::num(P.minSupportEvidence) << ",\"groundTolerance\":" << json::num(P.groundTolerance) << "},\n";
    // how the trees were regrown to decide which to remove: plant grows them again with exactly these
    char seedHex[17];
    std::snprintf(seedHex, sizeof(seedHex), "%016llx", static_cast<unsigned long long>(P.growth.seed));
    s << "\"growth\":{\"seed\":" << json::str(seedHex) << ",\"crownBaseRatio\":" << json::numPrecise(P.growth.crownBaseRatio)
      << ",\"crownBaseRatioExplicit\":" << (P.growth.crownBaseRatioExplicit ? "true" : "false")
      << ",\"trunkRadiusPerHeight\":" << json::numPrecise(P.growth.trunkRadiusPerHeight)
      << ",\"trunkRadiusPerHeightExplicit\":" << (P.growth.trunkRadiusPerHeightExplicit ? "true" : "false") << ",\"shellDepth\":" << json::numPrecise(P.growth.shellDepth)
      << ",\"minSurfaceReached\":" << json::numPrecise(P.growth.minSurfaceReached) << ",\"crownBaseSpread\":" << json::numPrecise(P.growth.crownBaseSpread)
      << ",\"branchAngleSpreadRad\":" << json::num(std::stod(detail::fixed(P.growth.morphology.branchAngleSpreadRad, 6))) << ",\"trunkLeanShare\":" << json::numPrecise(P.growth.trunkLeanShare)
      << ",\"apicalDominance\":" << json::num(std::stod(detail::fixed(P.growth.morphology.apicalDominance, 6))) << ",\"branchAngleMeanRad\":" << json::num(std::stod(detail::fixed(P.growth.morphology.branchAngleMeanRad, 6)))
      << ",\"internodeLengthM\":" << json::num(std::stod(detail::fixed(P.growth.morphology.internodeLengthM, 6)))
      << ",\"excurrentTopShareLo\":" << json::numPrecise(P.growth.excurrentTopShareLo) << ",\"excurrentTopShareHi\":" << json::numPrecise(P.growth.excurrentTopShareHi)
      << ",\"excurrentApicalLo\":" << json::numPrecise(P.growth.excurrentApicalLo) << ",\"excurrentApicalHi\":" << json::numPrecise(P.growth.excurrentApicalHi) << "},\n";
    // the species library the crowns were grown with (plant must grow them with the same one)
    if (P.growth.species) s << "\"species\":{\"schema\":" << json::str(P.growth.species->schema) << ",\"index\":" << json::str(P.growth.speciesIndex) << ",\"entries\":" << P.growth.species->entries.size()
                             << ",\"place\":" << tree_species::placeJson(*P.growth.species, P.growth.speciesChoice, P.growth.latAbsDeg) << "},\n";
    s << "\"crowns\":[";
    for (size_t i = 0; i < r.crowns.size(); ++i) {
        const auto& c = r.crowns[i];
        s << (i ? ",\n" : "\n") << "{\"id\":" << c.id << ",\"status\":" << json::str(c.status) << ",\"reachesBoundary\":" << (c.reachesBoundary ? "true" : "false") << ",\"apex\":" << v3(c.apex)
          << ",\"stem\":[" << json::numPrecise(c.stemX) << "," << json::numPrecise(c.stemZ) << "],\"supportY\":" << json::numPrecise(c.supportY)
          << ",\"supportTilt\":[" << json::num(c.tiltX) << "," << json::num(c.tiltZ) << "]"
          << ",\"supportSource\":" << json::str(c.supportSource) << (c.supportNote.empty() ? std::string() : ",\"supportNote\":" + json::str(c.supportNote)) << ",\"terrainY\":" << json::num(c.terrainY)
          << ",\"apexAboveSupport\":" << json::num(c.apexAboveSupport) << ",\"areaM2\":" << json::numPrecise(c.areaM2);
        // what the scan shows under the crown: per surface [height at the stem, share of the footprint's lines meeting
        // it, lines in the inner half meeting it, 1 when the line through the stem meets it]
        s << ",\"supportEvidence\":{\"probes\":" << c.evidence.probes << ",\"innerProbes\":" << c.evidence.innerProbes << ",\"surfaces\":[";
        for (size_t k = 0; k < c.evidence.surfaces.size(); ++k) {
            const auto& u = c.evidence.surfaces[k];
            s << (k ? "," : "") << "[" << json::num(u.yAtStem) << "," << json::num(u.coverage) << "," << u.innerProbes << "," << (u.stemHit ? 1 : 0) << "]";
        }
        s << "]}";
        if (std::isfinite(c.surroundingY)) s << ",\"surroundingY\":" << json::num(c.surroundingY);
        if (c.groundChecked) s << ",\"groundAtStemY\":" << json::num(c.groundAtStemY);
        if (c.supportMovedM != 0) s << ",\"supportMovedM\":" << json::num(c.supportMovedM);
        s << ",\"sectorRadii\":[";
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
            s << ",\"surfaceMassesNeeded\":" << c.regrowthSurfaceMassesNeeded;
            if (c.regrowthMeshed) {
                // the tree meshed within its own budget: what its delivered leaf masses reach (see meshCrown)
                s << ",\"ownBudget\":" << c.regrowthBudget << ",\"leaves\":{\"masses\":" << c.regrowthLeafMasses << ",\"surfaceMasses\":" << c.regrowthSurfaceMasses
                  << ",\"surfaceReached\":" << c.regrowthLeavesReached << ",\"surfaceShare\":" << json::num(c.regrowthLeavesShare) << ",\"topY\":" << json::num(c.regrowthLeavesTopY) << "}";
            }
            if (!c.regrowthFailure.empty()) s << ",\"reasonCode\":" << json::str(c.regrowthFailureCode) << ",\"reason\":" << json::str(c.regrowthFailure);
            s << ",\"colonisation\":" << json::str(c.regrowthColonisation) << "}";
        }
        if (!c.groundReason.empty()) s << ",\"ground\":{\"reasonCode\":" << json::str(c.groundReasonCode) << ",\"reason\":" << json::str(c.groundReason) << "}";
        if (c.keptSkirtAreaM2 > 0) {
            // kept as scanned, its side over rebuilt ground closed down to it: not in the scan
            s << ",\"keptSkirt\":{\"areaM2\":" << json::num(c.keptSkirtAreaM2) << ",\"topY\":" << json::num(c.keptSkirtTopY) << ",\"bottomY\":" << json::num(c.keptSkirtBottomY) << "}";
        }
        if (!c.walls.empty()) {
            // the scanned walls the removed crown touched (measured: kept wall triangles beside its removed triangles,
            // by plane): plant grows the tree on the crown's side of each
            s << ",\"walls\":[";
            for (size_t w = 0; w < c.walls.size(); ++w) {
                const auto& cw = c.walls[w];
                s << (w ? "," : "") << "{\"point\":[" << json::num(cw.point.x) << "," << json::num(cw.point.y) << "," << json::num(cw.point.z) << "],\"normal\":["
                  << json::num(cw.normal.x) << "," << json::num(cw.normal.y) << "," << json::num(cw.normal.z) << "],\"tangent\":["
                  << json::num(cw.tangent.x) << "," << json::num(cw.tangent.y) << "," << json::num(cw.tangent.z) << "],\"halfAlongM\":" << json::num(cw.halfAlongM)
                  << ",\"halfUpM\":" << json::num(cw.halfUpM) << ",\"areaM2\":" << json::num(cw.areaM2) << "}";
            }
            s << "]";
        }
        if (c.colourKnown) {
            // measured in the tile's photo (linear sRGB): see measureCrownColour
            s << ",\"colour\":{\"meanLinearRgb\":[" << json::num(c.colourMean[0]) << "," << json::num(c.colourMean[1]) << "," << json::num(c.colourMean[2])
              << "],\"spreadLinearRgb\":[" << json::num(c.colourSpread[0]) << "," << json::num(c.colourSpread[1]) << "," << json::num(c.colourSpread[2])
              << "],\"samples\":" << c.colourSamples << ",\"cells\":" << c.colourCells << ",\"greenShare\":" << json::num(c.greenShare)
              << ",\"hueDeg\":" << json::num(c.hueDeg) << ",\"chroma\":" << json::num(c.chroma) << "}";
        }
        if (c.regrowthChecked) s << detail::crownSpeciesMembers(c.hasSpecies, c.species, c.regrowthStems, c.regrowthCrownBaseRatio, c.regrowthTrunkRadiusPerHeight, P.growth);
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
    {
        // what each category of skirt did: built, or not built because the real scan has the surface behind it
        auto decision = [&](const char* name, size_t k, bool last) {
            s << "\"" << name << "\": {\"kept\": {\"count\": " << st.skirtKept[k].count << ", \"areaM2\": " << json::num(st.skirtKept[k].areaM2) << "}, \"shortened\": {\"count\": "
              << st.skirtShortened[k].count << ", \"areaRemovedM2\": " << json::num(st.skirtShortened[k].areaM2) << "}, \"dropped\": {\"count\": "
              << st.skirtDropped[k].count << ", \"areaM2\": " << json::num(st.skirtDropped[k].areaM2) << "}}" << (last ? "" : ", ");
        };
        s << "  \"skirtDecisions\": {";
        decision("onWalls", 0, false);
        decision("onLevelSurfaces", 1, false);
        decision("onKeptCanopy", 2, false);
        decision("onOther", 3, true);
        s << ", \"openEdgesAtDroppedSkirts\": " << st.openEdgesAtDroppedSkirts << "},\n";
        auto kind = [&](const char* name, const StripStats::FillKind& k, bool last) {
            s << "\"" << name << "\": {\"pieces\": " << k.pieces << ", \"piecesGenerated\": " << k.piecesUnsourced << ", \"piecesWidened\": " << k.piecesWidened << ", \"areaM2\": " << json::num(k.areaM2) << ", \"generatedAreaM2\": " << json::num(k.areaUnsourcedM2) << ", \"widenedAreaM2\": " << json::num(k.areaWidenedM2)
              << ", \"texels\": {\"target\": " << k.counts.targetTexels << ", \"real\": " << k.counts.realTexels << ", \"carried\": " << k.counts.carriedTexels << ", \"generated\": " << k.counts.unsourcedTexels
              << "}, \"meanCarriedM\": " << json::num(k.counts.meanCarriedM()) << ", \"maxCarriedM\": " << json::num(k.counts.carriedMaxM) << ", \"meanConfidence\": " << json::num(k.counts.meanConfidence()) << "}" << (last ? "" : ", ");
        };
        const double capClay = st.fillEnabled ? 0.0 : st.capAreaM2;
        const double skirtClay = st.fillEnabled ? 0.0 : st.skirtAreaOnWallsM2 + st.skirtAreaOnLevelSurfacesM2 + st.skirtAreaOnKeptCanopyM2 + st.skirtAreaOnOtherM2;
        s << "  \"fill\": {\"enabled\": " << (st.fillEnabled ? "true" : "false") << ", \"texelM\": " << json::num(st.fillTexelM) << ", \"atlas\": {\"width\": " << st.fillAtlasW << ", \"height\": " << st.fillAtlasH
          << ", \"pngBytes\": " << st.fillPngBytes << "}, \"capAreaM2\": " << json::num(st.capAreaM2) << ", \"clayAreaM2\": {\"cap\": " << json::num(capClay) << ", \"skirt\": " << json::num(skirtClay) << "}, ";
        kind("cap", st.fillCap, false);
        kind("skirt", st.fillSkirt, false);
        s << "\"generatedColourSrgb\": [" << json::num(st.fillGeneratedColourRgb[0]) << ", " << json::num(st.fillGeneratedColourRgb[1]) << ", " << json::num(st.fillGeneratedColourRgb[2]) << "], \"degradations\": [";
        for (size_t i = 0; i < st.fillDegradations.size(); ++i) {
            const auto& d = st.fillDegradations[i];
            s << (i ? ", " : "") << "{\"code\": " << json::str(d.code) << ", \"kind\": " << json::str(d.kind) << ", \"areaM2\": " << json::num(d.areaM2) << ", \"centre\": [" << json::num(d.centre[0]) << ", "
              << json::num(d.centre[1]) << ", " << json::num(d.centre[2]) << "], \"reason\": " << json::str(d.reason) << "}";
        }
        s << "]},\n";
    }
    s << "  \"buildingGuard\": {\"facadeGuardM\": " << json::num(st.guardM) << ", \"facadeGuardCos\": " << json::num(st.guardCos)
      << ", \"removedOnBuilding\": {\"before\": {\"onWalls\": " << st.guardBefore.onWalls << ", \"onLevelSurfaces\": " << st.guardBefore.onLevelSurfaces
      << "}, \"after\": {\"onWalls\": " << st.guardAfter.onWalls << ", \"onLevelSurfaces\": " << st.guardAfter.onLevelSurfaces << "}}"
      << ", \"keptAsBuilding\": {\"count\": " << st.guardKeptAsBuilding << ", \"areaM2\": " << json::num(st.guardKeptAsBuildingM2) << "}"
      << ", \"removedMeetingAlongEdge\": {\"onWalls\": " << st.creaseOnWalls << ", \"onLevelSurfaces\": " << st.creaseOnLevelSurfaces << ", \"onOther\": " << st.creaseOnOther << "}"
      << ", \"crownsWithWalls\": " << st.crownsWithWalls << ", \"crownWalls\": " << st.crownWalls << "},\n";
    s << "  \"drape\": {\"sheets\": " << st.drapeSheets << ", \"sheetAreaM2\": " << json::num(st.drapeSheetAreaM2) << ", \"canopyTakenWithTreesM2\": " << json::num(st.canopyTakenWithTreesM2)
      << ", \"fragmentsTaken\": " << st.fragmentsTaken << ", \"fragmentAreaTakenM2\": " << json::num(st.fragmentAreaTakenM2) << "},\n";
    s << "  \"canopyAreaM2\": " << json::num(st.canopyAreaM2) << ",\n  \"treeCanopyAreaM2\": " << json::num(st.treeCanopyAreaM2) << ",\n";
    s << "  \"crowns\": {\"tree\": " << st.crownsTree << ", \"treesReachingBoundary\": " << st.treesReachingBoundary << ", \"belowMinHeight\": " << st.crownsLow
      << ", \"cutAtBoundary\": " << st.crownsCut << ", \"cutAtBoundaryRemoved\": " << st.crownsCutRemoved << ", \"tooSmall\": " << st.crownsTooSmall
      << ", \"noMeasuredGround\": " << st.crownsNoGround << ", \"hangingBelowSupport\": " << st.crownsHangingBelowSupport << ", \"raisedLevelNotShown\": " << st.crownsRaisedLevelNotShown << ", \"supportedUnderStem\": " << st.crownsSupportedUnderStem
      << ", \"outsideRoi\": " << st.crownsOutsideRoi << ", \"supportedUnderFootprint\": " << st.crownsSupportedUnderFootprint << ", \"supportUndecided\": " << st.crownsSupportUndecided << ", \"notRegrowable\": " << st.crownsNotRegrowable << "},\n";
    // trunk bases measured against the ground the removal rebuilt (or kept) under their stems, pass by pass
    s << "  \"trunkGround\": {\"passes\": " << st.groundPasses << ", \"restood\": " << st.trunksRestood << ", \"supportUndecided\": " << st.crownsSupportUndecided
      << ", \"offRebuiltGroundAfterLastPass\": " << st.trunksOffRebuiltGround << "},\n";
    // trees the regrown SB-Veggie tree does not fill, kept as scanned, each with the reason
    auto keptSkirt = [](const CrownRecord& c) {
        if (!(c.keptSkirtAreaM2 > 0)) return std::string();
        return ", \"keptSkirt\": {\"areaM2\": " + json::num(c.keptSkirtAreaM2) + ", \"topY\": " + json::num(c.keptSkirtTopY) + ", \"bottomY\": " + json::num(c.keptSkirtBottomY) + "}";
    };
    s << "  \"notRegrowable\": [";
    {
        size_t n = 0;
        for (const auto& c : r.crowns) {
            if (c.status != "not_regrowable") continue;
            s << (n++ ? ", " : "") << "{\"crownId\": " << c.id << ", \"reasonCode\": " << json::str(c.regrowthFailureCode) << ", \"reason\": " << json::str(c.regrowthFailure)
              << ", \"colonisation\": " << json::str(c.regrowthColonisation) << ", \"areaM2\": " << json::num(c.areaM2) << ", \"heightM\": " << json::num(c.apexAboveSupport) << keptSkirt(c) << "}";
        }
    }
    s << "],\n";
    // trees whose crown hangs below the surface measured around them: their ground is not measured, kept as scanned
    s << "  \"hangingBelowSupport\": [";
    {
        size_t n = 0;
        for (const auto& c : r.crowns) {
            if (c.status != "no_measured_ground" || c.groundReasonCode != "crown_below_support") continue;
            s << (n++ ? ", " : "") << "{\"crownId\": " << c.id << ", \"reason\": " << json::str(c.groundReason) << ", \"areaM2\": " << json::num(c.areaM2)
              << ", \"apexY\": " << json::num(c.apex.y) << keptSkirt(c) << "}";
        }
    }
    s << "],\n";
    // trees whose trunk base the ground rebuilt under their stem did not hold: what they stand on is undecided, kept as scanned
    s << "  \"supportUndecided\": [";
    {
        size_t n = 0;
        for (const auto& c : r.crowns) {
            if (c.status != "no_measured_ground" || c.groundReasonCode != "support_undecided") continue;
            s << (n++ ? ", " : "") << "{\"crownId\": " << c.id << ", \"reason\": " << json::str(c.groundReason) << ", \"areaM2\": " << json::num(c.areaM2)
              << ", \"apexY\": " << json::num(c.apex.y) << keptSkirt(c) << "}";
        }
    }
    s << "],\n";
    s << "  \"cutCanopyRemovedM2\": " << json::num(st.cutCanopyRemovedM2) << ",\n";
    s << "  \"keepCells\": " << st.keepCells << ", \"keptStructureTriangles\": " << st.keptStructureTriangles << ",\n";
    s << "  \"removedAsScanned\": {\"nodes\": " << r.removedNodes << ", \"bytes\": " << r.removedGlb.size() << "},\n";
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


struct PlantedTree {
    int crownId{0};
    double excurrence{0}, topShare{0};   // how excurrent it grew, from its measured top share (CrownGrowth)
    double leaderHold{0};                // how firmly its leader held its course to the apex (CrownGrowth)
    uint32_t seed{0};
    size_t target{0};                // triangles this crown's size asks for (crownTriangleTarget)
    size_t needed{0};                // triangles its leaf masses on the measured surface need (trianglesForLeafMasses)
    size_t ownBudget{0};             // its own budget: the larger of the two (crownOwnBudget)
    size_t budget{0};                // triangles it was given
    nature::TreeBudgetReport report;
    nature::ColonizationReport colonisation;
    geometry::Mesh wood, foliage;    // level 2: the shipped blob tree (wood within its woodShare, leaf masses)
    nature::MeshGrowth growth;       // when each wood and foliage vertex grew (node creation order), for the reveal
    tree_lod::TreeLod lod;           // levels 0 and 1 (PlantParams::lod): wood with the whole budget, twigs and leaf-cluster instances
    bool hasLod{false};
    double lodMs{0};                 // wall time building levels 0 and 1
    double crownBaseRatio{0};        // this crown's (growth.crownBaseRatio varied by its seeded spread)
    double trunkRadiusPerHeight{0};  // the ratio its trunk radius came from (the species entry's, else the growth's)
    double heightAboveSupport{0}, crownBaseY{0}, trunkRadius{0};
    double grownShare{0}, reachRadius{0};  // the grown skeleton's leaf nodes: share of the measured surface within reach
    FoliageReach leaves;             // the delivered leaf masses: what they reach of the measured surface, and how high
    FoliageReach leavesStrict;       // ... within 1 m of a leaf triangle (the yardstick the leaf levels are measured with)
    std::string shortOfCrown;        // why its delivered leaves do not fill its crown within its budget (empty: they do)
    bool groundChecked{false};
    double groundGapM{std::numeric_limits<double>::quiet_NaN()};  // trunk base minus the nearest ground-mesh surface at its stem (NaN: none there)
    bool offGround{false};           // ... further than groundTolerance from it, or no surface there
    // buildings win over trees: the scanned walls the crown was kept off, and the attractors and surface samples left out
    size_t wallsClipped{0}, attractorsClipped{0}, attractorsTotal{0}, surfaceClipped{0};
    std::string keptOffWallsShort;   // ... and why the tree grown off the wall does not fill the crown measured against it (empty: it does)
    const io::GlbJsonValue* crown{nullptr};
    // the textures chosen for it from PlantParams::textures (hasTextures false without a library)
    bool hasTextures{false};
    tree_textures::TreeAppearance look;
    tree_textures::Choice textures;
    // the species entry it grew with (GrowthParams::species; hasSpecies false without a library) and its stems
    bool hasSpecies{false};
    tree_species::Choice species;
    int stems{1};
    // the photo-inferred correction its crown was grown with (hasCorrection false: the measured crown as is)
    bool hasCorrection{false};
    CrownCorrection correction;
    std::string correctionDropped;   // why a correction given for it was not applied (empty: none given, or applied)
};

struct PlantResult {
    std::vector<PlantedTree> trees;
    std::shared_ptr<tree_lod::ClusterLibrary> library;  // the leaf clusters and twig every tree's instances copy (PlantParams::lod)
    std::vector<std::pair<int, std::string>> skipped;  // crown id, reason
    std::vector<int> keptOnSupport, keptNotOnSupport;  // with a support mesh: trees kept as scanned on it, and not on it
    size_t triangles{0};
    double triangleBudget{0};        // what all trees were given together
    std::string budgetSource;        // explicit | crown_targets | crown_targets_capped (a label; nothing branches on it)
    size_t targetTriangles{0};       // sum of the trees' own budgets (what they ask for without a budget)
    size_t neededTriangles{0};       // sum of what their leaf masses on the measured surface need
    size_t shortOfCrown{0};          // trees whose delivered leaves do not fill their crown within their budget
    bool groundChecked{false};
    size_t offGround{0};             // trees whose trunk base is not on the ground mesh (within groundTolerance)
    size_t clippedAtWalls{0};        // trees whose crown was kept off a scanned wall (GrowthParams::wallClearance)
    size_t attractorsClipped{0}, attractorsAtClippedCrowns{0};
    double ms{0};
};

namespace detail {

inline Vec3 vec3Of(const io::GlbJsonValue& v) {
    return Vec3(static_cast<float>(v[0].num), static_cast<float>(v[1].num), static_cast<float>(v[2].num));
}


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

/**
 * Grows one tree per crown with status "tree" (growCrown, the same trees strip grew to decide what to remove) and meshes
 * each within its share of the triangle budget. `supportMesh` (optional, isolate requests) keeps only crowns whose trunk
 * base lies on that mesh within supportTolerance of the measured support. `groundMesh` (optional: the model the trees
 * are mounted on) is probed under every stem: a trunk base further than groundTolerance from its surfaces there, or with
 * none there, is reported (offGround), never moved.
 *
 * Budget: each tree has its own budget (crownOwnBudget: its crown's target, and at least what its leaf masses on the
 * measured surface need). Without a budget of the caller's, each tree gets its own, all within sceneTriangleCap; the
 * call fails only when minTrianglesPerTree for every tree exceeds that cap. An explicit triangleBudget (which fails when
 * it cannot give each tree minTrianglesPerTree) or a cap below the trees' own budgets is spread so that the trees get
 * what their leaf masses need first, and the rest in proportion to what they ask beyond it.
 *
 * Every tree's delivered leaf masses are measured against its crown (meshCrown); a tree whose leaves do not fill it
 * within the budget it was given is reported (shortOfCrown, with why), not substituted. A crown that does not regrow
 * into its measured crown at all fails the call, naming each: a crown strip removed is one it regrew with these
 * parameters and seed, so this means plant was given others.
 */
inline PlantResult plant(const io::GlbJsonValue& crownsDoc, const PlantParams& P,
                         const std::vector<Vec3>* supportPositions = nullptr, const std::vector<uint32_t>* supportIndices = nullptr,
                         const std::vector<Vec3>* groundPositions = nullptr, const std::vector<uint32_t>* groundIndices = nullptr) {
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
    detail::VerticalProbe ground;
    if (groundPositions && groundIndices) {
        if (groundIndices->empty()) throw VegetationError("bad_input", "the ground mesh has no triangles");
        ground.build(*groundPositions, *groundIndices);
    }
    PlantResult R;
    std::vector<const io::GlbJsonValue*> chosen;
    auto onSupport = [&](const io::GlbJsonValue& c) {
        const double sx = c["stem"][0].num, sz = c["stem"][1].num, sy = c["supportY"].num;
        bool on = false;
        for (double h : probe.heightsAt(sx, sz)) on = on || std::abs(h - sy) <= P.supportTolerance;
        return on;
    };
    for (const auto& c : crowns.arr) {
        const int id = c["id"].asInt(-1);
        // trees kept as scanned (not_regrowable): with a support mesh, say which stand on it, so an isolate request
        // names only those
        if (probe.p && c["status"].asString() == "not_regrowable") (onSupport(c) ? R.keptOnSupport : R.keptNotOnSupport).push_back(id);
        if (c["status"].asString() != "tree") continue;
        if (c["samples"].arr.size() < 3) throw VegetationError("bad_input", "crown " + std::to_string(id) + " has fewer than 3 surface samples");
        if (probe.p && !onSupport(c)) { R.skipped.emplace_back(id, "not_on_support_mesh"); continue; }
        chosen.push_back(&c);
    }
    const size_t n = chosen.size();
    std::vector<CrownShape> shapes(n);
    for (size_t i = 0; i < n; ++i) {
        shapes[i] = crownShapeFromJson(*chosen[i]);
        const auto k = P.crownCorrections.find(shapes[i].id);
        if (k != P.crownCorrections.end()) applyCrownCorrection(shapes[i], k->second);
    }

    // grow every tree first: its own budget depends on what its leaf masses need
    std::vector<CrownGrowth> grown(n);
    std::vector<std::string> errors(n), droppedCorrection(n), clippedShort(n);
    detail::forEachIndex(n, P.threads, [&](size_t i) {
        try {
            grown[i] = growCrown(shapes[i], P.growth, sampleSpacing);
            if (!grown[i].ok() && grown[i].wallsClipped && (grown[i].failureCode == "crown_not_reached" || grown[i].failureCode == "apex_not_reached")) {
                // buildings win over trees: a crown kept off a scanned wall grows as far as the clearance lets it; that it
                // does not fill the crown the scan measured against the wall is reported, not refused
                clippedShort[i] = grown[i].failure;
                grown[i].failure.clear();
                grown[i].failureCode.clear();
            }
            if (!grown[i].ok() && P.crownCorrections.count(shapes[i].id)) {
                // the corrected crown does not regrow: the measured one (the crown strip regrew) is grown instead, and the
                // correction is dropped for it (reported)
                CrownShape measured = crownShapeFromJson(*chosen[i]);
                CrownGrowth g = growCrown(measured, P.growth, sampleSpacing);
                if (g.ok()) { droppedCorrection[i] = grown[i].failure; shapes[i] = std::move(measured); grown[i] = std::move(g); }
            }
            if (!grown[i].ok()) errors[i] = "crown " + std::to_string(shapes[i].id) + ": " + grown[i].failure + " (colonisation: " + grown[i].colonisationSummary + ")";
        } catch (const std::exception& e) {
            errors[i] = "crown " + std::to_string(shapes[i].id) + ": " + e.what();
        }
    });
    {
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
    }

    const double minEach = std::ceil(P.minTrianglesPerTree);
    std::vector<double> own(n), need(n);
    double ownSum = 0, needSum = 0;
    for (size_t i = 0; i < n; ++i) {
        own[i] = static_cast<double>(crownOwnBudget(shapes[i], grown[i], P));
        need[i] = std::min(own[i], std::max(minEach, static_cast<double>(trianglesForLeafMasses(grown[i].surfaceMassesNeeded, P.woodShare))));
        ownSum += own[i];
        needSum += need[i];
    }
    R.targetTriangles = static_cast<size_t>(ownSum);
    R.neededTriangles = static_cast<size_t>(needSum);
    const double minTotal = minEach * static_cast<double>(n);
    double total;
    if (P.triangleBudget > 0) {
        if (n > 0 && P.triangleBudget < minTotal) {
            std::ostringstream m;
            m << "a triangle budget of " << detail::thousands(P.triangleBudget) << " cannot hold " << detail::thousands(static_cast<double>(n)) << " trees at "
              << detail::thousands(minEach) << " triangles each (they need at least " << detail::thousands(minTotal) << ")";
            throw VegetationError("budget_too_small", m.str());
        }
        total = P.triangleBudget;
        R.budgetSource = "explicit";
    } else {
        if (n > 0 && minTotal > P.sceneTriangleCap) {
            std::ostringstream m;
            m << "the " << detail::thousands(static_cast<double>(n)) << " measured trees need at least " << detail::thousands(minTotal) << " triangles at "
              << detail::thousands(minEach) << " each, more than the scene's cap of " << detail::thousands(P.sceneTriangleCap) << " triangles for trees";
            throw VegetationError("budget_too_small", m.str());
        }
        total = std::min(ownSum, P.sceneTriangleCap);
        R.budgetSource = ownSum > P.sceneTriangleCap ? "crown_targets_capped" : "crown_targets";
    }
    R.triangleBudget = total;
    // per-tree budgets: their own, plus a share of any budget beyond them; under them, first what their leaf masses need,
    // then the rest in proportion to what each asks beyond that; under even that, the minimum plus a share of the rest in
    // proportion to what each one's leaf masses need beyond the minimum
    std::vector<size_t> budgets(n);
    auto spread = [&](const std::vector<double>& base, const std::vector<double>& upTo, double baseSum) {
        double extra = 0;
        for (size_t i = 0; i < n; ++i) extra += upTo[i] - base[i];
        for (size_t i = 0; i < n; ++i) {
            const double share = extra > 0 ? (upTo[i] - base[i]) / extra : 1.0 / static_cast<double>(n);
            budgets[i] = static_cast<size_t>(std::floor(base[i] + (total - baseSum) * share));
        }
    };
    if (total >= ownSum) {
        for (size_t i = 0; i < n; ++i) budgets[i] = static_cast<size_t>(own[i] + std::floor((total - ownSum) * own[i] / std::max(1.0, ownSum)));
    } else if (total >= needSum) {
        spread(need, own, needSum);
    } else {
        spread(std::vector<double>(n, minEach), need, minTotal);
    }

    R.trees.resize(n);
    errors.assign(n, "");
    tree_lod::LodParams lodParams = P.treeLod;
    lodParams.psiSeason = P.psiSeason;
    lodParams.morphology = P.growth.morphology;
    if (P.lod) R.library = std::make_shared<tree_lod::ClusterLibrary>(tree_lod::buildClusterLibrary(lodParams));
    const double psi = std::clamp(P.psiSeason, 0.0, 1.0);
    // a tree whose crown has no measured colour is chosen by its neighbours' (the median of the measured crowns of this
    // planting, per channel), else by the library's leaf-on prior
    tree_textures::MeasuredColour fallbackColour;
    if (P.textures) {
        std::array<std::vector<double>, 3> ch;
        for (const auto* c : chosen) {
            const auto& col = (*c)["colour"]["meanLinearRgb"];
            if (col.type == io::GlbJsonValue::Array && col.arr.size() == 3 && col[0].type == io::GlbJsonValue::Number) for (size_t k = 0; k < 3; ++k) ch[k].push_back(std::max(0.0, col[k].num));
        }
        fallbackColour.known = true;
        if (!ch[0].empty()) {
            fallbackColour.source = "neighbours";
            for (size_t k = 0; k < 3; ++k) {
                std::nth_element(ch[k].begin(), ch[k].begin() + static_cast<std::ptrdiff_t>(ch[k].size() / 2), ch[k].end());
                fallbackColour.meanLinear[k] = ch[k][ch[k].size() / 2];
            }
        } else {
            fallbackColour.source = "prior";
            fallbackColour.meanLinear = tree_textures::leafOnPrior(*P.textures);
        }
    }
    detail::forEachIndex(n, P.threads, [&](size_t i) {
        PlantedTree& tr = R.trees[i];
        try {
            const CrownGrowth& g = grown[i];
            tr.crown = chosen[i];
            tr.crownId = shapes[i].id;
            tr.target = crownTriangleTarget(shapes[i], P);
            tr.needed = static_cast<size_t>(need[i]);
            tr.ownBudget = static_cast<size_t>(own[i]);
            tr.budget = budgets[i];
            tr.seed = g.seed;
            tr.heightAboveSupport = g.heightAboveSupport;
            tr.crownBaseY = g.crownBaseY;
            tr.trunkRadius = g.trunkRadius;
            tr.grownShare = g.surfaceShare();
            tr.reachRadius = g.reachRadius;
            tr.wallsClipped = g.wallsClipped;
            tr.attractorsClipped = g.attractorsClipped;
            tr.attractorsTotal = g.attractorsTotal;
            tr.surfaceClipped = g.surfaceClipped;
            tr.keptOffWallsShort = clippedShort[i];
            tr.colonisation = g.colonisation;
            tr.crownBaseRatio = g.crownBaseRatio;
            tr.trunkRadiusPerHeight = g.trunkRadiusPerHeight;
            tr.excurrence = g.excurrence;
            tr.leaderHold = g.leaderHold;
            tr.topShare = g.topShare;
            tr.hasSpecies = g.hasSpecies;
            tr.species = g.species;
            tr.stems = g.stems;
            if (const auto k = P.crownCorrections.find(tr.crownId); k != P.crownCorrections.end()) {
                if (droppedCorrection[i].empty()) { tr.hasCorrection = true; tr.correction = k->second; }
                else tr.correctionDropped = "the corrected crown did not regrow (" + droppedCorrection[i] + "); grown as measured";
            }
            // the far level: the shipped blob tree; a bare request (psiSeason < 1) gives the leaf masses a share of their budget
            // in proportion to the season
            MeshedCrown m = meshCrown(g, tr.budget, 1.0 - (1.0 - P.woodShare) * psi, P.reveal ? &tr.growth : nullptr);
            tr.report = m.report;
            tr.leaves = m.reach;
            tr.leavesStrict = measureFoliage(m.foliage, m.report.foliageClumps, g.surface, P.treeLod.strictReachM);
            if (m.foliage.indices.empty() && psi >= 1.0) {
                errors[i] = "crown " + std::to_string(tr.crownId) + ": " + m.shortfall(g, shapes[i], P.growth.minSurfaceReached, tr.budget);
                return;
            }
            if (psi >= 1.0) tr.shortOfCrown = m.shortfall(g, shapes[i], P.growth.minSurfaceReached, tr.budget);
            if (P.textures) {
                // its textures, by appearance: the crown's colour in the tile's photo, its size
                const auto& cj = *chosen[i];
                tr.look.seed = tree_lod::mix64(static_cast<uint64_t>(g.seed) ^ 0x7E87u);
                tr.look.heightM = g.heightAboveSupport;
                tr.look.trunkRadiusM = g.trunkRadius;
                double rs = 0;
                for (double r : shapes[i].sectorRadii) rs += r / 16.0;
                tr.look.crownRadiusM = rs;
                // the species entry's leaf (or frond) is what the leaf set is chosen by; unmatched, a length from the tree's size
                // and its blade width matches the foliage's form (a needle or scale leaf draws a needle spray)
                if (g.hasSpecies && g.species.matched) {
                    const auto& sp = P.growth.species->entries[g.species.entry];
                    tr.look.leafLengthHintM = sp.leafLengthM;
                    tr.look.leafWidthHintM = tree_textures::bladeWidthOfLeaf(sp.leafLengthM, sp.leafAspect);
                }
                const auto& col = cj["colour"]["meanLinearRgb"];
                if (col.type == io::GlbJsonValue::Array && col.arr.size() == 3 && col[0].type == io::GlbJsonValue::Number) {
                    tr.look.colour.known = true;
                    tr.look.colour.source = "measured";
                    for (size_t k = 0; k < 3; ++k) tr.look.colour.meanLinear[k] = std::max(0.0, col[k].num);
                } else {
                    tr.look.colour = fallbackColour;
                }
                tr.textures = tree_textures::choose(*P.textures, tr.look, P.textureChoice);
                tr.hasTextures = true;
            }
            if (P.lod) {
                tree_lod::TreeLodInput in;
                in.cfg = &g.cfg;
                in.skeleton = &g.skeleton;
                in.stemX = shapes[i].stemX;
                in.stemZ = shapes[i].stemZ;
                in.supportY = shapes[i].supportY;
                in.apex = shapes[i].apex;
                in.sectorRadii = shapes[i].sectorRadii;
                in.surface = &g.surface;
                in.reachRadius = g.reachRadius;
                in.heightAboveSupport = g.heightAboveSupport;
                in.seed = g.seed;
                in.woodBudget = tr.budget;
                {
                    // the crown's season cue: its measured colour (the share of green cells, else the mean's hue and chroma)
                    const auto& col = (*chosen[i])["colour"];
                    const auto num = [&](const char* k) { return col.type == io::GlbJsonValue::Object && col[k].type == io::GlbJsonValue::Number ? col[k].num : std::numeric_limits<double>::quiet_NaN(); };
                    in.leafiness = tree_lod::seasonLeafiness(lodParams, num("greenShare"), num("hueDeg"), num("chroma"));
                }
                if (tr.hasTextures) {
                    in.cutoutFill = P.textures->leaves[tr.textures.leaf].fill;
                    in.cutoutAspect = P.textures->leaves[tr.textures.leaf].leafWidthM / std::max(1e-6, P.textures->leaves[tr.textures.leaf].leafLengthM);
                    in.atlasLeafLengthM = P.textures->leaves[tr.textures.leaf].leafLengthM;
                    const auto& bark = P.textures->bark[tr.textures.bark];
                    in.barkTileAroundM = static_cast<float>(bark.tileAroundM);
                    in.barkTileAlongM = static_cast<float>(bark.tileAlongM);
                }
                in.farFoliage = &m.foliage;   // the far level's leaf masses, for its drawn coverage
                const auto tLod = std::chrono::steady_clock::now();
                tree_lod::buildTreeLod(tr.lod, in, *R.library);
                tr.lodMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - tLod).count();
                if (!tr.lod.error.empty()) { errors[i] = "crown " + std::to_string(tr.crownId) + ": " + tr.lod.error; return; }
                tr.hasLod = true;
                if (tr.lod.coverage.farMassSpread != 1.0) {
                    // the masses it delivers were spread: what they reach is measured again, on the masses the GLB holds
                    m.reach = measureFoliage(m.foliage, m.report.foliageClumps, g.surface, g.reachRadius);
                    tr.leaves = m.reach;
                    tr.leavesStrict = measureFoliage(m.foliage, m.report.foliageClumps, g.surface, P.treeLod.strictReachM);
                    if (psi >= 1.0) tr.shortOfCrown = m.shortfall(g, shapes[i], P.growth.minSurfaceReached, tr.budget);
                }
            }
            tr.wood = std::move(m.wood);
            tr.foliage = std::move(m.foliage);
            if (ground.p) {
                tr.groundChecked = true;
                double best = std::numeric_limits<double>::infinity();
                for (double h : ground.heightsAt(shapes[i].stemX, shapes[i].stemZ)) {
                    if (std::abs(shapes[i].supportY - h) < std::abs(best)) best = shapes[i].supportY - h;
                }
                if (std::isfinite(best)) tr.groundGapM = best;
                tr.offGround = !std::isfinite(best) || std::abs(best) > P.groundTolerance;
            }
        } catch (const std::exception& e) {
            errors[i] = "crown " + std::to_string(tr.crownId) + ": " + e.what();
        }
    });
    std::vector<std::string> failed;
    for (size_t i = 0; i < n; ++i) if (!errors[i].empty()) failed.push_back(errors[i]);
    if (!failed.empty()) {
        std::ostringstream m;
        m << failed.size() << " of " << n << " trees could not be meshed: ";
        for (size_t k = 0; k < failed.size(); ++k) m << (k ? "; " : "") << failed[k];
        throw VegetationError("plant_failed", m.str());
    }
    for (const auto& tr : R.trees) {
        R.triangles += (tr.wood.indices.size() + tr.foliage.indices.size()) / 3;
        R.shortOfCrown += tr.shortOfCrown.empty() ? 0 : 1;
        R.offGround += tr.offGround ? 1 : 0;
        if (tr.wallsClipped) { ++R.clippedAtWalls; R.attractorsClipped += tr.attractorsClipped; R.attractorsAtClippedCrowns += tr.attractorsTotal; }
    }
    R.groundChecked = ground.p != nullptr;
    if (static_cast<double>(R.triangles) > total) throw VegetationError("budget_exceeded", "trees used " + std::to_string(R.triangles) + " triangles, over the budget of " + std::to_string(static_cast<size_t>(total)));
    R.ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
    return R;
}

/**
 * Where a viewport changes a tree's level (m from the camera): near up to d0, near-mid up to dNearMid, mid up to d1, far
 * beyond; each handover dithers over its own band (fade, fadeNearMid, fade1), centred on its distance.
 */
struct LodBands { double d0{0}, dNearMid{0}, d1{0}, fade{0}, fadeNearMid{0}, fade1{0}; };

/** Whether (x, z) lies inside a closed polygon (tile frame metres); false for an empty or under-3-point polygon (no hero area). */
inline bool pointInPolygon(double x, double z, const std::vector<std::array<double, 2>>& poly) {
    if (poly.size() < 3) return false;
    bool inside = false;
    for (size_t i = 0, j = poly.size() - 1; i < poly.size(); j = i++) {
        const double xi = poly[i][0], zi = poly[i][1], xj = poly[j][0], zj = poly[j][1];
        if ((zi > z) != (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
}

inline LodBands lodBandsFor(double heightM, const PlantParams& P, bool fullQuality = false) {
    LodBands b;
    b.fade = P.lodFadeM;
    // the far handover swaps leaves for solid masses and a viewer sees the whole crown change: it dissolves over a wider band, a share of the distance
    b.fade1 = std::max(P.lodFadeM, P.lodFarFadeShare * std::clamp(P.lodFarPerHeight * heightM, P.lodFarMinM, P.lodFarMaxM));
    b.d0 = std::clamp(P.lodNearPerHeight * heightM, P.lodNearMinM, P.lodNearMaxM);
    const double nearMid = std::clamp(P.lodNearMidPerHeight * heightM, P.lodNearMidMinM, P.lodNearMidMaxM);
    b.fadeNearMid = std::max(P.lodFadeM, P.lodNearMidFadeShare * nearMid);
    // room for the near-mid band between the two others: its handovers never overlap theirs
    b.d1 = std::max(b.d0 + 0.5 * b.fade + b.fadeNearMid + 0.5 * b.fade1, std::clamp(P.lodFarPerHeight * heightM, P.lodFarMinM, P.lodFarMaxM));
    b.dNearMid = std::clamp(nearMid, b.d0 + 0.5 * (b.fade + b.fadeNearMid), b.d1 - 0.5 * (b.fadeNearMid + b.fade1));
    // a hero-area tree: hold near quality out to heroFullQualityM instead of its own height-scaled bands (never closer
    // than the bands already gave it, for a very tall tree whose own far band already reaches past heroFullQualityM)
    if (fullQuality) b.d0 = b.dNearMid = b.d1 = std::max(P.heroFullQualityM, b.d1);
    return b;
}

/** What a viewport draws of the planted trees: triangles per frame over a grid of camera poses (see estimateLodFrames). */
struct LodFrameEstimate {
    size_t poses{0};
    double median{0}, p95{0}, max{0};                // an 80 degree view; every tree within 8 m is in it
    double allAroundMedian{0}, allAroundMax{0};      // no view culling (a bound, not a frame)
    double allLevel0{0}, allLevel1{0}, allLevel2{0}; // triangles when every tree is at the near / mid / far level
    double allNearMid{0};                            // ... at the near-mid level
    std::array<size_t, 4> worstTreesPerLevel{};      // near, near-mid, mid, far (the GLB's level order)
};

/**
 * Estimates what a park view draws: camera poses every `gridM` metres over the trees' bounds, 8 headings each, every tree
 * at the level its distance calls for (the middle of the dither band), and only the trees within 40 degrees of the heading
 * (or 8 m) counted. Drawn triangles are those of the level (wood, twigs and clusters at the near level, wood and clusters at
 * the near-mid and mid levels, wood and blob leaf masses at the far level), instances expanded.
 */
inline LodFrameEstimate estimateLodFrames(const PlantResult& R, const PlantParams& P, double gridM = 30.0) {
    struct T { double x, z; LodBands b; std::array<double, 4> tri; };
    std::vector<T> trees;
    for (const auto& tr : R.trees) {
        if (!tr.hasLod) continue;
        T t;
        t.x = (*tr.crown)["stem"][0].num;
        t.z = (*tr.crown)["stem"][1].num;
        t.b = lodBandsFor(tr.heightAboveSupport, P, pointInPolygon(t.x, t.z, P.heroPolygon));
        t.tri = {static_cast<double>(tr.lod.drawnLevel0()), static_cast<double>(tr.lod.drawnNearMid()), static_cast<double>(tr.lod.drawnLevel1()), static_cast<double>(tr.lod.drawnFar(tr.foliage.indices.size() / 3))};
        trees.push_back(t);
    }
    LodFrameEstimate E;
    if (trees.empty()) return E;
    double x0 = 1e30, x1 = -1e30, z0 = 1e30, z1 = -1e30;
    for (const auto& t : trees) { x0 = std::min(x0, t.x); x1 = std::max(x1, t.x); z0 = std::min(z0, t.z); z1 = std::max(z1, t.z); E.allLevel0 += t.tri[0]; E.allNearMid += t.tri[1]; E.allLevel1 += t.tri[2]; E.allLevel2 += t.tri[3]; }
    auto levelAt = [](const LodBands& b, double d) { return d < b.d0 ? 0 : d < b.dNearMid ? 1 : d < b.d1 ? 2 : 3; };
    std::vector<double> frames, around;
    for (double x = x0; x <= x1 + 1e-9; x += gridM) {
        for (double z = z0; z <= z1 + 1e-9; z += gridM) {
            double all = 0;
            std::array<double, 8> byHeading{};
            std::array<std::array<size_t, 4>, 8> cnt{};
            for (const auto& t : trees) {
                const double d = std::hypot(t.x - x, t.z - z);
                const int lv = levelAt(t.b, d);
                all += t.tri[static_cast<size_t>(lv)];
                const double ang = std::atan2(t.z - z, t.x - x) * 180.0 / M_PI;
                for (int h = 0; h < 8; ++h) {
                    double da = std::fmod(ang - 45.0 * h + 540.0, 360.0) - 180.0;
                    if (std::abs(da) <= 40.0 || d < 8.0) { byHeading[static_cast<size_t>(h)] += t.tri[static_cast<size_t>(lv)]; ++cnt[static_cast<size_t>(h)][static_cast<size_t>(lv)]; }
                }
            }
            around.push_back(all);
            for (int h = 0; h < 8; ++h) {
                frames.push_back(byHeading[static_cast<size_t>(h)]);
                if (byHeading[static_cast<size_t>(h)] >= *std::max_element(frames.begin(), frames.end())) E.worstTreesPerLevel = cnt[static_cast<size_t>(h)];
            }
        }
    }
    std::sort(frames.begin(), frames.end());
    std::sort(around.begin(), around.end());
    E.poses = frames.size();
    E.median = frames[frames.size() / 2];
    E.p95 = frames[static_cast<size_t>(0.95 * static_cast<double>(frames.size() - 1))];
    E.max = frames.back();
    E.allAroundMedian = around[around.size() / 2];
    E.allAroundMax = around.back();
    return E;
}

/** What writing the trees GLB measured: its size, and with quantisation its error and the size it would have had unquantised. */
struct TreesGlbReport {
    staged_glb::WriteReport glb;
    size_t unquantizedBytes{0};      // the same nodes written with float positions and normals (0 when not quantised)
    size_t rings{0};                 // LINES rings over crowns kept as scanned
};

namespace detail {

/** The open-JSON members of a planted tree's extras (its measurements, in the tile frame), without braces. */
inline std::string treeExtrasMembers(const PlantedTree& tr, const PlantParams& P) {
    const auto& c = *tr.crown;
    std::ostringstream ex;
    ex << "\"crownId\":" << tr.crownId << ",\"apex\":" << json::write(c["apex"]) << ",\"stem\":" << json::write(c["stem"])
       << ",\"supportY\":" << json::num(c["supportY"].num) << ",\"supportSource\":" << json::write(c["supportSource"])
       << ",\"heightAboveSupportM\":" << json::num(tr.heightAboveSupport) << ",\"crownAreaM2\":" << json::num(c["areaM2"].num)
       << ",\"sectorRadiiM\":" << json::write(c["sectorRadii"]);
    // a described crown's free-text label (what the request called the tree): carried, it never changes the geometry
    if (c["label"].type == io::GlbJsonValue::String) ex << ",\"label\":" << json::write(c["label"]);
    if (c["origin"].type == io::GlbJsonValue::String) ex << ",\"crownOrigin\":" << json::write(c["origin"]);
    ex << ",\"inferred\":{\"crownBaseY\":" << json::num(tr.crownBaseY) << ",\"crownBaseRatio\":" << json::numPrecise(tr.crownBaseRatio)
       << ",\"trunkRadiusM\":" << json::num(tr.trunkRadius) << ",\"trunkRadiusPerHeight\":" << json::num(tr.trunkRadiusPerHeight)
       << ",\"topShare\":" << json::num(tr.topShare) << ",\"excurrence\":" << json::num(tr.excurrence) << ",\"leaderHold\":" << json::num(tr.leaderHold) << "}"
       // measured on the delivered leaf masses (this mesh): the share of the crown's surface samples above its crown
       // base inside one or within reachM of one, and how far their top lies below the apex; grownSurfaceReached is
       // the same share for the grown skeleton's leaf nodes
       << ",\"crownSurfaceReached\":" << json::num(tr.leaves.share()) << ",\"crownSurfaceSamples\":" << tr.leaves.samples
       << ",\"reachM\":" << json::num(tr.reachRadius) << ",\"leavesBelowApexM\":" << json::num(static_cast<double>(c["apex"][1].num) - tr.leaves.topY)
       << ",\"grownSurfaceReached\":" << json::num(tr.grownShare);
    if (tr.hasCorrection) {
        ex << ",\"crownCorrection\":{\"widthScale\":" << json::num(tr.correction.widthScale) << ",\"crownBaseRatio\":"
           << (std::isfinite(tr.correction.crownBaseRatio) ? json::num(tr.correction.crownBaseRatio) : std::string("null"))
           << ",\"source\":" << json::str(tr.correction.source) << ",\"provenance\":\"photo-inferred\",\"method\":" << json::str(P.crownCorrectionMethod) << "}";
    }
    if (!tr.correctionDropped.empty()) ex << ",\"crownCorrectionDropped\":" << json::str(tr.correctionDropped);
    if (!tr.shortOfCrown.empty()) ex << ",\"shortOfCrown\":" << json::str(tr.shortOfCrown);
    if (tr.groundChecked) {
        ex << ",\"groundGapM\":";
        if (std::isfinite(tr.groundGapM)) ex << json::num(tr.groundGapM); else ex << "null";
    }
    if (tr.wallsClipped) {
        ex << ",\"keptOffWalls\":{\"walls\":" << tr.wallsClipped << ",\"attractorsClipped\":" << tr.attractorsClipped << ",\"attractorsTotal\":" << tr.attractorsTotal
           << ",\"surfaceSamplesClipped\":" << tr.surfaceClipped << (tr.keptOffWallsShort.empty() ? std::string() : ",\"short\":" + json::str(tr.keptOffWallsShort)) << "}";
    }
    // `triangles` is the budgeted blob tree (what `triangleBudget` bounds); with levels the far level the file holds is the
    // delivered wood (given the whole budget, by the near levels) under the same blob masses: `farLevelTriangles`
    ex << ",\"triangles\":" << (tr.wood.indices.size() + tr.foliage.indices.size()) / 3 << ",\"triangleBudget\":" << tr.budget << ",\"ownBudget\":" << tr.ownBudget;
    if (tr.hasLod) ex << ",\"farLevelTriangles\":" << tr.lod.drawnFar(tr.foliage.indices.size() / 3) << ",\"deliveredWoodTriangles\":" << tr.lod.woodTriangles << ",\"farWoodTriangles\":" << tr.lod.farWoodTriangles;
    ex << ",\"woodTriangles\":" << tr.report.woodTriangles << ",\"foliageTriangles\":" << tr.report.foliageTriangles
       << ",\"foliageClumps\":" << tr.report.foliageClumps << ",\"surfaceMasses\":" << tr.report.surfaceMasses << ",\"surfaceMassesNeeded\":" << tr.report.surfaceMassesNeeded
       << ",\"seed\":" << tr.seed;
    return ex.str();
}

/** The projected coverage of a tree's leaves (tree_lod::CoverageReport) as a JSON object. */
inline std::string coverageJson(const tree_lod::CoverageReport& c) {
    auto lv = [](const tree_lod::CoverageLevel& l) {
        return "{\"mean\":" + json::num(l.meanEllipsoid) + ",\"min\":" + json::num(l.minEllipsoid) + ",\"meanHull\":" + json::num(l.meanHull) + ",\"areaM2\":" + json::num(l.meanAreaM2) + "}";
    };
    std::string o = "{\"measured\":" + std::string(c.measured ? "true" : "false") + ",\"leafiness\":" + json::num(c.leafiness) + ",\"target\":" + json::num(c.target) +
                    ",\"views\":" + std::to_string(c.views) + ",\"cellM\":" + json::num(c.cellM) + ",\"fillStations\":" + std::to_string(c.fillStations);
    if (c.measured) {
        o += ",\"level0Before\":" + lv(c.level0Before) + ",\"level0\":" + lv(c.level0) + ",\"nearMid\":" + lv(c.nearMid) + ",\"mid\":" + lv(c.mid);
        if (c.cardTarget > 0) o += ",\"midClusters\":" + lv(c.midClusters) + ",\"cardTarget\":" + json::num(c.cardTarget);
        if (c.level0Cutout.meanEllipsoid > 0 || c.midCutout.meanEllipsoid > 0)
            o += ",\"cutout\":{\"level0\":" + lv(c.level0Cutout) + ",\"mid\":" + lv(c.midCutout) + (c.cardTarget > 0 ? ",\"midClusters\":" + lv(c.midClustersCutout) : std::string()) + "}";
        o += ",\"drawn\":{\"level0\":" + lv(c.drawnLevel0) + ",\"nearMid\":" + lv(c.drawnNearMid) + ",\"mid\":" + lv(c.drawnMid) +
             (c.drawnFarMeasured ? ",\"far\":" + lv(c.drawnFar) + ",\"farBefore\":" + lv(c.drawnFarBefore) + ",\"farMassSpread\":" + json::num(c.farMassSpread) : std::string());
        o += ",\"of\":\"everything each level draws: its wood, twigs and every triangle of its leaf clusters or cards (the far level its trunk, main limbs and leaf masses, farBefore as the budgeted meshing built them, before they were spread farMassSpread along the crown surface until they cover as much of each view as the near level, areaM2); solid (clay), before any holes a viewer opens\"}";
    }
    return o + ",\"of\":\"the share of the measured crown (an ellipsoid fitted to its surface samples and footprint) the leaves cover, seen from outside, the mean over the views (areaM2: the area they cover in a view, inside the crown's silhouette or not); level0 .. midClusters and cutout count the leaf blades only, drawn counts everything each level draws\"}";
}

/** A tree's crown cards (the mid level when it has them): how many, their side, the candidates they were chosen from (and the time, stats only: a GLB holds no timings). */
inline std::string crownCardsJson(const tree_lod::TreeLod& L, bool withTime = false) {
    return "{\"cards\":" + std::to_string(L.cardCount()) + ",\"triangles\":" + std::to_string(2 * L.cardCount()) + ",\"sideM\":" + json::num(L.cardSideM) +
           ",\"candidates\":" + std::to_string(L.cardCandidates) + (withTime ? ",\"ms\":" + json::num(L.msCards) : std::string()) + "}";
}

/** `,"colour":{...}` of a tree's extras: its crown's colour as the tile's photo shows it (crowns.json), or nothing. */
inline std::string treeColourMembers(const io::GlbJsonValue& crown) {
    const auto& c = crown["colour"];
    if (c.type != io::GlbJsonValue::Object || c["meanLinearRgb"].arr.size() != 3) return std::string();
    std::string season = ",\"season\":{\"greenShare\":" + json::write(c["greenShare"]) + ",\"hueDeg\":" + json::write(c["hueDeg"]) + ",\"chroma\":" + json::write(c["chroma"]) + "}";
    return ",\"colour\":{\"meanLinearRgb\":" + json::write(c["meanLinearRgb"]) + ",\"spreadLinearRgb\":" + json::write(c["spreadLinearRgb"]) +
           ",\"samples\":" + json::write(c["samples"]) + season + ",\"provenance\":\"measured\",\"source\":\"the tile's photo texture over the crown's footprint\"}";
}

inline std::string treeSpeciesMembers(const PlantedTree& tr, const GrowthParams& G) {
    return crownSpeciesMembers(tr.hasSpecies, tr.species, tr.stems, tr.crownBaseRatio, tr.trunkRadiusPerHeight, G);
}

/** `,"texture":{...}` of a tree's extras: the leaf set and bark chosen for it, their tints, and why. */
inline std::string treeTextureMembers(const PlantedTree& tr, const tree_textures::Library& lib) {
    const auto& t = tr.textures;
    auto rgb = [](const tree_textures::RGB& c) { return "[" + json::num(c[0]) + "," + json::num(c[1]) + "," + json::num(c[2]) + "]"; };
    const auto& L = lib.leaves[t.leaf];
    const auto& B = lib.bark[t.bark];
    return ",\"texture\":{\"leaves\":{\"entry\":" + json::str(L.id) + ",\"tint\":" + rgb(t.leafTint) + ",\"leafLengthM\":" + json::num(L.leafLengthM) +
           ",\"targetLeafLengthM\":" + json::num(t.targetLeafLengthM) + ",\"bladeWidthM\":" + json::num(L.bladeWidthM) +
           ",\"targetBladeWidthM\":" + json::num(t.targetBladeWidthM) + ",\"cost\":" + json::num(t.leafCost) + ",\"provenance\":\"library\"}" +
           ",\"bark\":{\"entry\":" + json::str(B.id) + ",\"tint\":" + rgb(t.barkTint) + ",\"tileM\":[" + json::num(B.tileAroundM) + "," + json::num(B.tileAlongM) + "]" +
           ",\"reliefIndex\":" + json::num(B.reliefIndex) + ",\"targetReliefIndex\":" + json::num(t.targetRelief) + ",\"sizeShare\":" + json::num(t.sizeShare) +
           ",\"cost\":" + json::num(t.barkCost) + ",\"provenance\":\"library\"}" +
           ",\"massColourLinear\":" + rgb(t.massColourLinear) + ",\"colourProvenance\":" + json::str(t.colourSource) + "}";
}

/** A crown kept as scanned: its status says so, and it has a measured footprint to outline. */
inline bool keptAsScanned(const io::GlbJsonValue& c) {
    const std::string& st = c["status"].asString();
    return (st == "not_regrowable" || st == "no_measured_ground") && c["sectorRadii"].arr.size() == 16 && c["stem"].arr.size() == 2;
}

} // namespace detail

/**
 * The trees layer of a staged location build (stage "trees"): one node per planted tree and one LINES ring per crown
 * kept as scanned, in the tile frame, studio clay.
 *
 * With PlantParams::lod (the default) a tree node holds no mesh: it has four child nodes, the levels of detail (extras.sbLod,
 * the contract's TreeLodExtras): level 0 holds the wood (the whole triangle budget) and, as child nodes instancing library
 * meshes (EXT_mesh_gpu_instancing, positions in the level's quantisation frame), its pruned twigs and leaf clusters; levels 1
 * (near-mid: a share of the leaves with the near outline, each larger) and 2 (mid: fewer larger leaves as cards) share the
 * wood mesh, draw no twigs and instance the same cluster positions (their instance data is level 0's); level 3 holds its
 * own wood, the trunk and main limbs only (tree_lod::farWoodBudgetFor, a few hundred triangles; schema trees-lod/3; a
 * trees-lod/2 file's level 3 reused level 0's whole wood), and the blob leaf masses meshCrown builds. The library
 * (the cluster meshes, the twig tubes) and psiSeason are in the root extras `sbTrees`. Without levels a tree node holds its wood
 * and foliage primitives (the foliage last). Either way it holds its measurements as extras, and
 * extras.sb (StagedNodeExtras): provenance "grown to the measured crown" (stem, crown extent and height measured from
 * the tiles, branching grown into the measured crown; what ratios set is listed as inferred), its plant rank as
 * buildOrder, and `_REVEAL` on every vertex: x = plant rank / max(1, trees - 1), y = when the vertex grew (node creation
 * order over max(1, nodes - 1), nature::MeshGrowth), so a viewport grows each tree from its trunk to its tips, tree after
 * tree, in the generator's real order.
 *
 * A ring outlines a measured crown that stays as scanned in the remeshed tile (not regrowable, or its ground not
 * measured or undecided): its 16 measured footprint points at its support height (or, with none, the lowest point of its
 * measured surface), provenance "as-scanned" with the reason it stayed. Rings follow the trees in build order.
 *
 * The root extras keep the frame's axes, the label and what was planted, beside extras.sb (StagedGlbRootExtras). Nothing
 * geodetic is written (no lat/lng, no localToEcef): the trees are positioned only relative to the tile they were measured
 * in, and the geodetic crown list stays in the strip's cache entry (crowns.json). With P.quantize the file uses
 * KHR_mesh_quantization, its measured error is in asset.extras and in `report`, with the unquantised size beside it.
 */
inline std::vector<uint8_t> writeTreesGlb(const PlantResult& R, const io::GlbJsonValue& crownsDoc, const PlantParams& P, TreesGlbReport* report = nullptr) {
    std::vector<const io::GlbJsonValue*> rings;
    const auto& crowns = crownsDoc["crowns"];
    if (crowns.type == io::GlbJsonValue::Array) {
        for (const auto& c : crowns.arr) if (detail::keptAsScanned(c)) rings.push_back(&c);
    }
    std::vector<const PlantedTree*> planted;
    for (const auto& tr : R.trees) if (!tr.wood.indices.empty() || !tr.foliage.indices.empty()) planted.push_back(&tr);
    const size_t buildCount = std::max<size_t>(1, planted.size() + rings.size());
    std::vector<staged_glb::StagedNode> nodes;
    nodes.reserve(planted.size() + rings.size());
    for (size_t rank = 0; rank < planted.size(); ++rank) {
        const PlantedTree& tr = *planted[rank];
        staged_glb::StagedNode node;
        node.name = "sb_veggie_crown_" + std::to_string(tr.crownId);
        const float x = staged_glb::rankUnit(rank, planted.size());
        auto primitiveOf = [&](const geometry::Mesh& m, const std::vector<float>& grown) {
            if (P.reveal && grown.size() != m.vertices.size()) throw VegetationError("failed", "crown " + std::to_string(tr.crownId) + ": " + std::to_string(grown.size()) + " growth values for " + std::to_string(m.vertices.size()) + " vertices");
            staged_glb::StagedPrimitive pr;
            pr.positions = m.vertices;
            pr.normals.reserve(m.vertices.size());
            for (size_t v = 0; v < m.vertices.size(); ++v) pr.normals.push_back(v < m.normals.size() ? m.normals[v] : Vec3(0, 1, 0));
            pr.indices = m.indices;
            if (P.reveal) {
                pr.reveal.reserve(m.vertices.size());
                for (float y : grown) pr.reveal.push_back({x, y});
            }
            return pr;
        };
        // a tree without levels is the shipped blob tree: its wood and its leaf masses
        const bool levels = tr.hasLod && R.library;
        std::vector<staged_glb::StagedPrimitive> blobPrims;
        size_t vertices = 0, triangles = 0;
        if (!levels) {
            const std::pair<const geometry::Mesh*, const std::vector<float>*> parts[] = {{&tr.wood, &tr.growth.wood}, {&tr.foliage, &tr.growth.foliage}};
            for (const auto& [m, grown] : parts) {
                if (m->indices.empty()) continue;
                blobPrims.push_back(primitiveOf(*m, *grown));
                vertices += m->vertices.size();
                triangles += m->indices.size() / 3;
            }
        } else {
            // levels: the wood (written once, shared by levels 0, 1 and 2), the far level's trunk and limbs and its leaf masses
            vertices = tr.lod.wood.vertices.size() + tr.lod.farWood.vertices.size() + tr.foliage.vertices.size();
            triangles = tr.lod.woodTriangles + tr.lod.drawnFar(tr.foliage.indices.size() / 3);
        }
        std::string lodMembers;
        if (levels) {
            const auto& lib = *R.library;
            const tree_lod::TreeLod& L = tr.lod;
            const std::string base = node.name;
            const double H = tr.heightAboveSupport;
            const bool heroTree = pointInPolygon((*tr.crown)["stem"][0].num, (*tr.crown)["stem"][1].num, P.heroPolygon);
            const LodBands bands = lodBandsFor(H, P, heroTree);
            const double d0 = bands.d0, dNM = bands.dNearMid, d1 = bands.d1, fade = bands.fade, fadeNM = bands.fadeNearMid, fade1 = bands.fade1;
            auto lodExtras = [&](int level, double lo, double hi, double fadeM, size_t tris, bool instanced, const std::string& more = std::string()) {
                return "{\"sbLod\":{\"level\":" + std::to_string(level) + ",\"minDistM\":" + json::num(std::max(0.0, lo)) + ",\"maxDistM\":" + json::num(hi) +
                       ",\"fadeM\":" + json::num(fadeM) + ",\"triangles\":" + std::to_string(tris) + ",\"instanced\":" + (instanced ? "true" : "false") + more + "}}";
            };
            auto instancesOf = [&](const std::vector<tree_lod::Instance>& in, const std::string& mesh) {
                staged_glb::StagedInstances si;
                si.libraryMesh = mesh;
                si.translations.reserve(in.size());
                for (const auto& i : in) {
                    si.translations.push_back(i.t);
                    si.rotations.push_back({i.q.x, i.q.y, i.q.z, i.q.w});
                    si.scales.push_back(i.s);
                    if (P.reveal) si.reveal.push_back({x, i.order});
                }
                return si;
            };
            auto clusterExtras = [&](const std::string& variant, uint64_t salt) {
                return "{\"sbCluster\":{\"clusterMesh\":" + json::str(variant) + ",\"hashSeed\":" + std::to_string(static_cast<uint32_t>(tree_lod::mix64(tr.seed ^ salt) & 0xFFFFFFFFull)) + "}}";
            };
            // l1 is the near-mid level, l2 the mid level (L.level1), l3 the far level
            staged_glb::StagedNode l0, l1, l2, l3;
            l0.name = base + "_lod0";
            l1.name = base + "_lod1";
            l2.name = base + "_lod2";
            l3.name = base + "_lod3";
            l0.primitives.push_back(primitiveOf(L.wood, L.woodGrowth));
            if (tr.hasTextures && L.wood.uvs.size() == L.wood.vertices.size()) {
                // the wood in the chosen bark's tiles (u around, v along the path from the root)
                auto& uv = l0.primitives.back().uvs;
                uv.reserve(L.wood.uvs.size());
                for (const auto& t : L.wood.uvs) uv.push_back({t.x, t.y});
            }
            l0.frameGroup = l3.frameGroup = base;
            l1.meshFrom = l0.name;
            l2.meshFrom = l0.name;
            for (size_t k = 0; k < L.twigs.size(); ++k) {
                if (L.twigs[k].empty()) continue;
                staged_glb::StagedNode tw;
                tw.name = base + "_lod0_twigs" + std::to_string(k);
                tw.extrasJson = clusterExtras(lib.twigs[k].name, 0x7716ull + k);
                tw.instances.push_back(instancesOf(L.twigs[k], lib.twigs[k].name));
                l0.children.push_back(std::move(tw));
            }
            for (size_t k = 0; k < L.clusters.size(); ++k) {
                if (L.clusters[k].empty()) continue;
                const auto& v = lib.variants[k];
                staged_glb::StagedNode c0, c1, c2;
                c0.name = base + "_lod0_c" + std::to_string(k);
                c0.extrasJson = clusterExtras(v.name, 0xC100ull + k);
                c0.instances.push_back(instancesOf(L.clusters[k], v.level0.name));
                // the near-mid and mid clusters instance the same positions (the same hash seed, so a crossfade hands each cluster over whole)
                auto sameAs = [&](staged_glb::StagedNode& n, const std::string& level, const std::string& mesh) {
                    n.name = base + level + std::to_string(k);
                    n.extrasJson = clusterExtras(v.name, 0xC100ull + k);
                    staged_glb::StagedInstances si;
                    si.libraryMesh = mesh;
                    si.sameDataAs = c0.name;
                    n.instances.push_back(std::move(si));
                };
                sameAs(c1, "_lod1_c", v.nearMid.name);
                if (!L.midCards()) sameAs(c2, "_lod2_c", v.level1.name);
                l0.children.push_back(std::move(c0));
                l1.children.push_back(std::move(c1));
                if (!L.midCards()) l2.children.push_back(std::move(c2));
            }
            // the mid level's crown cards (when the tree has them, in place of the mid clusters): one node per atlas cell
            for (size_t k = 0; k < L.cards.size() && k < lib.cards.size(); ++k) {
                if (L.cards[k].empty()) continue;
                staged_glb::StagedNode cn;
                cn.name = base + "_lod2_card" + std::to_string(k);
                cn.extrasJson = clusterExtras(lib.cards[k].name, 0xCA4Dull + k);
                cn.instances.push_back(instancesOf(L.cards[k], lib.cards[k].name));
                l2.children.push_back(std::move(cn));
            }
            const bool instanced0 = !l0.children.empty(), instanced1 = !l1.children.empty(), instanced2 = !l2.children.empty();
            l0.extrasJson = lodExtras(0, 0.0, d0 + 0.5 * fade, fade, L.drawnLevel0(), instanced0);
            l1.extrasJson = lodExtras(1, d0 - 0.5 * fade, dNM + 0.5 * fadeNM, fadeNM, L.drawnNearMid(), instanced1);
            l2.extrasJson = lodExtras(2, dNM - 0.5 * fadeNM, d1 + 0.5 * fade1, fade1, L.drawnLevel1(), instanced2);
            // level 3: its own wood, the trunk and main limbs (a few hundred triangles; a viewer shows them through the holes it opens
            // in the masses), and the blob masses meshCrown builds on the same skeleton
            size_t level3Wood = L.farWoodTriangles;
            if (!L.farWood.indices.empty()) {
                l3.primitives.push_back(primitiveOf(L.farWood, L.farWoodGrowth));
                if (tr.hasTextures && L.farWood.uvs.size() == L.farWood.vertices.size()) {
                    auto& uv = l3.primitives.back().uvs;
                    for (const auto& t : L.farWood.uvs) uv.push_back({t.x, t.y});
                }
            } else {
                staged_glb::StagedPrimitive woodRef;     // no far wood (never expected: the trunk is always kept): level 0's wood
                woodRef.reuseNode = l0.name;
                woodRef.reuseIndex = 0;
                l3.primitives.push_back(std::move(woodRef));
                level3Wood = L.woodTriangles;
            }
            if (!tr.foliage.indices.empty()) l3.primitives.push_back(primitiveOf(tr.foliage, tr.growth.foliage));
            const size_t level3Triangles = level3Wood + tr.foliage.indices.size() / 3;
            // which of the level-3 primitives are leaves (the wood is primitive 0): a viewer shades only these with the crown
            l3.extrasJson = lodExtras(3, d1 - 0.5 * fade1, 1.0e6, fade1, level3Triangles, false, tr.foliage.indices.empty() ? std::string() : std::string(",\"foliagePrimitives\":[1]"));
            node.children.push_back(std::move(l0));
            node.children.push_back(std::move(l1));
            node.children.push_back(std::move(l2));
            node.children.push_back(std::move(l3));
            auto levelJson = [&](const tree_lod::LeafLevelMeasure& m, size_t drawn) {
                return "{\"leaves\":" + std::to_string(m.leaves) + ",\"drawnTriangles\":" + std::to_string(drawn) + ",\"crownSurfaceReached\":" + json::num(m.share()) +
                       ",\"crownSurfaceWithin1m\":" + json::num(m.strictShare()) + ",\"leavesBelowApexM\":" + json::num(static_cast<double>((*tr.crown)["apex"][1].num) - m.topY) + "}";
            };
            lodMembers = ",\"lod\":{\"leafLengthM\":" + json::num(L.leafLengthM) + ",\"stations\":" + std::to_string(L.stations) + ",\"repairStations\":" + std::to_string(L.repairStations) +
                         ",\"twigs\":" + std::to_string(L.twigCount()) + ",\"woodTriangles\":" + std::to_string(L.woodTriangles) +
                         ",\"level0\":" + levelJson(L.level0, L.drawnLevel0()) + ",\"nearMid\":" + levelJson(L.nearMid, L.drawnNearMid()) + ",\"level1\":" + levelJson(L.level1, L.drawnLevel1()) +
                         ",\"far\":{\"woodTriangles\":" + std::to_string(L.farWoodTriangles) + ",\"woodPrunedBelowRadiusM\":" + json::num(L.farWoodPrunedBelowRadiusM) +
                         ",\"drawnTriangles\":" + std::to_string(L.drawnFar(tr.foliage.indices.size() / 3)) + "}" +
                         ",\"fillStations\":" + std::to_string(L.coverage.fillStations) + (L.midCards() ? ",\"crownCards\":" + detail::crownCardsJson(L) : std::string()) +
                         ",\"coverage\":" + detail::coverageJson(L.coverage) + (heroTree ? ",\"hero\":true" : std::string()) + "}";
            // the crown envelope of the delivered leaves (tree node frame = the tile frame): a viewer shades the leaves with its normals
            std::string crownJson;
            const tree_lod::CrownEllipsoid ce = tree_lod::crownOfLeaves(L, lib);
            if (ce.valid()) {
                const auto& stem = (*tr.crown)["stem"];
                const double sx = stem.arr.size() == 2 ? stem[0].num : static_cast<double>(ce.centre.x), sz = stem.arr.size() == 2 ? stem[1].num : static_cast<double>(ce.centre.z);
                crownJson = ",\"crown\":{\"centre\":[" + json::num(ce.centre.x) + "," + json::num(ce.centre.y) + "," + json::num(ce.centre.z) + "],\"radii\":[" + json::num(ce.radii[0]) + "," +
                            json::num(ce.radii[1]) + "," + json::num(ce.radii[2]) + "],\"yawRad\":" + json::num(ce.yawRad) + ",\"leanM\":[" + json::num(ce.centre.x - sx) + "," + json::num(ce.centre.z - sz) +
                            "],\"points\":" + std::to_string(ce.points) + ",\"fittedTo\":\"leaf clusters\"";
                // the crown's lobes (a smooth union of spheres) when the clusters give any: a viewer shades with them instead of the ellipsoid
                const tree_lod::CrownLobes lobes = tree_lod::crownLobesOfLeaves(L, lib);
                if (lobes.valid()) {
                    crownJson += ",\"lobes\":[";
                    for (size_t li = 0; li < lobes.lobes.size(); ++li) {
                        const auto& lb = lobes.lobes[li];
                        crownJson += std::string(li ? "," : "") + "[" + json::num(lb[0]) + "," + json::num(lb[1]) + "," + json::num(lb[2]) + "," + json::num(lb[3]) + "]";
                    }
                    crownJson += "],\"lobeBlendM\":" + json::num(lobes.blendM);
                }
                crownJson += "}";
            }
            lodMembers += ",\"sbTree\":{\"id\":" + std::to_string(tr.crownId) + ",\"hashSeed\":" + std::to_string(tr.seed) + ",\"label\":" + std::string(((*tr.crown)["origin"].type == io::GlbJsonValue::String && (*tr.crown)["origin"].str == "described") ? "\"generated\"" : "\"grown to the measured crown\"") + crownJson +
                          detail::treeColourMembers(*tr.crown) + (tr.hasTextures ? detail::treeTextureMembers(tr, *P.textures) : std::string()) +
                          detail::treeSpeciesMembers(tr, P.growth) + "}";
        } else {
            node.primitives = std::move(blobPrims);
        }
        const auto& c = *tr.crown;
        staged_glb::NodeExtras sb;
        sb.stage = "trees";
        // a described crown (scratchbox_sb_veggie_grove.hpp: an imagined scene's tree, its size given by the request, no
        // scan behind it) is generated, never measured; its confidence is the share of the described crown its leaves fill
        const bool described = c["origin"].type == io::GlbJsonValue::String && c["origin"].str == "described";
        if (described) {
            sb.provenance.label = "generated";
            sb.provenance.measuredGeometry = false;
            sb.provenance.confidence = std::clamp(tr.leaves.share(), 0.0, 1.0);
            sb.provenance.method = "SB-Veggie space colonisation grown into a crown described by measurements (height, crown radii, crown base, crown profile, leaf colour), not measured from any scan" +
                                   std::string(tr.hasLod ? "; leaves are instanced SB-Veggie clusters placed on that branching" : "");
        } else {
            sb.provenance.label = "grown to the measured crown";
            sb.provenance.measuredGeometry = true;
            sb.provenance.method = "SB-Veggie space colonisation grown into the crown measured in the photo tiles: stem, crown extent and height measured, branching grown inside the measured crown" +
                                   std::string(tr.hasLod ? "; leaves are instanced SB-Veggie clusters placed on that branching, not measured" : "");
        }
        if (tr.hasCorrection) {
            sb.provenance.method += "; crown width (x" + detail::fixed(tr.correction.widthScale, 2) + ") and crown base photo-inferred from Street View (" + tr.correction.source + ")";
            sb.provenance.sources.push_back({"photo-inferred", "crown-correction-" + std::to_string(tr.crownId), "the crown's width and base read from registered Street View photos (scratchbox.crown-correction/1)"});
        }
        if (described) sb.provenance.sources.push_back({"described", "crown-" + std::to_string(tr.crownId), "the crown the request's measurements describe (scratchbox_sb_veggie_grove.hpp)"});
        else sb.provenance.sources.push_back({"tile-extraction", "crown-" + std::to_string(tr.crownId), "the crown tile_vegetation strip measured (crowns.json)"});
        sb.provenance.note = "trunk stands at " + detail::fixed(c["supportY"].num, 2) + " m (" + c["supportSource"].asString() + ")" +
                             (c["supportMovedM"].type == io::GlbJsonValue::Number ? "; stood " + detail::fixed(std::abs(c["supportMovedM"].num), 2) + " m " + (c["supportMovedM"].num < 0 ? "lower" : "higher") + " onto the ground rebuilt under its stem" : std::string());
        sb.provenance.inferred = {{"crownBaseRatio", tr.crownBaseRatio}, {"trunkRadiusPerHeight", tr.trunkRadiusPerHeight}, {"crownBaseY", tr.crownBaseY}, {"trunkRadiusM", tr.trunkRadius}};
        if (tr.hasLod) sb.provenance.inferred.push_back({"leafLengthM", tr.lod.leafLengthM});
        sb.buildOrder = static_cast<long long>(rank);
        sb.buildCount = static_cast<long long>(buildCount);
        sb.revealKind = "grow";
        sb.revealAttribute = P.reveal;
        sb.durationShare = 1.0;
        sb.crownId = tr.crownId;
        sb.vertices = static_cast<long long>(vertices);
        sb.triangles = static_cast<long long>(triangles);
        node.extrasJson = sb.toJson(detail::treeExtrasMembers(tr, P) + lodMembers);
        nodes.push_back(std::move(node));
    }
    for (size_t k = 0; k < rings.size(); ++k) {
        const auto& c = *rings[k];
        const int id = c["id"].asInt(-1);
        double base = c["supportY"].type == io::GlbJsonValue::Number ? c["supportY"].num : std::numeric_limits<double>::quiet_NaN();
        std::string baseNote = "at its support height";
        if (!std::isfinite(base)) {
            base = std::numeric_limits<double>::infinity();
            for (const auto& smp : c["samples"].arr) base = std::min(base, smp[1].num);
            baseNote = "at the lowest point of its measured surface (its ground is not measured)";
        }
        if (!std::isfinite(base)) continue;
        staged_glb::StagedPrimitive pr;
        pr.mode = 1;
        const double sx = c["stem"][0].num, sz = c["stem"][1].num;
        for (size_t s = 0; s < 16; ++s) {
            const double ang = -M_PI + (static_cast<double>(s) + 0.5) * (2 * M_PI / 16.0);
            const double r = c["sectorRadii"][s].num;
            pr.positions.push_back(Vec3(static_cast<float>(sx + r * std::cos(ang)), static_cast<float>(base), static_cast<float>(sz + r * std::sin(ang))));
            pr.colors.push_back({230, 159, 0, 255});
            pr.indices.push_back(static_cast<uint32_t>(s));
            pr.indices.push_back(static_cast<uint32_t>((s + 1) % 16));
        }
        staged_glb::StagedNode node;
        node.name = "as_scanned_crown_" + std::to_string(id);
        node.primitives.push_back(std::move(pr));
        staged_glb::NodeExtras sb;
        sb.stage = "trees";
        sb.provenance.label = "as-scanned";
        sb.provenance.measuredGeometry = true;
        sb.provenance.method = "a measured crown kept as scanned in the remeshed tile: its 16-sector measured footprint, " + baseNote;
        sb.provenance.sources.push_back({"tile-extraction", "crown-" + std::to_string(id), "the crown tile_vegetation strip measured (crowns.json)"});
        const std::string why = c["regrowth"]["reason"].type == io::GlbJsonValue::String ? c["regrowth"]["reason"].str
                              : c["ground"]["reason"].type == io::GlbJsonValue::String ? c["ground"]["reason"].str : std::string();
        sb.provenance.note = "kept as scanned (" + c["status"].asString() + ")" + (why.empty() ? std::string() : ": " + why);
        sb.buildOrder = static_cast<long long>(planted.size() + k);
        sb.buildCount = static_cast<long long>(buildCount);
        sb.revealKind = "outline";
        sb.durationShare = 1.0;
        sb.crownId = id;
        sb.vertices = 16;
        sb.triangles = 0;
        sb.lines = 16;
        node.extrasJson = sb.toJson("\"crownId\":" + std::to_string(id) + ",\"keptAsScanned\":true");
        nodes.push_back(std::move(node));
    }
    // root extras: the frame's axes (as the extraction named them), the request's free-text label (a top-level string
    // of the crown list; it names the trees, it never changes them) and what was planted, beside extras.sb
    const auto& frame = crownsDoc["frame"];
    std::string members;
    std::string frameName = "tile frame: x east, y up, z south (metres)";
    if (frame.type == io::GlbJsonValue::Object && frame.has("frame") && frame["frame"].type == io::GlbJsonValue::String) {
        members += "\"frame\":" + json::write(frame["frame"]) + ",";
        frameName = frame["frame"].str;
    }
    if (crownsDoc.has("label") && crownsDoc["label"].type == io::GlbJsonValue::String) members += "\"label\":" + json::write(crownsDoc["label"]) + ",";
    size_t farTotal = 0;
    for (const auto& t : R.trees) farTotal += t.hasLod ? t.lod.drawnFar(t.foliage.indices.size() / 3) : (t.wood.indices.size() + t.foliage.indices.size()) / 3;
    members += "\"sbVeggie\":{\"trees\":" + std::to_string(R.trees.size()) + ",\"triangles\":" + std::to_string(R.triangles) + (R.library ? ",\"farLevelTriangles\":" + std::to_string(farTotal) : std::string()) +
               ",\"triangleBudget\":" + std::to_string(static_cast<size_t>(R.triangleBudget)) + ",\"shortOfCrown\":" + std::to_string(R.shortOfCrown) +
               (R.groundChecked ? ",\"offGround\":" + std::to_string(R.offGround) : std::string()) + ",\"keptAsScannedRings\":" + std::to_string(rings.size()) +
               ",\"keptOffWalls\":{\"trees\":" + std::to_string(R.clippedAtWalls) + ",\"attractorsClipped\":" + std::to_string(R.attractorsClipped) + ",\"attractorsAtClippedCrowns\":" + std::to_string(R.attractorsAtClippedCrowns) + "}" +
               ",\"generator\":\"space colonisation\"}";
    staged_glb::WriteOptions opt;
    if (R.library) {
        const auto& lib = *R.library;
        auto libMesh = [&](const tree_lod::LibraryMesh& m) {
            staged_glb::StagedLibraryMesh lm;
            lm.name = m.name;
            lm.primitive.positions = m.positions;
            lm.primitive.normals = m.normals;
            lm.primitive.indices = m.indices;
            if (m.uvs.size() == m.positions.size()) for (const auto& t : m.uvs) lm.primitive.uvs.push_back({t.x, t.y});
            if (m.leaf.size() == m.positions.size()) lm.primitive.leaf = m.leaf;
            return lm;
        };
        std::string variants;
        for (const auto& v : lib.variants) {
            opt.library.push_back(libMesh(v.level0));
            opt.library.push_back(libMesh(v.level1));
            opt.library.push_back(libMesh(v.nearMid));
            variants += (variants.empty() ? "" : ",") + std::string("{\"mesh\":") + json::str(v.name) + ",\"leavesLevel0\":" + std::to_string(v.level0.leaves) + ",\"leavesNearMid\":" + std::to_string(v.nearMid.leaves) + ",\"leavesLevel1\":" + std::to_string(v.level1.leaves) + "}";
        }
        for (const auto& tw : lib.twigs) {
            opt.library.push_back(libMesh(tw));
            variants += "," + std::string("{\"mesh\":") + json::str(tw.name) + ",\"leavesLevel0\":0,\"leavesNearMid\":0,\"leavesLevel1\":0}";
        }
        // the crown cards (the mid level's leaves where a tree has them): leaf meshes of the mid level only
        bool anyCards = false;
        for (const auto& t : R.trees) if (t.hasLod && t.lod.midCards()) { anyCards = true; break; }
        std::string cardsJson;
        if (anyCards) {
            std::string names, cells;
            for (const auto& c : lib.cards) {
                opt.library.push_back(libMesh(c));
                variants += "," + std::string("{\"mesh\":") + json::str(c.name) + ",\"leavesLevel0\":0,\"leavesNearMid\":0,\"leavesLevel1\":" + std::to_string(c.leaves) + "}";
                names += (names.empty() ? "" : ",") + json::str(c.name);
            }
            for (const auto& cell : lib.cardLayout.cells) {
                std::string leaves;
                for (const auto& lf : cell) leaves += (leaves.empty() ? "" : ",") + std::string("[") + json::num(lf.u) + "," + json::num(lf.v) + "," + json::num(lf.angle) + "," + json::num(lf.length) + "," + json::num(lf.pick) + "]";
                cells += (cells.empty() ? "" : ",") + std::string("[") + leaves + "]";
            }
            cardsJson = ",\"crownCards\":{\"schema\":\"scratchbox.crown-cards/1\",\"meshes\":[" + names + "],\"cols\":" + std::to_string(lib.cardLayout.cols) + ",\"rows\":" + std::to_string(lib.cardLayout.rows) +
                        ",\"clayLeafAspect\":" + json::num(lib.params.morphology.blade.widthRatio) +
                        ",\"leaf\":\"[u, v, angle, length, pick]: an ellipse centred (u, v) in the card's cell ([0, 1]^2, s across, t up; TEXCOORD_0 = ((col + s) / cols, (row + t) / rows)), its long axis at angle (rad from +s), length long, length x aspect wide (clay: clayLeafAspect); textured, the leaf cell's image is drawn in a box along the same axis with the cell's own aspect, scaled so the cell's fill covers the clay ellipse's area (box length = length x sqrt((pi / 4) x clayLeafAspect / (fill x aspect))); pick in [0, 1) chooses its leaf image and shade; drawn in list order\"" +
                        ",\"cells\":[" + cells + "]}";
        }
        members += ",\"sbTrees\":{\"schema\":\"scratchbox.trees-lod/3\",\"psiSeason\":" + json::num(std::clamp(P.psiSeason, 0.0, 1.0)) + ",\"clusterLibrary\":{\"variants\":[" + variants +
                   "],\"leafSizeModel\":{\"sizeRatioToCrownHeight\":" + json::num(lib.params.leafSizeRatioToCrownHeight) + ",\"minM\":" + json::num(lib.params.leafMinM) + ",\"maxM\":" + json::num(lib.params.leafMaxM) + ",\"atlasMaxM\":" + json::num(lib.params.atlasLeafMaxM) + "}" +
                   // a leaf card's TEXCOORD_0 (u = 0.5 + across / length, v = along / length): its outline's box is widthRatio wide
                   ",\"leafCard\":{\"widthRatio\":" + json::num(lib.params.morphology.blade.widthRatio) + ",\"uv\":\"TEXCOORD_0: u = 0.5 + across / blade length, v = along / blade length (base 0)\",\"leafAttribute\":\"_LEAF: x atlas pick in [0, 1), y 1 on a blade, 0 on a stalk or shoot\"}}" + cardsJson +
                   (P.textures ? ",\"textures\":{\"schema\":" + json::str(P.textures->schema) + ",\"index\":" + json::str(P.textureIndex) +
                                 ",\"woodUv\":\"TEXCOORD_0 in the chosen bark's tiles: u around (whole tiles), v along the path from the root\",\"chosenBy\":\"appearance: measured crown colour, leaf size from the species leaf (else the tree's height and crown), the species leaf's blade width (a needle or scale leaf's millimetres draw a needle spray, a broad leaf's centimetres a leaf), bark relief from its size\"}"
                               : std::string()) +
                   (P.growth.species ? ",\"species\":{\"schema\":" + json::str(P.growth.species->schema) + ",\"index\":" + json::str(P.growth.speciesIndex) +
                                       ",\"chosenBy\":\"the crown's measurements: height, crown radius over height, the share of its surface near the apex, its photo hue\"}"
                                     : std::string()) + "}";
    }
    opt.generator = "Scratchbox SB-Veggie (space colonisation, tile_vegetation plant)";
    opt.rootName = "sb_veggie_trees";
    opt.rootExtrasJson = staged_glb::rootExtrasJson("trees", P.stageKey, frameName, std::string(), members);
    opt.quantize = P.quantize;
    opt.maxPositionErrorM = P.maxQuantizationErrorM;
    TreesGlbReport rep;
    rep.rings = rings.size();
    std::vector<uint8_t> out;
    try {
        out = staged_glb::write(nodes, opt, &rep.glb);
        if (P.quantize) {
            staged_glb::WriteOptions plain = opt;
            plain.quantize = false;
            rep.unquantizedBytes = staged_glb::write(nodes, plain).size();
        }
    } catch (const staged_glb::StagedGlbError& e) {
        throw VegetationError("failed", std::string("the trees GLB could not be written: ") + e.what());
    }
    if (report) *report = rep;
    return out;
}

} // namespace tile_vegetation
} // namespace scratchbox

#endif // SCRATCHBOX_TILE_VEGETATION_HPP
