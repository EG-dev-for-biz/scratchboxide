/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_TREE_LOD_HPP
#define SCRATCHBOX_TREE_LOD_HPP

/**
 * Level-of-detail trees on one skeleton.
 *
 * A tree grown into a measured crown (space colonisation, scratchbox_nature.hpp) is drawn at four levels:
 *
 *   level 0 (near)      its wood (the whole triangle budget), the twigs the budget prunes as instances of one tapered tube,
 *                       and leaves as instances of shared SB-Veggie leaf clusters (scratchbox_sb_veggie.hpp
 *                       SbVeggieFoliage::buildCluster): real blade sizes, scaled from the tree's height.
 *   level 1 (near-mid)  the same wood without the twigs, the same cluster positions, a share of each cluster's leaves
 *                       (nearMidLeafCountShare) with the near blade outline, each larger so the cluster keeps its leaf
 *                       area (about 0.3 of the level-0 triangles).
 *   level 2 (mid)       the same wood, the same cluster positions, fewer larger leaves per cluster as coarse cards (about
 *                       one eighth of the level-0 triangles); no twigs.
 *   level 3 (far)       the blob masses the budgeted meshing already builds on the same skeleton (nature::meshWithinBudget),
 *                       over its own wood: the trunk and main limbs only, a few hundred triangles (farWoodBudgetFor), which a
 *                       viewer shows through the holes it opens in the masses.
 *
 * In this file's types `level1` is the mid level (2 in the GLB) and `nearMid` the near-mid level (1 in the GLB).
 *
 * Everything here is a continuous quantity: leaf length follows the crown's height, leaf density follows how far a
 * station lies below the measured canopy surface, the clusters' orientation follows the shoot and the crown's outward
 * direction. Nothing branches on a name, and nothing is random: every choice is a hash of (tree seed, node id, salt), so
 * a tree is the same bytes at any thread count.
 *
 * What is measured, and what is not: the delivered leaf triangles of each level are compared with the crown surface the
 * tiles measured (the share of samples within a distance of a leaf triangle). The leaves themselves, their sizes and
 * their number are not measured; only the skeleton they hang from is grown into the measured crown.
 *
 * Fill: each level's projected coverage of the measured crown (orthographic views from outside; CoverageReport) is
 * measured, and a crown short of its target (LodParams coverage*, Beer-Lambert from a leaf area index, scaled by the
 * crown's season cue: its measured green share, else its hue and chroma) gets clusters on the outer shell of its envelope
 * where the views see the most of it uncovered, then a layer deeper. A crown whose colour says leafless keeps few or no
 * leaves (its stations are thinned by the same cue).
 */

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_nature.hpp"
#include "scratchbox_sb_veggie.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <chrono>
#include <cstdint>
#include <limits>
#include <string>
#include <unordered_map>
#include <vector>

namespace scratchbox {
namespace tree_lod {

using math::Quat;
using math::Vec2;
using math::Vec3;
using math::Vec4;
namespace nat = scratchbox::nature;
namespace sv = scratchbox::sb_veggie;

// ================================================================================================
// small helpers (the hashes are the ones tile_vegetation has always used: its seeds stay what they were)
// ================================================================================================

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

/** Distance from p to triangle abc (closest point, Ericson). */
inline double pointTriangleDistance(const Vec3& p, const Vec3& a, const Vec3& b, const Vec3& c) {
    const Vec3 ab = b - a, ac = c - a, ap = p - a;
    const float d1 = ab.dot(ap), d2 = ac.dot(ap);
    if (d1 <= 0 && d2 <= 0) return (p - a).length();
    const Vec3 bp = p - b;
    const float d3 = ab.dot(bp), d4 = ac.dot(bp);
    if (d3 >= 0 && d4 <= d3) return (p - b).length();
    const float vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) return (p - (a + ab * (d1 / (d1 - d3)))).length();
    const Vec3 cp = p - c;
    const float d5 = ab.dot(cp), d6 = ac.dot(cp);
    if (d6 >= 0 && d5 <= d6) return (p - c).length();
    const float vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) return (p - (a + ac * (d2 / (d2 - d6)))).length();
    const float va = d3 * d6 - d5 * d4;
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) return (p - (b + (c - b) * ((d4 - d3) / ((d4 - d3) + (d5 - d6))))).length();
    const float den = 1.0f / (va + vb + vc);
    return (p - (a + ab * (vb * den) + ac * (vc * den))).length();
}

inline Quat quatFromBasis(const Vec3& X, const Vec3& Y, const Vec3& Z) {
    const float m00 = X.x, m01 = Y.x, m02 = Z.x, m10 = X.y, m11 = Y.y, m12 = Z.y, m20 = X.z, m21 = Y.z, m22 = Z.z;
    const float tr = m00 + m11 + m22;
    Quat q;
    if (tr > 0) {
        const float s = std::sqrt(tr + 1.0f) * 2.0f;
        q.w = 0.25f * s; q.x = (m21 - m12) / s; q.y = (m02 - m20) / s; q.z = (m10 - m01) / s;
    } else if (m00 > m11 && m00 > m22) {
        const float s = std::sqrt(1.0f + m00 - m11 - m22) * 2.0f;
        q.w = (m21 - m12) / s; q.x = 0.25f * s; q.y = (m01 + m10) / s; q.z = (m02 + m20) / s;
    } else if (m11 > m22) {
        const float s = std::sqrt(1.0f + m11 - m00 - m22) * 2.0f;
        q.w = (m02 - m20) / s; q.x = (m01 + m10) / s; q.y = 0.25f * s; q.z = (m12 + m21) / s;
    } else {
        const float s = std::sqrt(1.0f + m22 - m00 - m11) * 2.0f;
        q.w = (m10 - m01) / s; q.x = (m02 + m20) / s; q.y = (m12 + m21) / s; q.z = 0.25f * s;
    }
    return q.normalized();
}

/** Rotation taking +Z to `f` with +Y as close to `upRef` as it can be. */
inline Quat frameAlong(Vec3 f, Vec3 upRef) {
    f = f.normalized();
    Vec3 y = upRef - f * f.dot(upRef);
    if (y.lengthSquared() < 1e-6f) y = Vec3(1, 0, 0) - f * f.x;
    y = y.normalized();
    const Vec3 x = y.cross(f).normalized();
    return quatFromBasis(x, y, f);
}

// ================================================================================================
// parameters
// ================================================================================================

/** Every quantity that shapes a tree's levels. All continuous (counts are resolutions); none names a kind of tree. */
struct LodParams {
    /** 0 bare .. 1 full summer: the share of leaf stations that carry leaves (and, in the far level, of its blob foliage). */
    double psiSeason{1.0};
    // blade length = clamp(ratio * crown height, min, max): real blades are 7-13 cm, so the crown's height sets it within that
    double leafSizeRatioToCrownHeight{0.0065};
    double leafMinM{0.08};
    double leafMaxM{0.14};
    double referenceLeafM{0.11};         // blade length the library clusters are built at (instances scale from it)
    // leaf clusters
    double clusterRadiusPerLeaf{7.0};    // reach of a cluster's sub-shoot spray, in blade lengths
    // at the densest class (a summer crown seen from the side is nearly closed: leaf area index 3-5). Fewer leaves a cluster
    // at a closer spacing cover more of the crown for the same triangles than dense balls of leaves far apart.
    double leavesPerCluster{100};
    double cupping{1.0};
    int densityClasses{3};               // resolution of the density axis of the shared clusters
    double densityFalloff{0.6};          // leaves of class c = leavesPerCluster * falloff^c
    double shellDepthPerHeight{0.10};    // leaf density falls as exp(-d / (this * crown height)) with d the distance below the measured canopy surface
    double shootletRadiusM{0.010};
    int bladeRowsLevel0{1};
    int bladeRowsLevel1{0};
    double level1LeafCountShare{0.25};   // level 1 holds this share of a cluster's leaves, each larger
    // The leaf area of level 1 per cluster, as a multiple of level 0's. Past a few tens of metres a viewer sees the crown as
    // a mass whose opacity is the leaf cover, not single blades, and level 1 hands over to the solid far masses: a little more
    // cover keeps that handover (dithered over a wide band) from changing the tree's weight. The coarse card's leaf covers
    // part of it (a kite, a cut-out leaf) and the blades of one cluster overlap, so at 2.6 the mid level's projected coverage
    // reaches about the target at full leaf (0.83 median over 1,043 measured crowns) for no more triangles.
    double level1AreaGain{2.6};
    // The near-mid level (between near and mid): this share of a cluster's leaves, with the near blade outline (rows) and no
    // petioles or sub-shoots, each scaled so the cluster's leaf area is nearMidAreaGain times the near level's (1.7: from
    // 25-60 m a crown's cover, not its single leaves, is what reads; the near-mid cover is 0.74 median, the near one 0.58).
    double nearMidLeafCountShare{0.35};
    double nearMidAreaGain{1.7};
    int bladeRowsNearMid{1};
    // The crown's lobes (a smooth union of spheres a viewer shades the leaves with): the placed clusters are grouped into
    // lobes of about crownLobeRadiusM (at most crownLobeMax of them, at least one); a lobe's radius covers the
    // crownLobeCoverQuantile of its clusters' hull points; the smooth-min blend radius is crownLobeBlendPerRadius times the
    // mean lobe radius.
    int crownLobeMax{8};
    double crownLobeRadiusM{2.5};
    double crownLobeCoverQuantile{0.85};
    double crownLobeBlendPerRadius{0.5};
    // stations
    double spacingRatio{0.4};            // distance between clusters / cluster reach
    double outwardBlend{0.45};           // cluster axis: the shoot's direction blended towards the crown's outward direction
    double upBias{0.25};
    double rollJitterRad{0.6};
    double sizeJitter{0.3};
    double minFitScale{0.5};             // a cluster shrunk to fit the crown never goes below this share of its size
    double minFill{0.95};                 // share of the measured surface the delivered leaves must reach (within the tree's reach radius)
    double strictReachM{1.0};            // reported: the share reached within this distance
    int supportDirections{48};          // directions the cluster's hull is sampled in, for fitting it into the crown
    // twigs (the wood the budget prunes): tapered tubes, instanced. A segment takes the unit tube whose taper (end radius /
    // start radius) is nearest its own, so a tip tapers towards the shoots of the cluster at its end and a limb barely tapers.
    int twigSides{6};
    std::array<double, 3> twigTapers{0.3, 0.6, 0.85};
    double twigMinRadiusM{0.004};        // a drawn twig is at least this thick
    double twigMergeTolerance{2.5};      // consecutive pruned segments of a chain are one tube while the nodes between lie within this many radii of the line
    // The far level's wood: the trunk and main limbs only (the thickest segments, the budgeted meshing's radius pruning),
    // within clamp(farWoodTrianglesPerHeightM x tree height, farWoodMinTriangles, farWoodMaxTriangles) triangles, so a
    // viewer that opens holes in the far blob masses shows structure inside the crown for a few hundred triangles.
    double farWoodTrianglesPerHeightM{24.0};
    double farWoodMinTriangles{160};
    double farWoodMaxTriangles{600};
    // Projected coverage: the share of a crown's envelope its leaves cover, seen from outside (detail::CoverageViews). A
    // tree is filled toward a target 1 - exp(-coverageProjection x coverageLeafAreaIndex x leafiness): Beer-Lambert gap
    // fraction through a crown of that leaf area index with a spherical leaf angle distribution (G = 0.5). Summer crowns
    // of broadleaf trees hold a leaf area index of about 3-6; 4.6 gives a target of 0.90 at full leaf (a crown seen from the
    // side lets about a tenth of the sky through), 0.68 at half leaf, 0 when bare. Clusters go to the envelope's outer
    // shell first (inset shellInsetPerReach cluster reaches), then a layer deeper, at most coverageMaxFillShare of the
    // tree's stations more. The coverage grid's cell is coverageCellPerLeaf blade lengths (never more than 512 cells across).
    bool coverageFill{true};
    double coverageLeafAreaIndex{4.6};
    double coverageProjection{0.5};
    double coverageMaxFillShare{0.8};
    double shellInsetPerReach{0.45};
    double coverageCellPerLeaf{0.6};
    double textureLeafStretch{2.0};              // the viewer's leaf stretch (tree-texture-library.ts DEFAULT_LEAF_STRETCH), for the cut-out estimate
    // The season cue a crown's measured colour gives (tile_vegetation crowns.json colour): leafiness rises from 0 to 1 as
    // the share of its cells that pass the green-vegetation test rises from seasonGreenBare to seasonGreenFull; with no
    // judged cells, as the mean's chroma rises from seasonChromaBare to seasonChromaFull, weighted by how green its hue is
    // (full between seasonHueGreen[1] and seasonHueGreen[2] degrees, none below [0] or above [3]). Unknown colour: 1.
    double seasonGreenBare{0.05}, seasonGreenFull{0.45};
    double seasonChromaBare{0.06}, seasonChromaFull{0.25};
    std::array<double, 4> seasonHueGreen{40, 70, 165, 200};
    sv::SbVeggieMorphology morphology;
};

