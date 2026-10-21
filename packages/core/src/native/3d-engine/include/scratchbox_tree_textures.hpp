/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_TREE_TEXTURES_HPP
#define SCRATCHBOX_TREE_TEXTURES_HPP

/**
 * The tree texture library (assets/textures/trees/index.json, schema scratchbox.tree-textures/1) and the choice of a
 * leaf set and a bark for each planted tree, by appearance.
 *
 * The library is a surface material library: every entry is described by continuous quantities (its colour statistics,
 * its leaves' length and width in metres, its bark's relief and real-world size), never by a species or a category,
 * and nothing here branches on an entry's name or its free-text appearance.
 *
 * - Leaves: the entry whose colour is nearest the crown colour the tile photo shows (its hue, and weakly its saturation:
 *   brightness is normalised away, and haze greys a photo), and whose typical leaf length is nearest a length in proportion to the tree's height and crown
 *   radius. Its tint takes the entry's mean colour to the measured crown colour itself (per channel, the measured over
 *   the entry's mean), so the leaves and the far masses read as the colour the scan showed; only a tint outside
 *   [tintChannelMin, tintChannelMax] is clamped.
 * - Bark: the entry whose relief is nearest a relief that grows continuously with the tree's size (height and trunk
 *   radius): furrowed for large, old trees, smoother for young ones. Its tint moves it lightly toward a plausible bark
 *   albedo (the entry's own colour, a little desaturated, its luminance within the range bark has).
 *
 * Each choice is deterministic per tree: among the entries within a margin of the best cost, a hash of the tree's seed
 * picks one, weighted toward the lower cost. The same tree is given the same textures on every rebuild.
 */

