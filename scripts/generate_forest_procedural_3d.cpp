/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Hyperrealistic Procedural 3D Forest Reconstruction (Astro Engine C++20)
 * Clean-Slate Master 3D Artist Architecture adhering to:
 * - .agents/skills/3d-artist/SKILL.md
 * - 70-20-10 Form Hierarchy
 * - 7-Tier Biome Stratification (Canopy -> Subcanopy -> Ferns -> Herbs -> Epiphytes -> Debris -> Substrate)
 * - Multi-Mesh glTF 2.0 Binary Output (.glb) with embedded PBR maps: the floor, moss and bark from the app's texture
 *   library (photographed tileable sets) at their real size, the fern pinnae a leaf from the tree texture library, each
 *   tinted to its region of the reference photograph
 * - Macro-to-Micro Rule-Based Clutter Placement
 * - Every crown grown by SB-Veggie (scratchbox_sb_veggie_grove.hpp) into <output>_trees.glb beside the forest
 *
 * Run from the repository root (it reads public/forest_reference.png, assets/textures/library/copies,
 * assets/vegetation/species and assets/textures/trees):
 *   clang++ -std=c++20 -O3 -pthread -I packages/core/src/native/3d-engine/include \
 *       scripts/generate_forest_procedural_3d.cpp -o build/3d-native/generate_forest_procedural_3d -lz
 *   build/3d-native/generate_forest_procedural_3d public/models/forest_hyperreal.glb
 * writes public/models/forest_hyperreal.glb, forest_hyperreal_trees.glb and forest_hyperreal_trees.stats.json, which
 * /forest_3d_viewer.html loads.
 ********************************************************************************/

#include "scratchbox_engine.hpp"
#include "scratchbox_nature.hpp"
#include "scratchbox_substrate.hpp"
#include "scratchbox_botanical_texture.hpp"
#include "scratchbox_infiniti.hpp"
#include "scratchbox_sb_veggie_grove.hpp"
#include "scratchbox_png.hpp"
#include "scratchbox_jpeg.hpp"

#include <iostream>
#include <fstream>
#include <sstream>
#include <vector>
#include <string>
#include <cmath>
#include <chrono>
#include <algorithm>
#include <limits>
#include <functional>
#include <stdexcept>
#include <tuple>

using namespace scratchbox;
using namespace scratchbox::geometry;
using namespace scratchbox::botanical;
using namespace scratchbox::nature;
using namespace scratchbox::substrate;
using namespace scratchbox::infiniti;
using math::Vec2;
using math::Vec3;
using math::Vec4;
using math::PI;
using math::TWO_PI;
using math::HALF_PI;
using math::DEG_TO_RAD;

// ============================================================================
// File Loading Helper for Embedded Textures
// ============================================================================
inline std::vector<uint8_t> readFileBytes(const std::string& path) {
    std::ifstream file(path, std::ios::binary | std::ios::ate);
    if (!file.is_open()) return {};
    std::streamsize size = file.tellg();
    file.seekg(0, std::ios::beg);
    std::vector<uint8_t> buffer(size);
    if (file.read(reinterpret_cast<char*>(buffer.data()), size)) {
        return buffer;
    }
    return {};
}

// ============================================================================
// Surface Materials: Texture Library Sets at Their Real Size, Tinted to the Reference Photograph
// ============================================================================
// The floor (needle duff), the moss and the bark are tileable photographed sets from the app's texture library
// (ambientCG / Poly Haven, CC0), copied at a working resolution into assets/textures/library/copies by
// scripts/copy_texture_library_sets.py; each was chosen by its measured colour and texture against the region of
// public/forest_reference.png it stands for (docs/processes/forest_viewer_library_surfaces_2026-11-02.md lists the
// candidates). The fern pinnae draw a leaf from the tree texture library, chosen below by shape, real size and colour.
// UVs are laid in metres over each set's real tile size. A material's baseColorFactor tints its map to the chromaticity
// measured in its region of the photograph (per channel the region's share over the set's, scaled so the largest is 1: a
// factor can only darken), then darkens it where the photograph shows the surface darker, relative to the duff, than its
// set is (luminanceShare); otherwise a set keeps its own albedo. Vertex colours only modulate the tinted map (1 = the set
// as tinted): damp humus, the flutes' crevices, moss on bark.

struct SurfaceSet {
    std::string id, publisher, licence, sizeSource, library;
    float tileU{1.0f}, tileV{1.0f};    // real tile width and height, metres
    Vec3 meanLinear;                   // the map's mean colour, linear sRGB (over opaque texels for a leaf)
    std::vector<uint8_t> albedo, normal, orm;
    std::string albedoMime{"image/jpeg"}, normalMime{"image/jpeg"}, ormMime{"image/jpeg"};
};

struct PhotoRegion { int x0, y0, x1, y1; };

/** A region set of the reference photograph and the linear colour measured over its kept pixels. */
struct MeasuredTarget {
    std::vector<PhotoRegion> regions;
    std::string keeps;   // which pixels count, for the record
    Vec3 meanLinear;
    size_t pixels{0};
};

inline float srgbToLinear(uint8_t v) {
    const float c = v / 255.0f;
    return c <= 0.04045f ? c / 12.92f : std::pow((c + 0.055f) / 1.055f, 2.4f);
}

inline std::string jsonVec(const Vec3& v) {
    std::ostringstream s;
    s << "[" << v.x << "," << v.y << "," << v.z << "]";
    return s.str();
}

inline std::string jsonStr(const std::string& v) {
    std::string out = "\"";
    for (char c : v) {
        if (c == '"' || c == '\\') out += '\\';
        out += c;
    }
    return out + "\"";
}

inline io::GlbJsonValue readJsonFile(const std::string& path) {
    const auto bytes = readFileBytes(path);
    if (bytes.empty()) throw std::runtime_error("cannot read " + path + " (run from the repository root)");
    io::GlbJsonParser p(reinterpret_cast<const char*>(bytes.data()), bytes.size());
    return p.parse();
}

inline Vec3 vec3Of(const io::GlbJsonValue& v, const std::string& what) {
    if (v.type != io::GlbJsonValue::Array || v.arr.size() < 3) throw std::runtime_error(what + " must be an array of three numbers");
    return Vec3(static_cast<float>(v[size_t(0)].num), static_cast<float>(v[size_t(1)].num), static_cast<float>(v[size_t(2)].num));
}

/** A set's working copy (assets/textures/library/copies/index.json): its maps and the size and colour measured on them. */
inline SurfaceSet loadLibraryCopy(const std::string& id) {
    const std::string dir = "assets/textures/library/copies/";
    const io::GlbJsonValue index = readJsonFile(dir + "index.json");
    for (const auto& e : index["sets"].arr) {
        if (e["id"].str != id) continue;
        SurfaceSet s;
        s.id = id;
        s.library = dir;
        s.publisher = e["publisher"].str;
        s.licence = e["licence"].str;
        s.sizeSource = e["sizeSource"].str;
        s.tileU = static_cast<float>(e["realSizeM"][size_t(0)].num);
        s.tileV = static_cast<float>(e["realSizeM"][size_t(1)].num);
        if (!(s.tileU > 0.0f) || !(s.tileV > 0.0f)) throw std::runtime_error(id + ": no real tile size in " + dir + "index.json");
        s.meanLinear = vec3Of(e["colour"]["meanLinearRgb"], id + ".colour.meanLinearRgb");
        for (auto [map, bytes] : { std::pair{"albedo", &s.albedo}, std::pair{"normal", &s.normal}, std::pair{"orm", &s.orm} }) {
            const std::string path = dir + e["maps"][map].str;
            *bytes = readFileBytes(path);
            if (bytes->empty()) throw std::runtime_error("cannot read " + path);
        }
        return s;
    }
    throw std::runtime_error("no set '" + id + "' in " + dir + "index.json (copy it with scripts/copy_texture_library_sets.py)");
}

/** The mean linear colour of the photograph's pixels in `regions` that `keep` accepts. */
inline MeasuredTarget measurePhoto(const texture::ImageBuffer& photo, std::vector<PhotoRegion> regions, std::string keeps,
                                   const std::function<bool(float r, float g, float b)>& keep) {
    MeasuredTarget t{std::move(regions), std::move(keeps), Vec3(0, 0, 0), 0};
    double sum[3] = {0, 0, 0};
    for (const auto& r : t.regions) {
        for (int y = std::max(0, r.y0); y < std::min(photo.height, r.y1); ++y) {
            for (int x = std::max(0, r.x0); x < std::min(photo.width, r.x1); ++x) {
                const uint8_t* px = &photo.data[(static_cast<size_t>(y) * photo.width + x) * photo.channels];
                const float lr = srgbToLinear(px[0]), lg = srgbToLinear(px[1]), lb = srgbToLinear(px[2]);
                if (!keep(lr, lg, lb)) continue;
                sum[0] += lr; sum[1] += lg; sum[2] += lb;
                ++t.pixels;
            }
        }
    }
    if (t.pixels == 0) throw std::runtime_error("no pixel of the reference photograph is kept for '" + t.keeps + "'");
    t.meanLinear = Vec3(static_cast<float>(sum[0] / t.pixels), static_cast<float>(sum[1] / t.pixels), static_cast<float>(sum[2] / t.pixels));
    return t;
}

inline Vec3 chromaticity(const Vec3& c) {
    const float s = std::max(1e-6f, c.x + c.y + c.z);
    return Vec3(c.x / s, c.y / s, c.z / s);
}

/** The factor (each channel at most 1) that gives `from` the chromaticity of `to`. */
inline Vec3 tintFactor(const Vec3& from, const Vec3& to) {
    const Vec3 a = chromaticity(to), b = chromaticity(from);
    Vec3 g(a.x / std::max(1e-6f, b.x), a.y / std::max(1e-6f, b.y), a.z / std::max(1e-6f, b.z));
    const float m = std::max({g.x, g.y, g.z});
    return Vec3(g.x / m, g.y / m, g.z / m);
}

inline float luminance(const Vec3& c) { return 0.2126f * c.x + 0.7152f * c.y + 0.0722f * c.z; }

/**
 * The share a surface's tint is darkened by so that its luminance stands to the duff's as the photograph shows them (the
 * duff, the largest and most evenly lit surface there, keeps its set's albedo). A factor can only darken, so a surface
 * the photograph shows brighter than this (sunlit moss, translucent fronds) keeps its set's own; 1 then.
 */
inline float luminanceShare(const Vec3& setMean, const Vec3& tint, const MeasuredTarget& target, float duffLuminance, const MeasuredTarget& duffTarget) {
    const float have = luminance(Vec3(setMean.x * tint.x, setMean.y * tint.y, setMean.z * tint.z));
    const float want = duffLuminance * luminance(target.meanLinear) / std::max(1e-6f, luminance(duffTarget.meanLinear));
    return have > 1e-6f ? std::min(1.0f, want / have) : 1.0f;
}

/** The material's extras: the set it draws, its real size, and the measurement it is tinted to. */
inline std::string surfaceExtras(const SurfaceSet& s, const MeasuredTarget& t, const Vec3& factor, float luminanceShareOf, const std::string& uv) {
    std::ostringstream e;
    e << "{\"sbSurface\":{\"set\":" << jsonStr(s.id) << ",\"library\":" << jsonStr(s.library) << ",\"publisher\":" << jsonStr(s.publisher)
      << ",\"licence\":" << jsonStr(s.licence) << ",\"realSizeM\":[" << s.tileU << "," << s.tileV << "],\"sizeSource\":" << jsonStr(s.sizeSource)
      << ",\"uv\":" << jsonStr(uv) << ",\"setMeanLinearRgb\":" << jsonVec(s.meanLinear)
      << ",\"tint\":{\"factor\":" << jsonVec(factor) << ",\"luminanceShare\":" << luminanceShareOf
      << ",\"measuredLinearRgb\":" << jsonVec(t.meanLinear) << ",\"pixels\":" << t.pixels
      << ",\"keeps\":" << jsonStr(t.keeps) << ",\"source\":\"public/forest_reference.png\",\"regionsPx\":[";
    for (size_t i = 0; i < t.regions.size(); ++i) {
        const auto& r = t.regions[i];
        e << (i ? "," : "") << "[" << r.x0 << "," << r.y0 << "," << r.x1 << "," << r.y1 << "]";
    }
    e << "]},\"provenance\":\"library\"}}";
    return e.str();
}

// A sword fern pinna as the clump generator (section 5) draws it: its length a share of the clump's radius at mid-frond,
// its width a share of that length. The pinnae's leaf is chosen against the pinna of a clump this size.
constexpr float PINNA_LENGTH_SHARE = 0.32f;
constexpr float PINNA_WIDTH_SHARE = 0.38f;
constexpr float PINNA_TIP_REACH = 1.15f;   // the tip stands this far out along the pinna's length
constexpr float REFERENCE_CLUMP_RADIUS_M = 0.95f;

/** One leaf of an atlas in glTF UVs (v down): uv = origin + t * along + s * across, s across and t along in [0, 1]. */
struct LeafCell {
    Vec2 origin, along, across;
    float aspect;   // the leaf's real width over its length
    Vec2 uvAt(float s, float t) const {
        return Vec2(origin.x + t * along.x + s * across.x, origin.y + t * along.y + s * across.y);
    }
};

/** The pinnae's leaf: an atlas from the tree texture library, its cells, and one opaque texel on a stem (the rachis). */
struct FernLeaf {
    SurfaceSet set;
    std::vector<LeafCell> cells;
    Vec2 stemUv;
    float lengthM{0}, widthM{0}, cost{0};
};

/**
 * Chooses the tree texture library's leaf whose shape (width over length), real length and colour are nearest a sword
 * fern pinna's, and readies its maps for a MASK material: the colour map with the opacity in its alpha (transparent
 * texels take the leaf's mean colour, so no background bleeds into the mips), its normal map, and its roughness packed
 * into an ORM map.
 */