/** Triangles the far level's wood (trunk and main limbs) is meshed within, for a tree `heightM` tall. */
inline size_t farWoodBudgetFor(const LodParams& P, double heightM) {
    return static_cast<size_t>(std::ceil(std::clamp(P.farWoodTrianglesPerHeightM * std::max(0.0, heightM), P.farWoodMinTriangles, std::max(P.farWoodMinTriangles, P.farWoodMaxTriangles))));
}

/** Blade length of a tree: scales with the crown's height within the real range of leaf sizes. */
inline double leafLengthFor(const LodParams& P, double crownHeightM) {
    return std::clamp(P.leafSizeRatioToCrownHeight * crownHeightM, P.leafMinM, P.leafMaxM);
}

// ================================================================================================
// the shared library: leaf clusters (levels 0 and 1) and the twig tube
// ================================================================================================

struct LibraryMesh {
    std::string name;
    std::vector<Vec3> positions, normals;
    std::vector<Vec2> uvs;               // TEXCOORD_0: a cluster's blade coordinates (SbVeggieClusterMesh::uvs), a twig's bark coordinates
    std::vector<std::array<float, 2>> leaf;  // `_LEAF` on cluster meshes (SbVeggieClusterMesh::leaf); empty on twigs
    std::vector<uint32_t> indices;
    std::vector<uint32_t> bladeFront;    // upper-side blade triangles alone (the surface a leaf measurement uses)
    std::vector<Vec3> support;           // hull points for fitting into a crown
    int leaves{0};
    double reach{0};
    // what a measurement of the leaves compares with the crown surface, in the mesh's own frame: the blades' upper-side
    // triangles (own vertices), their bounding spheres per blade, and the sphere around all of them
    struct Sphere { Vec3 c; float r{0}; uint32_t first{0}, count{0}; };
    std::vector<Vec3> bladePos;
    std::vector<uint32_t> bladeTri;      // 3 per triangle, into bladePos
    std::vector<Vec2> bladeUv;           // the blade's own coordinates at each bladePos (u = 0.5 + across / length, v = along / length)
    std::vector<Sphere> leafSpheres;     // `first`, `count`: triangles of bladeTri
    Vec3 bladeCentre;
    float bladeRadius{0};
    double bladeArea{0};                 // area of the blades' upper sides, m^2 (what a level's leaf cover is matched on)
    size_t triangles() const { return indices.size() / 3; }
};

/** One shared cluster: its near, near-mid and mid meshes (same attachment, same reach). */
struct ClusterVariant {
    std::string name;                    // base name; the mid mesh is name + "_mid", the near-mid one name + "_nearmid"
    LibraryMesh level0, level1, nearMid;
    int densityClass{0};
    bool terminal{true};
};

struct ClusterLibrary {
    LodParams params;
    std::vector<ClusterVariant> variants;
    std::vector<LibraryMesh> twigs;      // unit tubes, one per taper (LodParams::twigTapers)
    size_t twigTriangles() const { return twigs.empty() ? 0 : twigs.front().triangles(); }
};

namespace detail {

inline LibraryMesh fromCluster(const std::string& name, const sv::SbVeggieClusterMesh& c) {
    LibraryMesh m;
    m.name = name;
    m.positions = c.positions;
    m.normals = c.normals;
    m.uvs = c.uvs;
    m.leaf = c.leaf;
    m.indices = c.indices;
    m.bladeFront = c.bladeFrontIndices;
    m.support = c.support;
    m.leaves = c.leaves;
    m.reach = c.reach;
    // the blades' upper sides, compacted: own vertices, per-blade bounding spheres, one sphere around all
    std::unordered_map<uint32_t, uint32_t> remap;
    for (uint32_t idx : c.bladeFrontIndices) {
        auto it = remap.find(idx);
        if (it == remap.end()) {
            it = remap.emplace(idx, static_cast<uint32_t>(m.bladePos.size())).first;
            m.bladePos.push_back(c.positions[idx]);
            m.bladeUv.push_back(idx < c.uvs.size() ? c.uvs[idx] : Vec2(0.5f, 0.5f));
        }
        m.bladeTri.push_back(it->second);
    }
    const size_t front = m.bladeTri.size() / 3;
    for (size_t t = 0; t < front; ++t) {
        const Vec3& a = m.bladePos[m.bladeTri[t * 3]]; const Vec3& b = m.bladePos[m.bladeTri[t * 3 + 1]]; const Vec3& d = m.bladePos[m.bladeTri[t * 3 + 2]];
        m.bladeArea += 0.5 * (b - a).cross(d - a).length();
    }
    if (front > 0 && c.leaves > 0) {
        const size_t perLeaf = std::max<size_t>(1, front / static_cast<size_t>(c.leaves));
        Vec3 all(0, 0, 0);
        for (const auto& p : m.bladePos) all += p;
        m.bladeCentre = all / static_cast<float>(m.bladePos.size());
        for (const auto& p : m.bladePos) m.bladeRadius = std::max(m.bladeRadius, (p - m.bladeCentre).length());
        for (size_t t = 0; t < front; t += perLeaf) {
            LibraryMesh::Sphere sp;
            sp.first = static_cast<uint32_t>(t);
            sp.count = static_cast<uint32_t>(std::min(perLeaf, front - t));
            Vec3 sum(0, 0, 0);
            for (size_t k = t * 3; k < (t + sp.count) * 3; ++k) sum += m.bladePos[m.bladeTri[k]];
            sp.c = sum / static_cast<float>(sp.count * 3);
            for (size_t k = t * 3; k < (t + sp.count) * 3; ++k) sp.r = std::max(sp.r, (m.bladePos[m.bladeTri[k]] - sp.c).length());
            m.leafSpheres.push_back(sp);
        }
    }
    return m;
}

} // namespace detail

/** The unit twig: a tapered tube from z = 0 (radius 1) to z = 1 (radius `taper`), `sides` around, a flat cap at the tip. */
inline LibraryMesh buildTwigTube(int sides, double taper, const std::string& name) {
    LibraryMesh m;
    m.name = name;
    const int S = std::max(3, sides);
    for (int ring = 0; ring < 2; ++ring) {
        for (int s = 0; s < S; ++s) {
            const float a = math::TWO_PI * s / S;
            const float r = ring ? static_cast<float>(taper) : 1.0f;
            m.positions.push_back(Vec3(std::cos(a) * r, std::sin(a) * r, static_cast<float>(ring)));
            // bark coordinates: a narrow strip of the bark texture (a twig is a few centimetres round), half a tile along
            m.uvs.push_back(Vec2(0.08f * static_cast<float>(s) / static_cast<float>(S), 0.5f * static_cast<float>(ring)));
            // a round section: the normal points out, tilted a little along the taper
            m.normals.push_back(Vec3(std::cos(a), std::sin(a), static_cast<float>(1.0 - taper)).normalized());
        }
    }
    for (int s = 0; s < S; ++s) {
        const uint32_t a0 = s, a1 = (s + 1) % S, b0 = S + s, b1 = S + (s + 1) % S;
        m.indices.insert(m.indices.end(), {static_cast<uint32_t>(a0), static_cast<uint32_t>(a1), static_cast<uint32_t>(b1),
                                           static_cast<uint32_t>(a0), static_cast<uint32_t>(b1), static_cast<uint32_t>(b0)});
    }
    // the tip cap
    const uint32_t centre = static_cast<uint32_t>(m.positions.size());
    m.positions.push_back(Vec3(0, 0, 1));
    m.normals.push_back(Vec3(0, 0, 1));
    m.uvs.push_back(Vec2(0.04f, 0.5f));
    for (int s = 0; s < S; ++s) m.indices.insert(m.indices.end(), {centre, static_cast<uint32_t>(S + s), static_cast<uint32_t>(S + (s + 1) % S)});
    m.reach = 1.0;
    return m;
}

/**
 * The clusters every tree shares: densityClasses x 2 attachments (a tip spray reaches 1.15 x, a lateral one 0.92 x), each at
 * level 0 (full), near-mid (a share of the leaves with the near outline, each larger, no petioles, no sub-shoots) and
 * level 1 (a smaller share, each larger, coarse cards, no petioles, no sub-shoots), plus the twig.
 */
inline ClusterLibrary buildClusterLibrary(const LodParams& P) {
    ClusterLibrary lib;
    lib.params = P;
    int k = 0;
    for (int cls = 0; cls < std::max(1, P.densityClasses); ++cls) {
        for (int attach = 0; attach < 2; ++attach, ++k) {
            const uint64_t seed = 0x5B0C1A57ull + static_cast<uint64_t>(k) * 7919ull;
            const double jitterLeaves = 0.85 + 0.30 * hashUnit(seed, 1, 0);
            const double jitterRadius = 0.88 + 0.24 * hashUnit(seed, 2, 0);
            sv::SbVeggieClusterParams cp;
            cp.leafCount = std::max(3, static_cast<int>(std::lround(P.leavesPerCluster * std::pow(P.densityFalloff, cls) * jitterLeaves)));
            cp.radiusM = static_cast<float>(P.referenceLeafM * P.clusterRadiusPerLeaf * jitterRadius);
            cp.reachScale = attach == 0 ? 1.15f : 0.92f;
            cp.leafLengthM = static_cast<float>(P.referenceLeafM);
            cp.orientationRadiusM = static_cast<float>(2.2 * (0.75 + 0.5 * hashUnit(seed, 3, 0)) * (P.referenceLeafM * P.clusterRadiusPerLeaf / 0.85));
            cp.shootletRadiusM = static_cast<float>(P.shootletRadiusM);
            cp.seed = seed;
            cp.cupping = static_cast<float>(P.cupping * (0.75 + 0.5 * hashUnit(seed, 5, 0)));
            cp.morphology = P.morphology;
            cp.morphology.blade.rows = P.bladeRowsLevel0;
            cp.petioles = true;
            ClusterVariant v;
            v.name = "sb_veggie_leaf_cluster_" + std::to_string(k);
            v.densityClass = cls;
            v.terminal = attach == 0;
            v.level0 = detail::fromCluster(v.name, sv::SbVeggieFoliage::buildCluster(cp, P.supportDirections));
            // level 1: the same attachment and spray, fewer larger leaves
            sv::SbVeggieClusterParams c1 = cp;
            c1.leafCount = std::max(2, static_cast<int>(std::lround(cp.leafCount * P.level1LeafCountShare)));
            c1.leafLengthM = static_cast<float>(cp.leafLengthM * std::sqrt(static_cast<double>(cp.leafCount) / c1.leafCount) * 0.95);
            c1.morphology.blade.rows = P.bladeRowsLevel1;
            c1.morphology.blade.petioleRatio = 0.0f;
            c1.petioles = false;
            c1.shootletRadiusM = 0.0f;
            v.level1 = detail::fromCluster(v.name + "_mid", sv::SbVeggieFoliage::buildCluster(c1, P.supportDirections));
            // the mid level covers the same leaf area as the near one: blade outlines differ (the near blade is a fine ovate
            // outline, the mid one a coarse card), so rescale the mid blades until their summed area is level1AreaGain times the near level's
            for (int pass = 0; pass < 3 && v.level1.bladeArea > 0 && v.level0.bladeArea > 0; ++pass) {
                const double ratio = P.level1AreaGain * v.level0.bladeArea / v.level1.bladeArea;
                if (std::abs(ratio - 1.0) < 0.02) break;
                c1.leafLengthM = static_cast<float>(c1.leafLengthM * std::sqrt(ratio));
                v.level1 = detail::fromCluster(v.name + "_mid", sv::SbVeggieFoliage::buildCluster(c1, P.supportDirections));
            }
            // near-mid: the near outline, a share of the leaves, each larger, rescaled to the near level's leaf area times nearMidAreaGain
            sv::SbVeggieClusterParams cn = cp;
            const double nmShare = std::clamp(P.nearMidLeafCountShare, 0.05, 1.0);
            cn.leafCount = std::max(2, static_cast<int>(std::lround(cp.leafCount * nmShare)));
            cn.leafLengthM = static_cast<float>(cp.leafLengthM * std::sqrt(static_cast<double>(cp.leafCount) / cn.leafCount));
            cn.morphology.blade.rows = P.bladeRowsNearMid;
            cn.morphology.blade.petioleRatio = 0.0f;
            cn.petioles = false;
            cn.shootletRadiusM = 0.0f;
            v.nearMid = detail::fromCluster(v.name + "_nearmid", sv::SbVeggieFoliage::buildCluster(cn, P.supportDirections));
            for (int pass = 0; pass < 3 && v.nearMid.bladeArea > 0 && v.level0.bladeArea > 0; ++pass) {
                const double ratio = P.nearMidAreaGain * v.level0.bladeArea / v.nearMid.bladeArea;
                if (std::abs(ratio - 1.0) < 0.02) break;
                cn.leafLengthM = static_cast<float>(cn.leafLengthM * std::sqrt(ratio));
                v.nearMid = detail::fromCluster(v.name + "_nearmid", sv::SbVeggieFoliage::buildCluster(cn, P.supportDirections));
            }
            lib.variants.push_back(std::move(v));
        }
    }
    for (size_t k = 0; k < P.twigTapers.size(); ++k) lib.twigs.push_back(buildTwigTube(P.twigSides, P.twigTapers[k], "sb_veggie_twig_" + std::to_string(k)));
    return lib;
}