#include "scratchbox_io.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace scratchbox {
namespace tree_textures {

using RGB = std::array<double, 3>;

struct LeafEntry {
    std::string id;
    RGB meanLinear{0, 0, 0};
    double leafLengthM{0}, leafWidthM{0};
    double fill{0.7};   // share of a leaf's cell box (length x width) its cut-out covers (index leaf.fill; 0.7 when absent)
};

struct BarkEntry {
    std::string id;
    RGB meanLinear{0, 0, 0};
    double reliefIndex{0};
    double tileAroundM{0}, tileAlongM{0};   // real-world size of the texture: around the trunk (x), along it (y)
};

struct Library {
    std::string schema;
    std::vector<LeafEntry> leaves;
    std::vector<BarkEntry> bark;
    double reliefMin{0}, reliefMax{0};
};

class TextureIndexError : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

inline double luminance(const RGB& c) { return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }

inline RGB chromaticity(const RGB& c) {
    const double s = std::max(1e-9, c[0] + c[1] + c[2]);
    return {c[0] / s, c[1] / s, c[2] / s};
}

/** Hue (degrees, 0 red, about 120 green, 240 blue) and saturation (distance of the chromaticity from grey) of a colour. */
inline std::array<double, 2> hueSaturation(const RGB& c) {
    const RGB q = chromaticity(c);
    const double h = std::atan2(std::sqrt(3.0) * (q[1] - q[2]), 2.0 * q[0] - q[1] - q[2]) * 180.0 / 3.14159265358979323846;
    const double s = std::sqrt((q[0] - 1.0 / 3) * (q[0] - 1.0 / 3) + (q[1] - 1.0 / 3) * (q[1] - 1.0 / 3) + (q[2] - 1.0 / 3) * (q[2] - 1.0 / 3));
    return {h, s};
}

namespace detail {

inline uint64_t mix(uint64_t h) {
    h ^= h >> 33; h *= 0xff51afd7ed558ccdull; h ^= h >> 33; h *= 0xc4ceb9fe1a85ec53ull; h ^= h >> 33;
    return h;
}

inline double unit(uint64_t seed, uint64_t salt) { return static_cast<double>(mix(seed ^ mix(salt * 0x9E3779B97F4A7C15ull)) >> 11) / 9007199254740992.0; }

inline RGB rgbOf(const io::GlbJsonValue& v, const std::string& what) {
    if (v.type != io::GlbJsonValue::Array || v.arr.size() != 3) throw TextureIndexError(what + " is not an [r, g, b] array");
    RGB c{};
    for (size_t k = 0; k < 3; ++k) {
        if (v[k].type != io::GlbJsonValue::Number || !std::isfinite(v[k].num) || v[k].num < 0) throw TextureIndexError(what + " has a non-number or negative channel");
        c[k] = v[k].num;
    }
    return c;
}

inline double positive(const io::GlbJsonValue& v, const std::string& what) {
    if (v.type != io::GlbJsonValue::Number || !(v.num > 0) || !std::isfinite(v.num)) throw TextureIndexError(what + " must be a positive number");
    return v.num;
}

/**
 * Picks one of the candidates by cost: those within `margin` of the lowest, weighted exp(-cost), chosen by a hash of
 * `seed` (salted per use), so the choice is the same for the same tree and spreads over near-equal entries.
 */
inline size_t pick(const std::vector<double>& cost, uint64_t seed, uint64_t salt, double margin) {
    if (cost.empty()) return 0;
    const double best = *std::min_element(cost.begin(), cost.end());
    double sum = 0;
    std::vector<double> w(cost.size(), 0.0);
    for (size_t i = 0; i < cost.size(); ++i) if (cost[i] <= best + margin) sum += (w[i] = std::exp(-(cost[i] - best)));
    double r = unit(seed, salt) * sum;
    for (size_t i = 0; i < cost.size(); ++i) {
        if (w[i] <= 0) continue;
        if (r < w[i]) return i;
        r -= w[i];
    }
    for (size_t i = cost.size(); i-- > 0;) if (w[i] > 0) return i;
    return 0;
}

} // namespace detail

/** Parses index.json text. Throws TextureIndexError naming what is wrong. */
inline Library parseIndex(const std::string& text) {
    io::GlbJsonParser p(text.data(), text.size());
    const io::GlbJsonValue doc = p.parse();
    Library lib;
    lib.schema = doc["schema"].type == io::GlbJsonValue::String ? doc["schema"].str : std::string();
    if (lib.schema != "scratchbox.tree-textures/1") throw TextureIndexError("the texture index's schema is '" + lib.schema + "', not scratchbox.tree-textures/1");
    for (const auto& e : doc["leaves"].arr) {
        LeafEntry L;
        L.id = e["id"].type == io::GlbJsonValue::String ? e["id"].str : std::string();
        if (L.id.empty()) throw TextureIndexError("a leaf entry has no id");
        L.meanLinear = detail::rgbOf(e["colour"]["meanLinearRgb"], L.id + ".colour.meanLinearRgb");
        L.leafLengthM = detail::positive(e["leaf"]["lengthM"], L.id + ".leaf.lengthM");
        L.leafWidthM = detail::positive(e["leaf"]["widthM"], L.id + ".leaf.widthM");
        if (e["leaf"]["fill"].type == io::GlbJsonValue::Number && e["leaf"]["fill"].num > 0 && e["leaf"]["fill"].num <= 1) L.fill = e["leaf"]["fill"].num;
        lib.leaves.push_back(L);
    }
    for (const auto& e : doc["bark"].arr) {
        BarkEntry B;
        B.id = e["id"].type == io::GlbJsonValue::String ? e["id"].str : std::string();
        if (B.id.empty()) throw TextureIndexError("a bark entry has no id");
        B.meanLinear = detail::rgbOf(e["colour"]["meanLinearRgb"], B.id + ".colour.meanLinearRgb");
        const auto& relief = e["bark"]["reliefIndex"];
        if (relief.type != io::GlbJsonValue::Number || !(relief.num >= 0)) throw TextureIndexError(B.id + ".bark.reliefIndex must be a number >= 0");
        B.reliefIndex = relief.num;
        B.tileAroundM = detail::positive(e["realSizeM"][0], B.id + ".realSizeM[0]");
        B.tileAlongM = detail::positive(e["realSizeM"][1], B.id + ".realSizeM[1]");
        lib.bark.push_back(B);
    }
    if (lib.leaves.empty() || lib.bark.empty()) throw TextureIndexError("the texture index needs at least one leaf entry and one bark entry");
    lib.reliefMin = lib.reliefMax = lib.bark.front().reliefIndex;
    for (const auto& b : lib.bark) { lib.reliefMin = std::min(lib.reliefMin, b.reliefIndex); lib.reliefMax = std::max(lib.reliefMax, b.reliefIndex); }
    return lib;
}

/**
 * The crown colour the leaves are chosen and tinted by: the tree's own as the tile's photo shows it ("measured"), else the
 * median of the measured crowns of the same planting ("neighbours"), else a leaf-on prior: the mean of the library's
 * greener half ("prior"). `source` is a diagnostic label; nothing branches on it.
 */
struct MeasuredColour {
    bool known{false};
    RGB meanLinear{0, 0, 0};
    std::string source{"none"};
};

/** The leaf-on prior: the mean colour of the library's leaf entries whose green share is at least the median's. */
inline RGB leafOnPrior(const Library& lib) {
    std::vector<double> g;
    for (const auto& e : lib.leaves) g.push_back(chromaticity(e.meanLinear)[1]);
    std::vector<double> sorted = g;
    std::sort(sorted.begin(), sorted.end());
    const double med = sorted[sorted.size() / 2];
    RGB m{0, 0, 0};
    double n = 0;
    for (size_t i = 0; i < lib.leaves.size(); ++i) if (g[i] >= med) { for (int k = 0; k < 3; ++k) m[static_cast<size_t>(k)] += lib.leaves[i].meanLinear[static_cast<size_t>(k)]; n += 1; }
    for (auto& c : m) c /= std::max(1.0, n);
    return m;
}

/** What the choice reads of a tree: all measured or grown, none named. */
struct TreeAppearance {
    MeasuredColour colour;
    double leafLengthHintM{0};  // the leaf (or frond) length the leaf set is chosen by when > 0 (a species entry's); else from the tree's size
    double heightM{0};          // apex above support
    double crownRadiusM{0};     // mean of the measured sector radii
    double trunkRadiusM{0};
    uint64_t seed{0};
};

/** The constants of the choice. All continuous. */
struct ChoiceParams {
    // colour: a tile photo's crown colour is greyed by haze and sky light, so leaves are matched on hue (the angle of the
    // chromaticity around grey) and only weakly on saturation (its distance from grey)
    double hueSigmaDeg{12.0};           // hue difference that costs 1 (squared)
    double saturationSigmaLog{2.0};     // |ln(entry saturation / measured saturation)| that costs 1 (squared)
    double greySaturation{0.06};        // below this measured saturation the hue counts for proportionally less
    double leafSizeSigmaLog{0.35};      // |ln(entry length / target length)| that costs 1 (squared)
    double leafPerHeight{0.0065};       // target leaf length: the geometric mean of leafPerHeight x height ...
    double leafPerCrownRadius{0.018};   // ... and leafPerCrownRadius x crown radius,
    double leafMinM{0.04}, leafMaxM{0.35};  // within these
    double margin{1.5};                 // entries within this cost of the best may be picked
    // the tint is the measured crown colour over the entry's mean, per channel: the leaves come out the scan's colour.
    // Only a ratio past these is held (a near-black channel of an entry, or a crown measured far darker than any leaf set)
    double tintChannelMin{0.05}, tintChannelMax{8.0};
    // bark: the tree's size share s = mean of ln(H / youngH) / ln(oldH / youngH) and (r - youngR) / (oldR - youngR), both in [0, 1]
    double youngHeightM{5}, oldHeightM{28};
    double youngTrunkRadiusM{0.06}, oldTrunkRadiusM{0.45};
    double reliefSigmaShare{0.22};      // relief distance (as a share of the library's relief range) that costs 1 (squared)
    // a plausible bark albedo: the entry's colour desaturated by barkDesaturate, its luminance within [barkYMin, barkYMax];
    // the tint goes barkTintShare of the way there
    double barkDesaturate{0.25}, barkYMin{0.05}, barkYMax{0.18}, barkTintShare{0.6};
};

struct Choice {
    size_t leaf{0}, bark{0};
    RGB leafTint{1, 1, 1}, barkTint{1, 1, 1};
    RGB massColourLinear{0, 0, 0};       // the far level's leaf masses: the chosen leaves' mean colour under the tint
    double targetLeafLengthM{0};
    double sizeShare{0};                 // 0 young .. 1 old (the bark's target)
    double targetRelief{0};
    double leafCost{0}, barkCost{0};
    bool colourMeasured{false};
    std::string colourSource{"none"};     // measured | neighbours | prior | none (MeasuredColour::source)
};

/** The target leaf length of a tree: in proportion to its height and to its crown radius (their geometric mean). */
inline double targetLeafLength(const TreeAppearance& t, const ChoiceParams& C) {
    const double byHeight = C.leafPerHeight * std::max(0.5, t.heightM);
    const double byCrown = C.leafPerCrownRadius * std::max(0.25, t.crownRadiusM);
    return std::clamp(std::sqrt(byHeight * byCrown), C.leafMinM, C.leafMaxM);
}

/** The tree's size share (0 young .. 1 old), from its height and trunk radius. */
inline double sizeShare(const TreeAppearance& t, const ChoiceParams& C) {
    const double h = std::clamp(std::log(std::max(1e-3, t.heightM) / C.youngHeightM) / std::log(C.oldHeightM / C.youngHeightM), 0.0, 1.0);
    const double r = std::clamp((t.trunkRadiusM - C.youngTrunkRadiusM) / (C.oldTrunkRadiusM - C.youngTrunkRadiusM), 0.0, 1.0);
    return 0.5 * (h + r);
}

inline Choice choose(const Library& lib, const TreeAppearance& t, const ChoiceParams& C = ChoiceParams()) {
    Choice out;
    out.colourMeasured = t.colour.known && t.colour.source == "measured";
    out.colourSource = t.colour.known ? t.colour.source : "none";
    // ---- leaves ----
    // a leaf length the caller asks for (a species entry's leaf or frond) is used when the library has leaves of that order;
    // a frond no entry comes near would make the leaf cost pick the longest leaves whatever their look, so it is ignored
    double hint = 0;
    if (t.leafLengthHintM > 0 && !lib.leaves.empty()) {
        double lo = lib.leaves.front().leafLengthM, hi = lo;
        for (const auto& e : lib.leaves) { lo = std::min(lo, e.leafLengthM); hi = std::max(hi, e.leafLengthM); }
        if (t.leafLengthHintM >= lo / 1.5 && t.leafLengthHintM <= hi * 1.5) hint = t.leafLengthHintM;
    }
    out.targetLeafLengthM = hint > 0 ? hint : targetLeafLength(t, C);
    std::vector<double> lc(lib.leaves.size());
    for (size_t i = 0; i < lib.leaves.size(); ++i) {
        const auto& e = lib.leaves[i];
        const double dl = std::log(e.leafLengthM / out.targetLeafLengthM) / C.leafSizeSigmaLog;
        double cost = dl * dl;
        if (t.colour.known) {
            const auto hw = hueSaturation(t.colour.meanLinear), he = hueSaturation(e.meanLinear);
            double dh = std::fmod(std::abs(he[0] - hw[0]), 360.0);
            if (dh > 180.0) dh = 360.0 - dh;
            const double hueWeight = std::min(1.0, hw[1] / C.greySaturation);
            const double ds = std::log(std::max(1e-6, he[1]) / std::max(1e-6, hw[1])) / C.saturationSigmaLog;
            cost += hueWeight * (dh / C.hueSigmaDeg) * (dh / C.hueSigmaDeg) + ds * ds;
        }
        lc[i] = cost;
    }
    out.leaf = detail::pick(lc, t.seed, 0x1EAF, C.margin);
    out.leafCost = lc[out.leaf];
    const LeafEntry& L = lib.leaves[out.leaf];
    if (t.colour.known) {
        // the entry's mean colour to the measured crown colour: the tinted mean is the measured colour, channel by channel
        for (int k = 0; k < 3; ++k) {
            const double ratio = t.colour.meanLinear[static_cast<size_t>(k)] / std::max(1e-6, L.meanLinear[static_cast<size_t>(k)]);
            out.leafTint[static_cast<size_t>(k)] = std::clamp(ratio, C.tintChannelMin, C.tintChannelMax);
        }
    }
    for (int k = 0; k < 3; ++k) out.massColourLinear[static_cast<size_t>(k)] = L.meanLinear[static_cast<size_t>(k)] * out.leafTint[static_cast<size_t>(k)];
    // ---- bark ----
    out.sizeShare = sizeShare(t, C);
    out.targetRelief = lib.reliefMin + out.sizeShare * (lib.reliefMax - lib.reliefMin);
    const double sigma = std::max(1e-6, C.reliefSigmaShare * (lib.reliefMax - lib.reliefMin));
    std::vector<double> bc(lib.bark.size());
    for (size_t i = 0; i < lib.bark.size(); ++i) {
        const double d = (lib.bark[i].reliefIndex - out.targetRelief) / sigma;
        bc[i] = d * d;
    }
    out.bark = detail::pick(bc, t.seed, 0xBA4C, C.margin);
    out.barkCost = bc[out.bark];
    const BarkEntry& B = lib.bark[out.bark];
    {
        const double y = luminance(B.meanLinear);
        RGB target{};
        for (int k = 0; k < 3; ++k) target[static_cast<size_t>(k)] = y + (B.meanLinear[static_cast<size_t>(k)] - y) * (1.0 - C.barkDesaturate);
        const double yt = std::clamp(y, C.barkYMin, C.barkYMax);
        for (int k = 0; k < 3; ++k) {
            const double full = target[static_cast<size_t>(k)] * (yt / std::max(1e-6, y)) / std::max(1e-6, B.meanLinear[static_cast<size_t>(k)]);
            out.barkTint[static_cast<size_t>(k)] = std::clamp(1.0 + (full - 1.0) * C.barkTintShare, C.tintChannelMin, C.tintChannelMax);
        }
    }
    return out;
}

} // namespace tree_textures
} // namespace scratchbox

#endif // SCRATCHBOX_TREE_TEXTURES_HPP