inline FernLeaf chooseFernLeaf(const MeasuredTarget& fern) {
    const std::string root = "assets/textures/trees/";
    const io::GlbJsonValue index = readJsonFile(root + "index.json");
    const float pinnaLength = PINNA_TIP_REACH * PINNA_LENGTH_SHARE * REFERENCE_CLUMP_RADIUS_M;
    const float pinnaAspect = PINNA_WIDTH_SHARE * PINNA_LENGTH_SHARE * REFERENCE_CLUMP_RADIUS_M / pinnaLength;
    const Vec3 want = chromaticity(fern.meanLinear);
    const io::GlbJsonValue* best = nullptr;
    float bestCost = std::numeric_limits<float>::infinity();
    std::cout << "   Fern pinna (" << pinnaLength << " m long, width/length " << pinnaAspect << ") against the tree texture library's leaves:\n";
    for (const auto& e : index["leaves"].arr) {
        const float len = static_cast<float>(e["leaf"]["lengthM"].num), wid = static_cast<float>(e["leaf"]["widthM"].num);
        if (!(len > 0.0f) || !(wid > 0.0f)) continue;
        const Vec3 c = chromaticity(vec3Of(e["colour"]["meanLinearRgb"], e["id"].str));
        const float colour = std::abs(c.x - want.x) + std::abs(c.y - want.y) + std::abs(c.z - want.z);
        const float cost = std::abs(std::log((wid / len) / pinnaAspect)) + std::abs(std::log(len / pinnaLength)) + 4.0f * colour;
        std::cout << "     " << e["id"].str << ": shape " << std::abs(std::log((wid / len) / pinnaAspect)) << ", length "
                  << std::abs(std::log(len / pinnaLength)) << ", colour " << colour << " -> " << cost << "\n";
        if (cost < bestCost) { bestCost = cost; best = &e; }
    }
    if (!best) throw std::runtime_error("the tree texture library has no leaf with a measured size");
    const io::GlbJsonValue& e = *best;

    FernLeaf leaf;
    leaf.cost = bestCost;
    leaf.lengthM = static_cast<float>(e["leaf"]["lengthM"].num);
    leaf.widthM = static_cast<float>(e["leaf"]["widthM"].num);
    leaf.set.id = e["id"].str;
    leaf.set.library = root;
    leaf.set.publisher = "tree texture library";
    leaf.set.licence = "see assets/textures/trees/index.json";
    leaf.set.sizeSource = "leaf length and width measured on the atlas (" + root + "index.json: leafSize)";
    leaf.set.tileU = leaf.widthM;
    leaf.set.tileV = leaf.lengthM;

    auto colour = jpeg::decodeFile(root + e["maps"]["color"].str, jpeg::OutputFormat::Rgb);
    const auto opacityBytes = readFileBytes(root + e["maps"]["opacity"].str);
    auto opacity = png::decode(opacityBytes.data(), opacityBytes.size(), png::OutputFormat::Luma);
    auto rough = jpeg::decodeFile(root + e["maps"]["roughness"].str, jpeg::OutputFormat::Luma);
    if (!colour.ok || !opacity.ok || !rough.ok) throw std::runtime_error("cannot decode the maps of leaf " + leaf.set.id);
    if (opacity.image.width != colour.image.width || opacity.image.height != colour.image.height)
        throw std::runtime_error("leaf " + leaf.set.id + ": its opacity and colour maps differ in size");

    // halve the atlas (2x2 means, colour in linear light): the GLB stays light and a pinna still gets a texel per millimetre
    const int W = colour.image.width / 2, H = colour.image.height / 2;
    texture::ImageBuffer rgba(W, H, 4);
    double sum[3] = {0, 0, 0};
    size_t opaque = 0;
    std::vector<float> lin(static_cast<size_t>(W) * H * 3);
    for (int y = 0; y < H; ++y) {
        for (int x = 0; x < W; ++x) {
            float c[3] = {0, 0, 0}, a = 0;
            for (int dy = 0; dy < 2; ++dy) {
                for (int dx = 0; dx < 2; ++dx) {
                    const size_t i = static_cast<size_t>(2 * y + dy) * colour.image.width + (2 * x + dx);
                    for (int k = 0; k < 3; ++k) c[k] += srgbToLinear(colour.image.data[i * 3 + k]);
                    a += opacity.image.data[i] / 255.0f;
                }
            }
            const size_t o = static_cast<size_t>(y) * W + x;
            for (int k = 0; k < 3; ++k) lin[o * 3 + k] = c[k] / 4.0f;
            rgba.data[o * 4 + 3] = static_cast<uint8_t>(std::lround(a / 4.0f * 255.0f));
            if (a / 4.0f >= 0.5f) {
                for (int k = 0; k < 3; ++k) sum[k] += lin[o * 3 + k];
                ++opaque;
            }
        }
    }
    if (opaque == 0) throw std::runtime_error("leaf " + leaf.set.id + " has no opaque texel");
    leaf.set.meanLinear = Vec3(static_cast<float>(sum[0] / opaque), static_cast<float>(sum[1] / opaque), static_cast<float>(sum[2] / opaque));
    auto toSrgb = [](float v) {
        v = std::clamp(v, 0.0f, 1.0f);
        return static_cast<uint8_t>(std::lround((v <= 0.0031308f ? v * 12.92f : 1.055f * std::pow(v, 1.0f / 2.4f) - 0.055f) * 255.0f));
    };
    for (size_t o = 0; o < static_cast<size_t>(W) * H; ++o) {
        const bool clear = rgba.data[o * 4 + 3] < 128;
        rgba.data[o * 4 + 0] = toSrgb(clear ? leaf.set.meanLinear.x : lin[o * 3 + 0]);
        rgba.data[o * 4 + 1] = toSrgb(clear ? leaf.set.meanLinear.y : lin[o * 3 + 1]);
        rgba.data[o * 4 + 2] = toSrgb(clear ? leaf.set.meanLinear.z : lin[o * 3 + 2]);
    }
    leaf.set.albedo = png::encode(rgba, 6);
    leaf.set.albedoMime = "image/png";
    leaf.set.normal = readFileBytes(root + e["maps"]["normal"].str);
    texture::ImageBuffer orm(rough.image.width, rough.image.height, 3);
    for (size_t i = 0; i < static_cast<size_t>(rough.image.width) * rough.image.height; ++i) {
        orm.data[i * 3 + 0] = 255;
        orm.data[i * 3 + 1] = rough.image.data[i];
        orm.data[i * 3 + 2] = 0;
    }
    leaf.set.orm = png::encode(orm, 6);
    leaf.set.ormMime = "image/png";
    if (leaf.set.albedo.empty() || leaf.set.normal.empty() || leaf.set.orm.empty()) throw std::runtime_error("cannot ready the maps of leaf " + leaf.set.id);

    // the library's cells are in UVs with v up (a texture loaded flipped); glTF's v runs down the image
    for (const auto& c : e["atlas"]["cells"].arr) {
        LeafCell cell;
        cell.origin = Vec2(static_cast<float>(c["origin"][size_t(0)].num), 1.0f - static_cast<float>(c["origin"][size_t(1)].num));
        cell.along = Vec2(static_cast<float>(c["along"][size_t(0)].num), -static_cast<float>(c["along"][size_t(1)].num));
        cell.across = Vec2(static_cast<float>(c["across"][size_t(0)].num), -static_cast<float>(c["across"][size_t(1)].num));
        const float l = static_cast<float>(c["lengthM"].num), w = static_cast<float>(c["widthM"].num);
        cell.aspect = (l > 0.0f && w > 0.0f) ? w / l : leaf.widthM / leaf.lengthM;
        leaf.cells.push_back(cell);
    }
    if (leaf.cells.empty()) throw std::runtime_error("leaf " + leaf.set.id + " has no atlas cells");

    // the rachis and crosiers sample one opaque texel on the first leaf's stem, nearest its base
    const LeafCell& first = leaf.cells.front();
    float bestD = std::numeric_limits<float>::infinity();
    leaf.stemUv = first.uvAt(0.5f, 0.5f);
    for (int it = 0; it <= 60; ++it) {
        for (int is = 0; is <= 40; ++is) {
            const float t = 0.02f + 0.6f * it / 60.0f, s = 0.3f + 0.4f * is / 40.0f;
            const Vec2 uv = first.uvAt(s, t);
            const int x = std::clamp(static_cast<int>(uv.x * W), 0, W - 1), y = std::clamp(static_cast<int>(uv.y * H), 0, H - 1);
            if (rgba.data[(static_cast<size_t>(y) * W + x) * 4 + 3] < 250) continue;
            const float d = std::abs(s - 0.5f) * 4.0f + t;
            if (d < bestD) { bestD = d; leaf.stemUv = uv; }
        }
    }
    return leaf;
}

/** Per-vertex glTF tangents from the UVs: xyz along increasing u, w the sign that makes cross(normal, tangent) * w point up
 * the image (decreasing v), as glTF's normal textures (+Y up) need. */
inline void computeTangents(ScratchboxMesh& mesh) {
    std::vector<Vec3> du(mesh.vertices.size(), Vec3(0, 0, 0)), dv(mesh.vertices.size(), Vec3(0, 0, 0));
    for (size_t i = 0; i + 2 < mesh.indices.size(); i += 3) {
        const uint32_t a = mesh.indices[i], b = mesh.indices[i + 1], c = mesh.indices[i + 2];
        const Vertex &A = mesh.vertices[a], &B = mesh.vertices[b], &C = mesh.vertices[c];
        const Vec3 e1 = B.position - A.position, e2 = C.position - A.position;
        const float u1 = B.uv.x - A.uv.x, v1 = B.uv.y - A.uv.y, u2 = C.uv.x - A.uv.x, v2 = C.uv.y - A.uv.y;
        const float det = u1 * v2 - u2 * v1;
        if (std::abs(det) < 1e-12f) continue;
        const float r = 1.0f / det;
        const Vec3 sdir = (e1 * v2 - e2 * v1) * r, tdir = (e2 * u1 - e1 * u2) * r;
        for (uint32_t k : {a, b, c}) { du[k] = du[k] + sdir; dv[k] = dv[k] + tdir; }
    }
    for (size_t k = 0; k < mesh.vertices.size(); ++k) {
        Vertex& v = mesh.vertices[k];
        const Vec3 n = v.normal;
        Vec3 t = du[k] - n * n.dot(du[k]);
        if (t.length() < 1e-8f) {
            t = std::abs(n.y) < 0.9f ? Vec3(0, 1, 0).cross(n) : Vec3(1, 0, 0).cross(n);
        }
        t = t.normalized();
        const float w = n.cross(t).dot(dv[k] * -1.0f) < 0.0f ? -1.0f : 1.0f;
        v.tangent = Vec4(t.x, t.y, t.z, w);
    }
}

// ============================================================================
// Photometrically Calibrated Forest PBR Color Palette (National Geographic Grade)
// ============================================================================
static const Vec4 COL_REDWOOD_BARK(0.35f, 0.19f, 0.12f, 1.0f);       // Deep reddish-brown heartwood bark
static const Vec4 COL_BARK_FURROW(0.10f, 0.05f, 0.03f, 1.0f);        // Crevice shadow / ambient occlusion
static const Vec4 COL_FOREST_HUMUS(0.12f, 0.08f, 0.05f, 1.0f);       // Rich dark forest soil / loam (moist)
static const Vec4 COL_NEEDLE_DUFF(0.26f, 0.15f, 0.09f, 1.0f);        // Redwood fallen needle carpet (duff)
static const Vec4 COL_ORGANIC_LOAM(0.18f, 0.12f, 0.08f, 1.0f);       // Weathered soil surface
static const Vec4 COL_FLOOR_MOSS(0.24f, 0.46f, 0.12f, 1.0f);         // Velvet moss cushion around roots
static const Vec4 COL_NURSE_LOG_WOOD(0.42f, 0.28f, 0.18f, 1.0f);     // Splintered decaying wood core
static const Vec4 COL_NURSE_LOG_MOSS(0.30f, 0.60f, 0.16f, 1.0f);     // Dense sunlit moss cap on log
static const Vec4 COL_FERN_FROND(0.22f, 0.56f, 0.13f, 1.0f);         // Lush sword fern green
static const Vec4 COL_FERN_HIGHLIGHT(0.50f, 0.82f, 0.18f, 1.0f);     // Sunlit translucent fern tip (SSS)
static const Vec4 COL_SUNBEAM_GOLD(0.98f, 0.92f, 0.74f, 0.28f);      // Morning crepuscular light beam

// On the library-textured surfaces a vertex colour modulates the tinted map: the palette's variations as shares of the
// surface the map stands for (each channel at most 1)
inline Vec4 relativeTo(const Vec4& c, const Vec4& ref) {
    return Vec4(std::min(1.0f, c.x / ref.x), std::min(1.0f, c.y / ref.y), std::min(1.0f, c.z / ref.z), 1.0f);
}
inline float luminance(const Vec4& c) { return 0.2126f * c.x + 0.7152f * c.y + 0.0722f * c.z; }
static const Vec4 MOD_NONE(1.0f, 1.0f, 1.0f, 1.0f);
static const Vec4 MOD_HUMUS = relativeTo(COL_FOREST_HUMUS, COL_NEEDLE_DUFF);
static const Vec4 MOD_LOAM = relativeTo(COL_ORGANIC_LOAM, COL_NEEDLE_DUFF);
static const Vec4 MOD_DAMP_SOIL = relativeTo(Vec4(0.08f, 0.05f, 0.03f, 1.0f), COL_NEEDLE_DUFF);
static const Vec4 MOD_FURROW = relativeTo(COL_BARK_FURROW, COL_REDWOOD_BARK);
static const Vec4 MOD_FLOOR_MOSS = relativeTo(COL_FLOOR_MOSS, COL_NURSE_LOG_MOSS);
static const Vec4 MOD_FERN_FROND = relativeTo(COL_FERN_FROND, COL_FERN_HIGHLIGHT);