// ================================================================================================
// the crown envelope: the soft shape whose normals a viewer gives the leaves
// ================================================================================================

/**
 * An ellipsoid around a tree's delivered leaves, in the frame the leaves are in: centre, three semi-axes (radii[0] along
 * the horizontal axis at yawRad from +x toward +z, radii[1] vertical, radii[2] the other horizontal axis). A viewer
 * shades the leaves with its normals (the gradient of the ellipsoid), so the crown reads as one soft volume.
 */
struct CrownEllipsoid {
    Vec3 centre;
    std::array<double, 3> radii{0, 0, 0};
    double yawRad{0};
    size_t points{0};
    bool valid() const { return points > 0 && radii[0] > 0 && radii[1] > 0 && radii[2] > 0; }
};

/**
 * Fits a crown ellipsoid to points on the leaves (e.g. the hull points of every placed leaf cluster). The horizontal axes
 * are the principal axes of the points' horizontal spread; along each axis the ellipsoid spans the `trim` and
 * 1 - `trim` quantiles of the points (so a stray cluster does not inflate the crown), centred between them (so a crown
 * leaning off its stem has its centre where its leaves are). Radii never fall below `minRadius`.
 */
inline CrownEllipsoid fitCrownEllipsoid(const std::vector<Vec3>& pts, double trim = 0.02, double minRadius = 0.25) {
    CrownEllipsoid e;
    if (pts.empty()) return e;
    // the horizontal axes from the points near the crown: those within three median distances of the median point (a
    // stray cluster far off would otherwise turn the axes toward itself)
    const auto median = [](std::vector<double> v) {
        const size_t h = v.size() / 2;
        std::nth_element(v.begin(), v.begin() + static_cast<std::ptrdiff_t>(h), v.end());
        return v[h];
    };
    std::vector<double> xs, zs;
    xs.reserve(pts.size()); zs.reserve(pts.size());
    for (const auto& p : pts) { xs.push_back(p.x); zs.push_back(p.z); }
    const double medX = median(xs), medZ = median(zs);
    std::vector<double> dist;
    dist.reserve(pts.size());
    for (const auto& p : pts) dist.push_back(std::hypot(p.x - medX, p.z - medZ));
    const double keep = 3.0 * std::max(1e-6, median(dist));
    double mx = 0, mz = 0, kept = 0;
    for (size_t i = 0; i < pts.size(); ++i) if (dist[i] <= keep) { mx += pts[i].x; mz += pts[i].z; kept += 1; }
    mx /= kept;
    mz /= kept;
    double cxx = 0, cxz = 0, czz = 0;
    for (size_t i = 0; i < pts.size(); ++i) {
        if (dist[i] > keep) continue;
        const double dx = pts[i].x - mx, dz = pts[i].z - mz;
        cxx += dx * dx; cxz += dx * dz; czz += dz * dz;
    }
    // principal horizontal axis (angle from +x toward +z); a round crown keeps yaw 0
    const double yaw = (std::abs(cxz) < 1e-12 && std::abs(cxx - czz) < 1e-12) ? 0.0 : 0.5 * std::atan2(2.0 * cxz, cxx - czz);
    const double cy = std::cos(yaw), sy = std::sin(yaw);
    std::array<std::vector<double>, 3> along;
    for (auto& a : along) a.reserve(pts.size());
    for (const auto& p : pts) {
        const double dx = p.x - mx, dz = p.z - mz;
        along[0].push_back(dx * cy + dz * sy);
        along[1].push_back(p.y);
        along[2].push_back(-dx * sy + dz * cy);
    }
    const double t = std::clamp(trim, 0.0, 0.49);
    std::array<double, 3> mid{};
    for (int a = 0; a < 3; ++a) {
        auto& v = along[static_cast<size_t>(a)];
        std::sort(v.begin(), v.end());
        const auto at = [&](double q) {
            const double f = q * static_cast<double>(v.size() - 1);
            const size_t i = static_cast<size_t>(std::floor(f));
            const size_t j = std::min(v.size() - 1, i + 1);
            return v[i] + (v[j] - v[i]) * (f - static_cast<double>(i));
        };
        const double lo = at(t), hi = at(1.0 - t);
        mid[static_cast<size_t>(a)] = 0.5 * (lo + hi);
        e.radii[static_cast<size_t>(a)] = std::max(minRadius, 0.5 * (hi - lo));
    }
    e.centre = Vec3(static_cast<float>(mx + mid[0] * cy - mid[2] * sy), static_cast<float>(mid[1]), static_cast<float>(mz + mid[0] * sy + mid[2] * cy));
    e.yawRad = yaw;
    e.points = pts.size();
    return e;
}

// ================================================================================================
// one tree
// ================================================================================================

/** One placed copy of a library mesh. `order` is the growth order (0..1) of the skeleton node it hangs from. */
struct Instance {
    Vec3 t;
    Quat q;
    Vec3 s;
    float order{0};
};

// ================================================================================================
// projected leaf coverage: how much of a crown's envelope its leaves cover, seen from outside
// ================================================================================================

/** 0 bare .. 1 full leaf, from a crown's measured colour (LodParams season cue); NaN arguments are unknown. */
inline double seasonLeafiness(const LodParams& P, double greenShare, double hueDeg, double chroma) {
    auto ramp = [](double a, double b, double x) { const double t = std::clamp((x - a) / std::max(1e-9, b - a), 0.0, 1.0); return t * t * (3 - 2 * t); };
    if (std::isfinite(greenShare)) return ramp(P.seasonGreenBare, P.seasonGreenFull, greenShare);
    if (std::isfinite(chroma) && std::isfinite(hueDeg) && chroma > 0) {
        const auto& h = P.seasonHueGreen;
        const double hueW = ramp(h[0], h[1], hueDeg) * (1.0 - ramp(h[2], h[3], hueDeg));
        return ramp(P.seasonChromaBare, P.seasonChromaFull, chroma) * hueW;
    }
    return 1.0;
}

/** The projected coverage a crown is filled toward at `leafiness` (0 .. 1). */
inline double coverageTarget(const LodParams& P, double leafiness) {
    return 1.0 - std::exp(-std::max(0.0, P.coverageProjection) * std::max(0.0, P.coverageLeafAreaIndex) * std::clamp(leafiness, 0.0, 1.0));
}

/** Projected coverage of one level: the mean and least share over the views, against the ellipsoid and the hull. */
struct CoverageLevel {
    double meanEllipsoid{0}, minEllipsoid{0}, meanHull{0};
};

namespace detail {

/**
 * Orthographic views of a crown from outside (5 near the horizon, 3 at 45 degrees, 1 from above). Each view holds two
 * masks, the pixels whose line of sight crosses the reference ellipsoid and those inside the 2D convex hull of the
 * reference points as projected, and which pixels a leaf covers. A leaf triangle covers the pixels whose centres it
 * contains; with a cut-out, only where its blade coordinates fall inside the leaf's outline (an ellipse filling `fill` of
 * the card's box), as a textured leaf's alpha does.
 */
struct CoverageViews {
    struct View {
        Vec3 dir, ax, ay;
        double x0{0}, y0{0};
        int w{0}, h{0};
        std::vector<uint8_t> ell, hull, covered;
        size_t nEll{0}, nHull{0}, covEll{0}, covHull{0};
    };
    /** A textured leaf's outline in a blade's coordinates: an ellipse centred (0.5, cv), semi-axes hu x hv, scaled by sqrt(r2). */
    struct Cutout { double cv{0.5}, hu{0.35}, hv{0.5}, r2{1}; };
    std::vector<View> views;
    double cell{0.05};

    static std::vector<Vec3> directions() {
        std::vector<Vec3> d;
        auto at = [&](double elevDeg, double azDeg) {
            const double e = elevDeg * M_PI / 180.0, a = azDeg * M_PI / 180.0;
            d.push_back(Vec3(static_cast<float>(std::cos(e) * std::cos(a)), static_cast<float>(std::sin(e)), static_cast<float>(std::cos(e) * std::sin(a))));
        };
        for (int k = 0; k < 5; ++k) at(10.0, 72.0 * k);
        for (int k = 0; k < 3; ++k) at(45.0, 36.0 + 120.0 * k);
        at(90.0, 0.0);
        return d;
    }

