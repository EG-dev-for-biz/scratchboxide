/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_TREE_SPECIES_HPP
#define SCRATCHBOX_TREE_SPECIES_HPP

/**
 * The tree species library (assets/vegetation/species/index.json, schema scratchbox.tree-species/1): the proportions of
 * real trees, chosen per measured crown by its measurements so the parts a scan cannot see (crown base, trunk radius,
 * branching, leaf size) come from a tree of that shape instead of one ratio for every tree.
 *
 * Every entry is a parameter set described by continuous quantities: the heights the form is seen at, crown radius and
 * crown base as shares of the height, trunk radius per height, how much of the crown's surface lies near its top (a
 * dome, a cone, a flat rosette), how many stems leave the ground, the scaffold limbs and their angle, the leaf's length
 * and aspect, and the foliage's usual hue. The name on it is a label for people and prompts; nothing here or in the
 * grower branches on it. A crown is matched by the distance of its measurements to each entry's (nearest first, a
 * seeded pick among the near-equal ones, as the texture choice does); a crown far from every entry is unmatched and
 * grows from its own measurements with the grower's defaults.
 *
 * The descriptors of a crown are measured from what strip recorded: its apex above its support, its mean sector radius,
 * the share of its surface samples within topBandPerRadius x that radius of the apex (a hemisphere about 0.58, a 45
 * degree cone about 0.12, a flat top near 1), the depth of its surface, and its photo colour's hue when it has one.
 */

#include "scratchbox_io.hpp"
#include "scratchbox_math.hpp"
#include "scratchbox_tree_textures.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