// ============================================================================
// 1. Terrain Heightfield & Normal Telemetry (Domain-Warped Geology & Forest Bowl)
// ============================================================================
inline float getTerrainHeight(float x, float z) {
    static const WarpedTerrainConfig warpedCfg;
    float warpedGeology = DomainWarpedTerrain::sampleHeight(x, z, warpedCfg) * 0.35f;

    float macroSlope = -0.016f * x - 0.024f * z;

    float midSwells = 0.38f * std::sin(0.12f * x + 0.16f * z)
                    + 0.28f * std::cos(0.18f * x - 0.14f * z);

    float microRelief = 0.10f * std::sin(0.65f * x + 0.55f * z)
                      + 0.06f * std::cos(1.20f * x - 0.90f * z)
                      + 0.03f * std::sin(2.40f * x) * std::cos(2.10f * z);

    // Natural peripheral ridges rising gently beyond 26m
    float radial = std::sqrt(x * x + (z + 16.0f) * (z + 16.0f));
    float ridgeRise = radial > 25.0f ? std::pow((radial - 25.0f) * 0.11f, 2.0f) : 0.0f;

    return macroSlope + midSwells + microRelief + warpedGeology + ridgeRise;
}

inline Vec3 getTerrainNormal(float x, float z) {
    const float eps = 0.12f;
    float hL = getTerrainHeight(x - eps, z);
    float hR = getTerrainHeight(x + eps, z);
    float hD = getTerrainHeight(x, z - eps);
    float hU = getTerrainHeight(x, z + eps);

    Vec3 normal(-(hR - hL) / (2.0f * eps), 1.0f, -(hU - hD) / (2.0f * eps));
    return normal.normalized();
}

// ============================================================================
// 2. Woodland Floor Mesh Generator with Micro-Relief
// ============================================================================
ScratchboxMesh generateForestFloor(const SurfaceSet& duff, float minX, float maxX, float minZ, float maxZ, float step = 0.26f) {
    ScratchboxMesh mesh("Forest_Terrain_Floor");
    mesh.material.name = "PBR_Forest_Floor";
    mesh.material.roughnessFactor = 0.92f;
    mesh.material.metallicFactor = 0.01f;

    int cols = static_cast<int>((maxX - minX) / step) + 1;
    int rows = static_cast<int>((maxZ - minZ) / step) + 1;

    // Soil Machine Sediment & Moisture Simulation (Infiniti SoilMachine)
    SoilSimulationConfig soilCfg;
    soilCfg.numParticles = 750;
    soilCfg.maxSteps = 28;
    auto soilSim = SoilMachineSedimentTracker::runSimulation(
        cols, rows, minX, minZ, step, getTerrainHeight, soilCfg
    );

    for (int r = 0; r < rows; ++r) {
        float z = minZ + r * step;
        for (int c = 0; c < cols; ++c) {
            float x = minX + c * step;
            float y = getTerrainHeight(x, z);
            Vec3 pos(x, y, z);
            Vec3 norm = getTerrainNormal(x, z);

            float moisture = soilSim.sampleMoisture(x, z, minX, minZ, step, cols, rows);
            float sediment = soilSim.sampleSediment(x, z, minX, minZ, step, cols, rows);

            float needleNoise = 0.5f + 0.5f * std::sin(x * 1.8f + z * 1.4f) * std::cos(x * 2.2f - z * 1.9f);
            float humusNoise  = 0.5f + 0.5f * std::sin(x * 3.4f - z * 2.8f) * std::cos(x * 1.2f + z * 3.1f);
            float microFbm    = 0.5f + 0.5f * std::sin(x * 4.2f + z * 4.6f) * std::cos(x * 5.1f - z * 3.3f);

            // the duff map, darker where humus and loam show through and in the damp drainage channels (the moss is its
            // own surface, the hummocks)
            Vec4 color = math::lerp(MOD_HUMUS, MOD_NONE, needleNoise * 0.70f + 0.15f);
            color = math::lerp(color, MOD_LOAM, humusNoise * 0.35f);

            // Soil machine moisture deepening in drainage channels
            color = math::lerp(color, MOD_DAMP_SOIL, moisture * 0.40f);

            float noiseShade = 0.86f + 0.14f * microFbm;
            color = Vec4(color.x * noiseShade, color.y * noiseShade, color.z * noiseShade, 1.0f);

            // the duff's real tile size, in metres across the ground
            Vec2 uv((x - minX) / duff.tileU, (z - minZ) / duff.tileV);
            mesh.addVertex(Vertex(pos, norm, uv, color));
        }
    }

    for (int r = 0; r < rows - 1; ++r) {
        for (int c = 0; c < cols - 1; ++c) {
            uint32_t i0 = r * cols + c;
            uint32_t i1 = r * cols + (c + 1);
            uint32_t i2 = (r + 1) * cols + c;
            uint32_t i3 = (r + 1) * cols + (c + 1);

            mesh.addTriangle(i0, i2, i1);
            mesh.addTriangle(i1, i2, i3);
        }
    }

    mesh.recomputeBounds();
    return mesh;
}

// Micro-Topographic Moss Hummock Cushion Generator
ScratchboxMesh generateMossHummock(const SurfaceSet& moss, const Vec3& center, float radiusX = 1.4f, float radiusZ = 1.1f, float height = 0.38f) {
    ScratchboxMesh mesh("Moss_Hummock");
    mesh.material.name = "PBR_Moss";
    mesh.material.roughnessFactor = 1.0f;
    mesh.material.metallicFactor = 0.0f;

    const int rings = 12;
    const int sectors = 18;
    float gy = getTerrainHeight(center.x, center.z);

    for (int r = 0; r <= rings; ++r) {
        float t = static_cast<float>(r) / static_cast<float>(rings);
        float rFrac = std::sin(t * HALF_PI);
        float h = height * (1.0f - t * t);

        for (int s = 0; s <= sectors; ++s) {
            float theta = (static_cast<float>(s) / sectors) * TWO_PI;
            float px = center.x + std::cos(theta) * radiusX * rFrac;
            float pz = center.z + std::sin(theta) * radiusZ * rFrac;
            float py = gy + h;

            Vec3 pos(px, py, pz);
            Vec3 norm(std::cos(theta) * rFrac * 0.6f, 1.0f - rFrac * 0.5f, std::sin(theta) * rFrac * 0.6f);
            norm = norm.normalized();

            Vec4 col = math::lerp(MOD_FLOOR_MOSS, MOD_NONE, 0.5f + 0.5f * std::cos(theta * 3.0f));
            mesh.addVertex(Vertex(pos, norm, Vec2(px / moss.tileU, pz / moss.tileV), col));
        }
    }

    for (int r = 0; r < rings; ++r) {
        int r0 = r * (sectors + 1);
        int r1 = (r + 1) * (sectors + 1);
        for (int s = 0; s < sectors; ++s) {
            uint32_t i0 = r0 + s;
            uint32_t i1 = r0 + (s + 1);
            uint32_t i2 = r1 + s;
            uint32_t i3 = r1 + (s + 1);
            mesh.addTriangle(i0, i1, i2);
            mesh.addTriangle(i1, i3, i2);
        }
    }

    mesh.recomputeBounds();
    return mesh;
}

// ============================================================================
// 3. Ancient Redwood Trunk Generator with Fluted Buttress Roots & Cork Furrows
// ============================================================================
// The column stands vertical: its crown (section 6) is grown about the vertical through its stem, and the column is the
// leader that crown's limbs leave.
struct TrunkSpec {
    Vec3 basePos;
    float height;
    float baseRadius;
    float topRadius;
    int buttressLobes;
    float buttressSpread;
    bool hasHeroMoss;
    float furrowDepth;
};

ScratchboxMesh generateProceduralTrunk(const TrunkSpec& spec, const SurfaceSet& bark, const Vec4& mossOnBark) {
    ScratchboxMesh mesh("Procedural_Tree_Trunk");
    mesh.material.name = "PBR_Redwood_Bark";
    mesh.material.roughnessFactor = 0.92f;
    mesh.material.metallicFactor = 0.01f;

    const int vRings = 72;
    const int hSectors = 48;
    // The bark's real size: a whole number of tiles around the column at its mean radius (so the seam meets; the furrows
    // run up the column and widen with it towards the flared base, as an old trunk's do), metres up it along. A seam
    // column of vertices (sec = hSectors, at theta = 2 pi) carries u's last value.
    const float tilesAround = std::max(1.0f, std::round(TWO_PI * 0.5f * (spec.baseRadius + spec.topRadius) / bark.tileU));

    float groundY = getTerrainHeight(spec.basePos.x, spec.basePos.z);
    Vec3 rootOrigin(spec.basePos.x, groundY, spec.basePos.z);

    for (int ring = 0; ring <= vRings; ++ring) {
        float t = static_cast<float>(ring) / static_cast<float>(vRings);
        float currentY = rootOrigin.y + t * spec.height;

        float centerX = rootOrigin.x;
        float centerZ = rootOrigin.z;

        // Continuous Da Vinci taper transitioning to an organic pointed conifer spire apex
        float coreRadius = (t <= 0.72f)
            ? math::lerp(spec.baseRadius, spec.topRadius, std::pow(t, 0.68f))
            : math::lerp(spec.topRadius, 0.024f, std::pow((t - 0.72f) / 0.28f, 1.15f));

        float buttressDecay = std::max(0.0f, 1.0f - (t * spec.height) / 4.4f);
        buttressDecay = buttressDecay * buttressDecay;

        for (int sec = 0; sec <= hSectors; ++sec) {
            float theta = (static_cast<float>(sec) / static_cast<float>(hSectors)) * TWO_PI;
            float cosT = std::cos(theta);
            float sinT = std::sin(theta);

            float buttressFlare = 0.0f;
            if (spec.buttressLobes > 0 && buttressDecay > 0.001f) {
                float lobeAngle = theta * static_cast<float>(spec.buttressLobes);
                float lobeVal = std::max(0.0f, std::cos(lobeAngle));
                buttressFlare = lobeVal * lobeVal * spec.buttressSpread * buttressDecay;
            }

            // Organic multi-octave anastomosing bark furrow relief (No harsh periodic zebra stripes)
            float barkFbm = 0.10f * std::sin(16.0f * theta + std::sin(currentY * 1.5f) * 1.4f)
                          + 0.05f * std::sin(32.0f * theta + currentY * 2.8f)
                          + 0.025f * std::cos(64.0f * theta);

            float furrowMod = spec.furrowDepth * barkFbm * (1.0f - t * 0.45f);

            float totalRadius = coreRadius + buttressFlare + furrowMod;
            float px = centerX + cosT * totalRadius;
            float pz = centerZ + sinT * totalRadius;

            // Anchor base vertices deeply below terrain surface so roots never float
            float py = currentY;
            if (ring == 0) {
                py = getTerrainHeight(px, pz) - 0.75f;
            }

            Vec3 pos(px, py, pz);

            Vec3 norm(cosT, 0.0f, sinT);
            float dAngle = -spec.furrowDepth * 16.0f * 0.10f * std::cos(16.0f * theta);
            norm.x += -sinT * dAngle;
            norm.z += cosT * dAngle;
            norm = norm.normalized();

            // the bark map, shaded in the flutes' crevices (the map carries the bark's own furrows and plates)
            Vec4 color = MOD_NONE;
            if (barkFbm < -0.02f) {
                float tFurrow = std::clamp((-barkFbm - 0.02f) / 0.12f, 0.0f, 1.0f);
                color = math::lerp(MOD_NONE, MOD_FURROW, tFurrow * 0.45f);
            }

            if (spec.hasHeroMoss && (currentY - rootOrigin.y) < 3.8f) {
                float mossHeightFactor = std::max(0.0f, 1.0f - (currentY - rootOrigin.y) / 3.8f);
                float aspectFacing = 0.5f + 0.5f * (norm.z * 0.65f - norm.x * 0.35f);
                float mossAmount = mossHeightFactor * (0.50f + 0.50f * aspectFacing);
                color = math::lerp(color, mossOnBark, std::clamp(mossAmount, 0.0f, 0.94f));
            }

            Vec2 uv(static_cast<float>(sec) / static_cast<float>(hSectors) * tilesAround, t * spec.height / bark.tileV);
            mesh.addVertex(Vertex(pos, norm, uv, color));
        }
    }

    const int ringStride = hSectors + 1;
    for (int ring = 0; ring < vRings; ++ring) {
        int r0 = ring * ringStride;
        int r1 = (ring + 1) * ringStride;

        for (int sec = 0; sec < hSectors; ++sec) {
            int next = sec + 1;
            uint32_t i0 = r0 + sec;
            uint32_t i1 = r0 + next;
            uint32_t i2 = r1 + sec;
            uint32_t i3 = r1 + next;

            mesh.addTriangle(i0, i1, i2);
            mesh.addTriangle(i1, i3, i2);
        }
    }

    // 1. Close the subterranean trunk base with a watertight convex root disc cap (0 open boundary edges)
    uint32_t bottomCenterIdx = static_cast<uint32_t>(mesh.vertices.size());
    Vec3 bottomCenterPos(rootOrigin.x, rootOrigin.y - 0.90f, rootOrigin.z);
    mesh.addVertex(Vertex(bottomCenterPos, Vec3(0, -1, 0), Vec2(0.5f, 0.5f), MOD_FURROW));
    for (int sec = 0; sec < hSectors; ++sec) {
        int next = sec + 1;
        mesh.addTriangle(bottomCenterIdx, next, sec);
    }

    // 2. Close the trunk crown with a conical spire apex cap
    uint32_t apexIdx = static_cast<uint32_t>(mesh.vertices.size());
    Vec3 apexPos(rootOrigin.x, rootOrigin.y + spec.height + 0.55f, rootOrigin.z);
    mesh.addVertex(Vertex(apexPos, Vec3(0, 1, 0), Vec2(0.5f * tilesAround, (spec.height + 0.55f) / bark.tileV), MOD_NONE));

    int topRingBase = vRings * ringStride;
    for (int sec = 0; sec < hSectors; ++sec) {
        int next = sec + 1;
        mesh.addTriangle(topRingBase + sec, topRingBase + next, apexIdx);
    }

    mesh.recomputeBounds();
    return mesh;
}