    void init(const CrownEllipsoid& ref, const std::vector<Vec3>& hullPts, double cellM) {
        views.clear();
        const auto dirs = directions();
        const double cy = std::cos(ref.yawRad), sy = std::sin(ref.yawRad);
        const Vec3 axes[3] = {Vec3(static_cast<float>(cy), 0, static_cast<float>(sy)), Vec3(0, 1, 0), Vec3(static_cast<float>(-sy), 0, static_cast<float>(cy))};
        auto toUnit = [&](const Vec3& v) { return Vec3(static_cast<float>(v.dot(axes[0]) / ref.radii[0]), static_cast<float>(v.dot(axes[1]) / ref.radii[1]), static_cast<float>(v.dot(axes[2]) / ref.radii[2])); };
        const double R = std::max({ref.radii[0], ref.radii[1], ref.radii[2]});
        // one cell for every view, coarse enough that no view is more than 512 cells across
        double extent = 2 * R;
        for (const auto& d : dirs) {
            const Vec3 ax = std::abs(d.y) > 0.999f ? Vec3(1, 0, 0) : Vec3(0, 1, 0).cross(d).normalized();
            const Vec3 ay = d.cross(ax).normalized();
            for (const Vec3& a : {ax, ay}) {
                double lo = a.dot(ref.centre) - R, hi = a.dot(ref.centre) + R;
                for (const auto& p : hullPts) { lo = std::min(lo, static_cast<double>(a.dot(p))); hi = std::max(hi, static_cast<double>(a.dot(p))); }
                extent = std::max(extent, hi - lo);
            }
        }
        cell = std::max(cellM, extent / 510.0);
        for (const auto& d : dirs) {
            View v;
            v.dir = d;
            v.ax = std::abs(d.y) > 0.999f ? Vec3(1, 0, 0) : Vec3(0, 1, 0).cross(d).normalized();
            v.ay = d.cross(v.ax).normalized();
            double lx = v.ax.dot(ref.centre) - R, hx = v.ax.dot(ref.centre) + R, ly = v.ay.dot(ref.centre) - R, hy = v.ay.dot(ref.centre) + R;
            std::vector<std::array<double, 2>> pts;
            pts.reserve(hullPts.size());
            for (const auto& p : hullPts) {
                const double x = v.ax.dot(p), y = v.ay.dot(p);
                pts.push_back({x, y});
                lx = std::min(lx, x); hx = std::max(hx, x); ly = std::min(ly, y); hy = std::max(hy, y);
            }
            v.x0 = lx - cell; v.y0 = ly - cell;
            v.w = static_cast<int>(std::ceil((hx - lx) / cell)) + 3;
            v.h = static_cast<int>(std::ceil((hy - ly) / cell)) + 3;
            const size_t n = static_cast<size_t>(v.w) * static_cast<size_t>(v.h);
            v.ell.assign(n, 0); v.hull.assign(n, 0); v.covered.assign(n, 0);
            // the ellipsoid: a line of sight p + t d crosses it when, in the ellipsoid's unit frame, it passes within 1 of the centre
            const Vec3 qd = toUnit(d);
            const double qdd = std::max(1e-12, static_cast<double>(qd.dot(qd)));
            // the hull: monotone chain
            std::sort(pts.begin(), pts.end());
            std::vector<std::array<double, 2>> H;
            auto cross = [](const std::array<double, 2>& o, const std::array<double, 2>& a, const std::array<double, 2>& b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); };
            for (int pass = 0; pass < 2; ++pass) {
                const size_t start = H.size();
                for (size_t k = 0; k < pts.size(); ++k) {
                    const auto& p = pass == 0 ? pts[k] : pts[pts.size() - 1 - k];
                    while (H.size() >= start + 2 && cross(H[H.size() - 2], H.back(), p) <= 0) H.pop_back();
                    H.push_back(p);
                }
                H.pop_back();
            }
            for (int j = 0; j < v.h; ++j) {
                for (int i = 0; i < v.w; ++i) {
                    const double x = v.x0 + (i + 0.5) * cell, y = v.y0 + (j + 0.5) * cell;
                    const Vec3 P = v.ax * static_cast<float>(x) + v.ay * static_cast<float>(y);
                    const Vec3 q0 = toUnit(P - ref.centre);
                    const double t = q0.dot(qd);
                    const size_t at = static_cast<size_t>(j) * static_cast<size_t>(v.w) + static_cast<size_t>(i);
                    if (static_cast<double>(q0.dot(q0)) - t * t / qdd <= 1.0) { v.ell[at] = 1; ++v.nEll; }
                    if (H.size() >= 3) {
                        bool in = true;
                        for (size_t k = 0; k < H.size() && in; ++k) if (cross(H[k], H[(k + 1) % H.size()], {x, y}) < 0) in = false;
                        if (in) { v.hull[at] = 1; ++v.nHull; }
                    }
                }
            }
            views.push_back(std::move(v));
        }
    }

    void clearCovered() {
        for (auto& v : views) { std::fill(v.covered.begin(), v.covered.end(), 0); v.covEll = v.covHull = 0; }
    }

    void triangle(View& v, const Vec3& a, const Vec3& b, const Vec3& c, const Vec2& ua, const Vec2& ub, const Vec2& uc, const Cutout* cut) {
        const double inv = 1.0 / cell;
        const double ax_ = (v.ax.dot(a) - v.x0) * inv - 0.5, ay_ = (v.ay.dot(a) - v.y0) * inv - 0.5;
        const double bx = (v.ax.dot(b) - v.x0) * inv - 0.5, by = (v.ay.dot(b) - v.y0) * inv - 0.5;
        const double cx = (v.ax.dot(c) - v.x0) * inv - 0.5, cy = (v.ay.dot(c) - v.y0) * inv - 0.5;
        const double area = (bx - ax_) * (cy - ay_) - (by - ay_) * (cx - ax_);
        if (std::abs(area) < 1e-12) return;
        const int i0 = std::max(0, static_cast<int>(std::ceil(std::min({ax_, bx, cx})))), i1 = std::min(v.w - 1, static_cast<int>(std::floor(std::max({ax_, bx, cx}))));
        const int j0 = std::max(0, static_cast<int>(std::ceil(std::min({ay_, by, cy})))), j1 = std::min(v.h - 1, static_cast<int>(std::floor(std::max({ay_, by, cy}))));
        const double ia = 1.0 / area;
        for (int j = j0; j <= j1; ++j) {
            for (int i = i0; i <= i1; ++i) {
                const double w0 = ((bx - i) * (cy - j) - (by - j) * (cx - i)) * ia;
                const double w1 = ((cx - i) * (ay_ - j) - (cy - j) * (ax_ - i)) * ia;
                const double w2 = 1.0 - w0 - w1;
                if (w0 < 0 || w1 < 0 || w2 < 0) continue;
                const size_t at = static_cast<size_t>(j) * static_cast<size_t>(v.w) + static_cast<size_t>(i);
                if (v.covered[at]) continue;
                if (cut) {
                    const double u = w0 * ua.x + w1 * ub.x + w2 * uc.x, t = w0 * ua.y + w1 * ub.y + w2 * uc.y;
                    const double su = (u - 0.5) / cut->hu, sv = (t - cut->cv) / cut->hv;
                    if (su * su + sv * sv > cut->r2) continue;
                }
                v.covered[at] = 1;
                v.covEll += v.ell[at];
                v.covHull += v.hull[at];
            }
        }
    }

    /** Covers what the blades of one placed library mesh cover, in every view. */
    void add(const LibraryMesh& m, const Instance& in, const Cutout* cut = nullptr) {
        if (m.bladeTri.empty()) return;
        std::vector<Vec3> p(m.bladePos.size());
        for (size_t k = 0; k < p.size(); ++k) p[k] = in.t + in.q.rotate(Vec3(m.bladePos[k].x * in.s.x, m.bladePos[k].y * in.s.y, m.bladePos[k].z * in.s.z));
        const bool uv = m.bladeUv.size() == m.bladePos.size();
        const Vec2 z(0.5f, 0.5f);
        for (auto& v : views) {
            for (size_t t = 0; t + 2 < m.bladeTri.size(); t += 3) {
                const uint32_t a = m.bladeTri[t], b = m.bladeTri[t + 1], c = m.bladeTri[t + 2];
                triangle(v, p[a], p[b], p[c], uv ? m.bladeUv[a] : z, uv ? m.bladeUv[b] : z, uv ? m.bladeUv[c] : z, uv ? cut : nullptr);
            }
        }
    }

    CoverageLevel level() const {
        CoverageLevel L;
        if (views.empty()) return L;
        L.minEllipsoid = 1.0;
        for (const auto& v : views) {
            const double e = v.nEll ? static_cast<double>(v.covEll) / static_cast<double>(v.nEll) : 0.0;
            const double h = v.nHull ? static_cast<double>(v.covHull) / static_cast<double>(v.nHull) : 0.0;
            L.meanEllipsoid += e / static_cast<double>(views.size());
            L.meanHull += h / static_cast<double>(views.size());
            L.minEllipsoid = std::min(L.minEllipsoid, e);
        }
        return L;
    }

    /** Pixels of the ellipsoid's silhouette not yet covered within `radiusM` of where `p` projects, summed over the views. */
    double uncoveredNear(const Vec3& p, double radiusM) const {
        const int r = std::max(1, static_cast<int>(std::lround(radiusM / cell)));
        double n = 0;
        for (const auto& v : views) {
            const int ci = static_cast<int>(std::floor((v.ax.dot(p) - v.x0) / cell)), cj = static_cast<int>(std::floor((v.ay.dot(p) - v.y0) / cell));
            for (int j = std::max(0, cj - r); j <= std::min(v.h - 1, cj + r); ++j) {
                for (int i = std::max(0, ci - r); i <= std::min(v.w - 1, ci + r); ++i) {
                    if ((i - ci) * (i - ci) + (j - cj) * (j - cj) > r * r) continue;
                    const size_t at = static_cast<size_t>(j) * static_cast<size_t>(v.w) + static_cast<size_t>(i);
                    if (v.ell[at] && !v.covered[at]) n += 1;
                }
            }
        }
        return n;
    }
};

} // namespace detail

/**
 * The projected coverage of a set of placed clusters (per library variant, `pick` choosing the level's mesh of a variant)
 * against a reference crown: the ellipsoid and the hull of `hullPts`. With `cutout` the leaves are cut out as a textured
 * leaf is: an ellipse filling `cutoutFill` of the card's box (widthRatio wide).
 */
namespace detail {
/**
 * Where a textured leaf of aspect `aspect` (width / length) and cut-out `fill` lies on a blade, as the viewer maps it
 * (treeTextureMaterials.ts LEAF_VERTEX_MAIN): the leaf's cell is drawn widthRatio-wide cards at most textureLeafStretch
 * times its own aspect, and shortened along the blade when the card is narrower than the drawn leaf.
 */
inline CoverageViews::Cutout leafCutout(const LodParams& P, double fill, double aspect) {
    CoverageViews::Cutout c;
    const double card = std::max(0.05, static_cast<double>(P.morphology.blade.widthRatio));
    const double r = aspect > 0 ? aspect : card;
    const double drawn = std::min(std::max(r, card), r * std::max(1.0, P.textureLeafStretch));
    const double f = std::min(1.0, card / drawn);
    c.hu = 0.5 * f * drawn;
    c.hv = 0.5 * f;
    c.cv = 0.5 * f;
    c.r2 = std::clamp(fill, 0.0, 1.0) / (M_PI / 4.0);
    return c;
}
} // namespace detail

template <class Pick>
inline CoverageLevel measureProjectedCoverage(const std::vector<std::vector<Instance>>& clusters, const ClusterLibrary& lib, Pick&& pick, const CrownEllipsoid& ref,
                                              const std::vector<Vec3>& hullPts, double cellM, double cutoutFill = 0.0, double cutoutAspect = 0.0) {
    detail::CoverageViews cv;
    cv.init(ref, hullPts, cellM);
    const auto cut = detail::leafCutout(lib.params, cutoutFill, cutoutAspect);
    for (size_t k = 0; k < clusters.size() && k < lib.variants.size(); ++k) {
        const LibraryMesh& m = pick(lib.variants[k]);
        for (const auto& in : clusters[k]) cv.add(m, in, cutoutFill > 0 ? &cut : nullptr);
    }
    return cv.level();
}

/** What a tree needs from its growth, as plain values (no dependence on how the crown was measured). */
struct TreeLodInput {
    const nat::SpaceColonizationConfig* cfg{nullptr};
    const std::vector<nat::ColonizationNode>* skeleton{nullptr};
    double stemX{0}, stemZ{0}, supportY{0};
    Vec3 apex;
    std::array<double, 16> sectorRadii{};
    const std::vector<Vec3>* surface{nullptr};   // the measured canopy surface above the crown base
    double reachRadius{0};
    double heightAboveSupport{0};
    uint32_t seed{0};
    size_t woodBudget{0};                        // triangles for wood: all of the tree's budget
    float barkTileAroundM{0}, barkTileAlongM{0}; // the chosen bark's real size: the wood's UVs in its tiles (0: legacy UVs)
    double leafiness{1.0};                       // the crown's season cue (seasonLeafiness): scales psiSeason and the coverage target
    double cutoutFill{0.0};                      // the chosen leaf texture's fill of its cell (0: no textures; the cut-out coverage is not measured)
    double cutoutAspect{0.0};                    // ... and its leaf's width / length
};

/** What the leaves of a tree cover of its measured crown, seen from outside (LodParams coverage*, detail::CoverageViews). */
struct CoverageReport {
    bool measured{false};
    double leafiness{1}, target{0}, cellM{0};
    int views{0};
    CoverageLevel level0Before;                  // the near level before the fill
    CoverageLevel level0, nearMid, mid;          // solid leaves (clay), after the fill
    CoverageLevel level0Cutout, midCutout;       // cut out as the chosen leaf texture is (only with textures)
    size_t fillStations{0};
    CrownEllipsoid reference;                    // the measured crown the shares are of (surface samples and footprint ring)
};

