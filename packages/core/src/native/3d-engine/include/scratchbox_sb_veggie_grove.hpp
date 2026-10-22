/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_SB_VEGGIE_GROVE_HPP
#define SCRATCHBOX_SB_VEGGIE_GROVE_HPP

/**
 * SB-Veggie trees for scenes with no scan behind them (imagined scenes, single trees, document-to-3D morphs): the one
 * vegetation generator every 3D path uses. A tree is described by continuous measurements only - where its trunk stands,
 * its height, its crown's radii, where the crown begins and where it is widest, how its top is shaped (a superellipse
 * exponent: 1 a cone, 2 a dome, more a flat top), its trunk radius and its leaf colour. Nothing is keyed on a species
 * name: the label is free text carried into the GLB.
 *
 * describedCrownsJson turns the descriptions into the crowns.json that tile_vegetation strip writes for measured crowns
 * (an upper crown surface sampled on a grid, 16 sector radii, the stem and the support height), with origin "described"
 * so every tree grown from it is labelled generated (never measured) in its extras. growDescribedTrees then runs the
 * same plant() and writeTreesGlb() as a staged location: space-colonisation skeletons (scratchbox_nature.hpp) inside
 * each crown, SB-Veggie leaf clusters and morphology (scratchbox_sb_veggie.hpp via scratchbox_tree_lod.hpp), the species
 * library chosen by the crown's measurements (scratchbox_tree_species.hpp), the tree texture library chosen by appearance
 * (scratchbox_tree_textures.hpp) and the four viewport levels of detail.
 *
 * Used by the tile_vegetation CLI's `grow` command (tile-vegetation-service.ts grow, the botanical_synthesize_tree tool)
 * and by the sb Python binding scratchbox_native.vegetation.grow_described_trees (sb.create_tree, sb.create_vegetation).
 */

#include "scratchbox_tile_vegetation.hpp"

#include <array>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <limits>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