// Meandering surface root runner snaking across the forest floor
ScratchboxMesh generateSurfaceRootRunner(const SurfaceSet& bark, const Vec4& mossOnBark, const Vec3& start, const Vec3& end,
                                         float rStart = 0.32f, float rEnd = 0.08f) {
    ScratchboxMesh mesh("Surface_Root_Runner");
    mesh.material.name = "PBR_Redwood_Bark";
    mesh.material.roughnessFactor = 0.92f;
    mesh.material.metallicFactor = 0.01f;

    const int steps = 18;
    const int sectors = 14;

    Vec3 delta = end - start;
    float dist = delta.length();
    Vec3 dir = delta.normalized();
    // the bark at its real size: a whole number of tiles around (at the root's mean radius), metres along
    const float tilesAround = std::max(1.0f, std::round(TWO_PI * 0.5f * (rStart + rEnd) / bark.tileU));

    for (int s = 0; s <= steps; ++s) {
        float u = static_cast<float>(s) / static_cast<float>(steps);
        float meander = std::sin(u * PI * 1.5f) * 0.28f;
        Vec3 pos = start + dir * (u * dist) + Vec3(-dir.z * meander, 0, dir.x * meander);
        float gy = getTerrainHeight(pos.x, pos.z);
        pos.y = gy + math::lerp(rStart, rEnd, u) * 0.65f;

        float r = math::lerp(rStart, rEnd, u);
        Vec3 forward = dir;
        Vec3 up = getTerrainNormal(pos.x, pos.z);
        Vec3 side = forward.cross(up).normalized();

        for (int sec = 0; sec <= sectors; ++sec) {
            float theta = (static_cast<float>(sec) / static_cast<float>(sectors)) * TWO_PI;
            Vec3 radial = (side * std::cos(theta) + up * std::sin(theta)).normalized();
            Vec3 p = pos + radial * r;
            Vec3 norm = radial;
            Vec4 col = math::lerp(MOD_NONE, mossOnBark, std::clamp(norm.y * 0.65f + 0.35f, 0.0f, 0.88f));
            mesh.addVertex(Vertex(p, norm, Vec2(static_cast<float>(sec) / sectors * tilesAround, u * dist / bark.tileV), col));
        }
    }

    for (int s = 0; s < steps; ++s) {
        int r0 = s * (sectors + 1);
        int r1 = (s + 1) * (sectors + 1);
        for (int sec = 0; sec < sectors; ++sec) {
            uint32_t i0 = r0 + sec;
            uint32_t i1 = r0 + (sec + 1);
            uint32_t i2 = r1 + sec;
            uint32_t i3 = r1 + (sec + 1);
            mesh.addTriangle(i0, i1, i2);
            mesh.addTriangle(i1, i3, i2);
        }
    }

    // Seal both ends of surface root runner into closed watertight hulls
    uint32_t rootStartCap = static_cast<uint32_t>(mesh.vertices.size());
    mesh.addVertex(Vertex(start - dir * (rStart * 0.5f), -dir, Vec2(0.5f * tilesAround, 0.0f), MOD_NONE));
    for (int sec = 0; sec < sectors; ++sec) {
        mesh.addTriangle(rootStartCap, sec + 1, sec);
    }

    uint32_t rootEndCap = static_cast<uint32_t>(mesh.vertices.size());
    int endRingBase = steps * (sectors + 1);
    mesh.addVertex(Vertex(end + dir * (rEnd * 0.5f), dir, Vec2(0.5f * tilesAround, dist / bark.tileV), MOD_NONE));
    for (int sec = 0; sec < sectors; ++sec) {
        mesh.addTriangle(endRingBase + sec, endRingBase + sec + 1, rootEndCap);
    }

    mesh.recomputeBounds();
    return mesh;
}

// ============================================================================
// 4. Fallen Mossy Nurse Log with Decayed Cavities & Splintered Hollow Caps
// ============================================================================
ScratchboxMesh generateFallenNurseLog(const SurfaceSet& bark, const Vec4& mossOnBark, const Vec3& start, const Vec3& end, float radius = 0.50f) {
    ScratchboxMesh mesh("Fallen_Nurse_Log");
    mesh.material.name = "PBR_Redwood_Bark";
    mesh.material.roughnessFactor = 0.90f;
    mesh.material.metallicFactor = 0.01f;

    // the bark map, moss-tinted on the log's cap and shaded in its furrows; the split wood shows the same fibres
    geometry::Mesh hMesh = NurseLogGenerator::generateHollowNurseLog(
        start, end, radius, 0.55f, 40, 36,
        MOD_NONE, mossOnBark, MOD_NONE, MOD_FURROW
    );
    // its UVs run two tiles around and six along: rescaled to the bark's real size (a whole number of tiles around)
    const float length = (end - start).length();
    const float tilesAround = std::max(1.0f, std::round(TWO_PI * radius / bark.tileU));
    for (auto& uv : hMesh.uvs) uv = Vec2(uv.x * tilesAround / 2.0f, uv.y * (length / bark.tileV) / 6.0f);
    mesh.merge(hMesh.toScratchboxMesh());
    mesh.recomputeBounds();
    return mesh;
}

// ============================================================================
// 5. Lush Anatomical Sword Fern Clump Generator (Polystichum munitum)
// ============================================================================
// Each pinna draws one leaf of the chosen atlas (chooseFernLeaf): leaf-local t from the pinna's base on the rachis to its
// tip, s across it at the leaf's own width over length (the leaf keeps its real proportions at the pinna's length); the
// leaf's opacity cuts the pinna's outline. The rachis and the crosiers sample the leaf's stem.
ScratchboxMesh generateSwordFernClump(const FernLeaf& leaf, const Vec3& center, float clumpRadius = 1.45f, int numFronds = 24) {
    ScratchboxMesh mesh("Sword_Fern_Clump");
    mesh.material.name = "PBR_Sword_Ferns";
    mesh.material.roughnessFactor = 0.50f;
    mesh.material.metallicFactor = 0.01f;
    mesh.material.doubleSided = true;
    mesh.material.alphaMode = "MASK";
    mesh.material.alphaCutoff = 0.40f;

    float goldenAngle = 137.508f * DEG_TO_RAD;

    for (int f = 0; f < numFronds; ++f) {
        float fFrac = static_cast<float>(f) / static_cast<float>(numFronds);
        float azimuth = f * goldenAngle + (fFrac * 0.20f);

        float frondLen = clumpRadius * (0.85f + 0.45f * (1.0f - fFrac * 0.35f));
        float archHeight = clumpRadius * (0.45f + 0.35f * fFrac);

        Vec3 frondDir(std::cos(azimuth), 0.0f, std::sin(azimuth));
        Vec3 frondUp(0, 1, 0);
        Vec3 frondSide = frondDir.cross(frondUp).normalized();

        const int frondSteps = 16;
        std::vector<Vec3> spinePoints;
        spinePoints.reserve(frondSteps + 1);

        for (int s = 0; s <= frondSteps; ++s) {
            float u = static_cast<float>(s) / static_cast<float>(frondSteps);
            float h = archHeight * 4.0f * u * (1.0f - u * 0.70f) - (u > 0.65f ? (u - 0.65f) * 0.35f : 0.0f);
            float dist = frondLen * u;
            Vec3 spineP = center + frondDir * dist + Vec3(0, h, 0);
            spinePoints.push_back(spineP);
        }

        // Woody central rachis ribbon
        for (int s = 0; s < frondSteps; ++s) {
            float u = static_cast<float>(s) / static_cast<float>(frondSteps);
            float rRachis = math::lerp(0.008f, 0.0022f, u);
            const Vec3& pS = spinePoints[s];
            const Vec3& pE = spinePoints[s + 1];
            Vec3 forward = (pE - pS).normalized();
            Vec3 rSide = forward.cross(frondUp).normalized();

            uint32_t rIdx = static_cast<uint32_t>(mesh.vertices.size());
            Vec4 rCol = relativeTo(Vec4(0.26f, 0.18f, 0.10f, 1.0f), COL_FERN_HIGHLIGHT);
            mesh.addVertex(Vertex(pS - rSide * rRachis, frondUp, leaf.stemUv, rCol));
            mesh.addVertex(Vertex(pS + rSide * rRachis, frondUp, leaf.stemUv, rCol));
            mesh.addVertex(Vertex(pE - rSide * (rRachis * 0.8f), frondUp, leaf.stemUv, rCol));
            mesh.addVertex(Vertex(pE + rSide * (rRachis * 0.8f), frondUp, leaf.stemUv, rCol));
            mesh.addTriangle(rIdx, rIdx + 1, rIdx + 2);
            mesh.addTriangle(rIdx + 1, rIdx + 3, rIdx + 2);
        }

        // Alternating serrated pinnules
        for (int s = 1; s < frondSteps; ++s) {
            float u = static_cast<float>(s) / static_cast<float>(frondSteps);
            const Vec3& pStem = spinePoints[s];
            Vec3 forward = (spinePoints[s + 1] - spinePoints[s - 1]).normalized();
            Vec3 stemUp = forward.cross(frondSide).normalized();

            float pinnuleLen = clumpRadius * PINNA_LENGTH_SHARE * std::sin(u * PI);
            float pinnuleWidth = pinnuleLen * PINNA_WIDTH_SHARE;

            Vec4 leafColor = math::lerp(MOD_FERN_FROND, MOD_NONE, u * 0.85f);

            for (int sideSign = -1; sideSign <= 1; sideSign += 2) {
                float signF = static_cast<float>(sideSign);
                Vec3 pBlade = pStem + frondSide * (signF * pinnuleLen) + stemUp * (0.06f * signF);
                Vec3 pTip   = pStem + frondSide * (signF * pinnuleLen * PINNA_TIP_REACH) + forward * (pinnuleWidth * 0.5f);
                Vec3 pBase  = pStem - forward * (pinnuleWidth * 0.45f);

                // the pinna's leaf: its axis from the rachis to the tip, across it along the rachis
                const LeafCell& cell = leaf.cells[static_cast<size_t>(f * 31 + s * 7 + (sideSign > 0)) % leaf.cells.size()];
                const Vec3 axisVec = pTip - pStem;
                const float pinnaLen = std::max(1e-4f, axisVec.length());
                const Vec3 axis = axisVec * (1.0f / pinnaLen);
                Vec3 acrossDir = forward - axis * forward.dot(axis);
                acrossDir = acrossDir.length() > 1e-6f ? acrossDir.normalized() : frondUp;
                auto leafUv = [&](const Vec3& p) {
                    const Vec3 d = p - pStem;
                    const float t = std::clamp(d.dot(axis) / pinnaLen, 0.0f, 1.0f);
                    const float sAcross = std::clamp(0.5f + d.dot(acrossDir) / (pinnaLen * cell.aspect), 0.0f, 1.0f);
                    return cell.uvAt(sAcross, t);
                };

                Vec3 norm = stemUp;
                uint32_t bIdx = static_cast<uint32_t>(mesh.vertices.size());

                mesh.addVertex(Vertex(pStem, norm, leafUv(pStem), leafColor));
                mesh.addVertex(Vertex(pBase, norm, leafUv(pBase), leafColor));
                mesh.addVertex(Vertex(pBlade, norm, leafUv(pBlade), leafColor));
                mesh.addVertex(Vertex(pTip, norm, leafUv(pTip), leafColor));

                mesh.addTriangle(bIdx, bIdx + 1, bIdx + 2);
                mesh.addTriangle(bIdx, bIdx + 2, bIdx + 3);
            }
        }
    }

    // Emerging curling fiddleheads (crosiers) in clump center
    for (int c = 0; c < 3; ++c) {
        float cAzimuth = c * 2.1f;
        Vec3 cPos = center + Vec3(std::cos(cAzimuth) * 0.12f, 0.18f, std::sin(cAzimuth) * 0.12f);
        uint32_t cIdx = static_cast<uint32_t>(mesh.vertices.size());
        Vec3 cUp(0, 1, 0);
        Vec4 crosierColor = relativeTo(Vec4(0.38f, 0.62f, 0.16f, 1.0f), COL_FERN_HIGHLIGHT);
        mesh.addVertex(Vertex(cPos, cUp, leaf.stemUv, crosierColor));
        mesh.addVertex(Vertex(cPos + Vec3(0.08f, 0.10f, 0), cUp, leaf.stemUv, crosierColor));
        mesh.addVertex(Vertex(cPos + Vec3(-0.06f, 0.12f, 0.06f), cUp, leaf.stemUv, crosierColor));
        mesh.addTriangle(cIdx, cIdx + 1, cIdx + 2);
    }

    mesh.recomputeBounds();
    return mesh;
}

// ============================================================================
// 6. Crowns: SB-Veggie Trees Grown into Described Crowns
// ============================================================================
// Every crown is grown by SB-Veggie (scratchbox_sb_veggie_grove.hpp, the vegetation generator every 3D path uses): space
// colonisation into the crown described here in metres, SB-Veggie leaf clusters, proportions from the tree species
// library and bark from the tree texture library (each chosen by the crown's measurements and colour, never by name),
// written at four levels of detail into a GLB of its own. A redwood's crown rises from its fluted column: the grown
// tree's trunk is kept inside the column (half the column's base radius: inside its deepest furrows at the ground and
// at the crown base) and its limbs leave the column from the crown base up.

// Neighbouring crowns share the gap between their stems: a crown reaches this share of the distance to the nearest other
// stem past a reach every crown keeps, so foliage stops short of the next column.
constexpr float CROWN_GAP_SHARE = 0.62f;
constexpr float CROWN_MIN_REACH_M = 1.2f;