/** What the delivered leaves of one level reach of the measured surface, and how far past it they go. */
struct LeafLevelMeasure {
    size_t leaves{0}, leafTriangles{0}, clusterTriangles{0};
    size_t samples{0}, reached{0}, reachedStrict{0};
    double topY{-std::numeric_limits<double>::infinity()};
    std::array<double, 16> spread{};             // farthest leaf from the stem in each sector (m)
    double share() const { return samples ? static_cast<double>(reached) / static_cast<double>(samples) : 0.0; }
    double strictShare() const { return samples ? static_cast<double>(reachedStrict) / static_cast<double>(samples) : 0.0; }
};

struct TreeLod {
    geometry::Mesh wood;                         // the whole budget, all wood
    std::vector<float> woodGrowth;               // when each wood vertex grew
    size_t woodTriangles{0};
    float prunedBelowRadiusM{0};
    geometry::Mesh farWood;                      // the far level's wood: trunk and main limbs (farWoodBudgetFor)
    std::vector<float> farWoodGrowth;            // when each far wood vertex grew
    size_t farWoodTriangles{0};
    float farWoodPrunedBelowRadiusM{0};
    std::vector<std::vector<Instance>> twigs;    // per library twig (taper)
    size_t twigCount() const { size_t n = 0; for (const auto& t : twigs) n += t.size(); return n; }
    std::vector<std::vector<Instance>> clusters; // per library variant (levels 0 and 1 share the positions)
    double leafLengthM{0};
    size_t stations{0}, repairStations{0}, fitShrunk{0}, unfit{0}, outsideCrown{0}, inset{0};
    size_t twigTriangles{0};
    float twigRadiusMinM{0}, twigRadiusMedianM{0}, twigRadiusMaxM{0};   // of the pruned segments drawn as twigs (the radius they start at)
    LeafLevelMeasure level0, level1, nearMid;
    CoverageReport coverage;
    double msWood{0}, msTwigs{0}, msStations{0}, msRepair{0}, msFill{0}, msMeasure{0};   // where the build's time went
    std::string error;
    /** Triangles drawn at the near level / the mid level / the near-mid level (wood, twigs and clusters, instances expanded). */
    size_t drawnLevel0() const { return woodTriangles + twigTriangles + level0.clusterTriangles; }
    size_t drawnLevel1() const { return woodTriangles + level1.clusterTriangles; }
    size_t drawnNearMid() const { return woodTriangles + nearMid.clusterTriangles; }
    /** Triangles of the far level given its blob leaf masses: the trunk and main limbs and the masses. */
    size_t drawnFar(size_t blobTriangles) const { return farWoodTriangles + blobTriangles; }
};

namespace detail {

constexpr int kSectors = 16;

/** atan2 to within 1e-4 rad (a polynomial of the ratio): direction lookups in the envelope need no more. */
inline double fastAtan2(double y, double x) {
    const double ax = std::abs(x), ay = std::abs(y), mx = std::max(ax, ay), mn = std::min(ax, ay);
    if (mx == 0.0) return 0.0;
    const double a = mn / mx, s = a * a;
    double r = ((-0.0464964749 * s + 0.15931422) * s - 0.327622764) * s * a + a;
    if (ay > ax) r = 1.57079637 - r;
    if (x < 0) r = 3.14159274 - r;
    return y < 0 ? -r : r;
}

inline int sectorOf(double dx, double dz) {
    return static_cast<int>(std::floor((fastAtan2(dz, dx) + M_PI) / (2 * M_PI) * kSectors)) & (kSectors - 1);
}

/**
 * The crown's footprint as a smooth function of direction: the measured radius of each of the 16 sectors at the sector's
 * centre, linearly interpolated between neighbouring centres (so a narrow sector beside a wide one is entered gradually,
 * not by a step), never less than `floorM`.
 */
struct Envelope {
    std::array<double, kSectors> radii{};
    double stemX{0}, stemZ{0}, topY{0}, floorM{0.3};
    double radiusAt(double dx, double dz) const {
        const double a = (fastAtan2(dz, dx) + M_PI) / (2 * M_PI) * kSectors - 0.5;  // sector units, centres at integers
        const double f = std::floor(a);
        const int k0 = ((static_cast<int>(f) % kSectors) + kSectors) % kSectors, k1 = (k0 + 1) % kSectors;
        const double t = a - f;
        // between sector centres the radius is interpolated, and never more than the radius measured in the sector the
        // direction lies in (a sector's radius is the farthest sample in it: nothing was measured past it)
        const double own = radii[static_cast<size_t>(sectorOf(dx, dz))];
        return std::max(floorM, std::min(own, radii[static_cast<size_t>(k0)] * (1 - t) + radii[static_cast<size_t>(k1)] * t));
    }
    bool contains(const Vec3& p) const {
        const double dx = p.x - stemX, dz = p.z - stemZ;
        return p.y <= topY && std::hypot(dx, dz) <= radiusAt(dx, dz);
    }
};

inline Vec3 transformPoint(const Vec3& t, const Quat& q, const Vec3& s, const Vec3& p) {
    return t + q.rotate(Vec3(p.x * s.x, p.y * s.y, p.z * s.z));
}

/** A uniform-grid index of a point set. */
struct PointGrid {
    double cell{1};
    std::unordered_map<uint64_t, std::vector<uint32_t>> cells;
    const std::vector<Vec3>* pts{nullptr};
    static uint64_t key(int64_t a, int64_t b, int64_t c) {
        return (static_cast<uint64_t>(a & 0x1FFFFF) << 42) | (static_cast<uint64_t>(b & 0x1FFFFF) << 21) | static_cast<uint64_t>(c & 0x1FFFFF);
    }
    void build(const std::vector<Vec3>& p, double cellSize) {
        pts = &p;
        cell = std::max(0.05, cellSize);
        for (uint32_t i = 0; i < p.size(); ++i) cells[key(static_cast<int64_t>(std::floor(p[i].x / cell)), static_cast<int64_t>(std::floor(p[i].y / cell)), static_cast<int64_t>(std::floor(p[i].z / cell)))].push_back(i);
    }
    /** Calls fn(index) for every point in the 27 cells around q. */
    template <class F> void forNeighbors(const Vec3& q, F&& fn) const {
        const int64_t a = static_cast<int64_t>(std::floor(q.x / cell)), b = static_cast<int64_t>(std::floor(q.y / cell)), c = static_cast<int64_t>(std::floor(q.z / cell));
        for (int64_t dz = -1; dz <= 1; ++dz) for (int64_t dy = -1; dy <= 1; ++dy) for (int64_t dx = -1; dx <= 1; ++dx) {
            auto it = cells.find(key(a + dx, b + dy, c + dz));
            if (it == cells.end()) continue;
            for (uint32_t i : it->second) fn(i);
        }
    }
    /** Distance to the nearest point within one cell ring (cell size when none). */
    double nearest(const Vec3& q) const {
        const int64_t a = static_cast<int64_t>(std::floor(q.x / cell)), b = static_cast<int64_t>(std::floor(q.y / cell)), c = static_cast<int64_t>(std::floor(q.z / cell));
        double best = 1.5 * cell;
        for (int64_t dz = -1; dz <= 1; ++dz) for (int64_t dy = -1; dy <= 1; ++dy) for (int64_t dx = -1; dx <= 1; ++dx) {
            auto it = cells.find(key(a + dx, b + dy, c + dz));
            if (it == cells.end()) continue;
            for (uint32_t i : it->second) best = std::min(best, static_cast<double>(((*pts)[i] - q).length()));
        }
        return best;
    }
};

/** The clusters placed so far: which library mesh, where (uniform scale), and the sphere around its blades in the tile frame. */
struct LeafSoup {
    struct Placed { const LibraryMesh* mesh{nullptr}; Instance in; Vec3 centre; float radius{0}; };
    std::vector<Placed> clusters;
    float topY{-1e30f};
    void append(const LibraryMesh& m, const Instance& in) {
        if (m.leafSpheres.empty()) return;
        Placed p;
        p.mesh = &m;
        p.in = in;
        p.centre = transformPoint(in.t, in.q, in.s, m.bladeCentre);
        p.radius = m.bladeRadius * in.s.x;
        clusters.push_back(p);
        for (const auto& v : m.bladePos) topY = std::max(topY, transformPoint(in.t, in.q, in.s, v).y);
    }
};

/**
 * Which samples of the measured surface lie within `reach` (and within the smaller `reachSmall`) of a leaf triangle,
 * kept as clusters are placed: each cluster is tested only against the samples near it that are not yet within both.
 */
struct ReachTracker {
    const std::vector<Vec3>* surface{nullptr};
    double reach{0}, reachSmall{0}, cell{1};
    std::unordered_map<uint64_t, std::vector<uint32_t>> grid;
    std::vector<uint8_t> big, small;
    size_t nBig{0}, nSmall{0};
    int64_t cellOf(double v) const { return static_cast<int64_t>(std::floor(v / cell)); }
    void init(const std::vector<Vec3>& s, double r, double rSmall, double cellSize) {
        surface = &s;
        reach = r;
        reachSmall = std::min(rSmall, r);
        cell = std::max(0.25, cellSize);
        big.assign(s.size(), 0);
        small.assign(s.size(), 0);
        for (uint32_t i = 0; i < s.size(); ++i) grid[PointGrid::key(cellOf(s[i].x), cellOf(s[i].y), cellOf(s[i].z))].push_back(i);
    }
    /** Tests the newest cluster of `L` against the samples it can reach (in the cluster's own frame, the scale divided out). */
    void addLast(const LeafSoup& L) {
        const auto& pc = L.clusters.back();
        const LibraryMesh& m = *pc.mesh;
        const double R = reach + pc.radius, sc = pc.in.s.x, inv = 1.0 / sc;
        const double rLocal = reach * inv, rsLocal = reachSmall * inv;
        const Quat qInv(-pc.in.q.x, -pc.in.q.y, -pc.in.q.z, pc.in.q.w);
        for (int64_t a = cellOf(pc.centre.x - R); a <= cellOf(pc.centre.x + R); ++a)
        for (int64_t b = cellOf(pc.centre.y - R); b <= cellOf(pc.centre.y + R); ++b)
        for (int64_t c = cellOf(pc.centre.z - R); c <= cellOf(pc.centre.z + R); ++c) {
            auto it = grid.find(PointGrid::key(a, b, c));
            if (it == grid.end()) continue;
            for (uint32_t i : it->second) {
                if (small[i]) continue;
                const Vec3& s = (*surface)[i];
                if ((s - pc.centre).length() > R) continue;
                const Vec3 q = qInv.rotate(s - pc.in.t) * static_cast<float>(inv);
                for (const auto& leaf : m.leafSpheres) {
                    if ((q - leaf.c).length() > rLocal + leaf.r) continue;
                    for (uint32_t t = leaf.first; t < leaf.first + leaf.count; ++t) {
                        const double d = pointTriangleDistance(q, m.bladePos[m.bladeTri[3 * t]], m.bladePos[m.bladeTri[3 * t + 1]], m.bladePos[m.bladeTri[3 * t + 2]]);
                        if (d <= rLocal && !big[i]) { big[i] = 1; ++nBig; }
                        if (d <= rsLocal) { small[i] = 1; ++nSmall; if (!big[i]) { big[i] = 1; ++nBig; } break; }
                    }
                    if (small[i]) break;
                }
            }
        }
    }
};

} // namespace detail

/**
 * Builds one tree's wood, twigs and leaf-cluster stations. Throws nothing: a failure is in `error`.
 *
 * Stations are the skeleton's leaf nodes (tips, thin twigs, branches through the measured crown) thinned to the clusters'
 * spacing, outermost first; a station whose cluster would leave the crown envelope has its cluster shrunk to fit (never
 * below minFitScale) or moved down its branch to where it fits. Where the delivered leaves still miss the measured
 * surface, further stations are added at the nearest leaf node until minFill is met. A station's density class follows
 * its depth below the measured canopy surface.
 */