namespace scratchbox {
namespace tree_species {

using math::Vec3;

struct Entry {
    std::string id, label, description;
    double heightMinM{0}, heightMaxM{0};   // heights (apex above support) this form is seen at
    double crownRadiusPerHeight{0};        // mean crown radius / height
    double crownBaseRatio{0};              // crown base / height (0: foliage to the ground)
    double trunkRadiusPerHeight{0};        // trunk radius / height
    double topShare{0};                    // share of the crown's surface near its apex (see describeCrown)
    int stems{1};                          // 1: one trunk; more: stems leave the ground (grown as a shrub)
    int scaffoldBranches{0};               // primary limbs at the crown break (0: the grower's seeded 2-4)
    double apicalDominance{0.5};           // 0..1, the leader's momentum over the laterals
    double branchAngleRad{0.80795};        // the laterals' angle from the leader
    double leafLengthM{0.12}, leafAspect{0.7};  // the leaf (or frond) the leaf set is chosen by
    double hueDeg{110}, hueSpreadDeg{20};  // the foliage's usual hue in the chromaticity plane (0 red, 120 green) and its range
};

struct Library {
    std::string schema;
    std::vector<Entry> entries;
};

class SpeciesIndexError : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

/** What the choice reads of a crown: all measured by strip, none named. */
struct CrownDescriptors {
    double heightM{0};        // apex above support
    double meanRadiusM{0};    // mean of the 16 sector radii
    double aspect{0};         // meanRadiusM / heightM
    double topShare{0};       // share of the surface samples within topBandPerRadius x meanRadiusM of the apex
    double depthM{0};         // apex to the lowest surface sample (the scan's drape included)
    size_t samples{0};
    bool colourKnown{false};
    double hueDeg{0}, saturation{0};  // of the measured crown colour (tree_textures::hueSaturation)
};

struct ChoiceParams {
    double topBandPerRadius{0.35};   // the apex band topShare counts, as a share of the mean radius
    double heightSigmaLog{0.35};     // |ln(height / nearest bound of the entry's range)| that costs 1 (squared); inside the range costs 0
    double aspectSigmaLog{0.35};     // |ln(aspect / entry aspect)| that costs 1 (squared)
    double topShareSigma{0.2};       // |topShare - entry topShare| that costs 1 (squared)
    double hueSigmaDeg{10.0};        // hue past the entry's spread that costs 1 (squared); inside the spread costs 0
    double greySaturation{0.06};     // below this measured saturation the hue counts for proportionally less
    double margin{0.5};              // entries within this cost of the best may be picked (a seeded pick among them)
    double maxCost{6.0};             // past this the crown matches nothing: grown from its measurements alone
};

struct Choice {
    bool matched{false};
    size_t entry{0};
    double cost{std::numeric_limits<double>::infinity()};
    CrownDescriptors measured;
};

namespace detail {

inline double number(const io::GlbJsonValue& v, const std::string& what, double lo, double hi) {
    if (v.type != io::GlbJsonValue::Number || !std::isfinite(v.num) || v.num < lo || v.num > hi) {
        throw SpeciesIndexError(what + " must be a number in [" + std::to_string(lo) + ", " + std::to_string(hi) + "]");
    }
    return v.num;
}

inline std::string text(const io::GlbJsonValue& v) { return v.type == io::GlbJsonValue::String ? v.str : std::string(); }

} // namespace detail

/** Parses index.json text. Throws SpeciesIndexError naming what is wrong. */
inline Library parseIndex(const std::string& text) {
    io::GlbJsonParser p(text.data(), text.size());
    const io::GlbJsonValue doc = p.parse();
    Library lib;
    lib.schema = detail::text(doc["schema"]);
    if (lib.schema != "scratchbox.tree-species/1") throw SpeciesIndexError("the species index's schema is '" + lib.schema + "', not scratchbox.tree-species/1");
    for (const auto& e : doc["entries"].arr) {
        Entry E;
        E.id = detail::text(e["id"]);
        if (E.id.empty()) throw SpeciesIndexError("a species entry has no id");
        for (const auto& other : lib.entries) if (other.id == E.id) throw SpeciesIndexError("species entry " + E.id + " is listed twice");
        E.label = detail::text(e["label"]);
        if (E.label.empty()) throw SpeciesIndexError(E.id + " has no label");
        E.description = detail::text(e["description"]);
        const auto& h = e["heightM"];
        if (h.type != io::GlbJsonValue::Array || h.arr.size() != 2) throw SpeciesIndexError(E.id + ".heightM must be [min, max]");
        E.heightMinM = detail::number(h[0], E.id + ".heightM[0]", 0.2, 150);
        E.heightMaxM = detail::number(h[1], E.id + ".heightM[1]", E.heightMinM, 150);
        E.crownRadiusPerHeight = detail::number(e["crownRadiusPerHeight"], E.id + ".crownRadiusPerHeight", 0.05, 3);
        E.crownBaseRatio = detail::number(e["crownBaseRatio"], E.id + ".crownBaseRatio", 0, 0.95);
        E.trunkRadiusPerHeight = detail::number(e["trunkRadiusPerHeight"], E.id + ".trunkRadiusPerHeight", 0.002, 0.2);
        E.topShare = detail::number(e["topShare"], E.id + ".topShare", 0, 1);
        E.stems = static_cast<int>(detail::number(e["stems"], E.id + ".stems", 1, 40));
        E.scaffoldBranches = static_cast<int>(detail::number(e["scaffoldBranches"], E.id + ".scaffoldBranches", 0, 24));
        E.apicalDominance = detail::number(e["apicalDominance"], E.id + ".apicalDominance", 0, 1);
        E.branchAngleRad = detail::number(e["branchAngleRad"], E.id + ".branchAngleRad", 0.05, 1.5);
        E.leafLengthM = detail::number(e["leafLengthM"], E.id + ".leafLengthM", 0.005, 6);
        E.leafAspect = detail::number(e["leafAspect"], E.id + ".leafAspect", 0.02, 2);
        const auto& hue = e["hueDeg"];
        if (hue.type != io::GlbJsonValue::Array || hue.arr.size() != 2) throw SpeciesIndexError(E.id + ".hueDeg must be [centre, spread]");
        E.hueDeg = detail::number(hue[0], E.id + ".hueDeg[0]", -180, 360);
        E.hueSpreadDeg = detail::number(hue[1], E.id + ".hueDeg[1]", 0, 180);
        lib.entries.push_back(E);
    }
    if (lib.entries.empty()) throw SpeciesIndexError("the species index has no entries");
    return lib;
}

/** The descriptors of a measured crown (the tile frame: y up). `colour` is the crown's measured mean linear colour, or null. */
inline CrownDescriptors describeCrown(const Vec3& apex, double supportY, const std::array<double, 16>& sectorRadii, const std::vector<Vec3>& samples,
                                      const std::array<double, 3>* colour, const ChoiceParams& C = ChoiceParams()) {
    CrownDescriptors d;
    d.heightM = std::max(0.1, static_cast<double>(apex.y) - supportY);
    double r = 0;
    for (double v : sectorRadii) r += v / 16.0;
    d.meanRadiusM = std::max(0.05, r);
    d.aspect = d.meanRadiusM / d.heightM;
    d.samples = samples.size();
    double lowest = apex.y;
    size_t top = 0;
    const double band = C.topBandPerRadius * d.meanRadiusM;
    for (const auto& s : samples) {
        lowest = std::min(lowest, static_cast<double>(s.y));
        if (static_cast<double>(apex.y) - static_cast<double>(s.y) <= band) ++top;
    }
    d.topShare = samples.empty() ? 0.0 : static_cast<double>(top) / static_cast<double>(samples.size());
    d.depthM = static_cast<double>(apex.y) - lowest;
    if (colour) {
        d.colourKnown = true;
        const auto hs = tree_textures::hueSaturation({(*colour)[0], (*colour)[1], (*colour)[2]});
        d.hueDeg = hs[0];
        d.saturation = hs[1];
    }
    return d;
}

/** The cost of an entry for a crown (0 a perfect fit; each term squared, 1 at one sigma). */
inline double entryCost(const Entry& e, const CrownDescriptors& d, const ChoiceParams& C) {
    double cost = 0;
    if (d.heightM < e.heightMinM || d.heightM > e.heightMaxM) {
        const double bound = d.heightM < e.heightMinM ? e.heightMinM : e.heightMaxM;
        const double dh = std::log(d.heightM / bound) / C.heightSigmaLog;
        cost += dh * dh;
    }
    const double da = std::log(std::max(1e-6, d.aspect) / e.crownRadiusPerHeight) / C.aspectSigmaLog;
    cost += da * da;
    const double dt = (d.topShare - e.topShare) / C.topShareSigma;
    cost += dt * dt;
    if (d.colourKnown) {
        double dhue = std::fmod(std::abs(d.hueDeg - e.hueDeg), 360.0);
        if (dhue > 180.0) dhue = 360.0 - dhue;
        const double past = std::max(0.0, dhue - e.hueSpreadDeg) / C.hueSigmaDeg;
        cost += std::min(1.0, d.saturation / C.greySaturation) * past * past;
    }
    return cost;
}

/** The entry nearest a crown's measurements (a seeded pick among those within the margin), or unmatched past maxCost. */
inline Choice choose(const Library& lib, const CrownDescriptors& d, uint64_t seed, const ChoiceParams& C = ChoiceParams()) {
    Choice out;
    out.measured = d;
    if (lib.entries.empty()) return out;
    std::vector<double> cost(lib.entries.size());
    for (size_t i = 0; i < lib.entries.size(); ++i) cost[i] = entryCost(lib.entries[i], d, C);
    const size_t i = tree_textures::detail::pick(cost, seed, 0x5BEC1E5, C.margin);
    out.entry = i;
    out.cost = cost[i];
    out.matched = cost[i] <= C.maxCost;
    return out;
}

} // namespace tree_species
} // namespace scratchbox

#endif