inline float unitHash(uint32_t a, uint32_t b) {
    uint32_t h = a * 0x9E3779B1u ^ (b + 0x7F4A7C15u) * 0x85EBCA77u;
    h ^= h >> 15; h *= 0x2C1B3C6Du; h ^= h >> 12; h *= 0x297A2D39u; h ^= h >> 15;
    return static_cast<float>(h & 0xFFFFFFu) / static_cast<float>(0x1000000u);
}

struct CrownProfile {
    float crownBaseShare;      // crown base / tree height
    float widestAt;            // share of the crown's depth where it is widest (0 its base)
    float topExponent;         // superellipse exponent of its upper profile (1 a cone, 2 a dome)
    Vec3 leafLinearRgb;        // foliage colour, linear RGB
    float colourSpread;        // +- share each tree's foliage varies by
    const char* label;         // free text carried into the GLB
};

inline tile_vegetation::DescribedTree describeCrown(const Vec3& stem, float heightM, float crownRadiusM, float trunkRadiusM,
                                                    const CrownProfile& profile, uint32_t index) {
    tile_vegetation::DescribedTree d;
    d.x = stem.x;
    d.y = getTerrainHeight(stem.x, stem.z);
    d.z = stem.z;
    d.heightM = heightM;
    d.crownRadiusXM = d.crownRadiusZM = crownRadiusM;
    d.crownBaseHeightM = profile.crownBaseShare * (0.92f + 0.16f * unitHash(index, 1)) * heightM;
    d.crownWidestAt = profile.widestAt;
    d.crownTopExponent = profile.topExponent;
    if (trunkRadiusM > 0.0f) d.trunkRadiusM = trunkRadiusM;
    const float shade = 1.0f + profile.colourSpread * (2.0f * unitHash(index, 2) - 1.0f);
    d.leafColourKnown = true;
    d.leafLinearRgb = {std::clamp(profile.leafLinearRgb.x * shade, 0.0f, 1.0f), std::clamp(profile.leafLinearRgb.y * shade, 0.0f, 1.0f),
                       std::clamp(profile.leafLinearRgb.z * shade, 0.0f, 1.0f)};
    d.label = profile.label;
    return d;
}

/** Each crown's radius: its own spread, within the gap the nearest other stem (of these crowns or `columns`) leaves it. */
inline void shareCrownGaps(std::vector<tile_vegetation::DescribedTree>& crowns, const std::vector<Vec3>& columns = {}) {
    for (size_t i = 0; i < crowns.size(); ++i) {
        double gap = std::numeric_limits<double>::infinity();
        for (size_t j = 0; j < crowns.size(); ++j) {
            if (i != j) gap = std::min(gap, std::hypot(crowns[i].x - crowns[j].x, crowns[i].z - crowns[j].z));
        }
        for (const Vec3& c : columns) gap = std::min(gap, std::hypot(crowns[i].x - c.x, crowns[i].z - c.z));
        const double r = std::min(crowns[i].crownRadiusXM, CROWN_MIN_REACH_M + CROWN_GAP_SHARE * gap);
        crowns[i].crownRadiusXM = crowns[i].crownRadiusZM = r;
    }
}

// ============================================================================
// 7. Volumetric Atmospheric Crepuscular Sunbeams (God Rays Geometry)
// ============================================================================
// How far a shaft's axis runs from its canopy gap before a trunk or the ground stops the light: the axis is marched in
// 0.25 m steps against the terrain and each trunk's column (its radius tapering linearly from base to top).
inline float shaftLengthToFirstBlocker(const Vec3& start, const Vec3& dir, const std::vector<TrunkSpec>& trunks, float maxLength) {
    constexpr float STEP_M = 0.25f;
    for (float t = 0.0f; t < maxLength; t += STEP_M) {
        const Vec3 p = start + dir * t;
        if (p.y <= getTerrainHeight(p.x, p.z)) return t;
        for (const TrunkSpec& trunk : trunks) {
            const float h = p.y - trunk.basePos.y;
            if (h < 0.0f || h > trunk.height) continue;
            const float r = trunk.baseRadius + (trunk.topRadius - trunk.baseRadius) * (h / trunk.height);
            const float dx = p.x - trunk.basePos.x, dz = p.z - trunk.basePos.z;
            if (dx * dx + dz * dz < r * r) return t;
        }
    }
    return maxLength;
}

// Crepuscular shafts: the sun is far, so the light through each canopy gap is a near-parallel column as wide as the gap
// (widening a quarter by the forward-scattering halo), and it ends where a trunk or the ground stops it. A shaft that
// passed through a trunk would draw the trunk's facets where its wall meets the bark.
ScratchboxMesh generateAtmosphericGodRays(const Vec3& sunOrigin, const Vec3& focalCenter, const std::vector<TrunkSpec>& trunks,
                                          int numRays = 56) {
    ScratchboxMesh mesh("Atmospheric_Crepuscular_Sunbeams");
    mesh.material.name = "PBR_Volumetric_GodRays";
    mesh.material.roughnessFactor = 0.99f;
    mesh.material.metallicFactor = 0.0f;
    mesh.material.alphaMode = "BLEND";
    mesh.material.doubleSided = true;

    Vec3 beamDir = (focalCenter - sunOrigin).normalized();
    Vec3 up(0, 1, 0);
    Vec3 side = beamDir.cross(up).normalized();
    up = side.cross(beamDir).normalized();

    for (int r = 0; r < numRays; ++r) {
        float rAngle = (static_cast<float>(r) / static_cast<float>(numRays)) * TWO_PI;
        float rDist = 1.0f + 3.6f * std::sin(r * 2.3f);

        Vec3 rayStart = sunOrigin + (side * std::cos(rAngle) + up * std::sin(rAngle)) * rDist;
        float beamLength = shaftLengthToFirstBlocker(rayStart, beamDir, trunks, (focalCenter - sunOrigin).length() + 22.0f);
        if (beamLength < 1.0f) continue;
        float beamRadiusStart = 0.22f + 0.20f * (r % 4);
        float beamRadiusEnd = 1.25f * beamRadiusStart;

        // 32 sides: the viewer fades a beam toward its outline by its normal against the view, and an 8-sided cone's
        // interpolated normals stay 22 degrees off edge-on at the outline, which then shows as hard facets in near views
        const int raySegments = 32;
        uint32_t bIdx = static_cast<uint32_t>(mesh.vertices.size());

        for (int i = 0; i < raySegments; ++i) {
            float theta = (static_cast<float>(i) / static_cast<float>(raySegments)) * TWO_PI;
            Vec3 radial = side * std::cos(theta) + up * std::sin(theta);

            Vec3 p0 = rayStart + radial * beamRadiusStart;
            Vec3 p1 = rayStart + beamDir * beamLength + radial * beamRadiusEnd;

            Vec4 colStart = Vec4(COL_SUNBEAM_GOLD.x, COL_SUNBEAM_GOLD.y, COL_SUNBEAM_GOLD.z, 0.025f);
            Vec4 colEnd = Vec4(COL_SUNBEAM_GOLD.x, COL_SUNBEAM_GOLD.y, COL_SUNBEAM_GOLD.z, 0.005f);

            Vec3 norm = radial;
            mesh.addVertex(Vertex(p0, norm, Vec2(0, 0), colStart));
            mesh.addVertex(Vertex(p1, norm, Vec2(1, 1), colEnd));
        }

        for (int i = 0; i < raySegments; ++i) {
            int next = (i + 1) % raySegments;
            uint32_t i0 = bIdx + i * 2;
            uint32_t i1 = bIdx + i * 2 + 1;
            uint32_t i2 = bIdx + next * 2;
            uint32_t i3 = bIdx + next * 2 + 1;

            mesh.addTriangle(i0, i1, i2);
            mesh.addTriangle(i2, i1, i3);
        }
    }

    mesh.recomputeBounds();
    return mesh;
}

inline ScratchboxMesh generateShelfPolypores(const Vec3& attachBase, const Vec3& outwardDir, float maxRadius = 0.24f) {
    return BotanicalOrganGenerator::generateShelfPolypore(attachBase, outwardDir, maxRadius).toScratchboxMesh();
}