inline void buildTreeLod(TreeLod& T, const TreeLodInput& in, const ClusterLibrary& lib) {
    using Clock = std::chrono::steady_clock;
    auto msSince = [](Clock::time_point t) { return std::chrono::duration<double, std::milli>(Clock::now() - t).count(); };
    auto tPhase = Clock::now();
    const LodParams& P = lib.params;
    const auto& sk = *in.skeleton;
    const size_t N = sk.size();
    if (N < 2) { T.error = "skeleton has fewer than 2 nodes"; return; }
    nat::SpaceColonizationConfig cfg = *in.cfg;
    const float growthDen = static_cast<float>(std::max<size_t>(1, N - 1));

    // ---- wood: the whole budget ----
    cfg.triangleBudget = static_cast<float>(in.woodBudget);
    cfg.woodBudgetShare = 1.0f;
    cfg.barkTileAroundM = in.barkTileAroundM;
    cfg.barkTileAlongM = in.barkTileAlongM;
    nat::TreeBudgetReport rep;
    nat::MeshGrowth growth;
    auto meshes = nat::SpaceColonizationTreeGenerator::meshGrownSkeleton(cfg, sk, &rep, &growth);
    T.wood = std::move(meshes.first);
    T.woodGrowth = std::move(growth.wood);
    T.woodTriangles = rep.woodTriangles;
    T.prunedBelowRadiusM = rep.prunedBelowRadius;
    {
        // the far level's wood: the same skeleton within a few hundred triangles, so the budget keeps the trunk and main limbs
        nat::SpaceColonizationConfig farCfg = cfg;
        farCfg.triangleBudget = static_cast<float>(farWoodBudgetFor(P, in.heightAboveSupport));
        nat::TreeBudgetReport farRep;
        nat::MeshGrowth farGrowth;
        auto far = nat::SpaceColonizationTreeGenerator::meshGrownSkeleton(farCfg, sk, &farRep, &farGrowth);
        T.farWood = std::move(far.first);
        T.farWoodGrowth = std::move(farGrowth.wood);
        T.farWoodTriangles = farRep.woodTriangles;
        T.farWoodPrunedBelowRadiusM = farRep.prunedBelowRadius;
    }

    T.msWood = msSince(tPhase); tPhase = Clock::now();
    // ---- twigs: the segments the pruning dropped, one instance of the unit tube each ----
    T.twigs.assign(lib.twigs.size(), {});
    std::vector<float> twigRadii;
    // consecutive pruned segments of one chain (each starts where the one before ends) are drawn as one tube while the nodes
    // between lie within a radius of the straight line: the simplification the budgeted meshing applies to a branch
    // (a fraction of a radius) is finer than a twig of a few centimetres needs
    const auto& pr = growth.pruned;
    for (size_t k = 0; k < pr.size();) {
        size_t e = k;
        while (e + 1 < pr.size() && pr[e + 1].a == pr[e].b) {
            const Vec3 A = sk[static_cast<size_t>(pr[k].a)].position, B = sk[static_cast<size_t>(pr[e + 1].b)].position, AB = B - A;
            const float len2 = std::max(1e-12f, AB.lengthSquared());
            float worst = 0;
            for (size_t m = k; m <= e; ++m) {
                const Vec3 Pm = sk[static_cast<size_t>(pr[m].b)].position;
                const float tt = std::clamp((Pm - A).dot(AB) / len2, 0.0f, 1.0f);
                worst = std::max(worst, (Pm - (A + AB * tt)).length());
            }
            if (worst > static_cast<float>(P.twigMergeTolerance) * pr[k].radiusA) break;
            ++e;
        }
        const Vec3 a = sk[static_cast<size_t>(pr[k].a)].position, b = sk[static_cast<size_t>(pr[e].b)].position, d = b - a;
        const float len = d.length();
        if (len >= 1e-4f) {
            const float r = std::max(pr[k].radiusA, static_cast<float>(P.twigMinRadiusM));
            const double ratio = std::clamp(static_cast<double>(pr[e].radiusB) / std::max(1e-6, static_cast<double>(pr[k].radiusA)), 0.0, 1.0);
            size_t v = 0;
            for (size_t j = 1; j < P.twigTapers.size(); ++j) if (std::abs(P.twigTapers[j] - ratio) < std::abs(P.twigTapers[v] - ratio)) v = j;
            T.twigs[v].push_back(Instance{a, frameAlong(d / len, Vec3(0, 1, 0)), Vec3(r, r, len), static_cast<float>(pr[k].a) / growthDen});
            twigRadii.push_back(r);
        }
        k = e + 1;
    }
    T.twigTriangles = T.twigCount() * lib.twigTriangles();
    if (!twigRadii.empty()) {
        std::sort(twigRadii.begin(), twigRadii.end());
        T.twigRadiusMinM = twigRadii.front(); T.twigRadiusMedianM = twigRadii[twigRadii.size() / 2]; T.twigRadiusMaxM = twigRadii.back();
    }
    T.msTwigs = msSince(tPhase); tPhase = Clock::now();
    // ---- leaf-cluster stations ----
    const double H = in.heightAboveSupport;
    T.leafLengthM = leafLengthFor(P, H);
    const double baseScale = T.leafLengthM / P.referenceLeafM;
    double meanReach = 0;
    for (const auto& v : lib.variants) meanReach += v.level0.reach / static_cast<double>(lib.variants.size());
    const double spacing = P.spacingRatio * meanReach * baseScale;
    detail::Envelope env;
    env.radii = in.sectorRadii;
    env.stemX = in.stemX;
    env.stemZ = in.stemZ;
    env.topY = in.apex.y;
    env.floorM = 0.35 * meanReach * baseScale;
    auto radialOf = [&](const Vec3& p) { return std::hypot(p.x - in.stemX, p.z - in.stemZ); };
    const float trunkRef = nat::SpaceColonizationTreeGenerator::trunkRadiusReference(cfg, sk);
    const std::vector<uint8_t> leafy = nat::SpaceColonizationTreeGenerator::leafyNodes(cfg, sk, nat::SpaceColonizationTreeGenerator::kTwigRadiusShare * trunkRef);
    const float crownBottom = cfg.rootAnchor.y + cfg.clearTrunkHeight * 0.85f;
    const auto& surface = *in.surface;
    detail::PointGrid surfaceGrid;
    surfaceGrid.build(surface, std::max(1.5, 2.0 * spacing));
    const double lambda = std::max(0.5, P.shellDepthPerHeight * H);

    std::vector<uint32_t> order;
    for (uint32_t i = 0; i < N; ++i) if (leafy[i]) order.push_back(i);
    auto outwardness = [&](uint32_t i) {
        const Vec3& p = sk[i].position;
        return radialOf(p) / std::max(0.5, env.radiusAt(p.x - in.stemX, p.z - in.stemZ)) + (p.y - in.supportY) / H;
    };
    std::vector<double> rank(N, 0.0);
    for (uint32_t i : order) rank[i] = outwardness(i);
    // tips first, then the outermost (a cluster's silhouette matters most at the crown's edge)
    std::stable_sort(order.begin(), order.end(), [&](uint32_t a, uint32_t b) {
        const bool ta = sk[a].children.empty(), tb = sk[b].children.empty();
        if (ta != tb) return ta;
        return rank[a] > rank[b];
    });
    std::vector<Vec3> takenPts;  // stations, for the spacing test
    std::unordered_map<uint64_t, std::vector<uint32_t>> takenCells;
    auto gkey = [&](const Vec3& p, int dx, int dy, int dz) {
        return detail::PointGrid::key(static_cast<int64_t>(std::floor(p.x / spacing)) + dx, static_cast<int64_t>(std::floor(p.y / spacing)) + dy, static_cast<int64_t>(std::floor(p.z / spacing)) + dz);
    };
    std::vector<uint8_t> isStation(N, 0);
    auto farFromStations = [&](const Vec3& p) {
        for (int dz = -1; dz <= 1; ++dz) for (int dy = -1; dy <= 1; ++dy) for (int dx = -1; dx <= 1; ++dx) {
            auto it = takenCells.find(gkey(p, dx, dy, dz));
            if (it == takenCells.end()) continue;
            for (uint32_t j : it->second) if ((takenPts[j] - p).length() < spacing) return false;
        }
        return true;
    };
    auto stationPosition = [&](uint32_t i, const Vec3* at) { return at ? *at : sk[i].position; };

    T.clusters.assign(lib.variants.size(), {});
    detail::LeafSoup soup0, soup1, soupNM;
    detail::ReachTracker track0, track1, trackNM;
    track0.init(surface, in.reachRadius, P.strictReachM, in.reachRadius + 1.5);
    track1.init(surface, in.reachRadius, P.strictReachM, in.reachRadius + 1.5);
    trackNM.init(surface, in.reachRadius, P.strictReachM, in.reachRadius + 1.5);
    // returns the library variant the cluster took, or -1 when none fitted
    auto place = [&](uint32_t i, bool repair, const Vec3* at) -> long {
        const Vec3 p = stationPosition(i, at);
        const Vec3 par = sk[i].parentId >= 0 ? sk[static_cast<size_t>(sk[i].parentId)].position : p - Vec3(0, 1, 0);
        Vec3 shoot = p - par;
        shoot = shoot.lengthSquared() > 1e-8f ? shoot.normalized() : Vec3(0, 1, 0);
        Vec3 out(p.x - static_cast<float>(in.stemX), 0.0f, p.z - static_cast<float>(in.stemZ));
        out = out.lengthSquared() > 1e-4f ? out.normalized() : shoot;
        const Vec3 f = (shoot * static_cast<float>(1.0 - P.outwardBlend) + out * static_cast<float>(P.outwardBlend) + Vec3(0, static_cast<float>(P.upBias), 0)).normalized();
        Quat q = frameAlong(f, Vec3(0, 1, 0));
        const double roll = (hashUnit(in.seed, i, 11) * 2.0 - 1.0) * P.rollJitterRad;
        q = (Quat::fromAxisAngle(f, static_cast<float>(roll)) * q).normalized();
        // density class: leaves thin towards the inside, following the measured canopy surface
        const double depth = surfaceGrid.nearest(p);
        const double w = std::exp(-depth / lambda);
        const int classes = std::max(1, P.densityClasses);
        const int cls = std::clamp(static_cast<int>(std::floor((1.0 - w) * classes)), 0, classes - 1);
        const int attach = hashUnit(in.seed, i, 14) < 0.5 ? 0 : 1;
        const size_t k = static_cast<size_t>(cls * 2 + attach);
        const auto& v = lib.variants[k];
        float sc = static_cast<float>(baseScale * (1.0 - 0.5 * P.sizeJitter + P.sizeJitter * hashUnit(in.seed, i, 13)));
        // the whole cluster inside the crown: never above the apex, never past the (interpolated) footprint
        auto fits = [&](float s) {
            for (const auto& sp : v.level0.support) if (!env.contains(p + q.rotate(sp * s))) return false;
            for (const auto& sp : v.level1.support) if (!env.contains(p + q.rotate(sp * s))) return false;
            for (const auto& sp : v.nearMid.support) if (!env.contains(p + q.rotate(sp * s))) return false;
            return true;
        };
        Vec3 centre = p;
        if (!fits(sc)) {
            const float minScale = static_cast<float>(P.minFitScale * baseScale);
            float lo = minScale, hi = sc;
            if (!fits(lo)) {
                // not even a half-size cluster fits at the node: it moves in (towards the stem's axis and down, 0.15 of its
                // reach at a time, at most 1.8 reaches) to where it does, as nature::LeafEnvelope::keepIn moves a leaf mass
                const float stepM = static_cast<float>(0.15 * meanReach * baseScale);
                bool placed = false;
                for (int k = 1; k <= 12 && !placed; ++k) {
                    Vec3 c = p;
                    const float dx = c.x - static_cast<float>(in.stemX), dz = c.z - static_cast<float>(in.stemZ), r = std::sqrt(dx * dx + dz * dz);
                    const float moved = std::min(r, stepM * k);
                    if (r > 1e-6f) { c.x -= dx / r * moved; c.z -= dz / r * moved; }
                    c.y = std::min(c.y, static_cast<float>(env.topY - 0.2 * meanReach * baseScale));
                    bool ok = true;
                    for (const auto& sp : v.level0.support) { if (!env.contains(c + q.rotate(sp * lo))) { ok = false; break; } }
                    for (const auto& sp : v.level1.support) { if (ok && !env.contains(c + q.rotate(sp * lo))) { ok = false; } }
                    for (const auto& sp : v.nearMid.support) { if (ok && !env.contains(c + q.rotate(sp * lo))) { ok = false; } }
                    if (ok) { centre = c; placed = true; }
                }
                if (!placed) { isStation[i] = 1; ++T.unfit; return -1; }
                ++T.inset;
                sc = lo;
            } else {
                for (int it = 0; it < 10; ++it) { const float m = 0.5f * (lo + hi); if (fits(m)) lo = m; else hi = m; }
                sc = lo;
                ++T.fitShrunk;
            }
        }
        Instance inst{centre, q, Vec3(sc, sc, sc), static_cast<float>(i) / growthDen};
        T.clusters[k].push_back(inst);
        const size_t g0 = soup0.clusters.size(), g1 = soup1.clusters.size(), gn = soupNM.clusters.size();
        soup0.append(v.level0, inst);
        soup1.append(v.level1, inst);
        soupNM.append(v.nearMid, inst);
        if (soup0.clusters.size() > g0) track0.addLast(soup0);
        if (soup1.clusters.size() > g1) track1.addLast(soup1);
        if (soupNM.clusters.size() > gn) trackNM.addLast(soupNM);
        T.level0.leaves += static_cast<size_t>(v.level0.leaves);
        T.level1.leaves += static_cast<size_t>(v.level1.leaves);
        T.nearMid.leaves += static_cast<size_t>(v.nearMid.leaves);
        T.level0.leafTriangles += v.level0.bladeFront.size() / 3 * 2;
        T.level1.leafTriangles += v.level1.bladeFront.size() / 3 * 2;
        T.nearMid.leafTriangles += v.nearMid.bladeFront.size() / 3 * 2;
        T.level0.clusterTriangles += v.level0.triangles();
        T.level1.clusterTriangles += v.level1.triangles();
        T.nearMid.clusterTriangles += v.nearMid.triangles();
        ++T.stations;
        if (repair) ++T.repairStations;
        isStation[i] = 1;
        return static_cast<long>(k);
    };
    auto accept = [&](uint32_t i, const Vec3& p) {
        takenPts.push_back(p);
        takenCells[gkey(p, 0, 0, 0)].push_back(static_cast<uint32_t>(takenPts.size() - 1));
        (void)i;
    };

    // the request's season, times the crown's own (its measured colour)
    const double psi = std::clamp(P.psiSeason, 0.0, 1.0) * std::clamp(in.leafiness, 0.0, 1.0);
    std::vector<uint32_t> stations;
    if (psi > 0.0) {
        for (uint32_t i : order) {
            Vec3 sp = sk[i].position;
            if (!env.contains(sp)) {
                // the skeleton overshoots the measured crown here: the leaves go on the same branch, where it is still inside
                ++T.outsideCrown;
                int a = sk[i].parentId;
                while (a > 0 && !env.contains(sk[static_cast<size_t>(a)].position)) a = sk[static_cast<size_t>(a)].parentId;
                if (a <= 0 || sk[static_cast<size_t>(a)].position.y < crownBottom || isStation[static_cast<size_t>(a)]) continue;
                i = static_cast<uint32_t>(a);
                sp = sk[i].position;
            }
            if (!farFromStations(sp)) continue;
            // psiSeason thins the stations that carry leaves, by a stable hash of the node
            if (hashUnit(in.seed, i, 21) >= psi) { accept(i, sp); isStation[i] = 1; continue; }
            accept(i, sp);
            stations.push_back(i);
        }
        for (uint32_t i : stations) place(i, false, nullptr);
    }

    T.msStations = msSince(tPhase); tPhase = Clock::now();
    // ---- what the delivered leaves reach; add stations where they fall short ----
    const double reach = in.reachRadius;
    // the repair works to the strict yardstick when it is the tighter one: a sample within the tree's reach radius of a
    // leaf but not within a metre still counts as unreached
    const double repairReach = std::min(reach, P.strictReachM);
    T.level0.samples = T.level1.samples = T.nearMid.samples = surface.size();
    const std::vector<uint8_t>& flags = track0.small;   // within the strict radius of a level-0 leaf (the radius the repair works to)
    size_t reached = track0.nSmall;
    const bool repairable = psi >= 1.0;
    // the nodes a repair may use: above the crown base and inside the envelope, found through a grid
    std::vector<Vec3> nodePos(N);
    std::vector<uint8_t> nodeInside(N, 0);
    detail::PointGrid nodeGrid;
    if (repairable) {
        for (uint32_t i = 0; i < N; ++i) { nodePos[i] = sk[i].position; nodeInside[i] = sk[i].position.y >= crownBottom && env.contains(sk[i].position) ? 1 : 0; }
        nodeGrid.build(nodePos, std::max(2.5, repairReach + meanReach * baseScale));
    }
    for (int pass = 0; repairable && pass < 6 && static_cast<double>(reached) < P.minFill * static_cast<double>(surface.size()); ++pass) {
        std::vector<uint32_t> add;
        std::vector<uint8_t> chosen(N, 0);
        for (size_t s = 0; s < surface.size(); ++s) {
            if (flags[s]) continue;
            double best = 1e30; long bi = -1;
            nodeGrid.forNeighbors(surface[s], [&](uint32_t i) {
                if (isStation[i] || chosen[i] || !nodeInside[i]) return;
                const double d = (nodePos[i] - surface[s]).length();
                if (d < best) { best = d; bi = i; }
            });
            if (bi >= 0 && best <= repairReach + meanReach * baseScale) { chosen[static_cast<size_t>(bi)] = 1; add.push_back(static_cast<uint32_t>(bi)); }
        }
        if (add.empty()) break;
        for (uint32_t i : add) { accept(i, sk[i].position); place(i, true, nullptr); }
        reached = track0.nSmall;
    }
    // last resort, for crowns the skeleton overshoots (its nodes lie outside the measured footprint): the node nearest each
    // sample still unreached, or nearest the crown's highest sample when the leaves fall short of it, carries a cluster moved
    // in from the node to just inside the crown (reported as inset)
    auto insetPoint = [&](Vec3 q) {
        q.y = std::min(q.y, static_cast<float>(env.topY - 0.35 * meanReach * baseScale));
        const double dx = q.x - in.stemX, dz = q.z - in.stemZ, r = std::hypot(dx, dz), lim = 0.85 * env.radiusAt(dx, dz);
        if (r > lim && r > 1e-6) { const double k = lim / r; q.x = static_cast<float>(in.stemX + dx * k); q.z = static_cast<float>(in.stemZ + dz * k); }
        return q;
    };
    auto leafTop = [&]() { return static_cast<double>(soup0.topY); };
    for (int pass = 0; repairable && pass < 4; ++pass) {
        const bool shortFill = static_cast<double>(reached) < P.minFill * static_cast<double>(surface.size());
        const bool shortTop = leafTop() + repairReach < static_cast<double>(in.apex.y);
        if (!shortFill && !shortTop) break;
        std::vector<size_t> targets;
        if (shortFill) for (size_t s2 = 0; s2 < surface.size(); ++s2) if (!flags[s2]) targets.push_back(s2);
        if (shortTop) { size_t hi = 0; for (size_t s2 = 1; s2 < surface.size(); ++s2) if (surface[s2].y > surface[hi].y) hi = s2; targets.push_back(hi); }
        std::vector<uint8_t> chosen(N, 0);
        size_t added = 0;
        for (size_t s2 : targets) {
            double best = 1e30; long bi = -1;
            for (uint32_t i = 0; i < N; ++i) {
                if (chosen[i] || sk[i].position.y < crownBottom) continue;
                const double d = (sk[i].position - surface[s2]).length();
                if (d < best) { best = d; bi = i; }
            }
            if (bi < 0) continue;
            chosen[static_cast<size_t>(bi)] = 1;
            const Vec3 q = insetPoint(sk[static_cast<size_t>(bi)].position);
            const size_t before = T.stations;
            place(static_cast<uint32_t>(bi), true, &q);
            if (T.stations > before) { ++T.inset; ++added; }
        }
        if (!added) break;
        reached = track0.nSmall;
    }

    T.msRepair = msSince(tPhase); tPhase = Clock::now();
    // ---- projected coverage: fill the crown toward its target, the outer shell first ----
    // The reference is the measured crown: its surface samples and its footprint ring at the crown base. Clusters are
    // added where the views see the most uncovered envelope, at candidates on the reference's shell inset by
    // shellInsetPerReach cluster reaches (the surface samples and a Fibonacci sphere of the ellipsoid), then a layer
    // deeper; each hangs from the nearest skeleton node above the crown base (its shoot gives the orientation).
    detail::CoverageViews cov;
    std::vector<Vec3> refPts;
    T.coverage.leafiness = std::clamp(in.leafiness, 0.0, 1.0);
    T.coverage.target = coverageTarget(P, psi);
    if (!surface.empty()) {
        refPts = surface;
        for (int k = 0; k < detail::kSectors; ++k) {
            const double ang = -M_PI + (k + 0.5) * (2 * M_PI / detail::kSectors), r = in.sectorRadii[static_cast<size_t>(k)];
            if (r > 0) refPts.push_back(Vec3(static_cast<float>(in.stemX + r * std::cos(ang)), crownBottom, static_cast<float>(in.stemZ + r * std::sin(ang))));
        }
        T.coverage.reference = fitCrownEllipsoid(refPts);
    }
    if (T.coverage.reference.valid()) {
        cov.init(T.coverage.reference, refPts, P.coverageCellPerLeaf * T.leafLengthM);
        T.coverage.measured = true;
        T.coverage.cellM = cov.cell;
        T.coverage.views = static_cast<int>(cov.views.size());
        for (size_t k = 0; k < T.clusters.size(); ++k) for (const auto& c : T.clusters[k]) cov.add(lib.variants[k].level0, c);
        T.coverage.level0Before = cov.level();
    }
    if (T.coverage.measured && P.coverageFill && psi > 0.0 && cov.level().meanEllipsoid < T.coverage.target) {
        const CrownEllipsoid& ref = T.coverage.reference;
        const double reachM = meanReach * baseScale;
        const size_t cap = static_cast<size_t>(std::ceil(std::max(0.0, P.coverageMaxFillShare) * static_cast<double>(std::max<size_t>(T.stations, 8))));
        // the nodes a fill cluster may hang from
        std::vector<Vec3> fillNodePos;
        std::vector<uint32_t> fillNodeId;
        for (uint32_t i = 0; i < N; ++i) if (sk[i].position.y >= crownBottom) { fillNodePos.push_back(sk[i].position); fillNodeId.push_back(i); }
        detail::PointGrid fillGrid;
        fillGrid.build(fillNodePos, std::max(1.0, 2.0 * reachM));
        auto nearestNode = [&](const Vec3& q) -> long {
            long best = -1; double bd = 1e30;
            fillGrid.forNeighbors(q, [&](uint32_t j) { const double d = (fillNodePos[j] - q).length(); if (d < bd) { bd = d; best = static_cast<long>(fillNodeId[j]); } });
            if (best < 0) for (size_t j = 0; j < fillNodePos.size(); ++j) { const double d = (fillNodePos[j] - q).length(); if (d < bd) { bd = d; best = static_cast<long>(fillNodeId[j]); } }
            return best;
        };
        // shell points: the surface samples, and the reference ellipsoid's (it closes the underside the tiles do not see)
        std::vector<Vec3> shell = surface;
        {
            const double cy = std::cos(ref.yawRad), sy = std::sin(ref.yawRad);
            const int D = 256;
            for (int d = 0; d < D; ++d) {
                const double zz = 1.0 - 2.0 * (d + 0.5) / D, rr = std::sqrt(std::max(0.0, 1.0 - zz * zz)), ph = d * 2.399963229728653;
                const double ux = rr * std::cos(ph) * ref.radii[0], uy = zz * ref.radii[1], uz = rr * std::sin(ph) * ref.radii[2];
                shell.push_back(Vec3(static_cast<float>(ref.centre.x + ux * cy - uz * sy), static_cast<float>(ref.centre.y + uy), static_cast<float>(ref.centre.z + ux * sy + uz * cy)));
            }
        }
        const double minGap = 0.6 * spacing;
        size_t added = 0;
        for (int layer = 1; layer <= 2 && added < cap; ++layer) {
            // candidates of this layer: shell points moved toward the reference centre by `layer` insets
            std::vector<Vec3> cand;
            cand.reserve(shell.size());
            for (const auto& sp : shell) {
                Vec3 d = ref.centre - sp;
                const float len = d.length();
                if (len < 1e-4f) continue;
                const float inset = static_cast<float>(std::min(0.9 * len, layer * P.shellInsetPerReach * reachM));
                const Vec3 q = sp + d * (inset / len);
                if (q.y < crownBottom || !env.contains(q)) continue;
                cand.push_back(q);
            }
            std::vector<uint8_t> spent(cand.size(), 0);
            for (int round = 0; round < 64 && added < cap && cov.level().meanEllipsoid < T.coverage.target; ++round) {
                std::vector<std::pair<double, size_t>> score;
                for (size_t c = 0; c < cand.size(); ++c) {
                    if (spent[c]) continue;
                    const double u = cov.uncoveredNear(cand[c], 0.5 * reachM);
                    if (u > 0) score.push_back({u, c});
                }
                if (score.empty()) break;
                std::sort(score.begin(), score.end(), [](const auto& a, const auto& b) { return a.first > b.first || (a.first == b.first && a.second < b.second); });
                std::vector<Vec3> picked;
                size_t placedNow = 0;
                for (const auto& [u, c] : score) {
                    if (picked.size() >= 12 || added >= cap) break;
                    const Vec3& q = cand[c];
                    spent[c] = 1;
                    bool clear = true;
                    for (const auto& p : picked) if ((p - q).length() < 2.0 * minGap) { clear = false; break; }
                    if (clear) for (int dz = -1; dz <= 1 && clear; ++dz) for (int dy = -1; dy <= 1 && clear; ++dy) for (int dx = -1; dx <= 1 && clear; ++dx) {
                        auto it = takenCells.find(gkey(q, dx, dy, dz));
                        if (it == takenCells.end()) continue;
                        for (uint32_t j : it->second) if ((takenPts[j] - q).length() < minGap) { clear = false; break; }
                    }
                    if (!clear) continue;
                    const long node = nearestNode(q);
                    if (node < 0) continue;
                    picked.push_back(q);
                    const long k = place(static_cast<uint32_t>(node), false, &q);
                    if (k < 0) continue;
                    accept(static_cast<uint32_t>(node), q);
                    cov.add(lib.variants[static_cast<size_t>(k)].level0, T.clusters[static_cast<size_t>(k)].back());
                    ++added; ++placedNow;
                }
                if (!placedNow && picked.empty()) break;
            }
        }
        T.coverage.fillStations = added;
    }
    T.msFill = msSince(tPhase); tPhase = Clock::now();
    // ---- measurements of each level ----
    auto finish = [&](LeafLevelMeasure& m, const detail::LeafSoup& soup, const detail::ReachTracker& tr) {
        m.reached = tr.nBig;
        m.reachedStrict = tr.nSmall;
        m.topY = soup.topY;
        // the farthest leaf from the stem in each sector: a blade's bounding sphere (its centre's sector, its far edge)
        for (const auto& pc : soup.clusters) {
            for (const auto& leaf : pc.mesh->leafSpheres) {
                const Vec3 c = detail::transformPoint(pc.in.t, pc.in.q, pc.in.s, leaf.c);
                const double dx = c.x - in.stemX, dz = c.z - in.stemZ;
                double& s = m.spread[static_cast<size_t>(detail::sectorOf(dx, dz))];
                s = std::max(s, std::hypot(dx, dz) + leaf.r * pc.in.s.x);
            }
        }
    };
    finish(T.level0, soup0, track0);
    finish(T.level1, soup1, track1);
    finish(T.nearMid, soupNM, trackNM);
    if (T.coverage.measured) {
        const auto cut = detail::leafCutout(P, in.cutoutFill, in.cutoutAspect);
        auto levelOf = [&](auto pick, const detail::CoverageViews::Cutout* c) {
            cov.clearCovered();
            for (size_t k = 0; k < T.clusters.size(); ++k) for (const auto& inst : T.clusters[k]) cov.add(pick(lib.variants[k]), inst, c);
            return cov.level();
        };
        auto near = [](const ClusterVariant& v) -> const LibraryMesh& { return v.level0; };
        auto nearMid = [](const ClusterVariant& v) -> const LibraryMesh& { return v.nearMid; };
        auto mid = [](const ClusterVariant& v) -> const LibraryMesh& { return v.level1; };
        T.coverage.level0 = levelOf(near, nullptr);
        T.coverage.nearMid = levelOf(nearMid, nullptr);
        T.coverage.mid = levelOf(mid, nullptr);
        if (in.cutoutFill > 0) {
            T.coverage.level0Cutout = levelOf(near, &cut);
            T.coverage.midCutout = levelOf(mid, &cut);
        }
    }
    T.msMeasure = msSince(tPhase);
}

