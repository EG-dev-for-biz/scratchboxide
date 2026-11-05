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
 *
 * The pick is weighed by shape and by region (user decision, 2026-11-05). The region term is a continuous plausibility
 * cost from fields each entry carries: the signed latitude bands it grows in (latRangesDeg), the annual extreme minimum
 * temperatures it lives through (usdaZones, published hardiness zones converted to degrees C), the dryness it stands
 * (aridityIndexRange, precipitation / potential evapotranspiration) and how common it is in each of the index's own
 * regions (regionWeights). The build's place (Place: latitude, longitude, elevation, or climate values a caller
 * measured) is resolved against the index's `regions` table (lat/lon boxes with soft edges, each carrying a coarse
 * winter-minimum fit and an aridity index; an estimate, and reported as one by placeJson). A term whose place value or
 * entry field is unknown costs nothing; the sum saturates at placeCostCap, so an implausible species costs more and is
 * never forbidden: a strong shape match can still win. Region ids are joined data to data (an entry's weight to the
 * index's region); nothing here names one.
 *
 * Entries also carry seasonal quantities (leafRetention, leafOutMonth, leafFallMonth, autumnHueDeg) and where their
 * numbers come from (sources, estimated). The hue match reads the autumn hue (a photo may be of any season: a crown's
 * hue anywhere between the entry's summer and autumn hues costs nothing); leafPresence() reads the rest; the grower
 * does not take them yet.
 */

#include "scratchbox_io.hpp"
#include "scratchbox_math.hpp"
#include "scratchbox_tree_textures.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
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
    double apicalDominance{0.5};           // 0..1, the leader's dominance over the laterals (each shoot's momentum, the leader's hold to the apex)
    double branchAngleRad{0.80795};        // the laterals' angle from the leader
    double leafLengthM{0.12}, leafAspect{0.7};  // the leaf (or frond) the leaf set is chosen by
    double hueDeg{110}, hueSpreadDeg{20};  // the foliage's usual hue in the chromaticity plane (0 red, 120 green) and its range
    // Where this form grows outdoors, as absolute latitude (0 the equator, 90 a pole): optional, default [0, 90] (no
    // constraint - most of the library's forms, temperate street and park trees, grow across a wide latitude band and
    // are not costed by it). A form with a real climate limit (a palm) gives its own range; a crown whose own build is
    // measured outside an entry's range costs by how far past it, the same soft, continuous shape every other
    // dimension here already costs by - never a hard species-list exclusion.
    double latAbsMinDeg{0}, latAbsMaxDeg{90};  // the legacy symmetric band (latAbsRangeDeg); read into latRangesDeg
    // Where it grows outdoors, as signed latitude bands [south, north] (degrees, south negative); empty: uncosted. A
    // place outside every band costs by its distance to the nearest.
    std::vector<std::array<double, 2>> latRangesDeg;
    // The annual extreme minimum temperatures it lives through, from its published USDA hardiness zones [coldest zone,
    // warmest zone] (zone z spans -51.11 + 5.556 (z - 1) .. -51.11 + 5.556 z degrees C): colder than the first kills it,
    // warmer than the last gives it no winter. hasZones false: uncosted.
    bool hasZones{false};
    double usdaZoneMin{0}, usdaZoneMax{0};
    double winterMinColdestC{0}, winterMinWarmestC{0};
    // The aridity index (annual precipitation / potential evapotranspiration; 0.05 hyper-arid, 0.2 arid, 0.5 semi-arid,
    // 0.65 and over humid) it grows across, [driest, wettest]. hasAridity false: uncosted.
    bool hasAridity{false};
    double aridityMin{0}, aridityMax{0};
    // How common it is in each of the library's regions (aligned to Library::regions; 1 native or widely planted, the
    // library's regionWeightElsewhere where the entry names none). hasRegionWeights false: uncosted.
    bool hasRegionWeights{false};
    std::vector<double> regionWeight;
    // Seasons: the share of its foliage it keeps through winter (1 evergreen, 0 deciduous), the months (1 = January,
    // fractional, as at 40 degrees north) its leaves open and have fallen, and its autumn hue. NaN: not given.
    double leafRetention{std::numeric_limits<double>::quiet_NaN()};
    double leafOutMonth{std::numeric_limits<double>::quiet_NaN()}, leafFallMonth{std::numeric_limits<double>::quiet_NaN()};
    bool hasAutumnHue{false};
    double autumnHueDeg{0}, autumnHueSpreadDeg{0};
    // Where its numbers come from, and which of the fields the conventions call published are estimates for this entry.
    std::vector<std::string> sources, estimated;
};

/**
 * One box of the index's coarse place table: its latitude and longitude spans (west > east wraps the antimeridian),
 * the annual extreme minimum temperature at its south and north edges (interpolated by latitude between them) at
 * referenceElevationM, and its aridity index. A fit made for this library to named cities' published values: an
 * estimate, never a measurement.
 */
struct Region {
    std::string id, label;
    double latMinDeg{0}, latMaxDeg{0}, lonWestDeg{0}, lonEastDeg{0};
    double minWinterTempSouthC{0}, minWinterTempNorthC{0};
    double aridityIndex{1};
    double referenceElevationM{0};
};

struct Library {
    std::string schema;
    std::vector<Region> regions;
    double regionWeightElsewhere{0.15};  // an entry's weight in a region it does not name
    double regionEdgeDeg{3.0};           // a region's membership falls to 1/e this many degrees past its box
    std::vector<Entry> entries;
};

/** The build's place. Every member is optional (NaN: unknown, and what needs it costs nothing). */
struct Place {
    double latDeg{std::numeric_limits<double>::quiet_NaN()};         // signed, south negative
    double lonDeg{std::numeric_limits<double>::quiet_NaN()};         // east positive
    double elevationM{std::numeric_limits<double>::quiet_NaN()};     // above sea level
    double minWinterTempC{std::numeric_limits<double>::quiet_NaN()}; // the annual extreme minimum, when the caller has one (else estimated from the regions)
    double aridityIndex{std::numeric_limits<double>::quiet_NaN()};   // precipitation / potential evapotranspiration, when the caller has one
};

/** A place resolved against a library's regions: what the region cost reads, and where each value came from. */
struct PlaceClimate {
    bool latKnown{false}, latSigned{false};
    double latDeg{0};                  // signed when latSigned, else the absolute latitude
    bool tempKnown{false}, tempGiven{false};
    double minWinterTempC{0};
    bool aridityKnown{false}, aridityGiven{false};
    double aridityIndex{0};
    std::vector<double> membership;    // per region, 0..1
    double membershipSum{0};
    bool regionKnown{false};
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
    double latAbsDeg{std::numeric_limits<double>::quiet_NaN()};  // the build's own |latitude| (legacy; ChoiceParams::place carries the signed place); NaN (unknown) costs nothing
};

struct ChoiceParams {
    double topBandPerRadius{0.35};   // the apex band topShare counts, as a share of the mean radius
    double heightSigmaLog{0.35};     // |ln(height / nearest bound of the entry's range)| that costs 1 (squared); inside the range costs 0
    double aspectSigmaLog{0.35};     // |ln(aspect / entry aspect)| that costs 1 (squared)
    double topShareSigma{0.2};       // |topShare - entry topShare| that costs 1 (squared)
    double hueSigmaDeg{10.0};        // hue past the entry's spread that costs 1 (squared); inside the spread costs 0
    double latSigmaDeg{4.0};         // latitude past an entry's nearest band that costs 1 (squared); inside one costs 0
    double winterTempSigmaC{5.0};    // degrees C the place's winter minimum lies outside an entry's hardiness span that cost 1 (squared)
    double ariditySigmaLog{0.7};     // |ln(place aridity / nearer bound of the entry's range)| that costs 1 (squared)
    double regionWeightScale{1.0};   // times -ln(the entry's weight where the place is): a weight of 1 costs 0, 0.15 about 1.9
    double regionWeightFloor{0.05};  // the least weight counted (a weight of 0 costs as this)
    double minMembership{0.2};       // below this summed region membership the place is in no region: no region or estimated climate cost
    double lapseRateCPerKm{6.5};     // the standard atmosphere's lapse rate, applied to a place above its region's reference elevation
    double placeCostCap{4.0};        // the region terms' sum saturates here (sum / (1 + (sum / cap)^4)^(1/4)): implausible costs more, never forbidden
    Place place;                     // the build's place (unknown by default: the choice is by shape alone)
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

/** [a, b] with a <= b, each in [lo, hi]. */
inline std::array<double, 2> span(const io::GlbJsonValue& v, const std::string& what, double lo, double hi) {
    if (v.type != io::GlbJsonValue::Array || v.arr.size() != 2) throw SpeciesIndexError(what + " must be [min, max]");
    const double a = number(v[0], what + "[0]", lo, hi);
    return {a, number(v[1], what + "[1]", a, hi)};
}

inline bool present(const io::GlbJsonValue& v) { return v.type != io::GlbJsonValue::Null; }

/** A list of non-empty strings (at least `least` of them). */
inline std::vector<std::string> strings(const io::GlbJsonValue& v, const std::string& what, size_t least) {
    std::vector<std::string> out;
    if (v.type != io::GlbJsonValue::Array) {
        if (least == 0 && !present(v)) return out;
        throw SpeciesIndexError(what + " must be a list of strings");
    }
    for (const auto& x : v.arr) {
        if (x.type != io::GlbJsonValue::String || x.str.empty()) throw SpeciesIndexError(what + " must be a list of non-empty strings");
        out.push_back(x.str);
    }
    if (out.size() < least) throw SpeciesIndexError(what + " must name at least " + std::to_string(least));
    return out;
}

/** The lower bound, degrees C, of USDA hardiness zone z's annual extreme minimum (zone 1: -60 F; 10 F a zone). */
inline double usdaZoneLowerC(double z) { return (-60.0 + 10.0 * (z - 1.0) - 32.0) / 1.8; }

} // namespace detail

/** Parses index.json text. Throws SpeciesIndexError naming what is wrong. */
inline Library parseIndex(const std::string& text) {
    io::GlbJsonParser p(text.data(), text.size());
    const io::GlbJsonValue doc = p.parse();
    Library lib;
    lib.schema = detail::text(doc["schema"]);
    if (lib.schema != "scratchbox.tree-species/1") throw SpeciesIndexError("the species index's schema is '" + lib.schema + "', not scratchbox.tree-species/1");
    if (detail::present(doc["regionWeightElsewhere"])) lib.regionWeightElsewhere = detail::number(doc["regionWeightElsewhere"], "regionWeightElsewhere", 0, 1);
    if (detail::present(doc["regionEdgeDeg"])) lib.regionEdgeDeg = detail::number(doc["regionEdgeDeg"], "regionEdgeDeg", 0.1, 45);
    if (detail::present(doc["regions"])) {
        if (doc["regions"].type != io::GlbJsonValue::Array) throw SpeciesIndexError("regions must be a list");
        for (const auto& r : doc["regions"].arr) {
            Region R;
            R.id = detail::text(r["id"]);
            if (R.id.empty()) throw SpeciesIndexError("a region has no id");
            for (const auto& other : lib.regions) if (other.id == R.id) throw SpeciesIndexError("region " + R.id + " is listed twice");
            R.label = detail::text(r["label"]);
            if (R.label.empty()) throw SpeciesIndexError("region " + R.id + " has no label");
            const auto lat = detail::span(r["latDeg"], "region " + R.id + ".latDeg", -90, 90);
            R.latMinDeg = lat[0];
            R.latMaxDeg = lat[1];
            if (!(R.latMaxDeg > R.latMinDeg)) throw SpeciesIndexError("region " + R.id + ".latDeg must span more than nothing");
            const auto& lon = r["lonDeg"];
            if (lon.type != io::GlbJsonValue::Array || lon.arr.size() != 2) throw SpeciesIndexError("region " + R.id + ".lonDeg must be [west, east]");
            R.lonWestDeg = detail::number(lon[0], "region " + R.id + ".lonDeg[0]", -180, 180);
            R.lonEastDeg = detail::number(lon[1], "region " + R.id + ".lonDeg[1]", -180, 180);
            const auto& t = r["minWinterTempC"];
            if (t.type != io::GlbJsonValue::Array || t.arr.size() != 2) throw SpeciesIndexError("region " + R.id + ".minWinterTempC must be [at the south edge, at the north edge]");
            R.minWinterTempSouthC = detail::number(t[0], "region " + R.id + ".minWinterTempC[0]", -70, 30);
            R.minWinterTempNorthC = detail::number(t[1], "region " + R.id + ".minWinterTempC[1]", -70, 30);
            R.aridityIndex = detail::number(r["aridityIndex"], "region " + R.id + ".aridityIndex", 0.005, 5);
            if (detail::present(r["referenceElevationM"])) R.referenceElevationM = detail::number(r["referenceElevationM"], "region " + R.id + ".referenceElevationM", -430, 6000);
            lib.regions.push_back(R);
        }
    }
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
        const auto& lat = e["latAbsRangeDeg"];
        if (lat.type == io::GlbJsonValue::Array && lat.arr.size() == 2) {
            E.latAbsMinDeg = detail::number(lat[0], E.id + ".latAbsRangeDeg[0]", 0, 90);
            E.latAbsMaxDeg = detail::number(lat[1], E.id + ".latAbsRangeDeg[1]", E.latAbsMinDeg, 90);
            E.latRangesDeg.push_back({-E.latAbsMaxDeg, -E.latAbsMinDeg});
            E.latRangesDeg.push_back({E.latAbsMinDeg, E.latAbsMaxDeg});
        } else if (detail::present(lat)) {
            throw SpeciesIndexError(E.id + ".latAbsRangeDeg must be [min, max]");
        }
        const auto& bands = e["latRangesDeg"];
        if (detail::present(bands)) {
            if (detail::present(lat)) throw SpeciesIndexError(E.id + " gives both latAbsRangeDeg and latRangesDeg");
            if (bands.type != io::GlbJsonValue::Array || bands.arr.empty()) throw SpeciesIndexError(E.id + ".latRangesDeg must be a list of [south, north]");
            for (size_t b = 0; b < bands.arr.size(); ++b) E.latRangesDeg.push_back(detail::span(bands[b], E.id + ".latRangesDeg[" + std::to_string(b) + "]", -90, 90));
        }
        if (detail::present(e["usdaZones"])) {
            const auto z = detail::span(e["usdaZones"], E.id + ".usdaZones", 1, 13.5);
            E.hasZones = true;
            E.usdaZoneMin = z[0];
            E.usdaZoneMax = z[1];
            E.winterMinColdestC = detail::usdaZoneLowerC(z[0]);
            E.winterMinWarmestC = detail::usdaZoneLowerC(z[1] + 1.0);
        }
        if (detail::present(e["aridityIndexRange"])) {
            const auto a = detail::span(e["aridityIndexRange"], E.id + ".aridityIndexRange", 0.005, 5);
            E.hasAridity = true;
            E.aridityMin = a[0];
            E.aridityMax = a[1];
        }
        const auto& rw = e["regionWeights"];
        if (detail::present(rw)) {
            if (rw.type != io::GlbJsonValue::Object) throw SpeciesIndexError(E.id + ".regionWeights must be an object of region id: weight");
            E.hasRegionWeights = true;
            E.regionWeight.assign(lib.regions.size(), lib.regionWeightElsewhere);
            for (const auto& kv : rw.obj) {
                size_t at = lib.regions.size();
                for (size_t r = 0; r < lib.regions.size(); ++r) if (lib.regions[r].id == kv.first) at = r;
                if (at == lib.regions.size()) throw SpeciesIndexError(E.id + ".regionWeights names " + kv.first + ", which is not one of the index's regions");
                E.regionWeight[at] = detail::number(kv.second, E.id + ".regionWeights." + kv.first, 0, 1);
            }
        }
        if (detail::present(e["leafRetention"])) E.leafRetention = detail::number(e["leafRetention"], E.id + ".leafRetention", 0, 1);
        if (detail::present(e["leafOutMonth"]) != detail::present(e["leafFallMonth"])) throw SpeciesIndexError(E.id + " gives one of leafOutMonth and leafFallMonth without the other");
        if (detail::present(e["leafOutMonth"])) {
            E.leafOutMonth = detail::number(e["leafOutMonth"], E.id + ".leafOutMonth", 1, 13);
            E.leafFallMonth = detail::number(e["leafFallMonth"], E.id + ".leafFallMonth", E.leafOutMonth, 13);
        }
        const auto& autumn = e["autumnHueDeg"];
        if (detail::present(autumn)) {
            if (autumn.type != io::GlbJsonValue::Array || autumn.arr.size() != 2) throw SpeciesIndexError(E.id + ".autumnHueDeg must be [centre, spread]");
            E.hasAutumnHue = true;
            E.autumnHueDeg = detail::number(autumn[0], E.id + ".autumnHueDeg[0]", -180, 360);
            E.autumnHueSpreadDeg = detail::number(autumn[1], E.id + ".autumnHueDeg[1]", 0, 180);
        }
        E.sources = detail::strings(e["sources"], E.id + ".sources", 1);
        E.estimated = detail::strings(e["estimated"], E.id + ".estimated", 0);
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

/**
 * A place against a library's regions. `latAbsDeg` is the legacy unsigned latitude (CrownDescriptors::latAbsDeg), read
 * only when the place has no signed one. The winter minimum and the aridity are the caller's when given; else the
 * regions' values blended by membership (the winter minimum interpolated by latitude across each region and lowered by
 * the lapse rate above its reference elevation): an estimate from latitude, longitude and elevation alone.
 */
inline PlaceClimate resolvePlace(const Library& lib, const Place& p, double latAbsDeg, const ChoiceParams& C) {
    PlaceClimate out;
    if (std::isfinite(p.latDeg)) {
        out.latKnown = out.latSigned = true;
        out.latDeg = std::clamp(p.latDeg, -90.0, 90.0);
    } else if (std::isfinite(latAbsDeg)) {
        out.latKnown = true;
        out.latDeg = std::clamp(std::abs(latAbsDeg), 0.0, 90.0);
    }
    out.membership.assign(lib.regions.size(), 0.0);
    double tempSum = 0, logAridSum = 0;
    if (out.latSigned && std::isfinite(p.lonDeg)) {
        const double cosLat = std::cos(out.latDeg * 3.14159265358979323846 / 180.0);
        for (size_t i = 0; i < lib.regions.size(); ++i) {
            const Region& r = lib.regions[i];
            const double dLat = std::max({0.0, r.latMinDeg - out.latDeg, out.latDeg - r.latMaxDeg});
            // degrees east of the box's west edge, 0..360; inside when within its width
            const double width = std::fmod(r.lonEastDeg - r.lonWestDeg + 360.0, 360.0);
            const double east = std::fmod(std::fmod(p.lonDeg - r.lonWestDeg, 360.0) + 360.0, 360.0);
            const double dLon = east <= width ? 0.0 : std::min(east - width, 360.0 - east) * cosLat;
            const double m = std::exp(-(dLat * dLat + dLon * dLon) / (lib.regionEdgeDeg * lib.regionEdgeDeg));
            out.membership[i] = m;
            out.membershipSum += m;
            const double t = std::clamp((out.latDeg - r.latMinDeg) / (r.latMaxDeg - r.latMinDeg), 0.0, 1.0);
            double temp = r.minWinterTempSouthC + (r.minWinterTempNorthC - r.minWinterTempSouthC) * t;
            if (std::isfinite(p.elevationM)) temp -= C.lapseRateCPerKm * std::max(0.0, p.elevationM - r.referenceElevationM) / 1000.0;
            tempSum += m * temp;
            logAridSum += m * std::log(r.aridityIndex);
        }
        out.regionKnown = out.membershipSum >= C.minMembership;
    }
    if (std::isfinite(p.minWinterTempC)) {
        out.tempKnown = out.tempGiven = true;
        out.minWinterTempC = p.minWinterTempC;
    } else if (out.regionKnown) {
        out.tempKnown = true;
        out.minWinterTempC = tempSum / out.membershipSum;
    }
    if (std::isfinite(p.aridityIndex) && p.aridityIndex > 0) {
        out.aridityKnown = out.aridityGiven = true;
        out.aridityIndex = p.aridityIndex;
    } else if (out.regionKnown) {
        out.aridityKnown = true;
        out.aridityIndex = std::exp(logAridSum / out.membershipSum);
    }
    return out;
}

/** How implausible an entry is at a place: 0 at home, rising smoothly to C.placeCostCap, never past it. */
inline double placeCost(const Entry& e, const PlaceClimate& p, const ChoiceParams& C) {
    double raw = 0;
    if (p.latKnown && !e.latRangesDeg.empty()) {
        double past = std::numeric_limits<double>::infinity();
        for (const auto& band : e.latRangesDeg) {
            past = std::min(past, std::max({0.0, band[0] - p.latDeg, p.latDeg - band[1]}));
            // an unsigned latitude may be either hemisphere
            if (!p.latSigned) past = std::min(past, std::max({0.0, band[0] + p.latDeg, -p.latDeg - band[1]}));
        }
        const double dl = past / C.latSigmaDeg;
        raw += dl * dl;
    }
    if (p.tempKnown && e.hasZones) {
        const double past = p.minWinterTempC < e.winterMinColdestC ? e.winterMinColdestC - p.minWinterTempC : std::max(0.0, p.minWinterTempC - e.winterMinWarmestC);
        const double dt = past / C.winterTempSigmaC;
        raw += dt * dt;
    }
    if (p.aridityKnown && e.hasAridity) {
        const double a = std::max(1e-4, p.aridityIndex);
        const double past = a < e.aridityMin ? std::log(e.aridityMin / a) : std::max(0.0, std::log(a / e.aridityMax));
        const double da = past / C.ariditySigmaLog;
        raw += da * da;
    }
    if (p.regionKnown && e.hasRegionWeights) {
        double w = 0;
        for (size_t i = 0; i < e.regionWeight.size() && i < p.membership.size(); ++i) w += p.membership[i] * e.regionWeight[i];
        raw += C.regionWeightScale * -std::log(std::clamp(w / p.membershipSum, C.regionWeightFloor, 1.0));
    }
    if (!(C.placeCostCap > 0)) return 0.0;
    // nearly the sum itself well below the cap, bending to the cap above it
    const double q = raw / C.placeCostCap;
    return raw / std::sqrt(std::sqrt(1.0 + q * q * q * q));
}

/** The place the region cost read, for stats and extras: every value with where it came from, the estimate named as one. */
inline std::string placeJson(const Library& lib, const ChoiceParams& C, double latAbsDeg = std::numeric_limits<double>::quiet_NaN()) {
    const PlaceClimate p = resolvePlace(lib, C.place, latAbsDeg, C);
    auto num = [](double v) {
        char b[40];
        std::snprintf(b, sizeof b, "%.6g", v);
        return std::string(b);
    };
    std::string o = "{\"latitude\":";
    o += p.latKnown ? "{\"deg\":" + num(p.latDeg) + ",\"signed\":" + (p.latSigned ? "true" : "false") + "}" : std::string("null");
    o += ",\"minWinterTempC\":";
    o += p.tempKnown ? "{\"value\":" + num(p.minWinterTempC) + ",\"provenance\":" + (p.tempGiven ? "\"given\"" : "\"generated\",\"how\":\"estimated from latitude, longitude and elevation by the species index's region table, not measured\"") + "}" : std::string("null");
    o += ",\"aridityIndex\":";
    o += p.aridityKnown ? "{\"value\":" + num(p.aridityIndex) + ",\"provenance\":" + (p.aridityGiven ? "\"given\"" : "\"generated\",\"how\":\"the species index's region table, not measured\"") + "}" : std::string("null");
    o += ",\"regions\":[";
    bool first = true;
    for (size_t i = 0; i < lib.regions.size() && p.regionKnown; ++i) {
        if (p.membership[i] < 0.05) continue;
        o += std::string(first ? "" : ",") + "{\"label\":\"" + lib.regions[i].label + "\",\"membership\":" + num(p.membership[i]) + "}";
        first = false;
    }
    o += "]";
    if (!p.latKnown) o += ",\"note\":\"no place given: the species were chosen by shape alone\"";
    else if (!p.regionKnown) o += ",\"note\":\"latitude alone: no longitude, or outside every region of the index, so no climate or region cost\"";
    return o + "}";
}

/**
 * The share of its full foliage an entry carries in a month (1 = January, fractional) at a latitude: its retention
 * through winter, and between leaf-out and leaf-fall all of it, each edge a month wide. The months are the entry's at
 * 40 degrees north, moved 4 days per degree of latitude (Hopkins' bioclimatic law: later in spring and earlier in
 * autumn toward the pole) and half a year in the southern hemisphere. An entry without months keeps its retention all
 * year (1 when it gives none).
 */
inline double leafPresence(const Entry& e, double latDeg, double month) {
    const double keep = std::isfinite(e.leafRetention) ? e.leafRetention : 1.0;
    if (!std::isfinite(e.leafOutMonth) || !std::isfinite(e.leafFallMonth)) return keep;
    const double shift = (std::abs(latDeg) - 40.0) * 4.0 / 30.44;
    const double out = e.leafOutMonth + shift, fall = e.leafFallMonth - shift;
    if (fall <= out) return keep;
    double m = std::fmod(month - 1.0 + (latDeg < 0 ? 6.0 : 0.0), 12.0);
    if (m < 0) m += 12.0;
    m += 1.0;
    auto smooth = [](double t) { t = std::clamp(t, 0.0, 1.0); return t * t * (3.0 - 2.0 * t); };
    const double open = smooth(m - out + 0.5) * (1.0 - smooth(m - fall + 0.5));
    return keep + (1.0 - keep) * open;
}

/** The cost of an entry for a crown (0 a perfect fit; each term squared, 1 at one sigma) at a resolved place. */
inline double entryCost(const Entry& e, const CrownDescriptors& d, const ChoiceParams& C, const PlaceClimate& place = PlaceClimate()) {
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
        // degrees from a to b the short way round, in (-180, 180]
        auto turn = [](double a, double b) {
            double t = std::fmod(b - a, 360.0);
            if (t > 180.0) t -= 360.0;
            if (t <= -180.0) t += 360.0;
            return t;
        };
        // The photo may have been taken in any season: a tree that turns before it drops its leaves is seen anywhere
        // on the arc from its summer hue to its autumn hue (the short way round), so the nearest hue on that arc is
        // the one the crown is compared with, and the spread there is the two spreads' blend.
        double centre = e.hueDeg, spread = e.hueSpreadDeg;
        if (e.hasAutumnHue) {
            const double arc = turn(e.hueDeg, e.autumnHueDeg);
            const double u = std::abs(arc) > 1e-9 ? std::clamp(turn(e.hueDeg, d.hueDeg) / arc, 0.0, 1.0) : 0.0;
            centre = e.hueDeg + u * arc;
            spread = e.hueSpreadDeg + u * (e.autumnHueSpreadDeg - e.hueSpreadDeg);
        }
        const double past = std::max(0.0, std::abs(turn(centre, d.hueDeg)) - spread) / C.hueSigmaDeg;
        cost += std::min(1.0, d.saturation / C.greySaturation) * past * past;
    }
    cost += placeCost(e, place, C);
    return cost;
}

/** The entry nearest a crown's measurements (a seeded pick among those within the margin), or unmatched past maxCost. */
inline Choice choose(const Library& lib, const CrownDescriptors& d, uint64_t seed, const ChoiceParams& C = ChoiceParams()) {
    Choice out;
    out.measured = d;
    if (lib.entries.empty()) return out;
    const PlaceClimate place = resolvePlace(lib, C.place, d.latAbsDeg, C);
    std::vector<double> cost(lib.entries.size());
    for (size_t i = 0; i < lib.entries.size(); ++i) cost[i] = entryCost(lib.entries[i], d, C, place);
    const size_t i = tree_textures::detail::pick(cost, seed, 0x5BEC1E5, C.margin);
    out.entry = i;
    out.cost = cost[i];
    out.matched = cost[i] <= C.maxCost;
    return out;
}

} // namespace tree_species
} // namespace scratchbox

#endif