// ============================================================================
// Main Scene Assembly
// ============================================================================
int main(int argc, char** argv) {
    std::string outputPath = "public/models/forest_hyperreal.glb";
    if (argc > 1) {
        outputPath = argv[1];
    }

    std::cout << "================================================================\n";
    std::cout << "🌲 GENERATING HYPERREALISTIC 3D FOREST (ASTRO ENGINE C++20)\n";
    std::cout << "================================================================\n";

    auto tStart = std::chrono::high_resolution_clock::now();

    // 0. The surfaces: texture library sets at their real size, each tinted to its region of the reference photograph
    //    (section "Surface Materials"); a missing set or photograph stops the build
    std::cout << "🎨 Reading the Surface Sets (texture library copies) and Measuring the Reference Photograph...\n";
    SurfaceSet duff, moss, bark;
    FernLeaf fernLeaf;
    MeasuredTarget duffTarget, mossTarget, barkTarget, fernTarget;
    try {
        const auto photoBytes = readFileBytes("public/forest_reference.png");
        auto photo = png::decode(photoBytes.data(), photoBytes.size(), png::OutputFormat::Rgb);
        if (!photo.ok) throw std::runtime_error("cannot decode public/forest_reference.png: " + photo.error);
        // the photograph's needle duff (bottom right, clear of ferns), the moss on the nurse log and the right column's
        // base, the bark of the two near columns (moss-green pixels left out) and the sword fern fronds (their green)
        duffTarget = measurePhoto(photo.image, {{760, 640, 1000, 715}}, "every pixel", [](float, float, float) { return true; });
        mossTarget = measurePhoto(photo.image, {{600, 585, 880, 612}, {1040, 560, 1120, 640}}, "every pixel", [](float, float, float) { return true; });
        barkTarget = measurePhoto(photo.image, {{120, 100, 280, 420}, {990, 40, 1150, 400}}, "green below red (not moss)",
                                  [](float r, float g, float) { return g < r; });
        fernTarget = measurePhoto(photo.image, {{30, 560, 380, 700}}, "green over 1.15 x red and 1.3 x blue (fronds)",
                                  [](float r, float g, float b) { return g > 1.15f * r && g > 1.3f * b; });
        duff = loadLibraryCopy("Ground071");
        moss = loadLibraryCopy("Moss001");
        bark = loadLibraryCopy("bark_willow_02");
        fernLeaf = chooseFernLeaf(fernTarget);
    } catch (const std::exception& e) {
        std::cerr << "❌ Fatal: " << e.what() << "\n";
        return 1;
    }
    // each set takes its region's chromaticity, then its luminance relative to the duff's as the photograph shows them
    const Vec3 duffTint = tintFactor(duff.meanLinear, duffTarget.meanLinear);
    const float duffLuminance = luminance(Vec3(duff.meanLinear.x * duffTint.x, duff.meanLinear.y * duffTint.y, duff.meanLinear.z * duffTint.z));
    auto tintTo = [&](const SurfaceSet& set, const MeasuredTarget& target, float& share) {
        const Vec3 chroma = tintFactor(set.meanLinear, target.meanLinear);
        share = luminanceShare(set.meanLinear, chroma, target, duffLuminance, duffTarget);
        return chroma * share;
    };
    float duffShare = 1.0f, mossShare = 1.0f, barkShare = 1.0f, fernShare = 1.0f;
    const Vec3 mossTint = tintTo(moss, mossTarget, mossShare);
    const Vec3 barkTint = tintTo(bark, barkTarget, barkShare);
    const Vec3 fernTint = tintTo(fernLeaf.set, fernTarget, fernShare);
    // moss on bark: the bark map shifted to the photograph's moss (the moss's chromaticity over the bark's, at most 1)
    const Vec3 mossOverBark = tintFactor(barkTarget.meanLinear, mossTarget.meanLinear);
    const Vec4 mossOnBark(mossOverBark.x, mossOverBark.y, mossOverBark.z, 1.0f);
    for (const auto& [what, set, tint, share] : { std::tuple{"floor", &duff, duffTint, duffShare}, std::tuple{"moss", &moss, mossTint, mossShare},
                                                  std::tuple{"bark", &bark, barkTint, barkShare}, std::tuple{"fern", &fernLeaf.set, fernTint, fernShare} }) {
        std::cout << "   " << what << ": " << set->id << " (" << set->publisher << ", " << set->tileU << " x " << set->tileV
                  << " m, " << set->sizeSource << "), tint " << jsonVec(tint) << " (luminance share " << share << ")\n";
    }
    std::cout << "   fern leaf " << fernLeaf.set.id << ": " << fernLeaf.lengthM << " x " << fernLeaf.widthM << " m, cost " << fernLeaf.cost << "\n";

    // 1. Woodland Biome Undulating Floor (Expansive 80m x 70m Natural Landscape)
    std::cout << "🌿 Synthesizing Undulating Woodland Floor with Humus & Needle Duff...\n";
    ScratchboxMesh floor = generateForestFloor(duff, -40.0f, 40.0f, -50.0f, 20.0f, 0.48f);

    // The moss: cushions on the floor and tufts on the nurse logs (section 7), one surface of its own
    ScratchboxMesh mossCushions("Forest_Moss_Cushions");

    std::cout << "🌱 Modeling Micro-Topographic Moss Hummocks across the Forest Floor...\n";
    mossCushions.merge(generateMossHummock(moss, Vec3( 0.05f, 0, -0.55f), 1.6f, 0.55f, 0.45f));
    mossCushions.merge(generateMossHummock(moss, Vec3(-0.85f, 0, -0.35f), 1.1f, 0.50f, 0.40f));
    mossCushions.merge(generateMossHummock(moss, Vec3( 0.95f, 0, -0.65f), 1.2f, 0.50f, 0.42f));
    mossCushions.merge(generateMossHummock(moss, Vec3(-2.8f, 0,  0.4f), 1.5f, 1.2f, 0.42f));
    mossCushions.merge(generateMossHummock(moss, Vec3(-1.6f, 0,  1.2f), 1.3f, 0.9f, 0.35f));
    mossCushions.merge(generateMossHummock(moss, Vec3( 2.8f, 0,  0.2f), 1.6f, 1.3f, 0.45f));
    mossCushions.merge(generateMossHummock(moss, Vec3( 3.8f, 0, -1.2f), 1.4f, 1.0f, 0.38f));
    mossCushions.merge(generateMossHummock(moss, Vec3(-0.6f, 0, -3.2f), 1.8f, 0.8f, 0.32f));
    mossCushions.merge(generateMossHummock(moss, Vec3( 1.1f, 0, -3.5f), 1.9f, 0.9f, 0.36f));
    mossCushions.merge(generateMossHummock(moss, Vec3(-12.0f, 0, -8.0f), 2.2f, 1.6f, 0.45f));
    mossCushions.merge(generateMossHummock(moss, Vec3(-18.5f, 0, -15.0f), 2.4f, 1.8f, 0.48f));
    mossCushions.merge(generateMossHummock(moss, Vec3( 14.0f, 0, -6.0f), 2.0f, 1.5f, 0.42f));
    mossCushions.merge(generateMossHummock(moss, Vec3( 21.0f, 0, -14.0f), 2.5f, 1.7f, 0.46f));
    mossCushions.merge(generateMossHummock(moss, Vec3(-6.0f, 0, -26.0f), 2.1f, 1.5f, 0.40f));
    mossCushions.merge(generateMossHummock(moss, Vec3( 8.0f, 0, -28.0f), 2.3f, 1.6f, 0.44f));

    // 2. Redwood Columns (Forest_Trunks_And_Log); their crowns are grown in section 5
    ScratchboxMesh allTrunks("Forest_Trunks_And_Log");
    allTrunks.material.name = "PBR_Redwood_Bark";
    allTrunks.material.roughnessFactor = 0.92f;
    allTrunks.material.metallicFactor = 0.01f;

    std::cout << "🌳 Generating Hero Ancient Redwood Columns across Ecological Groves...\n";

    // Each redwood: its fluted column and the spread its crown may reach (section 6 shares it with its neighbours)
    struct Redwood {
        TrunkSpec trunk;
        float crownSpreadM;
    };

    // A. HERO FOREGROUND CORRIDOR (Framed for 1:1 National Geographic Alignment)
    std::vector<Redwood> redwoods = {
        // 1. The Monumental Monarch (Hero Ancient Redwood occupying center-right of frame at X = 0.95m, Z = -2.1m)
        { { Vec3( 0.95f, 0.0f, -2.1f), 36.0f, 1.95f, 0.88f, 10, 1.85f, true, 1.55f }, 6.5f },
        // 2. Left Sun-Facing Tree (Reaching into sunbeams)
        { { Vec3(-1.85f, 0.0f, -4.5f), 29.0f, 1.15f, 0.58f,  6, 1.15f, true, 1.25f }, 5.4f },
        // 3. Mid-Left Receding Tree 1
        { { Vec3(-3.2f,  0.0f, -6.5f), 28.0f, 0.95f, 0.50f,  5, 0.85f, true, 1.10f }, 4.8f },
        // 4. Far-Left Framing Redwood (Hugging left edge at X = -4.8m, Z = -0.5m)
        { { Vec3(-4.8f,  0.0f, -0.5f), 30.0f, 1.40f, 0.70f,  7, 1.25f, true, 1.20f }, 5.5f },
        // 5. Far-Right Foreground Framing Redwood (X = 4.8f, Z = 0.5f)
        { { Vec3( 4.8f,  0.0f,  0.5f), 30.0f, 1.45f, 0.72f,  7, 1.20f, true, 1.20f }, 5.5f }
    };

    // B. EXPANSIVE WEST & EAST GROVES AND DEEP COLONNADE (Spreading across 80m x 70m)
    std::cout << "🌲 Constructing Distributed Forest Groves across the Landscape...\n";
    const std::vector<TrunkSpec> landscapeTrees = {
        // West Grove (Spreading out to X = -35)
        { Vec3( -8.5f, 0.0f,   2.5f), 28.0f, 0.95f, 0.55f, 5, 0.85f, true, 1.05f },
        { Vec3(-11.5f, 0.0f,  -3.5f), 27.0f, 0.85f, 0.48f, 5, 0.75f, true, 0.95f },
        { Vec3(-15.0f, 0.0f,   1.0f), 28.0f, 0.90f, 0.52f, 4, 0.80f, true, 1.00f },
        { Vec3(-18.5f, 0.0f,  -6.5f), 26.0f, 0.78f, 0.45f, 4, 0.70f, true, 0.90f },
        { Vec3(-14.0f, 0.0f, -12.0f), 27.0f, 0.82f, 0.46f, 4, 0.75f, true, 0.95f },
        { Vec3(-22.0f, 0.0f, -10.5f), 25.0f, 0.75f, 0.42f, 3, 0.65f, false, 0.85f },
        { Vec3(-27.0f, 0.0f, -15.0f), 26.0f, 0.80f, 0.45f, 3, 0.70f, false, 0.85f },
        { Vec3(-19.5f, 0.0f, -20.0f), 25.0f, 0.74f, 0.42f, 3, 0.65f, false, 0.80f },
        { Vec3(-25.5f, 0.0f, -25.5f), 24.0f, 0.70f, 0.40f, 3, 0.60f, false, 0.80f },
        { Vec3(-16.0f, 0.0f, -29.0f), 25.0f, 0.72f, 0.40f, 3, 0.65f, false, 0.75f },
        { Vec3(-31.0f, 0.0f, -22.0f), 24.0f, 0.68f, 0.38f, 0, 0.00f, false, 0.75f },
        { Vec3(-28.0f, 0.0f, -35.0f), 25.0f, 0.70f, 0.40f, 0, 0.00f, false, 0.70f },
        { Vec3(-20.0f, 0.0f, -39.0f), 24.0f, 0.66f, 0.36f, 0, 0.00f, false, 0.70f },
        { Vec3(-35.0f, 0.0f, -30.0f), 23.0f, 0.64f, 0.35f, 0, 0.00f, false, 0.65f },

        // East Grove (Spreading out to X = +35)
        { Vec3(  8.0f, 0.0f,   3.0f), 28.0f, 0.92f, 0.54f, 5, 0.80f, true, 1.00f },
        { Vec3( 12.0f, 0.0f,  -1.5f), 27.0f, 0.88f, 0.50f, 5, 0.75f, true, 0.95f },
        { Vec3( 16.5f, 0.0f,   2.5f), 28.0f, 0.90f, 0.52f, 4, 0.80f, true, 0.95f },
        { Vec3( 14.5f, 0.0f,  -6.5f), 26.0f, 0.80f, 0.45f, 4, 0.70f, true, 0.90f },
        { Vec3( 10.5f, 0.0f, -11.0f), 27.0f, 0.82f, 0.46f, 4, 0.75f, true, 0.95f },
        { Vec3( 18.5f, 0.0f, -10.0f), 25.0f, 0.76f, 0.42f, 3, 0.65f, false, 0.85f },
        { Vec3( 23.0f, 0.0f, -14.5f), 26.0f, 0.78f, 0.44f, 3, 0.70f, false, 0.85f },
        { Vec3( 15.5f, 0.0f, -18.0f), 25.0f, 0.72f, 0.40f, 3, 0.65f, false, 0.80f },
        { Vec3( 27.0f, 0.0f, -20.0f), 24.0f, 0.70f, 0.38f, 3, 0.60f, false, 0.80f },
        { Vec3( 21.0f, 0.0f, -26.0f), 25.0f, 0.72f, 0.40f, 3, 0.65f, false, 0.75f },
        { Vec3( 17.0f, 0.0f, -31.0f), 24.0f, 0.68f, 0.38f, 0, 0.00f, false, 0.75f },
        { Vec3( 29.0f, 0.0f, -29.0f), 25.0f, 0.70f, 0.40f, 0, 0.00f, false, 0.70f },
        { Vec3( 24.0f, 0.0f, -37.0f), 24.0f, 0.66f, 0.36f, 0, 0.00f, false, 0.70f },
        { Vec3( 33.0f, 0.0f, -25.0f), 23.0f, 0.64f, 0.35f, 0, 0.00f, false, 0.65f },

        // North & Deep Background Colonnade (Z from -10 to -48 across clearing depth)
        { Vec3( -1.8f, 0.0f, -12.5f), 26.0f, 0.68f, 0.40f, 3, 0.55f, true, 0.85f },
        { Vec3(  3.2f, 0.0f, -14.5f), 25.0f, 0.65f, 0.38f, 3, 0.50f, true, 0.85f },
        { Vec3( -4.5f, 0.0f, -16.5f), 26.0f, 0.66f, 0.38f, 3, 0.50f, true, 0.80f },
        { Vec3(  1.5f, 0.0f, -18.5f), 25.0f, 0.62f, 0.36f, 3, 0.45f, true, 0.80f },
        { Vec3( -3.0f, 0.0f, -22.5f), 25.0f, 0.60f, 0.35f, 0, 0.00f, false, 0.75f },
        { Vec3(  3.8f, 0.0f, -25.0f), 24.0f, 0.58f, 0.34f, 0, 0.00f, false, 0.75f },
        { Vec3( -0.5f, 0.0f, -28.5f), 25.0f, 0.56f, 0.32f, 0, 0.00f, false, 0.70f },
        { Vec3(  2.4f, 0.0f, -33.0f), 24.0f, 0.54f, 0.30f, 0, 0.00f, false, 0.70f },
        { Vec3( -4.8f, 0.0f, -37.5f), 25.0f, 0.55f, 0.30f, 0, 0.00f, false, 0.65f },
        { Vec3(  1.2f, 0.0f, -43.0f), 24.0f, 0.50f, 0.28f, 0, 0.00f, false, 0.65f },
        { Vec3( -2.0f, 0.0f, -47.0f), 24.0f, 0.48f, 0.26f, 0, 0.00f, false, 0.60f },
        { Vec3(  4.5f, 0.0f, -48.0f), 23.0f, 0.46f, 0.25f, 0, 0.00f, false, 0.60f }
    };
    for (size_t i = 0; i < landscapeTrees.size(); ++i) {
        redwoods.push_back({ landscapeTrees[i], 3.6f + 1.2f * (static_cast<float>(i % 4) / 3.0f) });
    }

    // A redwood crown: a narrow cone from about two fifths of the height, widest low down, dark yellow-green foliage
    const CrownProfile redwoodCrown{ 0.38f, 0.18f, 1.15f, Vec3(0.040f, 0.085f, 0.030f), 0.18f, "coast redwood crown" };
    std::vector<tile_vegetation::DescribedTree> crowns;
    std::vector<Vec3> columns;
    for (size_t i = 0; i < redwoods.size(); ++i) {
        const TrunkSpec& trunk = redwoods[i].trunk;
        allTrunks.merge(generateProceduralTrunk(trunk, bark, mossOnBark));
        crowns.push_back(describeCrown(trunk.basePos, trunk.height + 0.55f, redwoods[i].crownSpreadM, 0.5f * trunk.baseRadius,
                                       redwoodCrown, static_cast<uint32_t>(i)));
        columns.push_back(trunk.basePos);
    }
    shareCrownGaps(crowns);

    // Root buttress runners grounding the Monarch into the humus
    allTrunks.merge(generateSurfaceRootRunner(bark, mossOnBark, Vec3(0.95f, 0, -2.1f), Vec3(-0.4f, 0, -0.6f), 0.42f, 0.10f));
    allTrunks.merge(generateSurfaceRootRunner(bark, mossOnBark, Vec3(0.95f, 0, -2.1f), Vec3( 2.3f, 0, -0.8f), 0.38f, 0.09f));
    allTrunks.merge(generateSurfaceRootRunner(bark, mossOnBark, Vec3(0.95f, 0, -2.1f), Vec3( 0.2f, 0, -4.2f), 0.35f, 0.08f));
    allTrunks.merge(generateSurfaceRootRunner(bark, mossOnBark, Vec3(0.95f, 0, -2.1f), Vec3( 2.4f, 0, -3.8f), 0.32f, 0.07f));

    // 4. Fallen Mossy Nurse Logs Spanning the Landscape
    std::cout << "🪵 Generating Massive Fallen Mossy Nurse Logs across Landscape Quadrants...\n";
    Vec3 logStart(-1.45f, 0.0f, -0.35f);
    Vec3 logEnd  ( 1.55f, 0.0f, -0.75f);
    allTrunks.merge(generateFallenNurseLog(bark, mossOnBark, logStart, logEnd, 0.52f));

    Vec3 log2Start(-3.8f, 0.0f, -4.5f);
    Vec3 log2End  (-1.8f, 0.0f, -6.8f);
    allTrunks.merge(generateFallenNurseLog(bark, mossOnBark, log2Start, log2End, 0.44f));

    Vec3 log3Start(-18.0f, 0.0f, -15.0f);
    Vec3 log3End  (-11.5f, 0.0f, -18.0f);
    allTrunks.merge(generateFallenNurseLog(bark, mossOnBark, log3Start, log3End, 0.52f));

    Vec3 log4Start(12.0f, 0.0f, -11.0f);
    Vec3 log4End  (17.5f, 0.0f, -14.5f);
    allTrunks.merge(generateFallenNurseLog(bark, mossOnBark, log4Start, log4End, 0.46f));

    Vec3 log5Start(-5.0f, 0.0f, -33.0f);
    Vec3 log5End  ( 2.0f, 0.0f, -35.5f);
    allTrunks.merge(generateFallenNurseLog(bark, mossOnBark, log5Start, log5End, 0.55f));

    // Epiphytic Shelf Bracket Polypores on Hero Redwood & Nurse Logs (fungus, not bark: drawn with the undergrowth)
    ScratchboxMesh polypores("Shelf_Polypores");
    polypores.merge(generateShelfPolypores(Vec3(0.55f, getTerrainHeight(0.55f, -1.8f) + 1.2f, -1.8f), Vec3(0.2f, 0, 0.9f), 0.26f));
    polypores.merge(generateShelfPolypores(Vec3(0.15f, getTerrainHeight(0.15f, -2.1f) + 2.2f, -2.1f), Vec3(-0.9f, 0, 0.2f), 0.22f));
    polypores.merge(generateShelfPolypores(Vec3(0.85f, getTerrainHeight(0.85f, -1.9f) + 0.38f, -1.9f), Vec3(0.7f, 0.2f, 0.6f), 0.20f));
    polypores.merge(generateShelfPolypores(Vec3(0.4f, getTerrainHeight(0.4f, -0.6f) + 0.45f, -0.6f), Vec3(-0.4f, 0.2f, 0.9f), 0.24f));
    polypores.merge(generateShelfPolypores(Vec3(-14.5f, getTerrainHeight(-14.5f, -16.5f) + 0.42f, -16.5f), Vec3(0.3f, 0.2f, 0.9f), 0.28f));
    polypores.merge(generateShelfPolypores(Vec3( 14.2f, getTerrainHeight( 14.2f, -12.8f) + 0.40f, -12.8f), Vec3(-0.5f, 0.2f, 0.8f), 0.25f));

    // 5. Understory Subcanopy Trees, then Every Crown Grown by SB-Veggie (section 6)
    std::cout << "🌲 Describing Understory Subcanopy Crowns in the Gaps between the Columns...\n";
    // A broadleaf understory crown: a dome from a third of the height, widest at its middle, brighter green than the redwoods
    const CrownProfile understoryCrown{ 0.32f, 0.45f, 2.2f, Vec3(0.070f, 0.150f, 0.040f), 0.15f, "understory broadleaf crown" };
    struct UnderstoryTree { float x, z, heightM, spreadM; };
    const UnderstoryTree understory[] = {
        {  0.8f,  -7.5f,  5.4f, 2.2f },
        {  4.5f,  -8.2f,  5.2f, 2.1f },
        { -6.2f, -10.75f, 5.8f, 2.4f },
        {  2.4f,  -9.5f,  5.5f, 2.4f }
    };
    std::vector<tile_vegetation::DescribedTree> understoryCrowns;
    for (size_t i = 0; i < std::size(understory); ++i) {
        const UnderstoryTree& u = understory[i];
        understoryCrowns.push_back(describeCrown(Vec3(u.x, 0.0f, u.z), u.heightM, u.spreadM, 0.0f, understoryCrown,
                                                 static_cast<uint32_t>(crowns.size() + i)));
    }
    shareCrownGaps(understoryCrowns, columns);
    crowns.insert(crowns.end(), understoryCrowns.begin(), understoryCrowns.end());

    std::cout << "🌳 Growing " << crowns.size() << " Crowns with SB-Veggie (space colonisation, species & texture libraries)...\n";
    tile_vegetation::GroveOptions grove;
    grove.seed = 0x5EED0F0E57ull;
    grove.speciesIndexPath = "assets/vegetation/species/index.json";
    grove.textureIndexPath = "assets/textures/trees/index.json";
    grove.reveal = false;
    grove.label = "forest_3d_viewer crowns";
    tile_vegetation::GroveResult grown;
    try {
        grown = tile_vegetation::growDescribedTrees(crowns, grove);
    } catch (const std::exception& e) {
        std::cerr << "❌ Fatal: SB-Veggie could not grow the forest's crowns: " << e.what() << "\n";
        return 1;
    }

    // 6. Fern Colonies Mesh Group (High Density - 85+ Colonies)
    ScratchboxMesh allFerns("Forest_Sword_Ferns");
    allFerns.material.name = "PBR_Sword_Ferns";
    allFerns.material.roughnessFactor = 0.50f;
    allFerns.material.metallicFactor = 0.01f;
    allFerns.material.doubleSided = true;
    allFerns.material.alphaMode = "MASK";
    allFerns.material.alphaCutoff = 0.40f;

    std::cout << "🌿 Populating Lush Sword Fern Colonies (Polystichum munitum - 85+ Colonies)...\n";
    std::vector<Vec3> fernLocations = {
        // Foreground Left Cascading Hero Fern Bank (Dominating bottom-left corner like in photo)
        Vec3(-1.15f, 0.0f,  0.95f), Vec3(-1.65f, 0.0f,  0.75f), Vec3(-0.75f, 0.0f,  1.15f),
        Vec3(-1.45f, 0.0f,  0.35f), Vec3(-1.95f, 0.0f,  0.15f), Vec3(-0.95f, 0.0f,  0.25f),

        // Foreground Center directly in front of and flanking the Fallen Nurse Log
        Vec3(-0.45f, 0.0f,  0.25f), Vec3( 0.15f, 0.0f,  0.15f), Vec3( 0.75f, 0.0f,  0.10f),
        Vec3( 1.35f, 0.0f, -0.15f), Vec3( 1.85f, 0.0f, -0.35f), Vec3( 2.35f, 0.0f, -0.55f),

        // Flanking and surrounding the Monarch root buttresses behind the log
        Vec3( 0.05f, 0.0f, -1.25f), Vec3( 0.55f, 0.0f, -1.35f), Vec3( 1.15f, 0.0f, -1.45f),
        Vec3( 1.85f, 0.0f, -1.25f), Vec3( 2.25f, 0.0f, -1.85f), Vec3(-0.45f, 0.0f, -1.65f),

        // Midground colonnade borders
        Vec3(-1.20f, 0.0f, -3.5f), Vec3(-2.20f, 0.0f, -4.5f), Vec3( 2.80f, 0.0f, -3.2f),
        Vec3(-1.60f, 0.0f, -6.5f), Vec3(-3.20f, 0.0f, -7.5f), Vec3( 1.80f, 0.0f, -6.2f)
    };

    for (size_t f = 0; f < fernLocations.size(); ++f) {
        float fx = fernLocations[f].x;
        float fz = fernLocations[f].z;
        float fy = getTerrainHeight(fx, fz);
        // a clump's radius sets its fronds' length and arch: 1 m makes sword fern fronds 1.1-1.3 m long arching 0.6-1.1 m
        // high (the reference's ferns, below a standing eye), not 3 m fronds over the bookmarks' cameras
        float radius = (f < 6) ? 1.05f : ((f < 12) ? 0.95f : 0.85f);
        int fronds = (f < 6) ? 34 : ((f < 12) ? 26 : 20);
        allFerns.merge(generateSwordFernClump(fernLeaf, Vec3(fx, fy, fz), radius, fronds));
    }

    std::cout << "🌿 Seeding Clustered Fern Colonies across the Landscape (Infiniti Keypoint Cluster Engine)...\n";
    ClusterScatterConfig fernClusterCfg;
    fernClusterCfg.numKeypoints = 12;
    fernClusterCfg.clusterRadius = 3.6f;
    fernClusterCfg.instancesPerCluster = 6;
    fernClusterCfg.minInstanceDistance = 0.55f;
    fernClusterCfg.maxSlopeAngleRad = 0.65f;
    fernClusterCfg.seed = 31415;

    auto scatteredFerns = KeypointClusterScatterEngine::generateClusters(
        -32.0f, 32.0f, -42.0f, 10.0f,
        getTerrainHeight, getTerrainNormal, fernClusterCfg
    );

    for (const auto& sf : scatteredFerns) {
        float rad = 0.85f * sf.scale;
        int numFronds = static_cast<int>(18 * sf.scale);
        allFerns.merge(generateSwordFernClump(fernLeaf, sf.position, rad, std::max(10, numFronds)));
    }

    // 7. Woodland Undergrowth (Grass Clumps, Oxalis Sorrel, Nurse Log Ivy & Fallen Wood Litter)
    std::cout << "🌱 Synthesizing Botanical Undergrowth (Grass Clumps, Oxalis Sorrel, Deadwood Litter & Nurse Log Ivy)...\n";
    ScratchboxMesh allUnderstory("Forest_Woodland_Undergrowth");
    allUnderstory.material.name = "PBR_Woodland_Undergrowth";
    allUnderstory.material.roughnessFactor = 0.52f;
    allUnderstory.material.metallicFactor = 0.01f;
    allUnderstory.material.doubleSided = true;
    allUnderstory.material.alphaMode = "MASK";
    allUnderstory.material.alphaCutoff = 0.35f;
    allUnderstory.merge(polypores);

    // Wood Sorrel (Oxalis oregana) ground carpets
    std::cout << "☘️ Spreading Wood Sorrel (Oxalis) Mats around Tree Buttresses...\n";
    std::vector<Vec3> sorrelPatches = {
        Vec3(-2.8f, 0,  0.2f), Vec3(-1.8f, 0,  1.1f), Vec3(-3.4f, 0, -1.2f),
        Vec3( 2.8f, 0,  0.2f), Vec3( 3.2f, 0, -0.4f), Vec3( 2.2f, 0,  1.2f),
        Vec3(-0.8f, 0, -3.1f), Vec3( 0.6f, 0, -3.3f), Vec3( 1.4f, 0, -3.7f),
        Vec3(-0.2f, 0, -5.2f), Vec3( 0.4f, 0, -5.8f), Vec3(-1.0f, 0, -5.5f)
    };
    for (const auto& sp : sorrelPatches) {
        geometry::Mesh sorrel = BotanicalOrganGenerator::generateWoodSorrelPatch(sp, 0.95f, 22);
        allUnderstory.merge(sorrel.toScratchboxMesh());
    }

    std::cout << "☘️ Seeding Clustered Wood Sorrel Mats across Landscape (Infiniti Keypoint Cluster Engine)...\n";
    ClusterScatterConfig sorrelClusterCfg;
    sorrelClusterCfg.numKeypoints = 14;
    sorrelClusterCfg.clusterRadius = 2.4f;
    sorrelClusterCfg.instancesPerCluster = 5;
    sorrelClusterCfg.minInstanceDistance = 0.40f;
    sorrelClusterCfg.maxSlopeAngleRad = 0.70f;
    sorrelClusterCfg.seed = 27182;

    auto scatteredSorrels = KeypointClusterScatterEngine::generateClusters(
        -30.0f, 30.0f, -40.0f, 12.0f,
        getTerrainHeight, getTerrainNormal, sorrelClusterCfg
    );

    for (const auto& ss : scatteredSorrels) {
        geometry::Mesh sorrelMesh = BotanicalOrganGenerator::generateWoodSorrelPatch(ss.position, 0.85f * ss.scale, 18);
        allUnderstory.merge(sorrelMesh.toScratchboxMesh());
    }

    // Grass Clumps across the forest floor
    for (int g = 0; g < 42; ++g) {
        float gx = -12.0f + 24.0f * (static_cast<float>(g % 7) / 6.0f) + (std::sin(g * 2.3f) * 0.8f);
        float gz = -30.0f + 36.0f * (static_cast<float>(g / 7) / 5.0f) + (std::cos(g * 1.7f) * 0.8f);
        float gy = getTerrainHeight(gx, gz);

        GrassClumpConfig gCfg;
        gCfg.bladeCount = 14 + (g % 8);
        gCfg.clumpRadius = 0.22f + 0.10f * std::sin(g * 1.5f);
        gCfg.bladeHeightMin = 0.22f;
        gCfg.bladeHeightMax = 0.45f;
        gCfg.seed = 1000 + g * 37;

        geometry::Mesh grassMesh = GrassClumpGenerator::generateClump(gCfg, Vec3(gx, gy, gz));
        allUnderstory.merge(grassMesh.toScratchboxMesh());
    }

    // Creeping moss/ivy tendrils wrapping over the nurse logs
    IvyConfig logIvy1;
    logIvy1.rootPosition = Vec3(1.3f, getTerrainHeight(1.3f, -2.4f), -2.4f);
    logIvy1.obstacleMin = Vec3(0.9f, getTerrainHeight(1.1f, -1.8f) - 0.2f, -5.4f);
    logIvy1.obstacleMax = Vec3(2.9f, getTerrainHeight(2.7f, -5.2f) + 0.7f, -1.6f);
    logIvy1.maxSteps = 30;
    logIvy1.stepLength = 0.18f;
    logIvy1.clingDistance = 0.04f;
    logIvy1.leafSize = 0.14f;
    logIvy1.seed = 7771;
    geometry::Mesh ivyMesh1 = IvyGrowthGenerator::generateIvy(logIvy1);
    allUnderstory.merge(ivyMesh1.toScratchboxMesh());

    // Volumetric 3D Velvet Moss Tufts on Nurse Logs & Buttress Roots: the moss surface, its map projected at its real
    // size (the tufts' blades stand up: across them diagonally, up them in metres) and their shading kept as a share of
    // the tufts' base colour
    std::cout << "🌱 Seeding 3D Volumetric Velvet Moss Tufts on Nurse Logs & Hero Roots...\n";
    auto addMossTufts = [&](geometry::Mesh tufts) {
        const float baseLuminance = luminance(COL_NURSE_LOG_MOSS);
        for (size_t i = 0; i < tufts.vertices.size(); ++i) {
            const Vec3& p = tufts.vertices[i];
            tufts.uvs[i] = Vec2((p.x + p.z) * 0.70710678f / moss.tileU, p.y / moss.tileV);
            const float k = std::min(1.0f, luminance(tufts.vertexColors[i]) / baseLuminance);
            tufts.vertexColors[i] = Vec4(k, k, k, 1.0f);
        }
        mossCushions.merge(tufts.toScratchboxMesh());
    };
    addMossTufts(BotanicalOrganGenerator::generateVolumetricMossTufts(logStart, logEnd, 0.48f, 180));
    addMossTufts(BotanicalOrganGenerator::generateVolumetricMossTufts(log2Start, log2End, 0.44f, 150));
    addMossTufts(BotanicalOrganGenerator::generateVolumetricMossTufts(log3Start, log3End, 0.52f, 160));
    addMossTufts(BotanicalOrganGenerator::generateVolumetricMossTufts(log4Start, log4End, 0.46f, 140));
    addMossTufts(BotanicalOrganGenerator::generateVolumetricMossTufts(Vec3(-2.2f, 0, -0.6f), Vec3(-3.8f, 0,  1.4f), 0.26f, 90));
    addMossTufts(BotanicalOrganGenerator::generateVolumetricMossTufts(Vec3(-2.2f, 0, -0.6f), Vec3(-1.1f, 0,  1.6f), 0.24f, 80));

    // Fallen Deadwood Branches, Pinecones, Bark Chips, Decaying Fronds & Sub-Centimeter Needle Carpet
    std::cout << "🍂 Laying Sub-Centimeter Fallen Needle Carpet & Woodland Litter...\n";
    for (int i = 0; i < 55; ++i) {
        float lx = -5.0f + 10.0f * (static_cast<float>(i % 8) / 7.0f) + (std::sin(i * 1.9f) * 1.2f);
        float lz = -12.0f + 16.0f * (static_cast<float>(i / 8) / 6.0f) + (std::cos(i * 2.7f) * 1.2f);
        float ly = getTerrainHeight(lx, lz);
        float len = 0.8f + 1.2f * std::sin(i * 3.3f);
        float ang = i * 1.8f;
        Vec3 bStart(lx, ly + 0.04f, lz);
        Vec3 bEnd(lx + std::cos(ang) * len, getTerrainHeight(lx + std::cos(ang) * len, lz + std::sin(ang) * len) + 0.04f, lz + std::sin(ang) * len);
        Vec3 dir = (bEnd - bStart).normalized();
        Vec3 up(0, 1, 0);
        Vec3 side = dir.cross(up).normalized();
        up = side.cross(dir).normalized();

        uint32_t bIdx = static_cast<uint32_t>(allUnderstory.vertices.size());
        float r = 0.035f + 0.02f * (i % 3);
        for (int s = 0; s < 4; ++s) {
            float theta = (static_cast<float>(s) / 4.0f) * TWO_PI;
            Vec3 rad = side * std::cos(theta) + up * std::sin(theta);
            Vec4 woodCol = math::lerp(COL_NURSE_LOG_WOOD, COL_BARK_FURROW, 0.40f);
            allUnderstory.addVertex(Vertex(bStart + rad * r, rad, Vec2(0, 0), woodCol));
            allUnderstory.addVertex(Vertex(bEnd + rad * (r * 0.6f), rad, Vec2(1, 1), woodCol));
        }
        for (int s = 0; s < 4; ++s) {
            int next = (s + 1) % 4;
            allUnderstory.addTriangle(bIdx + s * 2, bIdx + s * 2 + 1, bIdx + next * 2);
            allUnderstory.addTriangle(bIdx + next * 2, bIdx + s * 2 + 1, bIdx + next * 2 + 1);
        }
    }

    // 130 Fibonacci Pinecones scattered non-uniformly
    for (int i = 0; i < 130; ++i) {
        float px = -5.5f + 11.0f * (static_cast<float>(i % 13) / 12.0f) + (std::sin(i * 2.1f) * 0.85f);
        float pz = -12.5f + 17.0f * (static_cast<float>(i / 13) / 9.0f) + (std::cos(i * 1.7f) * 0.85f);
        float py = getTerrainHeight(px, pz) + 0.025f;
        float yaw = i * 1.35f;
        Vec3 dir(std::cos(yaw), 0.0f, std::sin(yaw));
        Vec3 up = getTerrainNormal(px, pz);
        geometry::Mesh cone = BotanicalOrganGenerator::generateFibonacciPinecone(Vec3(px, py, pz), dir, up, 0.11f, 0.042f, 18);
        allUnderstory.merge(cone.toScratchboxMesh());
    }

    // 38 Decaying Winter Fronds pressed to ground
    for (int f = 0; f < 38; ++f) {
        float fx = -3.8f + 7.6f * (static_cast<float>(f % 7) / 6.0f) + (std::sin(f * 2.3f) * 0.6f);
        float fz = -9.5f + 12.0f * (static_cast<float>(f / 7) / 5.0f) + (std::cos(f * 1.9f) * 0.6f);
        float fy = getTerrainHeight(fx, fz) + 0.015f;
        float yaw = f * 1.45f;
        Vec3 dir(std::cos(yaw), 0.0f, std::sin(yaw));
        Vec3 norm = getTerrainNormal(fx, fz);
        geometry::Mesh frond = BotanicalOrganGenerator::generateDecayingWinterFrond(Vec3(fx, fy, fz), dir, norm, 0.95f, 10);
        allUnderstory.merge(frond.toScratchboxMesh());
    }

    // 1400 Sub-Centimeter Fallen Needle Clusters
    for (int c = 0; c < 1400; ++c) {
        float cx = -5.2f + 10.4f * (static_cast<float>(c % 40) / 39.0f) + (std::sin(c * 2.3f) * 0.45f);
        float cz = -12.5f + 16.0f * (static_cast<float>(c / 40) / 34.0f) + (std::cos(c * 1.7f) * 0.45f);
        float cy = getTerrainHeight(cx, cz) + 0.012f;
        Vec3 groundNorm = getTerrainNormal(cx, cz);
        geometry::Mesh needles = BotanicalOrganGenerator::generateFallenNeedleCluster(Vec3(cx, cy, cz), groundNorm, 8, 0.038f, 0.0042f);
        allUnderstory.merge(needles.toScratchboxMesh());
    }

    // Macro-to-Micro Narrative Clutter Distribution in Biological Deposition Pockets
    std::cout << "📦 Distributing Macro-to-Micro Narrative Clutter into Biological Deposition Pockets...\n";
    auto pockets = NarrativeClutterPlacer::identifyPockets(
        { Vec3(-2.2f, 0, -0.6f), Vec3(2.6f, 0, -5.2f), Vec3(4.5f, 0, 0.5f), Vec3(-5.5f, 0, 1.2f), Vec3(-8.5f, 0, 2.5f), Vec3(8.0f, 0, 3.0f) },
        { { logStart, logEnd }, { log2Start, log2End }, { log3Start, log3End }, { log4Start, log4End } },
        getTerrainHeight,
        getTerrainNormal
    );
    for (const auto& p : pockets) {
        if (p.type == NarrativeClutterPlacer::PocketType::RootButtressCrotch) {
            geometry::Mesh cluster = BotanicalOrganGenerator::generateFallenNeedleCluster(p.position, p.surfaceNormal, 12);
            allUnderstory.merge(cluster.toScratchboxMesh());
        }
    }

    // 8. Volumetric Atmospheric God Rays
    std::cout << "☀️ Injecting Morning Crepuscular Sunbeams (56 Volumetric God Rays)...\n";
    Vec3 sunOrigin(3.8f, 18.0f, -14.0f);
    Vec3 focalCenter(-1.4f, 1.2f, -5.5f);
    std::vector<TrunkSpec> shaftBlockers;
    for (const Redwood& redwood : redwoods) shaftBlockers.push_back(redwood.trunk);
    ScratchboxMesh godRays = generateAtmosphericGodRays(sunOrigin, focalCenter, shaftBlockers, 56);

    // 9. Assemble Discrete Multi-Mesh Array for GlbWriter (the crowns are their own GLB, section 6). The library-textured
    //    surfaces take their set's map, normal and ORM (roughness from the map: factor 1), their tint as the base colour
    //    factor, tangents from their real-size UVs, and in their extras the set, its real size and the measurement.
    auto surface = [](ScratchboxMesh& mesh, const std::string& materialName, const SurfaceSet& set, const MeasuredTarget& target,
                      const Vec3& tint, float share, const std::string& uv) {
        mesh.material.name = materialName;
        mesh.material.baseColorFactor = Vec4(tint.x, tint.y, tint.z, 1.0f);
        mesh.material.roughnessFactor = 1.0f;
        mesh.material.metallicFactor = 0.0f;
        mesh.material.extrasJson = surfaceExtras(set, target, tint, share, uv);
        computeTangents(mesh);
    };
    surface(floor, "PBR_Forest_Floor", duff, duffTarget, duffTint, duffShare, "metres over realSizeM, across the ground (x, z)");
    surface(allTrunks, "PBR_Redwood_Bark", bark, barkTarget, barkTint, barkShare,
            "a whole number of tiles around each column, root and log at its mean radius; metres over realSizeM along it");
    surface(allFerns, "PBR_Sword_Ferns", fernLeaf.set, fernTarget, fernTint, fernShare,
            "one leaf of the atlas per pinna, at the leaf's own width over length; its opacity cuts the pinna");
    allFerns.material.alphaCutoff = 0.5f;
    surface(mossCushions, "PBR_Moss", moss, mossTarget, mossTint, mossShare,
            "metres over realSizeM: across the ground on the cushions, diagonally across and up the tufts' blades");
    mossCushions.material.doubleSided = true;   // the tufts' blades are seen from both sides
    // the undergrowth's small organs (sorrel, grass, ivy, cones, litter, fungi) are drawn in their own vertex colours
    allUnderstory.material.baseColorFactor = Vec4(1.0f, 1.0f, 1.0f, 1.0f);

    std::vector<ScratchboxMesh> subMeshes = {
        floor,          // Index 0: PBR_Forest_Floor
        allTrunks,      // Index 1: PBR_Redwood_Bark
        allFerns,       // Index 2: PBR_Sword_Ferns
        allUnderstory,  // Index 3: PBR_Woodland_Undergrowth
        mossCushions,   // Index 4: PBR_Moss
        godRays         // Index 5: PBR_Volumetric_GodRays
    };

    size_t totalVerts = 0, totalTris = 0;
    for (const auto& m : subMeshes) {
        totalVerts += m.vertices.size();
        totalTris += m.indices.size() / 3;
    }

    std::cout << "\n📊 Scene Multi-Mesh Telemetry:\n";
    std::cout << "   Submeshes Count: " << subMeshes.size() << "\n";
    std::cout << "   Total Vertices:  " << totalVerts << "\n";
    std::cout << "   Total Triangles: " << totalTris << "\n";
    std::cout << "   SB-Veggie Crowns: " << grown.statsJson.substr(0, grown.statsJson.find(",\"perTree\"")) << "}\n";

    // 10. Embed the surfaces' maps into the GLB's materials (the viewer draws with these)
    std::cout << "\n🎨 Embedding the Surface Sets' Maps into glTF Materials...\n";
    std::vector<io::EmbeddedTexture> remappedTextures;
    auto embed = [&](const SurfaceSet& set, int matIdx) {
        const std::tuple<const char*, const std::vector<uint8_t>*, const std::string*, io::TextureUsage> maps[] = {
            { "albedo", &set.albedo, &set.albedoMime, io::TextureUsage::BASE_COLOR },
            { "normal", &set.normal, &set.normalMime, io::TextureUsage::NORMAL },
            { "orm", &set.orm, &set.ormMime, io::TextureUsage::ORM } };
        for (const auto& [role, bytes, mime, usage] : maps) {
            io::EmbeddedTexture t;
            t.name = set.id + "_" + role;
            t.mimeType = *mime;
            t.data = *bytes;
            t.usage = usage;
            t.materialIndex = matIdx;
            remappedTextures.push_back(t);
            std::cout << "   ✅ Embedded " << t.name << " into Material " << matIdx << " (" << t.data.size() << " bytes)\n";
        }
    };
    embed(duff, 0);
    embed(bark, 1);
    embed(fernLeaf.set, 2);
    embed(moss, 4);

    std::cout << "   Total Embedded Textures: " << remappedTextures.size() << "\n";

    // Serialize to standard Binary glTF 2.0 (.glb)
    std::cout << "\n💾 Serializing to Standard Multi-Mesh Binary glTF 2.0 (.glb)...\n";
    std::vector<uint8_t> glbData = io::GlbWriter::serializeMultiMeshToGlb(subMeshes, remappedTextures);

    if (glbData.empty()) {
        std::cerr << "❌ Fatal: GlbWriter emitted empty byte array!\n";
        return 1;
    }

    std::string dir = outputPath.substr(0, outputPath.find_last_of("/\\"));
    if (!dir.empty()) {
        std::string mkdirCmd = "mkdir -p \"" + dir + "\"";
        int sysRet = system(mkdirCmd.c_str());
        (void)sysRet;
    }

    // The crowns beside the forest: <output>_trees.glb, and what SB-Veggie grew in <output>_trees.stats.json
    const std::string stem = outputPath.size() > 4 && outputPath.substr(outputPath.size() - 4) == ".glb" ? outputPath.substr(0, outputPath.size() - 4) : outputPath;
    const std::string treesPath = stem + "_trees.glb";
    const std::string treesStatsPath = stem + "_trees.stats.json";
    const std::pair<const std::string*, const std::vector<uint8_t>*> glbs[] = { { &outputPath, &glbData }, { &treesPath, &grown.glb } };
    for (const auto& [path, bytes] : glbs) {
        std::ofstream outFile(*path, std::ios::binary);
        if (!outFile.is_open()) {
            std::cerr << "❌ Fatal: Could not open output file " << *path << "\n";
            return 1;
        }
        outFile.write(reinterpret_cast<const char*>(bytes->data()), static_cast<std::streamsize>(bytes->size()));
        std::cout << "✅ Successfully Exported: " << *path << " (" << bytes->size() << " bytes)\n";
    }
    std::ofstream statsFile(treesStatsPath);
    statsFile << grown.statsJson << "\n";

    auto tEnd = std::chrono::high_resolution_clock::now();
    double ms = std::chrono::duration<double, std::milli>(tEnd - tStart).count();

    std::cout << "⏱️ Procedural Forest Generation Completed in " << ms << " ms.\n";
    std::cout << "================================================================\n";

    return 0;
}