/** The crown ellipsoid of a tree's level-0 leaves: the hull points of each placed cluster, in the tree's frame. */
inline CrownEllipsoid crownOfLeaves(const TreeLod& T, const ClusterLibrary& lib) {
    std::vector<Vec3> pts;
    for (size_t k = 0; k < T.clusters.size() && k < lib.variants.size(); ++k) {
        const auto& support = lib.variants[k].level0.support;
        for (const auto& in : T.clusters[k]) {
            if (support.empty()) { pts.push_back(in.t); continue; }
            for (const auto& sp : support) pts.push_back(detail::transformPoint(in.t, in.q, in.s, sp));
        }
    }
    return fitCrownEllipsoid(pts);
}

// ================================================================================================
// the crown's lobes: a smooth union of spheres, so a viewer's crown keeps its real bulges
// ================================================================================================

/** One placed leaf cluster as the lobe fit sees it: where it is and points on its hull (tree frame). */
struct LobeSeed {
    Vec3 centre;
    std::vector<Vec3> points;
};

/**
 * A crown as a smooth union of spheres (centre xyz, radius), in the frame of its seeds. A viewer evaluates the smooth
 * minimum f(x) = -k log sum exp(-(|x - c_i| - r_i) / k) with k = blendM and shades the leaves with its gradient, so the
 * crown keeps its lobes but stays soft.
 */