namespace scratchbox {
namespace tile_vegetation {

/** One tree described by measurements (metres; y up). */
struct DescribedTree {
    double x{0}, y{0}, z{0};               // trunk base
    double heightM{0};                     // trunk base to crown top
    double crownRadiusXM{0}, crownRadiusZM{0};  // the crown's half spread along x and z
    double crownBaseHeightM{std::numeric_limits<double>::quiet_NaN()};  // lowest crown above the base (NaN: the species entry's, else the growth's ratio)
    double crownWidestAt{0.5};             // share of the crown's depth (0 its base, 1 its top) at which it is widest
    double crownTopExponent{2.0};          // the upper profile (1 - u^n)^(1/n) over the normalised radius u: 1 a cone, 2 a dome, more a flatter top
    double trunkRadiusM{std::numeric_limits<double>::quiet_NaN()};      // NaN: the species entry's, else the growth's ratio
    bool leafColourKnown{false};
    std::array<double, 3> leafLinearRgb{};  // the foliage's colour, linear RGB 0..1 (the species and leaf textures are chosen by it)
    std::string label;                     // free text (what the request calls it); never changes the geometry
};

namespace detail {

inline double numberField(const io::GlbJsonValue& o, const char* key, double fallback, bool required, size_t index) {
    const auto& v = o[key];
    if (v.type == io::GlbJsonValue::Number) {
        if (!std::isfinite(v.num)) throw VegetationError("bad_request", "tree " + std::to_string(index) + ": \"" + key + "\" must be a finite number");
        return v.num;
    }
    if (v.type != io::GlbJsonValue::Null && o.has(key)) throw VegetationError("bad_request", "tree " + std::to_string(index) + ": \"" + key + "\" must be a number");
    if (required) throw VegetationError("bad_request", "tree " + std::to_string(index) + ": \"" + key + "\" is required (metres); nothing is assumed");
    return fallback;
}

} // namespace detail

/**
 * Reads a scratchbox.sb-veggie-trees/1 document: {"trees": [{position: [x, y, z], heightM, crownRadiusM | crownRadiiM:
 * [rx, rz], crownBaseHeightM?, crownWidestAt?, crownTopExponent?, trunkRadiusM?, leafLinearRgb?: [r, g, b], label?}],
 * label?}. Height and crown size are required; everything else has a stated default or comes from the species library.
 */
inline std::vector<DescribedTree> parseDescribedTrees(const io::GlbJsonValue& doc) {
    if (doc.type != io::GlbJsonValue::Object || doc["trees"].type != io::GlbJsonValue::Array) throw VegetationError("bad_request", "the tree description has no trees array");
    std::vector<DescribedTree> out;
    size_t i = 0;
    for (const auto& t : doc["trees"].arr) {
        if (t.type != io::GlbJsonValue::Object) throw VegetationError("bad_request", "tree " + std::to_string(i) + " is not an object");
        DescribedTree d;
        const auto& p = t["position"];
        if (p.type == io::GlbJsonValue::Array) {
            if (p.arr.size() != 3 || p[0].type != io::GlbJsonValue::Number || p[1].type != io::GlbJsonValue::Number || p[2].type != io::GlbJsonValue::Number)
                throw VegetationError("bad_request", "tree " + std::to_string(i) + ": \"position\" must be [x, y, z] in metres");
            d.x = p[0].num; d.y = p[1].num; d.z = p[2].num;
        }
        d.heightM = detail::numberField(t, "heightM", 0, true, i);
        const auto& radii = t["crownRadiiM"];
        if (radii.type == io::GlbJsonValue::Array) {
            if (radii.arr.size() != 2 || radii[0].type != io::GlbJsonValue::Number || radii[1].type != io::GlbJsonValue::Number)
                throw VegetationError("bad_request", "tree " + std::to_string(i) + ": \"crownRadiiM\" must be [along x, along z] in metres");
            d.crownRadiusXM = radii[0].num; d.crownRadiusZM = radii[1].num;
        } else {
            d.crownRadiusXM = d.crownRadiusZM = detail::numberField(t, "crownRadiusM", 0, true, i);
        }
        d.crownBaseHeightM = detail::numberField(t, "crownBaseHeightM", std::numeric_limits<double>::quiet_NaN(), false, i);
        d.crownWidestAt = detail::numberField(t, "crownWidestAt", 0.5, false, i);
        d.crownTopExponent = detail::numberField(t, "crownTopExponent", 2.0, false, i);
        d.trunkRadiusM = detail::numberField(t, "trunkRadiusM", std::numeric_limits<double>::quiet_NaN(), false, i);
        const auto& col = t["leafLinearRgb"];
        if (col.type == io::GlbJsonValue::Array) {
            if (col.arr.size() != 3) throw VegetationError("bad_request", "tree " + std::to_string(i) + ": \"leafLinearRgb\" must be [r, g, b] in 0..1");
            for (size_t k = 0; k < 3; ++k) {
                if (col[k].type != io::GlbJsonValue::Number || !(col[k].num >= 0 && col[k].num <= 1)) throw VegetationError("bad_request", "tree " + std::to_string(i) + ": \"leafLinearRgb\" must be [r, g, b] in 0..1");
                d.leafLinearRgb[k] = col[k].num;
            }
            d.leafColourKnown = true;
        }
        if (t["label"].type == io::GlbJsonValue::String) d.label = t["label"].str.substr(0, 200);
        const std::string at = "tree " + std::to_string(i) + ": ";
        if (!(d.heightM > 0.3)) throw VegetationError("bad_request", at + "\"heightM\" must be more than 0.3 m");
        if (!(d.crownRadiusXM > 0.1) || !(d.crownRadiusZM > 0.1)) throw VegetationError("bad_request", at + "the crown radii must be more than 0.1 m");
        if (std::isfinite(d.crownBaseHeightM) && !(d.crownBaseHeightM >= 0 && d.crownBaseHeightM < 0.95 * d.heightM))
            throw VegetationError("bad_request", at + "\"crownBaseHeightM\" must be at least 0 and below 0.95 of the height");
        if (!(d.crownWidestAt >= 0 && d.crownWidestAt <= 0.9)) throw VegetationError("bad_request", at + "\"crownWidestAt\" must be in [0, 0.9]");
        if (!(d.crownTopExponent >= 0.5 && d.crownTopExponent <= 8)) throw VegetationError("bad_request", at + "\"crownTopExponent\" must be in [0.5, 8]");
        if (std::isfinite(d.trunkRadiusM) && !(d.trunkRadiusM > 0 && d.trunkRadiusM < 0.2 * d.heightM)) throw VegetationError("bad_request", at + "\"trunkRadiusM\" must be more than 0 and under 0.2 of the height");
        out.push_back(d);
        ++i;
    }
    if (out.empty()) throw VegetationError("bad_request", "the tree description has no trees");
    return out;
}

/** The crown base ratio a description implies for its crown samples (the given base, else the growth default for sampling only). */
inline double describedCrownBaseRatio(const DescribedTree& d) {
    return std::isfinite(d.crownBaseHeightM) ? d.crownBaseHeightM / d.heightM : 0.35;
}

/**
 * The crowns.json (strip's format) of described trees: per tree its upper crown surface sampled on a grid (step about a
 * twelfth of the smaller crown radius), its 16 sector radii (sector k centred at -pi + (k + 0.5) 2 pi / 16 from +x towards
 * +z, as strip measures them), its stem and support, origin "described", and the given crown base and trunk ratio when
 * the description has them.
 */
inline std::string describedCrownsJson(const std::vector<DescribedTree>& trees, const std::string& label = std::string()) {
    double spacing = 0.7;
    for (const auto& d : trees) {
        const double depth = d.heightM * (1.0 - describedCrownBaseRatio(d));
        spacing = std::min(spacing, std::min({d.crownRadiusXM, d.crownRadiusZM, depth}) / 4.0);
    }
    spacing = std::clamp(spacing, 0.2, 0.7);
    std::ostringstream s;
    s << "{\"version\":1,\"frame\":null,\"origin\":\"described\"";
    if (!label.empty()) s << ",\"label\":" << json::str(label);
    s << ",\"params\":{\"sampleSpacing\":" << json::numPrecise(spacing) << "},\"crowns\":[";
    for (size_t i = 0; i < trees.size(); ++i) {
        const DescribedTree& d = trees[i];
        const double rx = d.crownRadiusXM, rz = d.crownRadiusZM;
        const double base = d.y + describedCrownBaseRatio(d) * d.heightM;
        const double top = d.y + d.heightM;
        const double widest = base + d.crownWidestAt * (top - base);
        const double n = d.crownTopExponent;
        const double step = std::clamp(std::min(rx, rz) / 12.0, 0.12, 0.6);
        s << (i ? "," : "") << "{\"id\":" << i << ",\"status\":\"tree\",\"origin\":\"described\"";
        if (!d.label.empty()) s << ",\"label\":" << json::str(d.label);
        s << ",\"apex\":[" << json::numPrecise(d.x) << "," << json::numPrecise(top) << "," << json::numPrecise(d.z) << "]"
          << ",\"stem\":[" << json::numPrecise(d.x) << "," << json::numPrecise(d.z) << "],\"supportY\":" << json::numPrecise(d.y)
          << ",\"supportSource\":\"given\",\"terrainY\":" << json::numPrecise(d.y) << ",\"apexAboveSupport\":" << json::numPrecise(d.heightM)
          << ",\"areaM2\":" << json::numPrecise(M_PI * rx * rz);
        if (std::isfinite(d.crownBaseHeightM)) s << ",\"crownBaseRatio\":" << json::numPrecise(d.crownBaseHeightM / d.heightM);
        if (std::isfinite(d.trunkRadiusM)) s << ",\"trunkRadiusPerHeight\":" << json::numPrecise(d.trunkRadiusM / d.heightM);
        if (d.leafColourKnown) s << ",\"colour\":{\"meanLinearRgb\":[" << json::numPrecise(d.leafLinearRgb[0]) << "," << json::numPrecise(d.leafLinearRgb[1]) << "," << json::numPrecise(d.leafLinearRgb[2]) << "],\"provenance\":\"described\"}";
        s << ",\"sectorRadii\":[";
        for (int k = 0; k < 16; ++k) {
            const double a = -M_PI + (k + 0.5) * (2.0 * M_PI / 16.0);
            const double r = 1.0 / std::sqrt(std::pow(std::cos(a) / rx, 2) + std::pow(std::sin(a) / rz, 2));
            s << (k ? "," : "") << json::numPrecise(r);
        }
        s << "],\"samples\":[";
        bool first = true;
        for (double dx = -rx; dx <= rx + 1e-9; dx += step) {
            for (double dz = -rz; dz <= rz + 1e-9; dz += step) {
                const double u2 = (dx * dx) / (rx * rx) + (dz * dz) / (rz * rz);
                if (u2 > 1.0) continue;
                const double u = std::sqrt(u2);
                const double h = std::pow(std::max(0.0, 1.0 - std::pow(u, n)), 1.0 / n);
                const double y = widest + (top - widest) * h;
                s << (first ? "" : ",") << "[" << json::num(d.x + dx) << "," << json::num(y) << "," << json::num(d.z + dz) << "]";
                first = false;
            }
        }
        s << "]}";
    }
    s << "]}";
    return s.str();
}

/** How described trees are grown and written. */
struct GroveOptions {
    double triangleBudget{0};                  // the caller's own total (> 0), or
    double sceneTriangleCap{1500000};          // each tree's own budget from its crown, within this cap (tile-vegetation-service.ts SCENE_TREE_TRIANGLE_CAP)
    uint64_t seed{0};
    std::string speciesIndexPath, speciesIndexLabel;   // the tree species library (empty: none)
    std::string textureIndexPath, textureIndexLabel;   // the tree texture library (empty: none)
    bool lod{true};
    bool quantize{true};
    bool reveal{true};
    double psiSeason{1.0};
    double latAbsDeg{std::numeric_limits<double>::quiet_NaN()};
    // A described crown is not a scan to match: a tree whose leaves fill this share of it is planted (the scan's 0.9 is for
    // deciding which measured crowns to remove); what it fills is its provenance confidence.
    double minSurfaceReached{0.75};
    std::string stageKey;
    std::string label;
};

struct GroveResult {
    std::vector<uint8_t> glb;
    std::string crownsJson;
    std::string statsJson;
};

namespace detail {

inline std::string readTextFile(const std::string& path, const char* what) {
    std::ifstream f(path, std::ios::binary);
    if (!f) throw VegetationError("not_found", std::string("cannot read the ") + what + " " + path);
    std::ostringstream s;
    s << f.rdbuf();
    return s.str();
}

} // namespace detail

/** Grows described trees with the staged location's planting (plant + writeTreesGlb) and returns the trees GLB. */
inline GroveResult growDescribedTrees(const std::vector<DescribedTree>& trees, const GroveOptions& o) {
    GroveResult out;
    out.crownsJson = describedCrownsJson(trees, o.label);
    const io::GlbJsonValue doc = json::parse(out.crownsJson);
    PlantParams P;
    if (o.triangleBudget > 0) P.triangleBudget = o.triangleBudget;
    else if (o.sceneTriangleCap > 0) P.sceneTriangleCap = o.sceneTriangleCap;
    else throw VegetationError("bad_request", "growing trees needs a triangle budget or a scene triangle cap greater than 0");
    P.growth.seed = o.seed;
    P.growth.minSurfaceReached = std::clamp(o.minSurfaceReached, 0.0, 1.0);
    P.growth.latAbsDeg = o.latAbsDeg;
    P.lod = o.lod;
    P.quantize = o.quantize;
    P.reveal = o.reveal;
    P.psiSeason = std::clamp(o.psiSeason, 0.0, 1.0);
    P.stageKey = o.stageKey;
    if (!o.speciesIndexPath.empty()) {
        try {
            P.growth.species = std::make_shared<const tree_species::Library>(tree_species::parseIndex(detail::readTextFile(o.speciesIndexPath, "tree species library")));
        } catch (const tree_species::SpeciesIndexError& e) {
            throw VegetationError("bad_input", std::string("the tree species library: ") + e.what());
        }
        P.growth.speciesIndex = o.speciesIndexLabel.empty() ? o.speciesIndexPath : o.speciesIndexLabel;
    }
    if (!o.textureIndexPath.empty()) {
        try {
            P.textures = std::make_shared<const tree_textures::Library>(tree_textures::parseIndex(detail::readTextFile(o.textureIndexPath, "tree texture library")));
        } catch (const tree_textures::TextureIndexError& e) {
            throw VegetationError("bad_input", std::string("the tree texture library: ") + e.what());
        }
        P.textureIndex = o.textureIndexLabel.empty() ? o.textureIndexPath : o.textureIndexLabel;
    }
    const PlantResult r = plant(doc, P);
    out.glb = writeTreesGlb(r, doc, P);
    std::ostringstream s;
    s << "{\"ok\":true,\"generator\":\"SB-Veggie (space colonisation, tile_vegetation plant)\",\"trees\":" << r.trees.size() << ",\"triangles\":" << r.triangles
      << ",\"triangleBudget\":" << static_cast<size_t>(r.triangleBudget) << ",\"shortOfCrown\":" << r.shortOfCrown
      << ",\"species\":" << (P.growth.species ? json::str(P.growth.speciesIndex) : std::string("null"))
      << ",\"textures\":" << (P.textures ? json::str(P.textureIndex) : std::string("null")) << ",\"perTree\":[";
    for (size_t i = 0; i < r.trees.size(); ++i) {
        const auto& t = r.trees[i];
        Vec3 lo(1e30f, 1e30f, 1e30f), hi(-1e30f, -1e30f, -1e30f);
        for (const geometry::Mesh* m : {t.hasLod ? &t.lod.wood : &t.wood, &t.foliage}) {
            for (const auto& v : m->vertices) {
                lo.x = std::min(lo.x, v.x); lo.y = std::min(lo.y, v.y); lo.z = std::min(lo.z, v.z);
                hi.x = std::max(hi.x, v.x); hi.y = std::max(hi.y, v.y); hi.z = std::max(hi.z, v.z);
            }
        }
        s << (i ? "," : "") << "{\"crownId\":" << t.crownId << ",\"heightAboveSupportM\":" << json::num(t.heightAboveSupport)
          << ",\"crownSurfaceReached\":" << json::num(t.leaves.share()) << ",\"crownBaseRatio\":" << json::num(t.crownBaseRatio)
          << ",\"trunkRadiusM\":" << json::num(t.trunkRadius) << ",\"stems\":" << t.stems
          << ",\"triangles\":" << (t.wood.indices.size() + t.foliage.indices.size()) / 3;
        if (t.hasLod) s << ",\"lod\":{\"woodTriangles\":" << t.lod.woodTriangles << ",\"farLevelTriangles\":" << t.lod.drawnFar(t.foliage.indices.size() / 3) << "}";
        if (t.hasSpecies && t.species.matched && P.growth.species) {
            const auto& e = P.growth.species->entries[t.species.entry];
            s << ",\"species\":{\"entry\":" << json::str(e.id) << ",\"label\":" << json::str(e.label) << ",\"cost\":" << json::num(t.species.cost) << "}";
        } else if (t.hasSpecies) {
            s << ",\"species\":null";
        }
        if (!t.shortOfCrown.empty()) s << ",\"shortOfCrown\":" << json::str(t.shortOfCrown);
        s << ",\"bounds\":[[" << json::num(lo.x) << "," << json::num(lo.y) << "," << json::num(lo.z) << "],[" << json::num(hi.x) << "," << json::num(hi.y) << "," << json::num(hi.z) << "]]}";
    }
    s << "]}";
    out.statsJson = s.str();
    return out;
}

} // namespace tile_vegetation
} // namespace scratchbox

#endif // SCRATCHBOX_SB_VEGGIE_GROVE_HPP