struct CrownLobes {
    std::vector<std::array<double, 4>> lobes;
    double blendM{0};
    bool valid() const { return !lobes.empty() && blendM > 0; }
};

/**
 * Groups leaf clusters into lobes. The number of lobes is the crown's volume (the ellipsoid of all hull points) over the
 * volume of a sphere of `targetRadiusM`, rounded, within [1, maxLobes] and never more than the seeds. The groups are
 * k-means on the cluster centres, started from the seed farthest from the centroid and then each seed farthest from the
 * ones taken (deterministic); a lobe's centre is its seeds' mean centre and its radius covers the `coverQuantile` of its
 * seeds' hull points (never below minRadius). The blend radius is blendPerRadius times the mean lobe radius.
 */
inline CrownLobes fitCrownLobes(const std::vector<LobeSeed>& seeds, int maxLobes, double targetRadiusM, double coverQuantile, double blendPerRadius, double minRadius = 0.25) {
    CrownLobes out;
    if (seeds.empty() || maxLobes < 1 || !(targetRadiusM > 0)) return out;
    std::vector<Vec3> all;
    for (const auto& s : seeds) { if (s.points.empty()) all.push_back(s.centre); else all.insert(all.end(), s.points.begin(), s.points.end()); }
    const CrownEllipsoid e = fitCrownEllipsoid(all, 0.02, minRadius);
    const double vol = e.valid() ? e.radii[0] * e.radii[1] * e.radii[2] : 0.0;
    const double ratio = vol / (targetRadiusM * targetRadiusM * targetRadiusM);
    const size_t K = static_cast<size_t>(std::clamp<long>(std::lround(ratio), 1L, static_cast<long>(std::min<size_t>(static_cast<size_t>(maxLobes), seeds.size()))));
    // farthest-point start
    Vec3 mean(0, 0, 0);
    for (const auto& s : seeds) mean += s.centre;
    mean = mean / static_cast<float>(seeds.size());
    std::vector<Vec3> c;
    size_t first = 0;
    for (size_t i = 1; i < seeds.size(); ++i) if ((seeds[i].centre - mean).lengthSquared() > (seeds[first].centre - mean).lengthSquared()) first = i;
    c.push_back(seeds[first].centre);
    std::vector<double> dmin(seeds.size(), std::numeric_limits<double>::infinity());
    while (c.size() < K) {
        size_t best = 0;
        double bestD = -1;
        for (size_t i = 0; i < seeds.size(); ++i) {
            dmin[i] = std::min(dmin[i], static_cast<double>((seeds[i].centre - c.back()).lengthSquared()));
            if (dmin[i] > bestD) { bestD = dmin[i]; best = i; }
        }
        if (bestD <= 0) break;
        c.push_back(seeds[best].centre);
    }
    // Lloyd iterations
    std::vector<size_t> owner(seeds.size(), std::numeric_limits<size_t>::max());
    for (int it = 0; it < 16; ++it) {
        bool moved = false;
        for (size_t i = 0; i < seeds.size(); ++i) {
            size_t b = 0;
            for (size_t k = 1; k < c.size(); ++k) if ((seeds[i].centre - c[k]).lengthSquared() < (seeds[i].centre - c[b]).lengthSquared()) b = k;
            if (b != owner[i]) { moved = true; owner[i] = b; }
        }
        if (!moved) break;
        std::vector<Vec3> sum(c.size(), Vec3(0, 0, 0));
        std::vector<size_t> n(c.size(), 0);
        for (size_t i = 0; i < seeds.size(); ++i) { sum[owner[i]] += seeds[i].centre; ++n[owner[i]]; }
        for (size_t k = 0; k < c.size(); ++k) if (n[k]) c[k] = sum[k] / static_cast<float>(n[k]);
    }
    const double q = std::clamp(coverQuantile, 0.0, 1.0);
    double rSum = 0;
    for (size_t k = 0; k < c.size(); ++k) {
        std::vector<double> d;
        for (size_t i = 0; i < seeds.size(); ++i) {
            if (owner[i] != k) continue;
            if (seeds[i].points.empty()) d.push_back((seeds[i].centre - c[k]).length());
            for (const auto& p : seeds[i].points) d.push_back((p - c[k]).length());
        }
        if (d.empty()) continue;
        std::sort(d.begin(), d.end());
        const double r = std::max(minRadius, d[static_cast<size_t>(std::floor(q * static_cast<double>(d.size() - 1)))]);
        out.lobes.push_back({static_cast<double>(c[k].x), static_cast<double>(c[k].y), static_cast<double>(c[k].z), r});
        rSum += r;
    }
    if (!out.lobes.empty()) out.blendM = std::max(1e-3, blendPerRadius * rSum / static_cast<double>(out.lobes.size()));
    return out;
}

/** The lobes of a tree's level-0 leaves (the hull points of each placed cluster, in the tree's frame), with the library's parameters. */
inline CrownLobes crownLobesOfLeaves(const TreeLod& T, const ClusterLibrary& lib) {
    std::vector<LobeSeed> seeds;
    for (size_t k = 0; k < T.clusters.size() && k < lib.variants.size(); ++k) {
        const auto& v = lib.variants[k].level0;
        for (const auto& in : T.clusters[k]) {
            LobeSeed s;
            s.centre = v.leafSpheres.empty() ? in.t : detail::transformPoint(in.t, in.q, in.s, v.bladeCentre);
            for (const auto& sp : v.support) s.points.push_back(detail::transformPoint(in.t, in.q, in.s, sp));
            seeds.push_back(std::move(s));
        }
    }
    const LodParams& P = lib.params;
    return fitCrownLobes(seeds, P.crownLobeMax, P.crownLobeRadiusM, P.crownLobeCoverQuantile, P.crownLobeBlendPerRadius);
}

} // namespace tree_lod
} // namespace scratchbox

#endif // SCRATCHBOX_TREE_LOD_HPP
