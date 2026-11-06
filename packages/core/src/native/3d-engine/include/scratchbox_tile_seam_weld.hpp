/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_TILE_SEAM_WELD_HPP
#define SCRATCHBOX_TILE_SEAM_WELD_HPP

/**
 * Tile-chunk seam weld: a bounded, position-only pre-pass that closes the real gaps between
 * adjacent Google 3D Tiles chunks in a just-loaded scan, and drops the slivers that collapse out of
 * them, before anything reads wall planes or wall directions out of the mesh.
 *
 * What it does (docs/processes/tile_seam_weld.md has the measurements):
 *   1. Position groups. Vertices at the same position (bit-identical float3) are one group: the
 *      GLB reader splits a chunk into UV islands and a chunk's own skirt shares the chunk's border
 *      vertices, so a border point is usually several vertex ids. A group moves as one, so a weld
 *      never tears a chunk away from its own skirt or UV neighbour.
 *   2. Pieces. Connected components of groups through triangle edges: a chunk with all its islands
 *      and skirts is one piece; different chunks never share a position before this pass runs.
 *   3. Strip pieces and boundary. A piece every triangle of which is a sliver (altitude at most the
 *      tolerance, aspect at least sliverAspectMin) is a strip no wider than the seam: dropped whole,
 *      not repositioned, before the weld (a genuine surface is never that thin everywhere). The
 *      boundary is then a group on an edge used by exactly one remaining triangle.
 *   4. Contacts. For every boundary group, the nearest boundary group of a different piece within
 *      the tolerance (uniform grid, exact distances). Of a pair, the group of the higher piece id
 *      moves onto the other group's original position (a fixed tie-break: exactly one side moves,
 *      and targets are read from original positions, so welds never cascade). Where three pieces
 *      meet, a short target chain (A->B->C) is followed while the total move stays within the
 *      tolerance, so the corner closes on one point.
 *   5. Guard. A triangle that a move would turn inside out (its normal reverses) and that does not
 *      itself collapse is a surface this vertex belonged to: the move is reverted and counted.
 *   6. Slivers. A triangle touched by a move whose remaining altitude is at most
 *      sliverAltitudeFraction x tolerance and whose aspect is at least sliverAspectMin is dropped.
 *      That is the strip that bridged the gap (its short edge was the gap, so it collapses when the
 *      gap closes); ordinary geometry, with edges of tens of centimetres or more, is moved by at most
 *      the tolerance and keeps its shape.
 *
 * Two more passes (TileSeamWeld::trimOverlaps before the weld, closeTJunctions after it) close what a vertex-to-vertex
 * weld cannot: where two pieces cover the same surface, the higher piece's border triangles lying wholly over the lower
 * piece go, ring by ring; where a border position lies on the interior of another piece's border edge (a T-junction,
 * half the seams of a district extraction), it moves onto the edge and the edge's triangle is split at it, so the pieces
 * share the point. The staged location runs all three on the extraction as it arrives (tile-seam-weld-service.ts).
 *
 * Then, tile by tile (each triangle's source tile carried through every pass as a side array, triangleTile): the adaptive
 * close (closeAdaptive) takes the gaps the fixed 3 cm passes leave, up to the smaller of the two tiles' stated geometric
 * errors, capped, only where the two surfaces agree (same facing, parallel borders, no step: each surface carried across
 * the seam meets the other); the strip fill (fillStrips) bridges, with thin triangles labelled generated, the agreed gaps a
 * move would have distorted. The seam audit (auditSeams) measures the open border by its gap to the nearest other tile,
 * inside the extraction's cut border, before and after. First of all, where the tiles' boxes are known, the caps two tiles
 * carry back to back in a shared cut plane are removed (trimCapsByBox). Last, the seam tone feather (featherSeamTone) levels the two tiles'
 * photos' colour toward each other on the surfaces crossing every cut their boxes share, faded out over a band.
 * Why it runs where it runs: scratchbox_scan_rectifier.hpp's own D1 weld (weldEpsilon, 1 mm) is far
 * tighter than a 1-3 cm tile seam, and its D4 orientation-family vote and D5 planar regions run four
 * stages before its own D8 seam close (tJunctionTolerance, 3 cm), so even inside the rectifier the
 * wall-direction vote sees the seam. scan_fit.hpp (the fit stage) never sees the rectifier at all:
 * it reads tile_refine's raw clay, written straight from the loaded scan, welds at 1 mm and grows
 * its planes over triangle adjacency, which a 1-3 cm gap breaks. One pre-pass on the scan the moment
 * it is loaded, before isolation, relief or rectification touch it, reaches every later consumer.
 *
 * Every tolerance here is a continuous metric; nothing in this file knows what a building, a tile or
 * a skirt is.
 */

#include "scratchbox_geometry.hpp"
#include "scratchbox_gltf_scene.hpp"
#include "scratchbox_jpeg.hpp"
#include "scratchbox_png.hpp"
#include "scratchbox_scan_rectifier.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <functional>
#include <limits>
#include <mutex>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace scratchbox {
namespace tile_seam_weld {

using scan_rectifier::V3;
using scan_rectifier::kFlagHidden;
using scan_rectifier::kFlagKeep;

// ============================================================================
// Parameters (continuous metric tolerances only)
// ============================================================================
struct TileSeamWeldParams {
    /**
     * A boundary group of one piece snaps onto the nearest boundary group of another piece when
     * they lie at most this far apart. Default 0.03 m: the measured real-seam band on a leaf-LOD
     * extraction tops out at 3 cm, and it is the tolerance scan_rectifier's own D8 already calls a
     * contact closeable (tJunctionTolerance), so a tile that later also runs the rectifier sees one
     * idea of "closed".
     */
    double weldToleranceM{0.03};
    /** Grid padding beyond weldToleranceM when searching for a partner (the histogram counts contacts
     *  out to weldToleranceM + searchPadM; only those within weldToleranceM move). */
    double searchPadM{0.01};
    /**
     * A triangle touched by a move is dropped only when its post-weld altitude (narrowest dimension)
     * is at most this fraction of weldToleranceM. Default 0.5.
     */
    double sliverAltitudeFraction{0.5};
    /**
     * A dropped triangle must also be at least this elongated (longest edge / altitude). Default 4.0,
     * above the measured whole-mesh median aspect ratio (2.75, Haughwout sample), so a small but
     * regular triangle near a seam is not caught. A very large value turns the drop off.
     */
    double sliverAspectMin{4.0};
    /**
     * Drop every piece whose triangles are all slivers (altitude <= weldToleranceM, aspect >=
     * sliverAspectMin) before welding: a strip lying in a seam, no wider than the seam anywhere. The
     * weld then closes the chunks it stood between. Default true.
     */
    bool dropStripPieces{true};
    /** Longest target chain followed where several pieces meet at one point. */
    int maxChainHops{4};
    /** Worker threads for the grid search (0 = hardware concurrency). */
    int threads{0};
};

// ============================================================================
// Result
// ============================================================================
struct TileSeamWeldStats {
    size_t vertexCount{0};
    size_t triangleCount{0};
    /** Distinct positions. */
    size_t groupCount{0};
    /** Connected pieces (through shared positions). */
    size_t pieceCount{0};
    size_t boundaryGroups{0};
    size_t boundaryEdges{0};
    /** Boundary groups with a boundary group of another piece within weldToleranceM + searchPadM. */
    size_t contactsFound{0};
    /** Boundary groups moved (gap <= weldToleranceM, after the guard). */
    size_t groupsWelded{0};
    /** Vertices moved (members of the welded groups). */
    size_t vertsWelded{0};
    /** Moves taken back because they would have turned a kept triangle inside out. */
    size_t groupsReverted{0};
    /** Moves resolved through a chain of targets (three or more pieces at one point). */
    size_t chainedWelds{0};
    /** Pieces dropped whole because every triangle of them is a sliver (strips lying in a seam). */
    size_t stripPiecesDropped{0};
    size_t stripTrianglesDropped{0};
    /** Triangles dropped in all: the strip pieces plus the triangles the weld collapsed. */
    size_t trianglesDropped{0};
    /** Of the collapsed triangles, those that were not slivers before the weld. */
    size_t trianglesCollapsed{0};
    double meanWeldDisplacementM{0};
    double maxWeldDisplacementM{0};
    /** Gap histogram of every contact found, bucketed like scan_rectifier's own gapHistogram:
     *  [0, 1mm, 5mm, 1cm, 3cm, 10cm). */
    std::array<size_t, 6> gapHistogram{};
};

struct TileSeamWeldResult {
    bool ok{false};
    std::string error;
    /** Per-triangle, in mesh.indices order: 1 keep (scan_rectifier::kFlagKeep), 0 dropped
     *  (scan_rectifier::kFlagHidden). Empty when ok is false. */
    std::vector<uint8_t> keepTriangle;
    TileSeamWeldStats stats;
};

/** The overlap trim and the T-junction closure (TileSeamWeld::trimOverlaps, closeTJunctions): continuous metric tolerances only. */
struct TileSeamCloseParams {
    /** T-junction: a border position at most this far from another piece's border edge moves onto it (default 0.03 m, the weld's own). */
    double toleranceM{0.03};
    /** T-junction: the point must lie at least this far from either end of the edge, and be nearer the edge than to either end
     *  by this much (the ends are the vertex weld's case). */
    double endGuardM{0.002};
    /** T-junction: a border position within this of another piece's position is already shared (no T-junction). */
    double sharedM{1e-5};
    double tJunctionCellM{0.5};
    int tJunctionRounds{3};
    /** Overlap: a border triangle lies over another piece's surface when every probe is within this of it (default 0.03 m). 0 = off. */
    double overlapToleranceM{0.03};
    /** Overlap: the covering triangle faces the same way within this cosine. */
    double overlapFacingCos{0.9};
    double overlapCellM{1.0};
    /** Overlap: rings trimmed in from a piece's border at most. */
    int overlapRounds{12};
    int threads{0};
};

struct TileSeamTrimStats {
    size_t trianglesDropped{0};
    double areaM2{0};
    size_t roundsRun{0};
};

struct TileSeamTJunctionStats {
    size_t borderEdges{0};
    /** Border positions on another piece's edge interior in the first round. */
    size_t found{0};
    /** Of all rounds: positions moved onto the edge and split into it. */
    size_t closed{0};
    size_t edgesSplit{0};
    size_t trianglesAdded{0};
    /** Moves taken back because they would have turned a triangle inside out. */
    size_t reverted{0};
    /** Points whose triangle was already split that round (closed in a later round when there is one). */
    size_t deferred{0};
    size_t roundsRun{0};
    double maxMoveM{0};
};

/**
 * The seam audit (TileSeamWeld::auditSeams): every open edge (a position-space edge one triangle uses) inside the cut border,
 * by its gap to the nearest open edge of a different source tile. The cut border is where the extraction itself ends: an
 * open edge whose plan neighbourhood (within cutMarginM) holds a cell no triangle covers is the cut, not a seam.
 */
struct TileSeamAuditParams {
    double cutCellM{1.0};
    double cutMarginM{2.0};
    /** Gaps are looked for this far; an edge with no other tile's open edge within it is in the last band. */
    double searchM{1.0};
    int threads{0};
};

/** Band edges of the audit in metres: [0, 3 cm), [3, 10 cm), [10, 30 cm), [30 cm, 1 m), none within searchM. */
constexpr double kSeamAuditBandsM[4] = {0.03, 0.10, 0.30, 1.0};

struct TileSeamAudit {
    /** Open edge length (m) inside the cut border, by gap band (kSeamAuditBandsM, then none within searchM). */
    std::array<double, 5> bandLengthM{};
    std::array<size_t, 5> bandEdges{};
    /** Open edge length on the cut border (left out of the bands). */
    double atCutM{0};
    size_t openEdges{0};
    size_t tiles{0};
};

/** The plan cells the extraction covers (TileSeamWeld::cutMask), taken once from the input so before and after are judged alike. */
struct TileSeamCutMask {
    double cellM{1.0};
    int64_t x0{0}, z0{0};
    int64_t w{0}, h{0};
    std::vector<uint8_t> covered;
    bool at(int64_t ix, int64_t iz) const { return ix >= x0 && iz >= z0 && ix < x0 + w && iz < z0 + h && covered[static_cast<size_t>((iz - z0) * w + (ix - x0))]; }
};

/**
 * The adaptive close (TileSeamWeld::closeAdaptive), after the fixed passes: a border position of one tile and the nearest
 * open border of another tile close up to the smaller of the two tiles' stated geometric errors, capped, only where the two
 * surfaces agree there. Continuous metric tolerances only.
 */
struct TileSeamAdaptiveParams {
    /** The tolerance of a pair where either tile states no geometric error (the fixed passes' own). */
    double baseToleranceM{0.03};
    /** Never further than this, whatever the tiles state. */
    double capM{0.30};
    /** Each side's surface is read from its own triangles within this of the seam point. */
    double surfaceRadiusM{0.75};
    /** The two surfaces face the same way within this. */
    double normalTolDeg{8.0};
    /** The two open borders run parallel within this. */
    double parallelTolDeg{20.0};
    /** No step: each side's surface, carried across the seam, passes within stepTolM + stepSlope x the distance of the other's. */
    double stepTolM{0.03};
    double stepSlope{0.05};
    /** A close is refused (left to the strip fill) when it turns a triangle by more than this, or inside out (0: every close is). */
    double maxTurnDeg{25.0};
    double endGuardM{0.002};
    double sharedM{1e-5};
    int rounds{6};
    int threads{0};
};

struct TileSeamAdaptiveStats {
    /** Border positions with another tile's open border within their pair's tolerance (first round). */
    size_t candidates{0};
    size_t agreed{0};
    size_t refusedNormal{0};
    size_t refusedParallel{0};
    size_t refusedStep{0};
    size_t refusedNoSurface{0};
    /** Contacts (first round) by the angle between the two surfaces: [0, 2, 5, 8, 15, 30, 90, 150, 180] degrees. */
    std::array<size_t, 8> normalAngleHist{};
    /** Agreed contacts (first round) by gap: [0, 3 cm), [3, 10 cm), [10, 30 cm), 30 cm and over. */
    std::array<size_t, 4> agreedByGap{};
    /** Points split into another tile's edge (the edge's tile moved to the point). */
    size_t splitsClosed{0};
    size_t edgesSplit{0};
    size_t trianglesAdded{0};
    /** Positions moved onto another tile's position. */
    size_t vertexMoves{0};
    size_t trianglesCollapsed{0};
    /** Closes the distortion guard took back (left for the strip fill). */
    size_t guardRefused{0};
    size_t roundsRun{0};
    double maxMoveM{0};
    double meanMoveM{0};
    /** The pair tolerances used: how many contacts came from tiles stating an error, and the largest tolerance used. */
    size_t pairsWithStatedError{0};
    double maxToleranceM{0};
};

struct TileSeamFillStats {
    size_t edgesFilled{0};
    size_t triangles{0};
    double areaM2{0};
    /** Open edges with an agreed partner on both ends that were not filled (a fill triangle would have folded). */
    size_t refused{0};
};

/** A source tile's bounding box in the mesh's frame: its centre and three half-axes (the tileset's, taken into the frame). */
struct TileBox { V3 c; V3 h[3]; bool valid{false}; };

/** The cap removal (TileSeamWeld::trimCapsByBox): continuous metric tolerances only. */
struct TileCapParams {
    /** A cap lies within this of its box face (most boxes bound the cut within centimetres; some stand half a metre loose,
     *  so two neighbours' boxes overlap by a metre). What makes it a cap is the neighbour's cap behind it, not this. */
    double capPlaneM{0.75};
    double capFacingCos{0.97};
    /** Two boxes' faces are one cut when their planes lie within this. */
    double faceMatchM{1.2};
    /** The neighbour's cap backs this one within this: two tiles' caps lie in one cut plane, centimetres apart. Kept well
     *  under a wall's thickness: the two faces of a thin wall or parapet standing along a cut, one in each tile, are also
     *  back to back near a shared box face, and must stay. */
    double backingM{0.10};
    int threads{0};
};
struct TileCapStats { size_t sharedFaces{0}; size_t candidates{0}; size_t trianglesDropped{0}; double areaM2{0}; };

/**
 * The step blend (TileSeamWeld::blendCutSteps) and the per-cut scores (measureCuts). At a cut, the two tiles' walls sit at
 * slightly different depths: seen in the cut plane, each tile's rim (its open border along the cut, once the caps are gone)
 * traces the same outline, a few centimetres to decimetres apart. That offset is the surface step.
 */
struct TileSeamBlendParams {
    /** Two boxes' faces are one cut when their planes lie within this (loose boxes overlap by up to a metre). */
    double faceMatchM{1.2};
    /** A rim is an open border edge of a surface crossing the cut (|normal . cut normal| <= crossCos) within this of the cut plane. */
    double bandM{1.0};
    double marginM{0.5};
    double crossCos{0.5};
    /** A step is matched and moved only within the smaller of the two tiles' stated errors, capped at this (m). */
    double capM{0.5};
    /** The two rims run parallel where they are matched (in the cut plane). */
    double parallelCos{0.866};
    /** Each side moves half the step at its rim, faded to nothing this far from it along the cut's normal (raised cosine). */
    double falloffM{1.5};
    /** A vertex follows the rim point nearest it in the cut plane, when that lies within this (the same wall). */
    double wallReachM{0.6};
    /** A move turning a triangle by more than this, or inside out, is taken back. */
    double maxTurnDeg{25.0};
    /** The rim zip's rounds (each halves what is left where only one rim has a point to move). */
    int zipRounds{5};
    /** The rim zip's take-back leaves out triangles no wider than this (their facing means nothing; the weld's own tolerance). */
    double zipSliverM{0.03};
    int threads{0};
};

/** One cut's score: what a seam there measures (continuous measures only). */
struct TileSeamCutScore {
    uint32_t tiles[2]{0, 0};
    V3 u;
    double o{0};
    /** Open border length of the two tiles along the cut (m), and how much of it found the other tile's rim. */
    double rimLengthM{0};
    double matchedLengthM{0};
    /** The surface step between the two rims in the cut plane (m): median and 90th percentile over matched rim points. */
    double stepP50M{0}, stepP90M{0};
    /** The gap between the two rims along the cut's normal (m, median of absolute values): open when positive, overlapping too. */
    double gapP50M{0};
};

struct TileSeamBlendStats {
    size_t cuts{0};
    size_t cutsMatched{0};
    size_t positionsMoved{0};
    size_t reverted{0};
    double maxMoveM{0};
    std::vector<TileSeamCutScore> before, after;
};

/** One cut's rim zip: how many rim points moved and how far (m). */
struct TileSeamCutMove {
    uint32_t tiles[2]{0, 0};
    V3 u;
    double o{0};
    size_t points{0};
    double meanMoveM{0}, maxMoveM{0};
};

struct TileSeamZipStats {
    size_t cuts{0};
    size_t cutsZipped{0};
    size_t positionsMoved{0};
    /** Rim points whose way to the other rim is longer than the pair's tolerance: left where they are. */
    size_t beyondError{0};
    size_t reverted{0};
    double maxMoveM{0};
    std::vector<TileSeamCutMove> perCut;
    std::vector<TileSeamCutScore> before, after;
};

/**
 * Picture offset across the cuts (TileSeamWeld::measureSeamOffsets): how far one tile's photo would have to slide along
 * a cut to line up with the other's. On each wall crossing a cut, a grey profile is read either side along the wall
 * (cellM cells, within sampleM of the cut, in segmentM pieces), and the two profiles are correlated at every shift up
 * to maxShiftM. A segment counts when both sides read at least minCells cells in common and carry a picture (contrast).
 */
struct TileSeamOffsetParams {
    double faceMatchM{0.12};
    /** The strip read either side of the cut: narrow, so both sides show the same part of the wall (a metre away they show
     *  different storeys, and correlate at 0.25 where a 0.2 m strip correlates at 0.66). */
    double sampleM{0.2};
    double crossCos{0.5};
    /** A profile cell along the wall: about a leaf photo's texel (0.155 m on the ESB and the Penn district). */
    double cellM{0.15};
    double segmentM{8.0};
    double maxShiftM{0.8};
    size_t minCells{16};
    /** A profile with less spread than this (grey levels) carries no picture to line up. */
    double minContrast{4.0};
    /** A segment is off when its best correlation is at least this, stands this much above the one at no shift, and lies a cell or more away. */
    double clearNcc{0.6};
    double clearGain{0.05};
    int threads{0};
};
struct TileSeamCutOffset {
    uint32_t tiles[2]{0, 0};
    V3 u;
    double o{0};
    size_t segments{0}, segmentsOff{0};
    /** Median over the cut's segments: correlation at no shift, the best shift's size (m, and in the photos' texels). */
    double nccAtZeroP50{0}, shiftP50M{0}, shiftP50Texels{0};
};
struct TileSeamOffsetStats {
    size_t cuts{0};
    /** Segments read on both sides, those with a picture, and those whose best match is clearly off no shift. */
    size_t segmentsRead{0}, segments{0}, segmentsOff{0};
    double nccAtZeroP50{0}, nccAtZeroP10{0};
    double shiftP50M{0}, shiftP90M{0}, shiftP50Texels{0}, shiftP90Texels{0};
    /** Among the segments that are off: their shift's median (m) and the correlation gained by it. */
    double offShiftP50M{0}, offGainP50{0};
    double texelP50M{0};
    std::vector<TileSeamCutOffset> perCut;
};

// ============================================================================
// Seam tone feather: the two tiles' photos levelled toward each other across every cut two tiles share
// ============================================================================

struct TileSeamToneParams {
    /** Two boxes' faces are one cut when their planes lie within this (the tileset's boxes are 5-10 cm loose). */
    double faceMatchM{0.12};
    /** Each side's tone is read from its photo within this of the cut (a tile's photo is coarse: 256-512 texels for ~30 m). */
    double sampleM{1.0};
    /** The levelling fades to nothing this far from the cut, on each side. */
    double bandM{2.5};
    /** Bins along the cut (m): the tone step is read and levelled per bin, so it may change along the seam. */
    double binM{2.0};
    /** Only surfaces crossing the cut (|normal . cut normal| below this) are levelled: never a cap lying in the cut. */
    double crossCos{0.5};
    /** A bin is levelled only when each side read at least this many texels in it. */
    size_t minTexels{8};
    /** No channel is scaled by more than this either way. */
    double maxGain{1.6};
    /** A levelled photo that came as a JPEG is written back as one at this quality. */
    int jpegQuality{92};
    /** The feather itself (off: only the balance below, when that is on). */
    bool feather{true};
    /** Tone balance: one gain per tile and channel for the whole scan, fitted over all its cuts at once, before the feather. */
    bool balance{false};
    /** A cut counts in the fit when its bins both sides read hold at least this many texels together. */
    size_t balanceMinTexels{64};
    /** No tile's channel is scaled by more than this either way. */
    double balanceMaxGain{1.6};
    /** The fit's pull of every gain toward none, as a share of a tile's cut weight: it pins the scan's overall level
     *  (a fit of differences alone leaves it free) and keeps a tile joined by one weak cut near its own level. */
    double balanceRidge{0.02};
    /** A cut whose step stands further than this (log gain) from the fit counts less, in proportion. */
    double balanceHuber{0.05};
    int threads{0};
};

struct TileSeamToneStats {
    size_t cuts{0};
    size_t binsMatched{0};
    size_t imagesChanged{0};
    size_t texelsChanged{0};
    /** The photos rewritten (scene.images indices). */
    std::vector<uint32_t> changedImages;
    double maxGain{1};
    /** The CIELAB step between the two sides' mean colours per matched bin, weighted by texels: before and after. */
    double dEBeforeP50{0}, dEBeforeP90{0}, dEAfterP50{0}, dEAfterP90{0};
    /** Tone balance: tiles given a gain, cuts in the fit, the largest gain either way, the mean log gain over tiles and
     *  channels (the scan's overall drift: near none), and the step after the balance, before the feather. */
    size_t tilesBalanced{0}, balanceCuts{0};
    double balanceMaxGain{1}, balanceMeanLogGain{0};
    double dEBalancedP50{0}, dEBalancedP90{0};
};

namespace tone_detail {
inline double toLinear(double c) { return c <= 0.04045 ? c / 12.92 : std::pow((c + 0.055) / 1.055, 2.4); }
inline double toSrgb(double c) { c = std::clamp(c, 0.0, 1.0); return c <= 0.0031308 ? 12.92 * c : 1.055 * std::pow(c, 1.0 / 2.4) - 0.055; }
inline std::array<double, 3> lab(const std::array<double, 3>& rgbLinear) {
    const double X = 0.4124 * rgbLinear[0] + 0.3576 * rgbLinear[1] + 0.1805 * rgbLinear[2];
    const double Y = 0.2126 * rgbLinear[0] + 0.7152 * rgbLinear[1] + 0.0722 * rgbLinear[2];
    const double Z = 0.0193 * rgbLinear[0] + 0.1192 * rgbLinear[1] + 0.9505 * rgbLinear[2];
    auto f = [](double t) { return t > 0.008856 ? std::cbrt(t) : 7.787 * t + 16.0 / 116.0; };
    const double fx = f(X / 0.9505), fy = f(Y), fz = f(Z / 1.089);
    return {116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)};
}
}  // namespace tone_detail

// ============================================================================
// Kernel
// ============================================================================
class TileSeamWeld {
    /** Positions grouped bit-identically, and the pieces they form through triangle edges. */
    struct Topology { std::vector<uint32_t> groupOf; std::vector<V3> gpos; std::vector<uint32_t> piece; };
    static Topology topology(const geometry::ScratchboxMesh& mesh) {
        Topology o;
        const size_t V = mesh.vertices.size(), F = mesh.indices.size() / 3;
        o.groupOf.resize(V);
        std::unordered_map<uint64_t, uint32_t> byKey;
        byKey.reserve(V);
        for (uint32_t v = 0; v < V; ++v) {
            const auto& q = mesh.vertices[v].position;
            uint32_t bx, by, bz;
            std::memcpy(&bx, &q.x, 4); std::memcpy(&by, &q.y, 4); std::memcpy(&bz, &q.z, 4);
            const uint64_t k = (static_cast<uint64_t>(bx) * 0x9E3779B97F4A7C15ull) ^ (static_cast<uint64_t>(by) * 0xC2B2AE3D27D4EB4Full) ^ (static_cast<uint64_t>(bz) << 1);
            auto it = byKey.find(k);
            if (it == byKey.end()) { it = byKey.emplace(k, static_cast<uint32_t>(o.gpos.size())).first; o.gpos.push_back(V3{q.x, q.y, q.z}); }
            o.groupOf[v] = it->second;
        }
        const size_t G = o.gpos.size();
        scan_rectifier::detail::UnionFind uf(G);
        for (size_t t = 0; t < F; ++t) { const uint32_t a = o.groupOf[mesh.indices[3 * t]]; uf.unite(a, o.groupOf[mesh.indices[3 * t + 1]]); uf.unite(a, o.groupOf[mesh.indices[3 * t + 2]]); }
        o.piece.resize(G);
        std::vector<uint32_t> ren(G, UINT32_MAX);
        uint32_t next = 0;
        for (size_t g = 0; g < G; ++g) { uint32_t& m = ren[uf.find(static_cast<uint32_t>(g))]; if (m == UINT32_MAX) m = next++; o.piece[g] = m; }
        return o;
    }

public:
    /** Each vertex's piece (connected through shared positions), taken before any pass joins pieces: the T-junction closure
     *  reads which piece a position and an edge belong to from it, not from connectivity a weld has already merged. */
    static std::vector<uint32_t> vertexPieces(const geometry::ScratchboxMesh& mesh) {
        const Topology t = topology(mesh);
        std::vector<uint32_t> out(mesh.vertices.size());
        for (size_t v = 0; v < out.size(); ++v) out[v] = t.piece[t.groupOf[v]];
        return out;
    }
    static std::string trimStatsJson(const TileSeamTrimStats& s) {
        char b[64]; std::snprintf(b, sizeof b, "%.1f", s.areaM2);
        return "\"trianglesDropped\": " + std::to_string(s.trianglesDropped) + ", \"areaM2\": " + b + ", \"roundsRun\": " + std::to_string(s.roundsRun);
    }
    static std::string tJunctionStatsJson(const TileSeamTJunctionStats& s) {
        char b[64]; std::snprintf(b, sizeof b, "%.6g", s.maxMoveM);
        return "\"borderEdges\": " + std::to_string(s.borderEdges) + ", \"found\": " + std::to_string(s.found) + ", \"closed\": " + std::to_string(s.closed) +
            ", \"edgesSplit\": " + std::to_string(s.edgesSplit) + ", \"trianglesAdded\": " + std::to_string(s.trianglesAdded) + ", \"reverted\": " + std::to_string(s.reverted) +
            ", \"deferred\": " + std::to_string(s.deferred) + ", \"roundsRun\": " + std::to_string(s.roundsRun) + ", \"maxMoveM\": " + b;
    }

    /**
     * Welds matching tile-piece boundary groups within params.weldToleranceM onto each other
     * (mutates mesh.vertices[*].position in place) and marks the triangles the weld collapses into
     * slivers for removal. Does not touch UVs, normals, colour or material; does not remove vertices
     * (only triangles); does not run a solver.
     */
    static TileSeamWeldResult weldAndMarkSlivers(geometry::ScratchboxMesh& mesh, const TileSeamWeldParams& p = {}, const std::vector<uint32_t>* vertexPiece = nullptr) {
        TileSeamWeldResult res;
        const size_t V = mesh.vertices.size();
        const size_t F = mesh.indices.size() / 3;
        res.stats.vertexCount = V;
        res.stats.triangleCount = F;
        if (V == 0 || F == 0) { res.error = "mesh has no triangles"; return res; }
        for (size_t i = 0; i < 3 * F; ++i) if (mesh.indices[i] >= V) { res.error = "triangle index out of range"; return res; }

        auto vpos = [&](uint32_t v) { const auto& q = mesh.vertices[v].position; return V3{q.x, q.y, q.z}; };

        // ---- 1. position groups (bit-identical float3, the same key passThroughMesh / the GLB writers weld on)
        std::vector<uint32_t> groupOf(V);
        std::vector<V3> gpos;
        {
            std::unordered_map<uint64_t, uint32_t> byKey;
            byKey.reserve(V);
            for (uint32_t v = 0; v < V; ++v) {
                const auto& q = mesh.vertices[v].position;
                uint32_t bx, by, bz;
                std::memcpy(&bx, &q.x, 4); std::memcpy(&by, &q.y, 4); std::memcpy(&bz, &q.z, 4);
                const uint64_t k = (static_cast<uint64_t>(bx) * 0x9E3779B97F4A7C15ull) ^ (static_cast<uint64_t>(by) * 0xC2B2AE3D27D4EB4Full) ^ (static_cast<uint64_t>(bz) << 1);
                auto it = byKey.find(k);
                if (it == byKey.end()) { it = byKey.emplace(k, static_cast<uint32_t>(gpos.size())).first; gpos.push_back(vpos(v)); }
                groupOf[v] = it->second;
            }
        }
        const size_t G = gpos.size();
        res.stats.groupCount = G;
        std::vector<uint32_t> memberStart(G + 1, 0), members(V);
        for (uint32_t v = 0; v < V; ++v) memberStart[groupOf[v] + 1]++;
        for (size_t g = 0; g < G; ++g) memberStart[g + 1] += memberStart[g];
        {
            std::vector<uint32_t> fill(memberStart.begin(), memberStart.end() - 1);
            for (uint32_t v = 0; v < V; ++v) members[fill[groupOf[v]]++] = v;
        }

        // ---- 2. pieces: connected components of groups through triangle edges
        std::vector<uint32_t> piece(G);
        if (vertexPiece && vertexPiece->size() == V) {
            // the pieces as they were before a pass brought two of them onto the same points (the step blend, the rim zip):
            // by connectivity they would now be one, and the rest of their shared border would never be welded
            uint32_t top = 0;
            for (size_t g = 0; g < G; ++g) { piece[g] = (*vertexPiece)[members[memberStart[g]]]; top = std::max(top, piece[g] + 1); }
            res.stats.pieceCount = top;
        } else {
            scan_rectifier::detail::UnionFind uf(G);
            for (size_t t = 0; t < F; ++t) {
                const uint32_t a = groupOf[mesh.indices[3 * t]], b = groupOf[mesh.indices[3 * t + 1]], c = groupOf[mesh.indices[3 * t + 2]];
                uf.unite(a, b);
                uf.unite(a, c);
            }
            std::vector<uint32_t> ren(G, UINT32_MAX);
            uint32_t next = 0;
            for (size_t g = 0; g < G; ++g) { const uint32_t r = uf.find(static_cast<uint32_t>(g)); uint32_t& m = ren[r]; if (m == UINT32_MAX) m = next++; piece[g] = m; }
            res.stats.pieceCount = next;
        }

        // ---- 2b. strip pieces: every triangle a sliver (altitude <= tolerance, aspect >= sliverAspectMin)
        auto shapeOf = [&](const V3& a, const V3& b, const V3& c, double& altitude, double& aspect) {
            const double ab = (b - a).norm(), bc = (c - b).norm(), ca = (a - c).norm();
            const double s = (ab + bc + ca) * 0.5;
            const double area = std::sqrt(std::max(0.0, s * (s - ab) * (s - bc) * (s - ca)));
            const double longest = std::max({ab, bc, ca});
            altitude = longest > 1e-9 ? 2.0 * area / longest : 0.0;
            aspect = altitude > 1e-9 ? longest / altitude : 1e300;
        };
        std::vector<uint8_t> removed(F, 0);
        if (p.dropStripPieces) {
            std::vector<uint8_t> allSlivers(res.stats.pieceCount, 1);
            std::vector<uint32_t> pieceTris(res.stats.pieceCount, 0);
            for (size_t t = 0; t < F; ++t) {
                const uint32_t pc = piece[groupOf[mesh.indices[3 * t]]];
                ++pieceTris[pc];
                if (!allSlivers[pc]) continue;
                double alt, asp;
                shapeOf(gpos[groupOf[mesh.indices[3 * t]]], gpos[groupOf[mesh.indices[3 * t + 1]]], gpos[groupOf[mesh.indices[3 * t + 2]]], alt, asp);
                if (!(alt <= p.weldToleranceM && asp >= p.sliverAspectMin)) allSlivers[pc] = 0;
            }
            size_t strips = 0, stripTris = 0;
            for (size_t pc = 0; pc < allSlivers.size(); ++pc) if (allSlivers[pc] && pieceTris[pc] > 0) ++strips;
            for (size_t t = 0; t < F; ++t) if (allSlivers[piece[groupOf[mesh.indices[3 * t]]]]) { removed[t] = 1; ++stripTris; }
            res.stats.stripPiecesDropped = strips;
            res.stats.stripTrianglesDropped = stripTris;
        }

        // ---- 3. boundary groups: on an edge (in group space) used by exactly one remaining triangle
        std::vector<uint8_t> isBoundary(G, 0);
        {
            std::unordered_map<uint64_t, uint32_t> edgeCount;
            edgeCount.reserve(F * 3);
            for (size_t t = 0; t < F; ++t) {
                if (removed[t]) continue;
                for (int k = 0; k < 3; ++k) {
                    const uint32_t a = groupOf[mesh.indices[3 * t + k]], b = groupOf[mesh.indices[3 * t + (k + 1) % 3]];
                    if (a == b) continue;
                    edgeCount[(static_cast<uint64_t>(std::min(a, b)) << 32) | std::max(a, b)]++;
                }
            }
            size_t be = 0;
            for (const auto& kv : edgeCount) {
                if (kv.second != 1) continue;
                ++be;
                isBoundary[static_cast<uint32_t>(kv.first >> 32)] = 1;
                isBoundary[static_cast<uint32_t>(kv.first & 0xffffffffu)] = 1;
            }
            res.stats.boundaryEdges = be;
        }
        std::vector<uint32_t> bgroups;
        for (uint32_t g = 0; g < G; ++g) if (isBoundary[g]) bgroups.push_back(g);
        res.stats.boundaryGroups = bgroups.size();

        // ---- 4. contacts: nearest boundary group of another piece, from ORIGINAL positions
        const double pad = p.weldToleranceM + p.searchPadM;
        const double cell = std::max(pad, 1e-3);
        auto ci = [&](double v) { return static_cast<int64_t>(std::floor(v / cell)); };
        std::unordered_map<int64_t, std::vector<uint32_t>, scan_rectifier::detail::CellKeyHash> grid;
        for (uint32_t g : bgroups) grid[scan_rectifier::detail::cellKey(ci(gpos[g].x), ci(gpos[g].y), ci(gpos[g].z))].push_back(g);

        std::vector<uint32_t> target(G, UINT32_MAX);   // direct partner (any gap within pad)
        std::vector<double> targetGap(G, 0.0);
        const unsigned threads = scan_rectifier::detail::resolveThreads(p.threads);
        std::vector<size_t> histPerThread(static_cast<size_t>(threads) * 6, 0);
        std::atomic<size_t> contactCounter{0};
        const double edgesM[6] = {0.0, 0.001, 0.005, 0.01, 0.03, 0.1};
        scan_rectifier::detail::parallelFor(bgroups.size(), threads, 256, [&](size_t i0, size_t i1, unsigned th) {
            for (size_t i = i0; i < i1; ++i) {
                const uint32_t g = bgroups[i];
                const V3 q = gpos[g];
                const int64_t cx = ci(q.x), cy = ci(q.y), cz = ci(q.z);
                double bestD = 1e300;
                uint32_t bestH = UINT32_MAX;
                for (int64_t dx = -1; dx <= 1; ++dx) for (int64_t dy = -1; dy <= 1; ++dy) for (int64_t dz = -1; dz <= 1; ++dz) {
                    auto it = grid.find(scan_rectifier::detail::cellKey(cx + dx, cy + dy, cz + dz));
                    if (it == grid.end()) continue;
                    for (uint32_t h : it->second) {
                        if (piece[h] == piece[g]) continue;
                        const double d = (q - gpos[h]).norm();
                        if (d <= pad && (d < bestD || (d == bestD && h < bestH))) { bestD = d; bestH = h; }
                    }
                }
                if (bestH == UINT32_MAX) continue;
                ++contactCounter;
                int b = 0;
                for (int k = 0; k < 6; ++k) if (bestD >= edgesM[k]) b = k;
                histPerThread[static_cast<size_t>(th) * 6 + static_cast<size_t>(b)]++;
                target[g] = bestH;
                targetGap[g] = bestD;
            }
        });
        res.stats.contactsFound = contactCounter.load();
        for (unsigned th = 0; th < threads; ++th) for (int k = 0; k < 6; ++k) res.stats.gapHistogram[static_cast<size_t>(k)] += histPerThread[static_cast<size_t>(th) * 6 + static_cast<size_t>(k)];

        // the side that moves: the higher piece id (ties on piece id cannot happen: partners are in different pieces)
        auto moves = [&](uint32_t g) { return target[g] != UINT32_MAX && targetGap[g] <= p.weldToleranceM && piece[g] > piece[target[g]]; };
        // the point a group lands on: follow the chain of moving targets while the total move stays within the tolerance
        std::vector<uint32_t> landing(G, UINT32_MAX);
        size_t chained = 0;
        for (uint32_t g : bgroups) {
            if (!moves(g)) continue;
            uint32_t land = target[g];
            int hops = 1;
            uint32_t cur = land;
            while (hops < p.maxChainHops && moves(cur) && target[cur] != g) {
                const uint32_t nxt = target[cur];
                if ((gpos[nxt] - gpos[g]).norm() > p.weldToleranceM) break;
                land = nxt;
                cur = nxt;
                ++hops;
            }
            if (hops > 1) ++chained;
            landing[g] = land;
        }
        res.stats.chainedWelds = chained;

        // ---- 5. apply, then guard against turned triangles
        std::vector<uint8_t> movedGroup(G, 0);
        std::vector<uint8_t> touched(F, 0);
        auto setGroupPos = [&](uint32_t g, const V3& to) {
            for (uint32_t m = memberStart[g]; m < memberStart[g + 1]; ++m)
                mesh.vertices[members[m]].position = geometry::Vec3(static_cast<float>(to.x), static_cast<float>(to.y), static_cast<float>(to.z));
        };
        for (uint32_t g : bgroups) {
            if (landing[g] == UINT32_MAX) continue;
            setGroupPos(g, gpos[landing[g]]);
            movedGroup[g] = 1;
        }
        std::vector<V3> origNormal(F);
        for (size_t t = 0; t < F; ++t) {
            if (removed[t]) continue;
            const uint32_t i0 = mesh.indices[3 * t], i1 = mesh.indices[3 * t + 1], i2 = mesh.indices[3 * t + 2];
            touched[t] = movedGroup[groupOf[i0]] || movedGroup[groupOf[i1]] || movedGroup[groupOf[i2]];
            if (touched[t]) origNormal[t] = (gpos[groupOf[i1]] - gpos[groupOf[i0]]).cross(gpos[groupOf[i2]] - gpos[groupOf[i0]]);
        }
        auto shape = [&](size_t t, double& altitude, double& aspect) {
            shapeOf(vpos(mesh.indices[3 * t]), vpos(mesh.indices[3 * t + 1]), vpos(mesh.indices[3 * t + 2]), altitude, aspect);
        };
        const double altitudeMax = p.sliverAltitudeFraction * p.weldToleranceM;
        auto isSliver = [&](size_t t) { double alt, asp; shape(t, alt, asp); return alt <= altitudeMax && asp >= p.sliverAspectMin; };
        size_t reverted = 0;
        for (int round = 0; round < 4; ++round) {
            size_t revertedThisRound = 0;
            for (size_t t = 0; t < F; ++t) {
                if (!touched[t]) continue;
                const uint32_t i0 = mesh.indices[3 * t], i1 = mesh.indices[3 * t + 1], i2 = mesh.indices[3 * t + 2];
                if (!(movedGroup[groupOf[i0]] || movedGroup[groupOf[i1]] || movedGroup[groupOf[i2]])) continue;
                if (isSliver(t)) continue;  // collapsing, not turning: dropped below
                const V3 n = (vpos(i1) - vpos(i0)).cross(vpos(i2) - vpos(i0));
                if (n.dot(origNormal[t]) >= 0.0) continue;
                for (uint32_t v : {i0, i1, i2}) {
                    const uint32_t g = groupOf[v];
                    if (!movedGroup[g]) continue;
                    setGroupPos(g, gpos[g]);
                    movedGroup[g] = 0;
                    ++revertedThisRound;
                }
            }
            reverted += revertedThisRound;
            if (!revertedThisRound) break;
        }
        res.stats.groupsReverted = reverted;

        // ---- 6. counts of what moved
        double sumD = 0.0, maxD = 0.0;
        size_t groupsWelded = 0, vertsWelded = 0;
        for (uint32_t g : bgroups) {
            if (!movedGroup[g]) continue;
            const double d = (gpos[landing[g]] - gpos[g]).norm();
            sumD += d;
            maxD = std::max(maxD, d);
            ++groupsWelded;
            vertsWelded += memberStart[g + 1] - memberStart[g];
        }
        res.stats.groupsWelded = groupsWelded;
        res.stats.vertsWelded = vertsWelded;
        res.stats.meanWeldDisplacementM = groupsWelded ? sumD / static_cast<double>(groupsWelded) : 0.0;
        res.stats.maxWeldDisplacementM = maxD;

        // ---- 7. drop the slivers among the triangles a move touched (post-weld shape)
        res.keepTriangle.assign(F, kFlagKeep);
        size_t dropped = res.stats.stripTrianglesDropped, collapsed = 0;
        for (size_t t = 0; t < F; ++t) {
            if (removed[t]) { res.keepTriangle[t] = kFlagHidden; continue; }
            const uint32_t i0 = mesh.indices[3 * t], i1 = mesh.indices[3 * t + 1], i2 = mesh.indices[3 * t + 2];
            if (!(movedGroup[groupOf[i0]] || movedGroup[groupOf[i1]] || movedGroup[groupOf[i2]])) continue;
            if (!isSliver(t)) continue;
            res.keepTriangle[t] = kFlagHidden;
            ++dropped;
            // was it a real triangle before the move? (altitude from the original positions)
            double alt0, asp0;
            shapeOf(gpos[groupOf[i0]], gpos[groupOf[i1]], gpos[groupOf[i2]], alt0, asp0);
            if (alt0 > altitudeMax) ++collapsed;
        }
        res.stats.trianglesDropped = dropped;
        res.stats.trianglesCollapsed = collapsed;

        res.ok = true;
        return res;
    }

    /**
     * Physically removes the triangles `keepTriangle` marks dropped (kFlagHidden) from mesh.indices,
     * keeping every per-triangle side array the caller passes (e.g. GltfScene::triangleMaterial) in
     * lockstep. Vertices are left untouched (an unused vertex costs nothing downstream; dropping it
     * would renumber every remaining triangle for no benefit). Safe to call with no side arrays.
     */
    static void compactDropped(geometry::ScratchboxMesh& mesh, const std::vector<uint8_t>& keepTriangle, std::vector<std::vector<uint32_t>*> sideArrays = {}) {
        const size_t F = mesh.indices.size() / 3;
        if (keepTriangle.size() != F) return;
        size_t kept = 0;
        for (size_t t = 0; t < F; ++t) if (keepTriangle[t] == kFlagKeep) ++kept;
        if (kept == F) return;
        std::vector<uint32_t> newIndices;
        newIndices.reserve(kept * 3);
        std::vector<std::vector<uint32_t>> newSide(sideArrays.size());
        for (size_t s = 0; s < sideArrays.size(); ++s) newSide[s].reserve(kept);
        for (size_t t = 0; t < F; ++t) {
            if (keepTriangle[t] != kFlagKeep) continue;
            newIndices.push_back(mesh.indices[3 * t]);
            newIndices.push_back(mesh.indices[3 * t + 1]);
            newIndices.push_back(mesh.indices[3 * t + 2]);
            for (size_t s = 0; s < sideArrays.size(); ++s)
                if (sideArrays[s] && t < sideArrays[s]->size()) newSide[s].push_back((*sideArrays[s])[t]);
        }
        mesh.indices = std::move(newIndices);
        for (size_t s = 0; s < sideArrays.size(); ++s) if (sideArrays[s]) *sideArrays[s] = std::move(newSide[s]);
    }

    /**
     * Overlap trim, before the weld: where two pieces cover the same surface (a strip along a seam delivered by both tiles, a
     * patch at two levels of detail), the triangles of the higher piece lying wholly over a lower piece's surface go, ring by
     * ring in from the piece's border, so one surface is left and the weld closes the rest. A triangle is over a surface when
     * every probe (its centroid, and its corners and edge midpoints pulled 15% toward the centroid) projects inside a
     * lower piece's triangle facing the same way (cos >= overlapFacingCos) within overlapToleranceM of it. Only triangles on the piece's current border are tried, so an
     * interior surface never goes. Removes triangles from mesh.indices
     * (side arrays kept in lockstep); moves nothing.
     */
    static TileSeamTrimStats trimOverlaps(geometry::ScratchboxMesh& mesh, std::vector<std::vector<uint32_t>*> sideArrays, const TileSeamCloseParams& p = {}) {
        TileSeamTrimStats st;
        if (!(p.overlapToleranceM > 0.0)) return st;
        const size_t V = mesh.vertices.size();
        auto vp = [&](uint32_t v) { const auto& q = mesh.vertices[v].position; return V3{q.x, q.y, q.z}; };
        const Topology topo = topology(mesh);
        const unsigned threads = scan_rectifier::detail::resolveThreads(p.threads);
        for (int round = 0; round < p.overlapRounds; ++round) {
            const size_t F = mesh.indices.size() / 3;
            // the border: triangles owning an edge (in group space) used once
            std::unordered_map<uint64_t, uint32_t> edgeCount;
            edgeCount.reserve(F * 3);
            auto ekey = [](uint32_t a, uint32_t b) { return (static_cast<uint64_t>(std::min(a, b)) << 32) | std::max(a, b); };
            for (size_t t = 0; t < F; ++t) for (int k = 0; k < 3; ++k) {
                const uint32_t a = topo.groupOf[mesh.indices[3 * t + k]], b = topo.groupOf[mesh.indices[3 * t + (k + 1) % 3]];
                if (a != b) edgeCount[ekey(a, b)]++;
            }
            std::vector<uint32_t> border;
            for (size_t t = 0; t < F; ++t) for (int k = 0; k < 3; ++k) {
                const uint32_t a = topo.groupOf[mesh.indices[3 * t + k]], b = topo.groupOf[mesh.indices[3 * t + (k + 1) % 3]];
                if (a != b && edgeCount[ekey(a, b)] == 1) { border.push_back(static_cast<uint32_t>(t)); break; }
            }
            if (border.empty()) break;
            // every triangle in a grid of overlapCellM cells (its box grown by the tolerance)
            const double cell = std::max(p.overlapCellM, 1e-3), tol = p.overlapToleranceM;
            auto ci = [&](double v) { return static_cast<int64_t>(std::floor(v / cell)); };
            std::unordered_map<int64_t, std::vector<uint32_t>, scan_rectifier::detail::CellKeyHash> grid;
            for (size_t t = 0; t < F; ++t) {
                const V3 a = vp(mesh.indices[3 * t]), b = vp(mesh.indices[3 * t + 1]), c = vp(mesh.indices[3 * t + 2]);
                const int64_t x0 = ci(std::min({a.x, b.x, c.x}) - tol), x1 = ci(std::max({a.x, b.x, c.x}) + tol), y0 = ci(std::min({a.y, b.y, c.y}) - tol), y1 = ci(std::max({a.y, b.y, c.y}) + tol), z0 = ci(std::min({a.z, b.z, c.z}) - tol), z1 = ci(std::max({a.z, b.z, c.z}) + tol);
                if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > 512) continue;
                for (int64_t x = x0; x <= x1; ++x) for (int64_t y = y0; y <= y1; ++y) for (int64_t z = z0; z <= z1; ++z) grid[scan_rectifier::detail::cellKey(x, y, z)].push_back(static_cast<uint32_t>(t));
            }
            auto pieceOfTri = [&](size_t t) { return topo.piece[topo.groupOf[mesh.indices[3 * t]]]; };
            std::vector<uint8_t> drop(F, 0);
            scan_rectifier::detail::parallelFor(border.size(), threads, 256, [&](size_t i0, size_t i1, unsigned) {
                for (size_t i = i0; i < i1; ++i) {
                    const uint32_t t = border[i];
                    const uint32_t pc = pieceOfTri(t);
                    const V3 a = vp(mesh.indices[3 * t]), b = vp(mesh.indices[3 * t + 1]), c = vp(mesh.indices[3 * t + 2]);
                    V3 n = (b - a).cross(c - a);
                    const double nl = n.norm();
                    if (!(nl > 1e-12)) continue;
                    n = n * (1.0 / nl);
                    const V3 g = (a + b + c) * (1.0 / 3.0);
                    auto in = [&](const V3& q) { return q + (g - q) * 0.15; };
                    const V3 probes[7] = {g, in(a), in(b), in(c), in((a + b) * 0.5), in((b + c) * 0.5), in((c + a) * 0.5)};
                    bool all = true;
                    for (const V3& q : probes) {
                        bool covered = false;
                        auto it = grid.find(scan_rectifier::detail::cellKey(ci(q.x), ci(q.y), ci(q.z)));
                        if (it != grid.end()) for (uint32_t u : it->second) {
                            if (pieceOfTri(u) >= pc) continue;
                            const V3 ua = vp(mesh.indices[3 * u]), ub = vp(mesh.indices[3 * u + 1]), uc = vp(mesh.indices[3 * u + 2]);
                            V3 m = (ub - ua).cross(uc - ua);
                            const double ml = m.norm();
                            if (!(ml > 1e-12) || m.dot(n) < p.overlapFacingCos * ml) continue;
                            m = m * (1.0 / ml);
                            const double d = (q - ua).dot(m);
                            if (std::abs(d) > tol) continue;
                            const V3 r = q - m * d;
                            if ((ub - ua).cross(r - ua).dot(m) < 0 || (uc - ub).cross(r - ub).dot(m) < 0 || (ua - uc).cross(r - uc).dot(m) < 0) continue;
                            covered = true;
                            break;
                        }
                        if (!covered) { all = false; break; }
                    }
                    if (all) drop[t] = 1;
                }
            });
            std::vector<uint8_t> keep(F, kFlagKeep);
            size_t n = 0;
            for (size_t t = 0; t < F; ++t) if (drop[t]) {
                keep[t] = kFlagHidden; ++n;
                const V3 a = vp(mesh.indices[3 * t]), b = vp(mesh.indices[3 * t + 1]), c = vp(mesh.indices[3 * t + 2]);
                st.areaM2 += 0.5 * (b - a).cross(c - a).norm();
            }
            st.roundsRun = static_cast<size_t>(round + 1);
            if (!n) break;
            st.trianglesDropped += n;
            compactDropped(mesh, keep, sideArrays);
        }
        (void)V;
        return st;
    }

    /**
     * Cap removal, first: a tile arrives cut along its box and capped, so where two tiles' boxes share a face, each tile
     * carries a strip lying in that face, back to back with the other's. The strips are inside the surface and stand
     * between the two walls the cut divides, so the walls never meet: from outside the seam reads as a hairline lip.
     * A triangle goes when it lies on a face its tile's box shares with another tile's box (facing along the face's normal
     * within capFacingCos, every corner within capPlaneM of the face) and the other tile backs it there (a triangle of it
     * lying on the same face, facing the other way, within backingM of this one's centroid, which projects inside it).
     * Both tiles' caps go together. On the raw scan nothing shows (the caps are inside); in a rebuilt building the facade's
     * bays are recessed behind the scan's wall plane and each cap stands out across them as a slot at the cut's height. tileBoxes: per tile, its box's centre and three half-axes in the mesh's frame (empty half-axes:
     * no box, nothing removed for that tile). Removes triangles only (side arrays in lockstep).
     */
    static TileCapStats trimCapsByBox(geometry::ScratchboxMesh& mesh, std::vector<std::vector<uint32_t>*> sideArrays, const std::vector<uint32_t>& triTileIn,
                                      const std::vector<TileBox>& boxes, const TileCapParams& p = {}) {
        TileCapStats st;
        const std::vector<uint32_t> triTile = triTileIn;
        const size_t F = mesh.indices.size() / 3;
        if (triTile.size() != F) return st;
        auto vp = [&](uint32_t v) { const auto& q = mesh.vertices[v].position; return V3{q.x, q.y, q.z}; };
        // the faces of every box: outward unit normal u, offset o (u . x = o), its centre and in-plane half extents
        struct Face { uint32_t tile; V3 u, c, a, b; double o, ha, hb; std::vector<uint32_t> nbr; };
        std::vector<Face> faces;
        std::vector<std::vector<uint32_t>> facesOf(boxes.size());
        for (uint32_t t = 0; t < boxes.size(); ++t) {
            const TileBox& B = boxes[t];
            if (!B.valid) continue;
            for (int k = 0; k < 3; ++k) for (int s = -1; s <= 1; s += 2) {
                const double hk = B.h[k].norm();
                if (!(hk > 1e-6)) continue;
                Face f;
                f.tile = t;
                f.u = B.h[k] * (s / hk);
                f.c = B.c + B.h[k] * s;
                f.o = f.u.dot(f.c);
                f.a = B.h[(k + 1) % 3]; f.b = B.h[(k + 2) % 3];
                f.ha = f.a.norm(); f.hb = f.b.norm();
                if (f.ha > 1e-9) f.a = f.a * (1.0 / f.ha);
                if (f.hb > 1e-9) f.b = f.b * (1.0 / f.hb);
                facesOf[t].push_back(static_cast<uint32_t>(faces.size()));
                faces.push_back(f);
            }
        }
        // shared: another box's face on the same plane, facing the other way, whose rectangle overlaps this one's
        auto overlaps = [](const Face& f, const Face& g) {
            // g's rectangle corners in f's in-plane axes, against f's half extents
            double lo[2] = {1e300, 1e300}, hi[2] = {-1e300, -1e300};
            for (int i = -1; i <= 1; i += 2) for (int j = -1; j <= 1; j += 2) {
                const V3 q = g.c + g.a * (i * g.ha) + g.b * (j * g.hb) - f.c;
                const double x = q.dot(f.a), y = q.dot(f.b);
                lo[0] = std::min(lo[0], x); hi[0] = std::max(hi[0], x); lo[1] = std::min(lo[1], y); hi[1] = std::max(hi[1], y);
            }
            const double m = 0.05;
            return lo[0] < f.ha - m && hi[0] > -f.ha + m && lo[1] < f.hb - m && hi[1] > -f.hb + m;
        };
        for (auto& f : faces) {
            for (const auto& g : faces) {
                if (g.tile == f.tile || f.u.dot(g.u) > -0.995 || std::abs(f.o + g.o) > p.faceMatchM) continue;
                if (overlaps(f, g)) f.nbr.push_back(g.tile);
            }
            if (!f.nbr.empty()) ++st.sharedFaces;
        }
        // candidates: triangles lying on one of their tile's shared faces
        std::vector<int32_t> onFace(F, -1);
        for (size_t t = 0; t < F; ++t) {
            const uint32_t tile = triTile[t];
            if (tile >= facesOf.size()) continue;
            const V3 a = vp(mesh.indices[3 * t]), b = vp(mesh.indices[3 * t + 1]), c = vp(mesh.indices[3 * t + 2]);
            V3 n = (b - a).cross(c - a);
            const double nl = n.norm();
            if (!(nl > 1e-12)) continue;
            n = n * (1.0 / nl);
            for (uint32_t fi : facesOf[tile]) {
                const Face& f = faces[fi];
                if (f.nbr.empty() || std::abs(n.dot(f.u)) < p.capFacingCos) continue;
                if (std::abs(f.u.dot(a) - f.o) > p.capPlaneM || std::abs(f.u.dot(b) - f.o) > p.capPlaneM || std::abs(f.u.dot(c) - f.o) > p.capPlaneM) continue;
                onFace[t] = static_cast<int32_t>(fi);
                ++st.candidates;
                break;
            }
        }
        // backing: a neighbour's candidate on a matching face, facing the other way, under this one's centroid
        const double cell = std::max(1.0, p.backingM);
        auto ci = [&](double v) { return static_cast<int64_t>(std::floor(v / cell)); };
        std::unordered_map<int64_t, std::vector<uint32_t>, scan_rectifier::detail::CellKeyHash> grid;
        for (size_t t = 0; t < F; ++t) {
            if (onFace[t] < 0) continue;
            const V3 a = vp(mesh.indices[3 * t]), b = vp(mesh.indices[3 * t + 1]), c = vp(mesh.indices[3 * t + 2]);
            const int64_t x0 = ci(std::min({a.x, b.x, c.x}) - p.backingM), x1 = ci(std::max({a.x, b.x, c.x}) + p.backingM), y0 = ci(std::min({a.y, b.y, c.y}) - p.backingM), y1 = ci(std::max({a.y, b.y, c.y}) + p.backingM), z0 = ci(std::min({a.z, b.z, c.z}) - p.backingM), z1 = ci(std::max({a.z, b.z, c.z}) + p.backingM);
            if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > 4096) continue;
            for (int64_t x = x0; x <= x1; ++x) for (int64_t y = y0; y <= y1; ++y) for (int64_t z = z0; z <= z1; ++z) grid[scan_rectifier::detail::cellKey(x, y, z)].push_back(static_cast<uint32_t>(t));
        }
        std::vector<uint8_t> drop(F, 0);
        const unsigned threads = scan_rectifier::detail::resolveThreads(p.threads);
        scan_rectifier::detail::parallelFor(F, threads, 1024, [&](size_t i0, size_t i1, unsigned) {
            for (size_t t = i0; t < i1; ++t) {
                if (onFace[t] < 0) continue;
                const Face& f = faces[static_cast<size_t>(onFace[t])];
                const V3 a = vp(mesh.indices[3 * t]), b = vp(mesh.indices[3 * t + 1]), c = vp(mesh.indices[3 * t + 2]);
                const V3 g = (a + b + c) * (1.0 / 3.0);
                const V3 n = (b - a).cross(c - a).normalized();
                auto it = grid.find(scan_rectifier::detail::cellKey(ci(g.x), ci(g.y), ci(g.z)));
                if (it == grid.end()) continue;
                for (uint32_t u : it->second) {
                    if (triTile[u] == triTile[t] || std::find(f.nbr.begin(), f.nbr.end(), triTile[u]) == f.nbr.end()) continue;
                    const V3 ua = vp(mesh.indices[3 * u]), ub = vp(mesh.indices[3 * u + 1]), uc = vp(mesh.indices[3 * u + 2]);
                    const V3 m = (ub - ua).cross(uc - ua).normalized();
                    if (m.dot(n) > -p.capFacingCos) continue;
                    const double d = (g - ua).dot(m);
                    if (std::abs(d) > p.backingM) continue;
                    const V3 r = g - m * d;
                    if ((ub - ua).cross(r - ua).dot(m) < 0 || (uc - ub).cross(r - ub).dot(m) < 0 || (ua - uc).cross(r - uc).dot(m) < 0) continue;
                    drop[t] = 1;
                    break;
                }
            }
        });
        std::vector<uint8_t> keep(F, kFlagKeep);
        for (size_t t = 0; t < F; ++t) if (drop[t]) {
            keep[t] = kFlagHidden; ++st.trianglesDropped;
            const V3 a = vp(mesh.indices[3 * t]), b = vp(mesh.indices[3 * t + 1]), c = vp(mesh.indices[3 * t + 2]);
            st.areaM2 += 0.5 * (b - a).cross(c - a).norm();
        }
        if (st.trianglesDropped) compactDropped(mesh, keep, sideArrays);
        return st;
    }

    /**
     * T-junction closure, after the weld: a border position of one piece lying on the interior of another piece's border
     * edge (within toleranceM of it, nearer to the edge than to either end of it by endGuardM, and not already shared with
     * another piece) moves onto that edge, and the edge's triangle is split there: a new vertex at exactly that position,
     * its UVs, normal and colour interpolated along the edge, the triangle fanned through it with its winding and material
     * kept. Both pieces then share the point, so the seam is closed in topology, not only in position. A move that would
     * turn a triangle inside out is taken back, with its split. Splits wait a round when their triangle was already split
     * (up to tJunctionRounds).
     */
    static TileSeamTJunctionStats closeTJunctions(geometry::ScratchboxMesh& mesh, std::vector<std::vector<uint32_t>*> sideArrays, const TileSeamCloseParams& p = {}, std::vector<uint32_t>* vertexPiece = nullptr) {
        TileSeamTJunctionStats st;
        if (!(p.toleranceM > 0.0)) return st;
        // which piece each vertex came from (the caller's, taken before the weld joined pieces; else the mesh's own now)
        std::vector<uint32_t> ownPiece;
        if (!vertexPiece || vertexPiece->size() != mesh.vertices.size()) { ownPiece = vertexPieces(mesh); vertexPiece = &ownPiece; }
        std::vector<uint32_t>& vpiece = *vertexPiece;
        const unsigned threads = scan_rectifier::detail::resolveThreads(p.threads);
        for (int round = 0; round < p.tJunctionRounds; ++round) {
            const Topology topo = topology(mesh);
            const size_t F = mesh.indices.size() / 3, G = topo.gpos.size();
            // border edges (group space) with the triangle that owns each
            struct BEdge { uint32_t a, b, tri; };
            std::unordered_map<uint64_t, std::pair<uint32_t, uint32_t>> edgeInfo;   // key -> (count, owner)
            edgeInfo.reserve(F * 3);
            auto ekey = [](uint32_t a, uint32_t b) { return (static_cast<uint64_t>(std::min(a, b)) << 32) | std::max(a, b); };
            for (size_t t = 0; t < F; ++t) for (int k = 0; k < 3; ++k) {
                const uint32_t a = topo.groupOf[mesh.indices[3 * t + k]], b = topo.groupOf[mesh.indices[3 * t + (k + 1) % 3]];
                if (a == b) continue;
                auto& e = edgeInfo[ekey(a, b)];
                e.first++;
                e.second = static_cast<uint32_t>(t);
            }
            std::vector<BEdge> edges;
            std::vector<uint8_t> isB(G, 0);
            for (const auto& kv : edgeInfo) if (kv.second.first == 1) {
                const uint32_t a = static_cast<uint32_t>(kv.first >> 32), b = static_cast<uint32_t>(kv.first & 0xffffffffu);
                edges.push_back({a, b, kv.second.second});
                isB[a] = 1; isB[b] = 1;
            }
            if (round == 0) st.borderEdges = edges.size();
            // a position's piece (UINT32_MAX when its vertices came from several pieces: shared already), an edge's from its triangle
            std::vector<uint32_t> gPiece(G, UINT32_MAX - 1);
            for (uint32_t v = 0; v < mesh.vertices.size(); ++v) { uint32_t& gp = gPiece[topo.groupOf[v]]; if (gp == UINT32_MAX - 1) gp = vpiece[v]; else if (gp != vpiece[v]) gp = UINT32_MAX; }
            auto edgePiece = [&](const BEdge& e) { return vpiece[mesh.indices[3 * e.tri]]; };
            // border positions and border edges in a grid (edges by their box)
            const double cell = std::max(p.tJunctionCellM, 1e-3), tol = p.toleranceM;
            auto ci = [&](double v) { return static_cast<int64_t>(std::floor(v / cell)); };
            std::unordered_map<int64_t, std::vector<uint32_t>, scan_rectifier::detail::CellKeyHash> eGrid, gGrid;
            for (uint32_t i = 0; i < edges.size(); ++i) {
                const V3 a = topo.gpos[edges[i].a], b = topo.gpos[edges[i].b];
                const int64_t x0 = ci(std::min(a.x, b.x) - tol), x1 = ci(std::max(a.x, b.x) + tol), y0 = ci(std::min(a.y, b.y) - tol), y1 = ci(std::max(a.y, b.y) + tol), z0 = ci(std::min(a.z, b.z) - tol), z1 = ci(std::max(a.z, b.z) + tol);
                if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > 4096) continue;
                for (int64_t x = x0; x <= x1; ++x) for (int64_t y = y0; y <= y1; ++y) for (int64_t z = z0; z <= z1; ++z) eGrid[scan_rectifier::detail::cellKey(x, y, z)].push_back(i);
            }
            for (uint32_t g = 0; g < G; ++g) if (isB[g]) gGrid[scan_rectifier::detail::cellKey(ci(topo.gpos[g].x), ci(topo.gpos[g].y), ci(topo.gpos[g].z))].push_back(g);
            // per border position: its T-junction (the nearest other piece's edge interior), unless it already sits on another piece's position
            struct Hit { uint32_t edge{UINT32_MAX}; double s{0}, d{0}; V3 q; };
            std::vector<Hit> hit(G);
            std::vector<uint32_t> bgs;
            for (uint32_t g = 0; g < G; ++g) if (isB[g]) bgs.push_back(g);
            scan_rectifier::detail::parallelFor(bgs.size(), threads, 256, [&](size_t i0, size_t i1, unsigned) {
                for (size_t i = i0; i < i1; ++i) {
                    const uint32_t g = bgs[i];
                    const V3 x = topo.gpos[g];
                    const int64_t cx = ci(x.x), cy = ci(x.y), cz = ci(x.z);
                    bool shared = gPiece[g] == UINT32_MAX;
                    for (int64_t dx = -1; dx <= 1 && !shared; ++dx) for (int64_t dy = -1; dy <= 1 && !shared; ++dy) for (int64_t dz = -1; dz <= 1 && !shared; ++dz) {
                        auto it = gGrid.find(scan_rectifier::detail::cellKey(cx + dx, cy + dy, cz + dz));
                        if (it != gGrid.end()) for (uint32_t h : it->second) if (h != g && gPiece[h] != gPiece[g] && (topo.gpos[h] - x).norm() <= p.sharedM) { shared = true; break; }
                    }
                    if (shared) continue;
                    auto it = eGrid.find(scan_rectifier::detail::cellKey(cx, cy, cz));
                    if (it == eGrid.end()) continue;
                    Hit best; best.d = 1e300;
                    for (uint32_t ei : it->second) {
                        const BEdge& e = edges[ei];
                        if (edgePiece(e) == gPiece[g]) continue;
                        const V3 a = topo.gpos[e.a], b = topo.gpos[e.b], ab = b - a;
                        const double ll = ab.dot(ab);
                        if (!(ll > 1e-12)) continue;
                        const double s = (x - a).dot(ab) / ll;
                        const double L = std::sqrt(ll);
                        if (s * L <= p.endGuardM || (1.0 - s) * L <= p.endGuardM) continue;
                        const V3 q = a + ab * s;
                        const double d = (x - q).norm();
                        if (d > tol || d >= best.d) continue;
                        // nearer the edge than either end by the guard, or it is the vertex weld's case
                        if (std::min((x - a).norm(), (x - b).norm()) <= d + p.endGuardM) continue;
                        best.edge = ei; best.s = s; best.d = d; best.q = q;
                    }
                    if (best.edge != UINT32_MAX) hit[g] = best;
                }
            });
            // one side moves first, as in the weld: positions of the higher piece onto the lower piece's edges; a lower piece's
            // position moves onto a higher piece's edge only when neither end of that edge moves (else it waits a round, when the
            // edge has come to it and the split moves nothing). Any move onto an edge whose own ends move waits a round too.
            size_t rawHits = 0;
            {
                const double still = 1e-6;
                std::vector<uint8_t> mover(G, 0);
                for (uint32_t g : bgs) if (hit[g].edge != UINT32_MAX) { ++rawHits; if (hit[g].d > still && gPiece[g] > edgePiece(edges[hit[g].edge])) mover[g] = 1; }
                for (uint32_t g : bgs) {
                    if (hit[g].edge == UINT32_MAX || hit[g].d <= still || mover[g]) continue;
                    const BEdge& e = edges[hit[g].edge];
                    if (mover[e.a] || mover[e.b]) continue;
                    mover[g] = 2;
                }
                for (uint32_t g : bgs) {
                    if (hit[g].edge == UINT32_MAX) continue;
                    const BEdge& e = edges[hit[g].edge];
                    if ((hit[g].d > still && !mover[g]) || mover[e.a] || mover[e.b]) { hit[g].edge = UINT32_MAX; ++st.deferred; }
                }
            }
            // moves, guarded against turned triangles
            std::vector<uint32_t> memberStart(G + 1, 0), members(mesh.vertices.size());
            for (uint32_t v = 0; v < mesh.vertices.size(); ++v) memberStart[topo.groupOf[v] + 1]++;
            for (size_t g = 0; g < G; ++g) memberStart[g + 1] += memberStart[g];
            { std::vector<uint32_t> fill(memberStart.begin(), memberStart.end() - 1); for (uint32_t v = 0; v < mesh.vertices.size(); ++v) members[fill[topo.groupOf[v]]++] = v; }
            std::vector<geometry::Vec3> qf(G);
            size_t found = 0;
            for (uint32_t g : bgs) if (hit[g].edge != UINT32_MAX) {
                ++found;
                qf[g] = geometry::Vec3(static_cast<float>(hit[g].q.x), static_cast<float>(hit[g].q.y), static_cast<float>(hit[g].q.z));
                for (uint32_t m = memberStart[g]; m < memberStart[g + 1]; ++m) mesh.vertices[members[m]].position = qf[g];
            }
            if (round == 0) st.found = rawHits;
            if (!rawHits) break;
            for (size_t t = 0; t < F; ++t) {
                const uint32_t i0 = mesh.indices[3 * t], i1 = mesh.indices[3 * t + 1], i2 = mesh.indices[3 * t + 2];
                const uint32_t g0 = topo.groupOf[i0], g1 = topo.groupOf[i1], g2 = topo.groupOf[i2];
                if (hit[g0].edge == UINT32_MAX && hit[g1].edge == UINT32_MAX && hit[g2].edge == UINT32_MAX) continue;
                const V3 n0 = (topo.gpos[g1] - topo.gpos[g0]).cross(topo.gpos[g2] - topo.gpos[g0]);
                auto vp = [&](uint32_t v) { const auto& q = mesh.vertices[v].position; return V3{q.x, q.y, q.z}; };
                const V3 n1 = (vp(i1) - vp(i0)).cross(vp(i2) - vp(i0));
                if (n1.dot(n0) >= 0.0) continue;
                for (uint32_t g : {g0, g1, g2}) if (hit[g].edge != UINT32_MAX) {
                    for (uint32_t m = memberStart[g]; m < memberStart[g + 1]; ++m) mesh.vertices[members[m]].position = geometry::Vec3(static_cast<float>(topo.gpos[g].x), static_cast<float>(topo.gpos[g].y), static_cast<float>(topo.gpos[g].z));
                    hit[g].edge = UINT32_MAX;
                    ++st.reverted;
                }
            }
            // splits: per edge its points in order along it; a triangle split once a round
            std::unordered_map<uint32_t, std::vector<uint32_t>> byEdge;
            for (uint32_t g : bgs) if (hit[g].edge != UINT32_MAX) {
                byEdge[hit[g].edge].push_back(g);
                st.maxMoveM = std::max(st.maxMoveM, hit[g].d);
            }
            std::vector<uint8_t> splitTri(F, 0);
            size_t splitsThisRound = 0;
            std::vector<uint32_t> newIdx;
            std::vector<std::vector<uint32_t>> newSide(sideArrays.size());
            for (auto& kv : byEdge) {
                const BEdge& e = edges[kv.first];
                const uint32_t t = e.tri;
                if (splitTri[t]) { st.deferred += kv.second.size(); continue; }
                // the triangle's corners from the edge's start (as wound): a -> b, then c
                int k = -1;
                for (int j = 0; j < 3; ++j) {
                    const uint32_t ga = topo.groupOf[mesh.indices[3 * t + j]], gb = topo.groupOf[mesh.indices[3 * t + (j + 1) % 3]];
                    if ((ga == e.a && gb == e.b) || (ga == e.b && gb == e.a)) { k = j; break; }
                }
                if (k < 0) continue;
                const uint32_t va = mesh.indices[3 * t + k], vb = mesh.indices[3 * t + (k + 1) % 3], vc = mesh.indices[3 * t + (k + 2) % 3];
                const V3 A = topo.gpos[topo.groupOf[va]], B = topo.gpos[topo.groupOf[vb]], AB = B - A;
                auto& pts = kv.second;
                std::vector<std::pair<double, uint32_t>> along;
                for (uint32_t g : pts) along.push_back({(topo.gpos[g] - A).dot(AB) / AB.dot(AB), g});
                std::sort(along.begin(), along.end());
                // one new vertex per point, interpolated between the edge's own corners (this triangle's attributes)
                std::vector<uint32_t> chain{va};
                for (const auto& [s0, g] : along) {
                    const double s = std::clamp(s0, 0.0, 1.0);
                    geometry::Vertex nv = mesh.vertices[va];
                    const auto& ua = mesh.vertices[va];
                    const auto& ub = mesh.vertices[vb];
                    const float fs = static_cast<float>(s), fr = 1.0f - fs;
                    nv.position = qf[g];
                    nv.uv = geometry::Vec2(ua.uv.x * fr + ub.uv.x * fs, ua.uv.y * fr + ub.uv.y * fs);
                    nv.uv1 = geometry::Vec2(ua.uv1.x * fr + ub.uv1.x * fs, ua.uv1.y * fr + ub.uv1.y * fs);
                    geometry::Vec3 nn(ua.normal.x * fr + ub.normal.x * fs, ua.normal.y * fr + ub.normal.y * fs, ua.normal.z * fr + ub.normal.z * fs);
                    const float nl = std::sqrt(nn.x * nn.x + nn.y * nn.y + nn.z * nn.z);
                    nv.normal = nl > 0 ? geometry::Vec3(nn.x / nl, nn.y / nl, nn.z / nl) : ua.normal;
                    nv.color = geometry::Vec4(ua.color.x * fr + ub.color.x * fs, ua.color.y * fr + ub.color.y * fs, ua.color.z * fr + ub.color.z * fs, ua.color.w * fr + ub.color.w * fs);
                    chain.push_back(static_cast<uint32_t>(mesh.vertices.size()));
                    mesh.vertices.push_back(nv);
                    vpiece.push_back(vpiece[va]);
                }
                chain.push_back(vb);
                // the triangle becomes its first fan piece; the rest are appended with its side values
                mesh.indices[3 * t + 0] = chain[0]; mesh.indices[3 * t + 1] = chain[1]; mesh.indices[3 * t + 2] = vc;
                for (size_t j = 1; j + 1 < chain.size(); ++j) {
                    newIdx.push_back(chain[j]); newIdx.push_back(chain[j + 1]); newIdx.push_back(vc);
                    for (size_t si = 0; si < sideArrays.size(); ++si) if (sideArrays[si] && t < sideArrays[si]->size()) newSide[si].push_back((*sideArrays[si])[t]);
                    ++st.trianglesAdded;
                }
                splitTri[t] = 1;
                ++st.edgesSplit;
                st.closed += pts.size();
                ++splitsThisRound;
            }
            mesh.indices.insert(mesh.indices.end(), newIdx.begin(), newIdx.end());
            for (size_t si = 0; si < sideArrays.size(); ++si) if (sideArrays[si]) sideArrays[si]->insert(sideArrays[si]->end(), newSide[si].begin(), newSide[si].end());
            st.roundsRun = static_cast<size_t>(round + 1);
            if (!splitsThisRound) break;
        }
        return st;
    }

    // ------------------------------------------------------------------------
    // Seam audit, adaptive close and strip fill: tile-aware (each triangle's source tile, triangleTile, carried through
    // every pass as a side array), where the passes above only tell connected pieces apart.
    // ------------------------------------------------------------------------
private:
    /** Open edges (position space, used by one triangle) with the triangle that owns each, and each position's open edges. */
    struct OpenBorder {
        struct E { uint32_t a, b, tri; };
        std::vector<E> edges;
        std::vector<uint32_t> start, list;   // CSR: a position's open edges
    };
    static OpenBorder openBorder(const geometry::ScratchboxMesh& mesh, const Topology& topo) {
        OpenBorder ob;
        const size_t F = mesh.indices.size() / 3, G = topo.gpos.size();
        std::unordered_map<uint64_t, std::pair<uint32_t, uint32_t>> info;
        info.reserve(F * 3);
        for (size_t t = 0; t < F; ++t) for (int k = 0; k < 3; ++k) {
            const uint32_t a = topo.groupOf[mesh.indices[3 * t + k]], b = topo.groupOf[mesh.indices[3 * t + (k + 1) % 3]];
            if (a == b) continue;
            auto& e = info[(static_cast<uint64_t>(std::min(a, b)) << 32) | std::max(a, b)];
            e.first++;
            e.second = static_cast<uint32_t>(t);
        }
        for (const auto& kv : info) if (kv.second.first == 1) ob.edges.push_back({static_cast<uint32_t>(kv.first >> 32), static_cast<uint32_t>(kv.first & 0xffffffffu), kv.second.second});
        // a fixed order (the map's is not), so every run of a scan gives the same result
        std::sort(ob.edges.begin(), ob.edges.end(), [](const OpenBorder::E& x, const OpenBorder::E& y) { return x.a != y.a ? x.a < y.a : x.b < y.b; });
        ob.start.assign(G + 1, 0);
        for (const auto& e : ob.edges) { ob.start[e.a + 1]++; ob.start[e.b + 1]++; }
        for (size_t g = 0; g < G; ++g) ob.start[g + 1] += ob.start[g];
        ob.list.resize(ob.start[G]);
        std::vector<uint32_t> fill(ob.start.begin(), ob.start.end() - 1);
        for (uint32_t i = 0; i < ob.edges.size(); ++i) { ob.list[fill[ob.edges[i].a]++] = i; ob.list[fill[ob.edges[i].b]++] = i; }
        return ob;
    }
    static constexpr uint32_t kMixedTile = UINT32_MAX;
    /** Each position's tile: the tile of every triangle using it, or kMixedTile when triangles of several tiles share it. */
    static std::vector<uint32_t> groupTiles(const geometry::ScratchboxMesh& mesh, const Topology& topo, const std::vector<uint32_t>& triTile) {
        std::vector<uint32_t> gt(topo.gpos.size(), kMixedTile - 1);
        const size_t F = mesh.indices.size() / 3;
        for (size_t t = 0; t < F; ++t) for (int k = 0; k < 3; ++k) {
            uint32_t& g = gt[topo.groupOf[mesh.indices[3 * t + k]]];
            const uint32_t tt = t < triTile.size() ? triTile[t] : 0u;
            if (g == kMixedTile - 1) g = tt; else if (g != tt) g = kMixedTile;
        }
        return gt;
    }
    static double pointSegment(const V3& x, const V3& a, const V3& b, double* sOut = nullptr) {
        const V3 ab = b - a;
        const double ll = ab.dot(ab);
        double s = ll > 1e-18 ? std::clamp((x - a).dot(ab) / ll, 0.0, 1.0) : 0.0;
        if (sOut) *sOut = s;
        return (x - (a + ab * s)).norm();
    }

public:
    /** The plan cells (x, z: the frame is y up) any triangle of the mesh covers, at cellM. */
    static TileSeamCutMask cutMask(const geometry::ScratchboxMesh& mesh, double cellM = 1.0) {
        TileSeamCutMask m;
        m.cellM = std::max(cellM, 1e-3);
        if (mesh.vertices.empty()) return m;
        double minX = 1e300, minZ = 1e300, maxX = -1e300, maxZ = -1e300;
        for (const auto& v : mesh.vertices) { minX = std::min(minX, double(v.position.x)); maxX = std::max(maxX, double(v.position.x)); minZ = std::min(minZ, double(v.position.z)); maxZ = std::max(maxZ, double(v.position.z)); }
        auto ci = [&](double v) { return static_cast<int64_t>(std::floor(v / m.cellM)); };
        m.x0 = ci(minX); m.z0 = ci(minZ);
        m.w = ci(maxX) - m.x0 + 1; m.h = ci(maxZ) - m.z0 + 1;
        if (m.w <= 0 || m.h <= 0 || m.w * m.h > 400'000'000) { m.w = m.h = 0; return m; }
        m.covered.assign(static_cast<size_t>(m.w * m.h), 0);
        const size_t F = mesh.indices.size() / 3;
        for (size_t t = 0; t < F; ++t) {
            const auto& a = mesh.vertices[mesh.indices[3 * t]].position;
            const auto& b = mesh.vertices[mesh.indices[3 * t + 1]].position;
            const auto& c = mesh.vertices[mesh.indices[3 * t + 2]].position;
            const int64_t x0 = ci(std::min({a.x, b.x, c.x})), x1 = ci(std::max({a.x, b.x, c.x})), z0 = ci(std::min({a.z, b.z, c.z})), z1 = ci(std::max({a.z, b.z, c.z}));
            if ((x1 - x0 + 1) * (z1 - z0 + 1) > 4096) {
                for (const auto* p : {&a, &b, &c}) m.covered[static_cast<size_t>((ci(p->z) - m.z0) * m.w + (ci(p->x) - m.x0))] = 1;
                continue;
            }
            for (int64_t z = z0; z <= z1; ++z) for (int64_t x = x0; x <= x1; ++x) m.covered[static_cast<size_t>((z - m.z0) * m.w + (x - m.x0))] = 1;
        }
        return m;
    }

    /**
     * The seam audit: open edge length inside the cut border by the gap to the nearest open edge of a different tile
     * (measured from the edge's midpoint). Reads the mesh; changes nothing.
     */
    static TileSeamAudit auditSeams(const geometry::ScratchboxMesh& mesh, const std::vector<uint32_t>& triTile, const TileSeamCutMask& mask, const TileSeamAuditParams& p = {}) {
        TileSeamAudit au;
        const Topology topo = topology(mesh);
        const OpenBorder ob = openBorder(mesh, topo);
        au.openEdges = ob.edges.size();
        {
            std::vector<uint32_t> ts(triTile.begin(), triTile.end());
            std::sort(ts.begin(), ts.end());
            au.tiles = static_cast<size_t>(std::unique(ts.begin(), ts.end()) - ts.begin());
        }
        auto tileOf = [&](uint32_t e) { const uint32_t t = ob.edges[e].tri; return t < triTile.size() ? triTile[t] : 0u; };
        const double cell = std::max(p.searchM, 1e-3);
        auto ci = [&](double v) { return static_cast<int64_t>(std::floor(v / cell)); };
        std::unordered_map<int64_t, std::vector<uint32_t>, scan_rectifier::detail::CellKeyHash> grid;
        for (uint32_t i = 0; i < ob.edges.size(); ++i) {
            const V3 a = topo.gpos[ob.edges[i].a], b = topo.gpos[ob.edges[i].b];
            const int64_t x0 = ci(std::min(a.x, b.x)), x1 = ci(std::max(a.x, b.x)), y0 = ci(std::min(a.y, b.y)), y1 = ci(std::max(a.y, b.y)), z0 = ci(std::min(a.z, b.z)), z1 = ci(std::max(a.z, b.z));
            if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > 4096) continue;
            for (int64_t x = x0; x <= x1; ++x) for (int64_t y = y0; y <= y1; ++y) for (int64_t z = z0; z <= z1; ++z) grid[scan_rectifier::detail::cellKey(x, y, z)].push_back(i);
        }
        const int64_t marginCells = static_cast<int64_t>(std::ceil(p.cutMarginM / mask.cellM));
        auto atCut = [&](const V3& m) {
            if (mask.covered.empty()) return false;
            const int64_t ix = static_cast<int64_t>(std::floor(m.x / mask.cellM)), iz = static_cast<int64_t>(std::floor(m.z / mask.cellM));
            for (int64_t dz = -marginCells; dz <= marginCells; ++dz) for (int64_t dx = -marginCells; dx <= marginCells; ++dx)
                if (!mask.at(ix + dx, iz + dz)) return true;
            return false;
        };
        const unsigned threads = scan_rectifier::detail::resolveThreads(p.threads);
        std::vector<int8_t> band(ob.edges.size(), -1);
        scan_rectifier::detail::parallelFor(ob.edges.size(), threads, 512, [&](size_t i0, size_t i1, unsigned) {
            for (size_t i = i0; i < i1; ++i) {
                const V3 a = topo.gpos[ob.edges[i].a], b = topo.gpos[ob.edges[i].b], m = (a + b) * 0.5;
                if (atCut(m)) continue;
                const uint32_t mine = tileOf(static_cast<uint32_t>(i));
                double best = 1e300;
                const int64_t cx = ci(m.x), cy = ci(m.y), cz = ci(m.z);
                for (int64_t dx = -1; dx <= 1; ++dx) for (int64_t dy = -1; dy <= 1; ++dy) for (int64_t dz = -1; dz <= 1; ++dz) {
                    auto it = grid.find(scan_rectifier::detail::cellKey(cx + dx, cy + dy, cz + dz));
                    if (it == grid.end()) continue;
                    for (uint32_t j : it->second) {
                        if (tileOf(j) == mine) continue;
                        best = std::min(best, pointSegment(m, topo.gpos[ob.edges[j].a], topo.gpos[ob.edges[j].b]));
                    }
                }
                int8_t k = 4;
                for (int8_t j = 0; j < 4; ++j) if (best < kSeamAuditBandsM[j] && best <= p.searchM) { k = j; break; }
                band[i] = k;
            }
        });
        for (size_t i = 0; i < ob.edges.size(); ++i) {
            const double L = (topo.gpos[ob.edges[i].a] - topo.gpos[ob.edges[i].b]).norm();
            if (band[i] < 0) { au.atCutM += L; continue; }
            au.bandLengthM[static_cast<size_t>(band[i])] += L;
            au.bandEdges[static_cast<size_t>(band[i])]++;
        }
        return au;
    }
    static std::string auditJson(const TileSeamAudit& a) {
        auto num = [](double v) { char b[64]; std::snprintf(b, sizeof b, "%.1f", v); return std::string(b); };
        std::string js = "\"bandEdgesM\": [0, 0.03, 0.1, 0.3, 1], \"bandLengthM\": [";
        for (size_t k = 0; k < 5; ++k) js += (k ? ", " : "") + num(a.bandLengthM[k]);
        js += "], \"bandEdges\": [";
        for (size_t k = 0; k < 5; ++k) js += (k ? ", " : "") + std::to_string(a.bandEdges[k]);
        js += "], \"atCutM\": " + num(a.atCutM) + ", \"openEdges\": " + std::to_string(a.openEdges) + ", \"tiles\": " + std::to_string(a.tiles);
        return js;
    }

private:
    /** A tile's surface near a point: its triangles' area-weighted normal and centroid within a radius. */
    struct LocalSurface { V3 n, c; double area{0}; };
    struct TriGrid {
        double cell{1};
        std::unordered_map<int64_t, std::vector<uint32_t>, scan_rectifier::detail::CellKeyHash> cells;
        std::vector<V3> centroid, areaNormal;   // areaNormal: the cross product (twice the area, along the normal)
    };
    static TriGrid triGrid(const geometry::ScratchboxMesh& mesh, double cellM) {
        TriGrid tg;
        tg.cell = std::max(cellM, 1e-3);
        const size_t F = mesh.indices.size() / 3;
        tg.centroid.resize(F); tg.areaNormal.resize(F);
        auto vp = [&](uint32_t v) { const auto& q = mesh.vertices[v].position; return V3{q.x, q.y, q.z}; };
        for (size_t t = 0; t < F; ++t) {
            const V3 a = vp(mesh.indices[3 * t]), b = vp(mesh.indices[3 * t + 1]), c = vp(mesh.indices[3 * t + 2]);
            tg.centroid[t] = (a + b + c) * (1.0 / 3.0);
            tg.areaNormal[t] = (b - a).cross(c - a);
            const V3& g = tg.centroid[t];
            tg.cells[scan_rectifier::detail::cellKey(static_cast<int64_t>(std::floor(g.x / tg.cell)), static_cast<int64_t>(std::floor(g.y / tg.cell)), static_cast<int64_t>(std::floor(g.z / tg.cell)))].push_back(static_cast<uint32_t>(t));
        }
        return tg;
    }
    static LocalSurface surfaceNear(const TriGrid& tg, const std::vector<uint32_t>& triTile, uint32_t tile, const V3& x, double radius) {
        LocalSurface s;
        V3 n, c;
        const int64_t cx = static_cast<int64_t>(std::floor(x.x / tg.cell)), cy = static_cast<int64_t>(std::floor(x.y / tg.cell)), cz = static_cast<int64_t>(std::floor(x.z / tg.cell));
        for (int64_t dx = -1; dx <= 1; ++dx) for (int64_t dy = -1; dy <= 1; ++dy) for (int64_t dz = -1; dz <= 1; ++dz) {
            auto it = tg.cells.find(scan_rectifier::detail::cellKey(cx + dx, cy + dy, cz + dz));
            if (it == tg.cells.end()) continue;
            for (uint32_t t : it->second) {
                if ((t < triTile.size() ? triTile[t] : 0u) != tile) continue;
                if ((tg.centroid[t] - x).norm() > radius) continue;
                const double a = tg.areaNormal[t].norm();
                n += tg.areaNormal[t];
                c += tg.centroid[t] * a;
                s.area += a;
            }
        }
        if (s.area > 1e-12) { s.n = n.normalized(); s.c = c * (1.0 / s.area); s.area *= 0.5; }
        return s;
    }
    /** 0 agreed; 1 no surface; 2 normals; 3 not parallel; 4 a step. */
    static int agreement(const LocalSurface& A, const LocalSurface& B, const std::vector<V3>& dirsA, const std::vector<V3>& dirsB, const TileSeamAdaptiveParams& p) {
        if (!(A.area > 1e-6) || !(B.area > 1e-6) || A.n.norm() < 0.5 || B.n.norm() < 0.5) return 1;
        if (A.n.dot(B.n) < std::cos(p.normalTolDeg * M_PI / 180.0)) return 2;
        double best = 0;
        for (const V3& u : dirsA) for (const V3& v : dirsB) best = std::max(best, std::abs(u.dot(v)));
        if (best < std::cos(p.parallelTolDeg * M_PI / 180.0)) return 3;
        const V3 d = B.c - A.c;
        const double along = (d - A.n * d.dot(A.n)).norm();
        const double allowed = p.stepTolM + p.stepSlope * along;
        if (std::abs(d.dot(A.n)) > allowed || std::abs(d.dot(B.n)) > allowed) return 4;
        return 0;
    }
    static double pairTolerance(uint32_t ta, uint32_t tb, const std::vector<double>& tileErrorM, const TileSeamAdaptiveParams& p, bool* stated = nullptr) {
        const double ea = ta < tileErrorM.size() ? tileErrorM[ta] : -1.0, eb = tb < tileErrorM.size() ? tileErrorM[tb] : -1.0;
        const bool s = ea > 0 && eb > 0;
        if (stated) *stated = s;
        return s ? std::min(p.capM, std::min(ea, eb)) : std::min(p.capM, p.baseToleranceM);
    }
    /** A total order on tiles: the larger stated error first, then the higher id. The higher-ranked tile moves or fills. */
    static bool ranksAbove(uint32_t ta, uint32_t tb, const std::vector<double>& tileErrorM) {
        const double ea = ta < tileErrorM.size() ? tileErrorM[ta] : -1.0, eb = tb < tileErrorM.size() ? tileErrorM[tb] : -1.0;
        return ea != eb ? ea > eb : ta > tb;
    }
    /** One contact: a border position and the nearest open border of another tile within the pair's tolerance. */
    struct Contact {
        uint32_t edge{UINT32_MAX};   // the other tile's open edge (OpenBorder index)
        uint32_t vertex{UINT32_MAX}; // set when the nearest point is that edge's end (a position)
        uint32_t tile{0};
        double s{0}, d{1e300};
        V3 q;
        int agree{-1};
        /** The angle between the two surfaces' normals (degrees; -1 when either side has no surface). */
        double normalDeg{-1};
    };
    struct Contacts {
        Topology topo;
        OpenBorder ob;
        std::vector<uint32_t> gTile;
        std::vector<Contact> at;   // per position
        std::vector<uint32_t> border;   // positions on an open edge with a single tile
    };
    static Contacts findContacts(const geometry::ScratchboxMesh& mesh, const std::vector<uint32_t>& triTile, const std::vector<double>& tileErrorM, const TileSeamAdaptiveParams& p, unsigned threads) {
        Contacts c;
        c.topo = topology(mesh);
        c.ob = openBorder(mesh, c.topo);
        c.gTile = groupTiles(mesh, c.topo, triTile);
        const size_t G = c.topo.gpos.size();
        c.at.assign(G, Contact{});
        auto edgeTile = [&](uint32_t e) { const uint32_t t = c.ob.edges[e].tri; return t < triTile.size() ? triTile[t] : 0u; };
        const double reach = std::max(std::max(p.capM, p.baseToleranceM), 1e-3);
        auto ci = [&](double v) { return static_cast<int64_t>(std::floor(v / reach)); };
        std::unordered_map<int64_t, std::vector<uint32_t>, scan_rectifier::detail::CellKeyHash> grid;
        for (uint32_t i = 0; i < c.ob.edges.size(); ++i) {
            const V3 a = c.topo.gpos[c.ob.edges[i].a], b = c.topo.gpos[c.ob.edges[i].b];
            const int64_t x0 = ci(std::min(a.x, b.x) - reach), x1 = ci(std::max(a.x, b.x) + reach), y0 = ci(std::min(a.y, b.y) - reach), y1 = ci(std::max(a.y, b.y) + reach), z0 = ci(std::min(a.z, b.z) - reach), z1 = ci(std::max(a.z, b.z) + reach);
            if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > 4096) continue;
            for (int64_t x = x0; x <= x1; ++x) for (int64_t y = y0; y <= y1; ++y) for (int64_t z = z0; z <= z1; ++z) grid[scan_rectifier::detail::cellKey(x, y, z)].push_back(i);
        }
        for (uint32_t g = 0; g < G; ++g) if (c.ob.start[g + 1] > c.ob.start[g] && c.gTile[g] != kMixedTile) c.border.push_back(g);
        const TriGrid tg = triGrid(mesh, p.surfaceRadiusM);
        auto dirsOf = [&](uint32_t g) {
            std::vector<V3> d;
            for (uint32_t k = c.ob.start[g]; k < c.ob.start[g + 1]; ++k) { const auto& e = c.ob.edges[c.ob.list[k]]; d.push_back((c.topo.gpos[e.b] - c.topo.gpos[e.a]).normalized()); }
            return d;
        };
        scan_rectifier::detail::parallelFor(c.border.size(), threads, 256, [&](size_t i0, size_t i1, unsigned) {
            for (size_t i = i0; i < i1; ++i) {
                const uint32_t g = c.border[i];
                const V3 x = c.topo.gpos[g];
                const uint32_t mine = c.gTile[g];
                auto it = grid.find(scan_rectifier::detail::cellKey(ci(x.x), ci(x.y), ci(x.z)));
                if (it == grid.end()) continue;
                Contact best;
                for (uint32_t e : it->second) {
                    const uint32_t et = edgeTile(e);
                    if (et == mine) continue;
                    const auto& E = c.ob.edges[e];
                    const double tol = pairTolerance(mine, et, tileErrorM, p);
                    double s;
                    const V3 A = c.topo.gpos[E.a], B = c.topo.gpos[E.b];
                    const double d = pointSegment(x, A, B, &s);
                    if (d > tol) continue;
                    const double L = (B - A).norm();
                    const double da = (x - A).norm(), db = (x - B).norm();
                    Contact h;
                    h.edge = e; h.tile = et; h.s = s;
                    if (s * L <= p.endGuardM || (1.0 - s) * L <= p.endGuardM || std::min(da, db) <= d + p.endGuardM) {
                        h.vertex = da <= db ? E.a : E.b;
                        h.d = std::min(da, db);
                        h.q = c.topo.gpos[h.vertex];
                        if (h.d > tol) continue;
                    } else { h.d = d; h.q = A + (B - A) * s; }
                    if (h.d < best.d || (h.d == best.d && (h.vertex != UINT32_MAX) > (best.vertex != UINT32_MAX))) best = h;
                }
                if (best.edge == UINT32_MAX) continue;
                const LocalSurface sa = surfaceNear(tg, triTile, mine, x, p.surfaceRadiusM), sb = surfaceNear(tg, triTile, best.tile, best.q, p.surfaceRadiusM);
                const auto& E = c.ob.edges[best.edge];
                std::vector<V3> db = best.vertex != UINT32_MAX ? dirsOf(best.vertex) : std::vector<V3>{(c.topo.gpos[E.b] - c.topo.gpos[E.a]).normalized()};
                best.agree = agreement(sa, sb, dirsOf(g), db, p);
                if (sa.area > 1e-6 && sb.area > 1e-6) best.normalDeg = std::acos(std::clamp(sa.n.dot(sb.n), -1.0, 1.0)) * 180.0 / M_PI;
                c.at[g] = best;
            }
        });
        return c;
    }

public:
    /**
     * Adaptive close, after the fixed passes: for every border position of one tile, the nearest open border of another
     * tile within the pair's tolerance (the smaller of the two tiles' stated geometric errors, capped at capM; the base
     * tolerance when either states none), and only where the two surfaces agree there (normals within normalTolDeg, the
     * borders parallel within parallelTolDeg, each surface carried across the seam passing the other's within the step
     * tolerance). Rounds alternate:
     *  - positions: a position whose nearest is another tile's position moves onto it, the higher-ranked tile (ranksAbove)
     *    moving; triangles that collapse go;
     *  - splits: a position on the interior of another tile's edge splits that edge there, the new vertex exactly at the
     *    position (the edge's tile yields, by at most the pair's tolerance); UVs, normal and colour interpolated along it.
     * A close that would turn a triangle inside out or by more than maxTurnDeg is taken back and counted (guardRefused).
     * triTile is the per-triangle tile, kept in lockstep with every other side array passed.
     */
    static TileSeamAdaptiveStats closeAdaptive(geometry::ScratchboxMesh& mesh, std::vector<uint32_t>& triTile, const std::vector<double>& tileErrorM,
                                               std::vector<std::vector<uint32_t>*> sideArrays, const TileSeamAdaptiveParams& p = {}) {
        TileSeamAdaptiveStats st;
        sideArrays.push_back(&triTile);
        const unsigned threads = scan_rectifier::detail::resolveThreads(p.threads);
        const double maxTurnCos = std::cos(p.maxTurnDeg * M_PI / 180.0);
        double sumMove = 0; size_t nMoves = 0;
        int idle = 0;
        for (int round = 0; round < p.rounds; ++round) {
            const bool positionsRound = round % 2 == 0;
            Contacts c = findContacts(mesh, triTile, tileErrorM, p, threads);
            const Topology& topo = c.topo;
            const size_t G = topo.gpos.size(), F = mesh.indices.size() / 3;
            if (round == 0) {
                for (uint32_t g : c.border) {
                    const Contact& h = c.at[g];
                    if (h.edge == UINT32_MAX) continue;
                    ++st.candidates;
                    bool stated;
                    const double tol = pairTolerance(c.gTile[g], h.tile, tileErrorM, p, &stated);
                    if (stated) ++st.pairsWithStatedError;
                    st.maxToleranceM = std::max(st.maxToleranceM, tol);
                    if (h.normalDeg >= 0) { static constexpr double e[7] = {2, 5, 8, 15, 30, 90, 150}; size_t b = 7; for (size_t k = 0; k < 7; ++k) if (h.normalDeg < e[k]) { b = k; break; } st.normalAngleHist[b]++; }
                    switch (h.agree) {
                        case 0: ++st.agreed; st.agreedByGap[h.d < 0.03 ? 0 : h.d < 0.10 ? 1 : h.d < 0.30 ? 2 : 3]++; break;
                        case 1: ++st.refusedNoSurface; break;
                        case 2: ++st.refusedNormal; break;
                        case 3: ++st.refusedParallel; break;
                        default: ++st.refusedStep; break;
                    }
                }
            }
            std::vector<uint32_t> memberStart(G + 1, 0), members(mesh.vertices.size());
            for (uint32_t v = 0; v < mesh.vertices.size(); ++v) memberStart[topo.groupOf[v] + 1]++;
            for (size_t g = 0; g < G; ++g) memberStart[g + 1] += memberStart[g];
            { std::vector<uint32_t> fill(memberStart.begin(), memberStart.end() - 1); for (uint32_t v = 0; v < mesh.vertices.size(); ++v) members[fill[topo.groupOf[v]]++] = v; }
            auto vp = [&](uint32_t v) { const auto& q = mesh.vertices[v].position; return V3{q.x, q.y, q.z}; };
            auto setGroup = [&](uint32_t g, const geometry::Vec3& to) { for (uint32_t m = memberStart[g]; m < memberStart[g + 1]; ++m) mesh.vertices[members[m]].position = to; };
            // maxTurnDeg 0: no close moves anything, every agreed gap is left to the strip fill
            auto turnsBad = [&](const V3& n0, const V3& n1) {
                const double l0 = n0.norm(), l1 = n1.norm();
                if (!(l0 > 1e-14)) return false;
                if (!(p.maxTurnDeg > 0.0)) return true;
                if (!(l1 > 1e-14)) return true;
                return n0.dot(n1) < maxTurnCos * l0 * l1;
            };
            size_t changed = 0;
            if (positionsRound) {
                // a position-to-position contact moves its higher-ranked side onto the other (whichever side found it); a
                // position with several such contacts takes its nearest; a target never moves in the same round
                std::vector<uint8_t> mover(G, 0), target(G, 0);
                std::vector<uint32_t> onto(G, UINT32_MAX);
                std::vector<double> ontoD(G, 1e300);
                for (uint32_t g : c.border) {
                    const Contact& h = c.at[g];
                    if (h.agree != 0 || h.vertex == UINT32_MAX || c.gTile[h.vertex] == kMixedTile) continue;
                    const bool gMoves = ranksAbove(c.gTile[g], h.tile, tileErrorM);
                    const uint32_t m = gMoves ? g : h.vertex, to = gMoves ? h.vertex : g;
                    if (h.d < ontoD[m] || (h.d == ontoD[m] && to < onto[m])) { onto[m] = to; ontoD[m] = h.d; }
                }
                for (uint32_t g = 0; g < G; ++g) if (onto[g] != UINT32_MAX) { mover[g] = 1; target[onto[g]] = 1; }
                for (uint32_t g = 0; g < G; ++g) if (mover[g] && target[g]) mover[g] = 0;
                std::vector<uint8_t> touched(F, 0);
                std::vector<V3> n0(F);
                for (uint32_t g = 0; g < G; ++g) if (mover[g]) setGroup(g, mesh.vertices[members[memberStart[onto[g]]]].position);
                for (size_t t = 0; t < F; ++t) {
                    const uint32_t g0 = topo.groupOf[mesh.indices[3 * t]], g1 = topo.groupOf[mesh.indices[3 * t + 1]], g2 = topo.groupOf[mesh.indices[3 * t + 2]];
                    if (!(mover[g0] || mover[g1] || mover[g2])) continue;
                    touched[t] = 1;
                    n0[t] = (topo.gpos[g1] - topo.gpos[g0]).cross(topo.gpos[g2] - topo.gpos[g0]);
                }
                auto collapsed = [&](size_t t) {
                    const V3 a = vp(mesh.indices[3 * t]), b = vp(mesh.indices[3 * t + 1]), cc = vp(mesh.indices[3 * t + 2]);
                    return (a - b).norm() < 1e-7 || (b - cc).norm() < 1e-7 || (cc - a).norm() < 1e-7;
                };
                for (int pass = 0; pass < 4; ++pass) {
                    size_t rev = 0;
                    for (size_t t = 0; t < F; ++t) {
                        if (!touched[t] || collapsed(t)) continue;
                        const uint32_t i0 = mesh.indices[3 * t], i1 = mesh.indices[3 * t + 1], i2 = mesh.indices[3 * t + 2];
                        if (!turnsBad(n0[t], (vp(i1) - vp(i0)).cross(vp(i2) - vp(i0)))) continue;
                        for (uint32_t v : {i0, i1, i2}) {
                            const uint32_t g = topo.groupOf[v];
                            if (!mover[g]) continue;
                            const V3& o = topo.gpos[g];
                            setGroup(g, geometry::Vec3(static_cast<float>(o.x), static_cast<float>(o.y), static_cast<float>(o.z)));
                            mover[g] = 0;
                            ++rev;
                        }
                    }
                    st.guardRefused += rev;
                    if (!rev) break;
                }
                std::vector<uint8_t> keep(F, kFlagKeep);
                size_t drops = 0;
                for (size_t t = 0; t < F; ++t) if (touched[t] && collapsed(t)) { keep[t] = kFlagHidden; ++drops; }
                for (uint32_t g = 0; g < G; ++g) if (mover[g]) {
                    ++st.vertexMoves; ++changed;
                    sumMove += ontoD[g]; ++nMoves;
                    st.maxMoveM = std::max(st.maxMoveM, ontoD[g]);
                }
                st.trianglesCollapsed += drops;
                compactDropped(mesh, keep, sideArrays);
            } else {
                // splits: per edge its points in order along it; one split per triangle a round
                std::unordered_map<uint32_t, std::vector<uint32_t>> byEdge;
                std::vector<uint32_t> order;
                for (uint32_t g : c.border) {
                    const Contact& h = c.at[g];
                    if (h.agree != 0 || h.vertex != UINT32_MAX) continue;
                    auto& v = byEdge[h.edge];
                    if (v.empty()) order.push_back(h.edge);
                    v.push_back(g);
                }
                std::sort(order.begin(), order.end());
                std::vector<uint8_t> splitTri(F, 0);
                std::vector<uint32_t> newIdx;
                std::vector<std::vector<uint32_t>> newSide(sideArrays.size());
                for (uint32_t ei : order) {
                    const auto& E = c.ob.edges[ei];
                    const uint32_t t = E.tri;
                    if (splitTri[t]) continue;
                    int k = -1;
                    for (int j = 0; j < 3; ++j) {
                        const uint32_t ga = topo.groupOf[mesh.indices[3 * t + j]], gb = topo.groupOf[mesh.indices[3 * t + (j + 1) % 3]];
                        if ((ga == E.a && gb == E.b) || (ga == E.b && gb == E.a)) { k = j; break; }
                    }
                    if (k < 0) continue;
                    const uint32_t va = mesh.indices[3 * t + k], vb = mesh.indices[3 * t + (k + 1) % 3], vc = mesh.indices[3 * t + (k + 2) % 3];
                    const V3 A = vp(va), B = vp(vb), Cc = vp(vc), AB = B - A;
                    const V3 nOrig = AB.cross(Cc - A);
                    std::vector<std::pair<double, uint32_t>> along;
                    for (uint32_t g : byEdge[ei]) along.push_back({std::clamp((topo.gpos[g] - A).dot(AB) / AB.dot(AB), 0.0, 1.0), g});
                    std::sort(along.begin(), along.end());
                    // drop the points whose fan pieces would turn too far, the farthest first, until the rest fan cleanly
                    for (;;) {
                        size_t worst = SIZE_MAX;
                        double worstD = -1;
                        for (size_t j = 0; j <= along.size(); ++j) {
                            const V3 P = j == 0 ? A : topo.gpos[along[j - 1].second];
                            const V3 Q = j == along.size() ? B : topo.gpos[along[j].second];
                            if (!turnsBad(nOrig, (Q - P).cross(Cc - P))) continue;
                            for (size_t jj : {j, j + 1}) {
                                if (jj == 0 || jj > along.size()) continue;
                                const double d = c.at[along[jj - 1].second].d;
                                if (d > worstD) { worstD = d; worst = jj - 1; }
                            }
                        }
                        if (worst == SIZE_MAX) break;
                        along.erase(along.begin() + static_cast<std::ptrdiff_t>(worst));
                        ++st.guardRefused;
                    }
                    if (along.empty()) continue;
                    std::vector<uint32_t> chain{va};
                    for (const auto& [s, g] : along) {
                        geometry::Vertex nv = mesh.vertices[va];
                        const auto& ua = mesh.vertices[va];
                        const auto& ub = mesh.vertices[vb];
                        const float fs = static_cast<float>(s), fr = 1.0f - fs;
                        nv.position = mesh.vertices[members[memberStart[g]]].position;
                        nv.uv = geometry::Vec2(ua.uv.x * fr + ub.uv.x * fs, ua.uv.y * fr + ub.uv.y * fs);
                        nv.uv1 = geometry::Vec2(ua.uv1.x * fr + ub.uv1.x * fs, ua.uv1.y * fr + ub.uv1.y * fs);
                        geometry::Vec3 nn(ua.normal.x * fr + ub.normal.x * fs, ua.normal.y * fr + ub.normal.y * fs, ua.normal.z * fr + ub.normal.z * fs);
                        const float nl = std::sqrt(nn.x * nn.x + nn.y * nn.y + nn.z * nn.z);
                        nv.normal = nl > 0 ? geometry::Vec3(nn.x / nl, nn.y / nl, nn.z / nl) : ua.normal;
                        nv.color = geometry::Vec4(ua.color.x * fr + ub.color.x * fs, ua.color.y * fr + ub.color.y * fs, ua.color.z * fr + ub.color.z * fs, ua.color.w * fr + ub.color.w * fs);
                        chain.push_back(static_cast<uint32_t>(mesh.vertices.size()));
                        mesh.vertices.push_back(nv);
                        const double d = c.at[g].d;
                        sumMove += d; ++nMoves;
                        st.maxMoveM = std::max(st.maxMoveM, d);
                    }
                    chain.push_back(vb);
                    mesh.indices[3 * t + 0] = chain[0]; mesh.indices[3 * t + 1] = chain[1]; mesh.indices[3 * t + 2] = vc;
                    for (size_t j = 1; j + 1 < chain.size(); ++j) {
                        newIdx.push_back(chain[j]); newIdx.push_back(chain[j + 1]); newIdx.push_back(vc);
                        for (size_t si = 0; si < sideArrays.size(); ++si) if (sideArrays[si] && t < sideArrays[si]->size()) newSide[si].push_back((*sideArrays[si])[t]);
                        ++st.trianglesAdded;
                    }
                    splitTri[t] = 1;
                    ++st.edgesSplit;
                    st.splitsClosed += along.size();
                    changed += along.size();
                }
                mesh.indices.insert(mesh.indices.end(), newIdx.begin(), newIdx.end());
                for (size_t si = 0; si < sideArrays.size(); ++si) if (sideArrays[si]) sideArrays[si]->insert(sideArrays[si]->end(), newSide[si].begin(), newSide[si].end());
            }
            st.roundsRun = static_cast<size_t>(round + 1);
            idle = changed ? 0 : idle + 1;
            if (idle >= 2) break;
        }
        st.meanMoveM = nMoves ? sumMove / static_cast<double>(nMoves) : 0.0;
        return st;
    }

    /**
     * Strip fill, last: an open edge of one tile whose both ends have agreed contacts with the same other tile, which the
     * closes above left open (a move there would have distorted the surface), is bridged by thin triangles from the edge to
     * the other tile's border positions along it (its ends' nearest, and those projecting between them), wound as the
     * edge's own triangle across it. Only the higher-ranked tile of a pair fills, so a gap is bridged once. The new
     * triangles are appended at the end of mesh.indices (from *firstFill); their side values are the edge triangle's (the
     * caller relabels their material: the bridge is generated, not scanned). UVs are the edge's own, interpolated along it.
     */
    static TileSeamFillStats fillStrips(geometry::ScratchboxMesh& mesh, std::vector<uint32_t>& triTile, const std::vector<double>& tileErrorM,
                                        std::vector<std::vector<uint32_t>*> sideArrays, const TileSeamAdaptiveParams& p, size_t* firstFill) {
        TileSeamFillStats st;
        sideArrays.push_back(&triTile);
        if (firstFill) *firstFill = mesh.indices.size() / 3;
        const unsigned threads = scan_rectifier::detail::resolveThreads(p.threads);
        Contacts c = findContacts(mesh, triTile, tileErrorM, p, threads);
        const Topology& topo = c.topo;
        const TriGrid tg = triGrid(mesh, p.surfaceRadiusM);
        auto vp = [&](uint32_t v) { const auto& q = mesh.vertices[v].position; return V3{q.x, q.y, q.z}; };
        // a position's float position, exactly (the fill shares the other tile's positions bit for bit)
        std::vector<uint32_t> anyVertex(topo.gpos.size(), UINT32_MAX);
        for (uint32_t v = 0; v < mesh.vertices.size(); ++v) if (anyVertex[topo.groupOf[v]] == UINT32_MAX) anyVertex[topo.groupOf[v]] = v;
        // the other tiles' border positions in a grid, to find those projecting along an edge
        const double reach = std::max(std::max(p.capM, p.baseToleranceM), 1e-3);
        auto ci = [&](double v) { return static_cast<int64_t>(std::floor(v / reach)); };
        std::unordered_map<int64_t, std::vector<uint32_t>, scan_rectifier::detail::CellKeyHash> gGrid;
        for (uint32_t g : c.border) gGrid[scan_rectifier::detail::cellKey(ci(topo.gpos[g].x), ci(topo.gpos[g].y), ci(topo.gpos[g].z))].push_back(g);
        // the nearest position of the other tile: the contact's own position, or the nearer end of its edge
        auto partner = [&](uint32_t g) -> uint32_t {
            const Contact& h = c.at[g];
            if (h.edge == UINT32_MAX || h.agree != 0) return UINT32_MAX;
            if (h.vertex != UINT32_MAX) return h.vertex;
            const auto& E = c.ob.edges[h.edge];
            const uint32_t n = (topo.gpos[E.a] - topo.gpos[g]).norm() <= (topo.gpos[E.b] - topo.gpos[g]).norm() ? E.a : E.b;
            return (topo.gpos[n] - topo.gpos[g]).norm() <= pairTolerance(c.gTile[g], h.tile, tileErrorM, p) ? n : UINT32_MAX;
        };
        std::vector<uint32_t> newIdx;
        std::vector<std::vector<uint32_t>> newSide(sideArrays.size());
        for (const auto& E : c.ob.edges) {
            const uint32_t t = E.tri, tA = t < triTile.size() ? triTile[t] : 0u;
            if (c.gTile[E.a] != tA || c.gTile[E.b] != tA) continue;
            const uint32_t pa = partner(E.a), pb = partner(E.b);
            if (pa == UINT32_MAX || pb == UINT32_MAX) continue;
            const uint32_t tB = c.at[E.a].tile;
            if (c.at[E.b].tile != tB || c.gTile[pa] != tB || c.gTile[pb] != tB) continue;
            if (!ranksAbove(tA, tB, tileErrorM)) continue;
            // the edge as its triangle winds it: a -> b; the fill runs across it b -> a
            int k = -1;
            for (int j = 0; j < 3; ++j) if (topo.groupOf[mesh.indices[3 * t + j]] == E.a && topo.groupOf[mesh.indices[3 * t + (j + 1) % 3]] == E.b) { k = j; break; }
            uint32_t va, vb;
            if (k >= 0) { va = mesh.indices[3 * t + k]; vb = mesh.indices[3 * t + (k + 1) % 3]; }
            else {
                for (int j = 0; j < 3; ++j) if (topo.groupOf[mesh.indices[3 * t + j]] == E.b && topo.groupOf[mesh.indices[3 * t + (j + 1) % 3]] == E.a) { k = j; break; }
                if (k < 0) continue;
                va = mesh.indices[3 * t + k]; vb = mesh.indices[3 * t + (k + 1) % 3];
            }
            const V3 A = vp(va), B = vp(vb), AB = B - A;
            const double ll = AB.dot(AB);
            if (!(ll > 1e-12)) continue;
            auto sOf = [&](uint32_t g) { return (topo.gpos[g] - A).dot(AB) / ll; };
            const uint32_t qa = topo.groupOf[va] == E.a ? pa : pb, qb = topo.groupOf[va] == E.a ? pb : pa;
            const double s0 = sOf(qa), s1 = sOf(qb);
            if (!(s1 > s0)) continue;
            const double tol = pairTolerance(tA, tB, tileErrorM, p);
            std::vector<std::pair<double, uint32_t>> q{{s0, qa}};
            {
                const V3 lo{std::min(A.x, B.x) - tol, std::min(A.y, B.y) - tol, std::min(A.z, B.z) - tol}, hi{std::max(A.x, B.x) + tol, std::max(A.y, B.y) + tol, std::max(A.z, B.z) + tol};
                if ((ci(hi.x) - ci(lo.x) + 1) * (ci(hi.y) - ci(lo.y) + 1) * (ci(hi.z) - ci(lo.z) + 1) > 4096) continue;
                for (int64_t x = ci(lo.x); x <= ci(hi.x); ++x) for (int64_t y = ci(lo.y); y <= ci(hi.y); ++y) for (int64_t z = ci(lo.z); z <= ci(hi.z); ++z) {
                    auto it = gGrid.find(scan_rectifier::detail::cellKey(x, y, z));
                    if (it == gGrid.end()) continue;
                    for (uint32_t g : it->second) {
                        if (c.gTile[g] != tB || g == qa || g == qb) continue;
                        const double s = sOf(g);
                        if (!(s > s0 && s < s1)) continue;
                        if (pointSegment(topo.gpos[g], A, B) > tol) continue;
                        q.push_back({s, g});
                    }
                }
            }
            q.push_back({s1, qb});
            std::sort(q.begin() + 1, q.end() - 1);
            // the edge's own surface, to orient and check the bridge
            const LocalSurface sa = surfaceNear(tg, triTile, tA, (A + B) * 0.5, p.surfaceRadiusM);
            if (!(sa.area > 1e-6)) { ++st.refused; continue; }
            // polygon b -> a -> q0 .. qm, fanned from b
            std::vector<std::array<V3, 3>> tris;
            std::vector<std::array<int, 3>> ref;   // -1 a, -2 b, j >= 0 q[j]
            bool ok = true;
            auto P = [&](int r) { return r == -1 ? A : r == -2 ? B : topo.gpos[q[static_cast<size_t>(r)].second]; };
            std::vector<int> ring{-1};
            for (int j = 0; j < static_cast<int>(q.size()); ++j) ring.push_back(j);
            for (size_t j = 0; j + 1 < ring.size(); ++j) {
                const V3 a = P(-2), b = P(ring[j]), cc = P(ring[j + 1]);
                const V3 n = (b - a).cross(cc - a);
                if (n.norm() < 1e-8) continue;
                if (n.normalized().dot(sa.n) < -0.1) { ok = false; break; }
                ref.push_back({-2, ring[j], ring[j + 1]});
            }
            if (!ok || ref.empty()) { ++st.refused; continue; }
            auto vertexFor = [&](int r) -> uint32_t {
                if (r == -1) return va;
                if (r == -2) return vb;
                const auto [s, g] = q[static_cast<size_t>(r)];
                geometry::Vertex nv = mesh.vertices[va];
                const auto& ua = mesh.vertices[va];
                const auto& ub = mesh.vertices[vb];
                const float fs = static_cast<float>(std::clamp(s, 0.0, 1.0)), fr = 1.0f - fs;
                nv.position = mesh.vertices[anyVertex[g]].position;
                nv.uv = geometry::Vec2(ua.uv.x * fr + ub.uv.x * fs, ua.uv.y * fr + ub.uv.y * fs);
                nv.uv1 = geometry::Vec2(ua.uv1.x * fr + ub.uv1.x * fs, ua.uv1.y * fr + ub.uv1.y * fs);
                nv.normal = geometry::Vec3(static_cast<float>(sa.n.x), static_cast<float>(sa.n.y), static_cast<float>(sa.n.z));
                mesh.vertices.push_back(nv);
                return static_cast<uint32_t>(mesh.vertices.size() - 1);
            };
            std::unordered_map<int, uint32_t> made;
            auto vid = [&](int r) { auto it = made.find(r); if (it != made.end()) return it->second; const uint32_t v = vertexFor(r); made[r] = v; return v; };
            for (const auto& r : ref) {
                newIdx.push_back(vid(r[0])); newIdx.push_back(vid(r[1])); newIdx.push_back(vid(r[2]));
                for (size_t si = 0; si < sideArrays.size(); ++si) if (sideArrays[si] && t < sideArrays[si]->size()) newSide[si].push_back((*sideArrays[si])[t]);
                st.areaM2 += 0.5 * (P(r[1]) - P(r[0])).cross(P(r[2]) - P(r[0])).norm();
                ++st.triangles;
            }
            ++st.edgesFilled;
        }
        mesh.indices.insert(mesh.indices.end(), newIdx.begin(), newIdx.end());
        for (size_t si = 0; si < sideArrays.size(); ++si) if (sideArrays[si]) sideArrays[si]->insert(sideArrays[si]->end(), newSide[si].begin(), newSide[si].end());
        return st;
    }
    static std::string adaptiveStatsJson(const TileSeamAdaptiveStats& s) {
        auto num = [](double v) { char b[64]; std::snprintf(b, sizeof b, "%.6g", v); return std::string(b); };
        std::string js = "\"candidates\": " + std::to_string(s.candidates) + ", \"agreed\": " + std::to_string(s.agreed) +
            ", \"refusedNormal\": " + std::to_string(s.refusedNormal) + ", \"refusedParallel\": " + std::to_string(s.refusedParallel) +
            ", \"refusedStep\": " + std::to_string(s.refusedStep) + ", \"refusedNoSurface\": " + std::to_string(s.refusedNoSurface) + ", \"agreedByGap\": [";
        for (size_t k = 0; k < 4; ++k) js += (k ? ", " : "") + std::to_string(s.agreedByGap[k]);
        js += "], \"normalAngleEdgesDeg\": [0, 2, 5, 8, 15, 30, 90, 150, 180], \"normalAngleHist\": [";
        for (size_t k = 0; k < 8; ++k) js += (k ? ", " : "") + std::to_string(s.normalAngleHist[k]);
        js += "], \"splitsClosed\": " + std::to_string(s.splitsClosed) + ", \"edgesSplit\": " + std::to_string(s.edgesSplit) + ", \"trianglesAdded\": " + std::to_string(s.trianglesAdded) +
            ", \"vertexMoves\": " + std::to_string(s.vertexMoves) + ", \"trianglesCollapsed\": " + std::to_string(s.trianglesCollapsed) + ", \"guardRefused\": " + std::to_string(s.guardRefused) +
            ", \"roundsRun\": " + std::to_string(s.roundsRun) + ", \"maxMoveM\": " + num(s.maxMoveM) + ", \"meanMoveM\": " + num(s.meanMoveM) +
            ", \"pairsWithStatedError\": " + std::to_string(s.pairsWithStatedError) + ", \"maxToleranceM\": " + num(s.maxToleranceM);
        return js;
    }
    static std::string fillStatsJson(const TileSeamFillStats& s) {
        char b[64]; std::snprintf(b, sizeof b, "%.2f", s.areaM2);
        return "\"edgesFilled\": " + std::to_string(s.edgesFilled) + ", \"triangles\": " + std::to_string(s.triangles) + ", \"areaM2\": " + b + ", \"refused\": " + std::to_string(s.refused);
    }

private:
    /**
     * The cuts two tiles share, and what the photo passes need to read and write the photos near them: each cut is the
     * plane halfway between two boxes' faces that face each other within faceMatchM and whose rectangles overlap, facing out
     * of the lower tile; each photo's texels are located in the world (the first place a triangle draws each), and a texel
     * drawn at two places more than sharedM apart (an atlas reusing it) is marked shared: the passes never write it.
     */
    /** A cut: the plane halfway between two boxes' facing faces (u . x = o, u out of the lower tile), and the lower tile's
     *  face rectangle on it (centre c, in-plane axes a, b, half extents ha, hb). */
    struct SeamCut { uint32_t tile[2]; V3 u, c, a, b; double o, ha, hb; };
    struct SeamCuts {
        std::vector<SeamCut> cuts;
        std::vector<std::vector<std::pair<uint32_t, int>>> cutsOf;   // per tile: (cut, side)
        std::vector<std::vector<uint32_t>> trisOf;                   // per tile with a cut: its triangles
        std::vector<int32_t> imageOfTri;                             // per triangle: its photo (scene.images), -1 none
        std::vector<std::vector<float>> texelAt;                     // per photo: world position per texel (NaN: no triangle draws it)
        std::vector<std::vector<uint8_t>> texelShared;
    };
    /** The cuts two boxes share: faces facing each other within faceMatchM whose rectangles overlap (the tile seam stage's cuts). */
    static std::vector<SeamCut> boxCuts(const std::vector<TileBox>& boxes, double faceMatchM) {
        std::vector<SeamCut> cuts;
        struct Face { uint32_t tile; V3 u, c, a, b; double o, ha, hb; };
        std::vector<Face> faces;
        for (uint32_t t = 0; t < boxes.size(); ++t) {
            const TileBox& B = boxes[t];
            if (!B.valid) continue;
            for (int k = 0; k < 3; ++k) for (int s = -1; s <= 1; s += 2) {
                const double hk = B.h[k].norm();
                if (!(hk > 1e-6)) continue;
                Face f;
                f.tile = t; f.u = B.h[k] * (s / hk); f.c = B.c + B.h[k] * s; f.o = f.u.dot(f.c);
                f.a = B.h[(k + 1) % 3]; f.b = B.h[(k + 2) % 3]; f.ha = f.a.norm(); f.hb = f.b.norm();
                if (f.ha > 1e-9) f.a = f.a * (1.0 / f.ha);
                if (f.hb > 1e-9) f.b = f.b * (1.0 / f.hb);
                faces.push_back(f);
            }
        }
        auto overlaps = [](const Face& f, const Face& g) {
            double lo[2] = {1e300, 1e300}, hi[2] = {-1e300, -1e300};
            for (int i = -1; i <= 1; i += 2) for (int j = -1; j <= 1; j += 2) {
                const V3 q = g.c + g.a * (i * g.ha) + g.b * (j * g.hb) - f.c;
                const double x = q.dot(f.a), y = q.dot(f.b);
                lo[0] = std::min(lo[0], x); hi[0] = std::max(hi[0], x); lo[1] = std::min(lo[1], y); hi[1] = std::max(hi[1], y);
            }
            return lo[0] < f.ha && hi[0] > -f.ha && lo[1] < f.hb && hi[1] > -f.hb;
        };
        for (size_t i = 0; i < faces.size(); ++i) for (size_t j = 0; j < faces.size(); ++j) {
            const Face& f = faces[i]; const Face& g = faces[j];
            if (f.tile >= g.tile || f.u.dot(g.u) > -0.995 || std::abs(f.o + g.o) > faceMatchM || !overlaps(f, g)) continue;
            SeamCut c;
            c.tile[0] = f.tile; c.tile[1] = g.tile; c.u = f.u; c.o = 0.5 * (f.o - g.o); c.a = f.a; c.b = f.b; c.c = f.c - f.u * (f.o - c.o);
            c.ha = f.ha; c.hb = f.hb;
            cuts.push_back(c);
        }
        return cuts;
    }

    static SeamCuts seamCuts(const gltf::GltfScene& scene, const std::vector<uint32_t>& triTile, const std::vector<TileBox>& boxes, double faceMatchM, int threadsWanted) {
        SeamCuts sc;
        const auto& mesh = scene.mesh;
        const size_t F = mesh.indices.size() / 3;
        auto vp = [&](uint32_t v) { const auto& q = mesh.vertices[v].position; return V3{q.x, q.y, q.z}; };
        sc.cuts = boxCuts(boxes, faceMatchM);
        sc.cutsOf.assign(boxes.size(), {});
        for (uint32_t k = 0; k < sc.cuts.size(); ++k) { sc.cutsOf[sc.cuts[k].tile[0]].push_back({k, 0}); sc.cutsOf[sc.cuts[k].tile[1]].push_back({k, 1}); }
        sc.trisOf.assign(boxes.size(), {});
        sc.imageOfTri.assign(F, -1);
        std::vector<std::vector<uint32_t>> trisOfImage(scene.images.size());
        for (size_t t = 0; t < F; ++t) {
            const uint32_t m = t < scene.triangleMaterial.size() ? scene.triangleMaterial[t] : UINT32_MAX;
            if (m < scene.materials.size()) {
                const int im = scene.materials[m].baseColorImage;
                if (im >= 0 && im < static_cast<int>(scene.images.size()) && scene.images[static_cast<size_t>(im)].decoded) {
                    sc.imageOfTri[t] = im;
                    trisOfImage[static_cast<size_t>(im)].push_back(static_cast<uint32_t>(t));
                }
            }
            if (triTile[t] < boxes.size() && !sc.cutsOf[triTile[t]].empty()) sc.trisOf[triTile[t]].push_back(static_cast<uint32_t>(t));
        }
        const double sharedM = 0.5;
        sc.texelAt.assign(scene.images.size(), {});
        sc.texelShared.assign(scene.images.size(), {});
        std::vector<uint32_t> used;
        for (uint32_t i = 0; i < scene.images.size(); ++i) if (!trisOfImage[i].empty()) used.push_back(i);
        scan_rectifier::detail::parallelFor(used.size(), scan_rectifier::detail::resolveThreads(threadsWanted), 1, [&](size_t a0, size_t a1, unsigned) {
            for (size_t ui = a0; ui < a1; ++ui) {
                const uint32_t im = used[ui];
                const auto& img = scene.images[im].pixels;
                auto& at = sc.texelAt[im];
                auto& sh = sc.texelShared[im];
                at.assign(static_cast<size_t>(img.width) * img.height * 3, std::numeric_limits<float>::quiet_NaN());
                sh.assign(static_cast<size_t>(img.width) * img.height, 0);
                for (uint32_t t : trisOfImage[im]) {
                    const uint32_t i0 = mesh.indices[3 * t], i1 = mesh.indices[3 * t + 1], i2 = mesh.indices[3 * t + 2];
                    const V3 P0 = vp(i0), P1 = vp(i1), P2 = vp(i2);
                    const auto& u0 = mesh.vertices[i0].uv; const auto& u1 = mesh.vertices[i1].uv; const auto& u2 = mesh.vertices[i2].uv;
                    const double W = img.width, H = img.height;
                    const double x0 = u0.x * W, y0 = u0.y * H, x1 = u1.x * W, y1 = u1.y * H, x2 = u2.x * W, y2 = u2.y * H;
                    const double den = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
                    const int xa = std::max(0, static_cast<int>(std::floor(std::min({x0, x1, x2})))), xb = std::min(img.width - 1, static_cast<int>(std::ceil(std::max({x0, x1, x2}))));
                    const int ya = std::max(0, static_cast<int>(std::floor(std::min({y0, y1, y2})))), yb = std::min(img.height - 1, static_cast<int>(std::ceil(std::max({y0, y1, y2}))));
                    if (xb < xa || yb < ya || static_cast<int64_t>(xb - xa + 1) * (yb - ya + 1) > 4'000'000) continue;
                    // a triangle with (almost) no texture area draws one texel or a line of them everywhere it stands
                    const bool flat = std::abs(den) < 1e-9;
                    for (int y = ya; y <= yb; ++y) for (int x = xa; x <= xb; ++x) {
                        V3 q;
                        if (flat) q = (P0 + P1 + P2) * (1.0 / 3.0);
                        else {
                            const double px = x + 0.5, py = y + 0.5;
                            const double l1 = ((px - x0) * (y2 - y0) - (x2 - x0) * (py - y0)) / den, l2 = ((x1 - x0) * (py - y0) - (px - x0) * (y1 - y0)) / den, l0 = 1 - l1 - l2;
                            if (l0 < -0.02 || l1 < -0.02 || l2 < -0.02) continue;
                            q = P0 * l0 + P1 * l1 + P2 * l2;
                        }
                        const size_t ti = static_cast<size_t>(y) * img.width + x;
                        float* a = &at[ti * 3];
                        if (std::isnan(a[0])) { a[0] = static_cast<float>(q.x); a[1] = static_cast<float>(q.y); a[2] = static_cast<float>(q.z); continue; }
                        const double dx = a[0] - q.x, dy = a[1] - q.y, dz = a[2] - q.z;
                        if (dx * dx + dy * dy + dz * dz > sharedM * sharedM) sh[ti] = 1;
                    }
                }
            }
        });
        return sc;
    }
    /** One texel of a surface crossing a cut, within the band on its own side. */
    struct BandTexel { uint32_t cut; int side; double d; V3 q, n; uint32_t tri; int image; int x, y; size_t texel; };
    /** Visits every texel of every triangle of `tile` that crosses one of its cuts (|n . u| <= crossCos) within maxD on its own side. */
    static void visitBand(const gltf::GltfScene& scene, const SeamCuts& sc, uint32_t tile, double maxD, double crossCos, const std::function<void(const BandTexel&)>& fn) {
        const auto& mesh = scene.mesh;
        auto vp = [&](uint32_t v) { const auto& q = mesh.vertices[v].position; return V3{q.x, q.y, q.z}; };
        for (uint32_t t : sc.trisOf[tile]) {
            const int im = sc.imageOfTri[t];
            if (im < 0) continue;
            const auto& img = scene.images[static_cast<size_t>(im)].pixels;
            const uint32_t i0 = mesh.indices[3 * t], i1 = mesh.indices[3 * t + 1], i2 = mesh.indices[3 * t + 2];
            const V3 P0 = vp(i0), P1 = vp(i1), P2 = vp(i2);
            V3 n = (P1 - P0).cross(P2 - P0);
            if (!(n.norm() > 1e-12)) continue;
            n = n.normalized();
            for (const auto& [k, side] : sc.cutsOf[tile]) {
                const SeamCut& C = sc.cuts[k];
                if (std::abs(n.dot(C.u)) > crossCos) continue;
                const double sg = side == 0 ? -1.0 : 1.0;   // own side: inside the lower tile is below the plane
                const double d0 = sg * (C.u.dot(P0) - C.o), d1 = sg * (C.u.dot(P1) - C.o), d2 = sg * (C.u.dot(P2) - C.o);
                if (std::min({d0, d1, d2}) > maxD || std::max({d0, d1, d2}) < -0.3) continue;
                const auto& u0 = mesh.vertices[i0].uv; const auto& u1 = mesh.vertices[i1].uv; const auto& u2 = mesh.vertices[i2].uv;
                const double W = img.width, H = img.height;
                const double x0 = u0.x * W, y0 = u0.y * H, x1 = u1.x * W, y1 = u1.y * H, x2 = u2.x * W, y2 = u2.y * H;
                const double den = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
                if (std::abs(den) < 1e-9) continue;
                const int xa = std::max(0, static_cast<int>(std::floor(std::min({x0, x1, x2})))), xb = std::min(img.width - 1, static_cast<int>(std::ceil(std::max({x0, x1, x2}))));
                const int ya = std::max(0, static_cast<int>(std::floor(std::min({y0, y1, y2})))), yb = std::min(img.height - 1, static_cast<int>(std::ceil(std::max({y0, y1, y2}))));
                if (static_cast<int64_t>(xb - xa + 1) * (yb - ya + 1) > 4'000'000) continue;
                for (int y = ya; y <= yb; ++y) for (int x = xa; x <= xb; ++x) {
                    const double px = x + 0.5, py = y + 0.5;
                    const double l1 = ((px - x0) * (y2 - y0) - (x2 - x0) * (py - y0)) / den, l2 = ((x1 - x0) * (py - y0) - (px - x0) * (y1 - y0)) / den, l0 = 1 - l1 - l2;
                    if (l0 < 0 || l1 < 0 || l2 < 0) continue;
                    const size_t texel = static_cast<size_t>(y) * img.width + x;
                    if (sc.texelShared[static_cast<size_t>(im)][texel]) continue;
                    const V3 q = P0 * l0 + P1 * l1 + P2 * l2;
                    const double d = sg * (C.u.dot(q) - C.o);
                    if (d > maxD || d < -0.3) continue;
                    fn(BandTexel{k, side, std::max(0.0, d), q, n, t, im, x, y, texel});
                }
            }
        }
    }
    /** Which way a surface crossing a cut faces, in eighths of a turn in the cut's plane. */
    static int facingOctant(const SeamCut& C, const V3& n) {
        return static_cast<int>(std::floor((std::atan2(n.dot(C.b), n.dot(C.a)) + M_PI) / (M_PI / 4.0))) & 7;
    }
    static std::vector<uint32_t> tilesWithCuts(const SeamCuts& sc) {
        std::vector<uint32_t> out;
        for (uint32_t t = 0; t < sc.trisOf.size(); ++t) if (!sc.trisOf[t].empty()) out.push_back(t);
        return out;
    }

public:
    /**
     * Seam tone feather: on every surface crossing a cut two tiles share (seamCuts), each tile's photo is read within sampleM
     * of the cut, in binM bins along it (whichever way the surface faces: binning by facing split a facade's triangles
     * along a bin's edge, each side levelled its own way). Where both sides read a bin, the two mean
     * colours (linear RGB) are levelled toward their geometric mean, half the step each, the correction smoothed over
     * neighbouring bins, interpolated between bin centres (a bin with none counting as none, so it fades out where the read
     * ends), faded to nothing over bandM from the cut (raised cosine), and capped at maxGain per texel. The
     * texels are rewritten in each tile's photo (re-encoded in its own format); geometry and UVs are untouched. The levels are fitted,
     * so a stage reports them as generated; the photo's detail stays the photo's.
     */
    static TileSeamToneStats featherSeamTone(gltf::GltfScene& scene, const std::vector<uint32_t>& triTile, const std::vector<TileBox>& boxes, const TileSeamToneParams& p = {}) {
        using namespace tone_detail;
        TileSeamToneStats st;
        if (triTile.size() != scene.mesh.indices.size() / 3) return st;
        const SeamCuts sc = seamCuts(scene, triTile, boxes, p.faceMatchM, p.threads);
        st.cuts = sc.cuts.size();
        if (sc.cuts.empty()) return st;
        const unsigned threads = scan_rectifier::detail::resolveThreads(p.threads);
        const std::vector<uint32_t> tiles = tilesWithCuts(sc);
        // bins: (cut, ia, ib, facing) -> per side sums
        auto binKey = [&](uint32_t cut, int64_t ia, int64_t ib, int oct) {
            return (static_cast<uint64_t>(cut) << 40) | (static_cast<uint64_t>((ia + 32768) & 0xFFFF) << 24) | (static_cast<uint64_t>((ib + 32768) & 0xFFFF) << 8) | static_cast<uint64_t>(oct);
        };
        auto keyOf = [&](const BandTexel& b) {
            const SeamCut& C = sc.cuts[b.cut];
            const V3 r = b.q - C.c;
            return binKey(b.cut, static_cast<int64_t>(std::floor(r.dot(C.a) / p.binM)), static_cast<int64_t>(std::floor(r.dot(C.b) / p.binM)), 0);
        };
        struct Sum { double r{0}, g{0}, b{0}; size_t n{0}; };
        using BinMap = std::unordered_map<uint64_t, std::array<Sum, 2>>;
        auto sample = [&]() {
            std::vector<BinMap> local(threads);
            scan_rectifier::detail::parallelFor(tiles.size(), threads, 1, [&](size_t i0, size_t i1, unsigned th) {
                for (size_t i = i0; i < i1; ++i) visitBand(scene, sc, tiles[i], p.sampleM, p.crossCos, [&](const BandTexel& b) {
                    const auto& img = scene.images[static_cast<size_t>(b.image)].pixels;
                    const uint8_t* px = &img.data[b.texel * static_cast<size_t>(img.channels)];
                    Sum& s = local[th][keyOf(b)][static_cast<size_t>(b.side)];
                    s.r += toLinear(px[0] / 255.0); s.g += toLinear(px[img.channels >= 3 ? 1 : 0] / 255.0); s.b += toLinear(px[img.channels >= 3 ? 2 : 0] / 255.0); ++s.n;
                });
            });
            BinMap all;
            for (auto& m : local) for (auto& [k, v] : m) for (int s = 0; s < 2; ++s) { auto& a = all[k][static_cast<size_t>(s)]; a.r += v[static_cast<size_t>(s)].r; a.g += v[static_cast<size_t>(s)].g; a.b += v[static_cast<size_t>(s)].b; a.n += v[static_cast<size_t>(s)].n; }
            return all;
        };
        auto stepPercentiles = [&](const BinMap& bins, const std::vector<uint64_t>& keys, double& p50, double& p90) {
            std::vector<std::pair<double, double>> de;   // (dE, weight)
            double wsum = 0;
            for (uint64_t k : keys) {
                auto it = bins.find(k);
                if (it == bins.end() || it->second[0].n < p.minTexels || it->second[1].n < p.minTexels) continue;
                const auto& A = it->second[0]; const auto& B = it->second[1];
                const auto la = lab({A.r / A.n, A.g / A.n, A.b / A.n}), lb = lab({B.r / B.n, B.g / B.n, B.b / B.n});
                const double w = static_cast<double>(std::min(A.n, B.n));
                de.push_back({std::sqrt((la[0] - lb[0]) * (la[0] - lb[0]) + (la[1] - lb[1]) * (la[1] - lb[1]) + (la[2] - lb[2]) * (la[2] - lb[2])), w});
                wsum += w;
            }
            std::sort(de.begin(), de.end());
            p50 = p90 = 0;
            double acc = 0;
            bool got50 = false;
            for (const auto& [v, w] : de) { acc += w; if (!got50 && acc >= 0.5 * wsum) { p50 = v; got50 = true; } if (acc >= 0.9 * wsum) { p90 = v; break; } }
        };
        // ---- read both sides, and the levelling per bin (half the step each way, in log space)
        BinMap before = sample();
        // ---- tone balance: one gain per tile and channel, fitted over every cut at once (weighted least squares on the log
        // of the two sides' mean colours per cut, with a small pull toward no gain), applied to the tile's whole photos
        std::vector<uint8_t> balanced(scene.images.size(), 0);
        double rawP50 = 0, rawP90 = 0;
        if (p.balance) {
            std::vector<uint64_t> keys;
            for (const auto& [k, v] : before) if (v[0].n >= p.minTexels && v[1].n >= p.minTexels) keys.push_back(k);
            std::sort(keys.begin(), keys.end());
            stepPercentiles(before, keys, rawP50, rawP90);
            // a cut's step: the weighted median of its bins' (one bin over a window or a shadow's edge says nothing of the tile)
            struct CutSum { std::array<double, 3> lg{0, 0, 0}; double w{0}; std::vector<std::pair<double, double>> bins[3]; };
            std::vector<CutSum> perCut(sc.cuts.size());
            for (uint64_t k : keys) {
                const auto& v = before.at(k);
                const double w = static_cast<double>(std::min(v[0].n, v[1].n));
                CutSum& c = perCut[static_cast<size_t>(k >> 40)];
                auto lg = [](double a, double b) { return std::log(std::max(b, 1e-4)) - std::log(std::max(a, 1e-4)); };
                c.bins[0].push_back({lg(v[0].r / v[0].n, v[1].r / v[1].n), w}); c.bins[1].push_back({lg(v[0].g / v[0].n, v[1].g / v[1].n), w}); c.bins[2].push_back({lg(v[0].b / v[0].n, v[1].b / v[1].n), w});
                c.w += w;
            }
            for (CutSum& c : perCut) for (size_t ch = 0; ch < 3; ++ch) {
                auto& b = c.bins[ch];
                if (b.empty()) continue;
                std::sort(b.begin(), b.end());
                double acc = 0;
                for (const auto& [v, w] : b) { acc += w; if (acc >= 0.5 * c.w) { c.lg[ch] = v * c.w; break; } }
            }
            // the fit: g(tile 0) - g(tile 1) = the cut's log step, per channel (Gauss-Seidel on the normal equations)
            struct Edge { uint32_t other; double w; std::array<double, 3> d; double w0; };
            std::unordered_map<uint32_t, std::vector<Edge>> edgesOf;
            for (size_t k = 0; k < sc.cuts.size(); ++k) {
                if (!(perCut[k].w >= static_cast<double>(p.balanceMinTexels))) continue;
                ++st.balanceCuts;
                std::array<double, 3> d;
                for (size_t c = 0; c < 3; ++c) d[c] = perCut[k].lg[c] / perCut[k].w;
                edgesOf[sc.cuts[k].tile[0]].push_back({sc.cuts[k].tile[1], perCut[k].w, d, perCut[k].w});
                edgesOf[sc.cuts[k].tile[1]].push_back({sc.cuts[k].tile[0], perCut[k].w, {-d[0], -d[1], -d[2]}, perCut[k].w});
            }
            std::vector<uint32_t> order;
            for (const auto& kv : edgesOf) order.push_back(kv.first);
            std::sort(order.begin(), order.end());
            std::unordered_map<uint32_t, std::array<double, 3>> gain;
            for (uint32_t t : order) gain[t] = {0, 0, 0};
            const double bcap = std::log(p.balanceMaxGain);
            // refitted with each cut's weight cut down by how far it stands from the fit (Huber): a tile holds faces lit
            // differently, and a cut on one of them disagrees with the rest whatever gain the tile takes
            for (int refit = 0; refit < 6; ++refit) {
            if (refit) for (uint32_t t : order) for (Edge& e : edgesOf[t]) {
                double r = 0;
                for (size_t c = 0; c < 3; ++c) r = std::max(r, std::abs(gain[t][c] - gain[e.other][c] - e.d[c]));
                e.w = e.w0 * std::min(1.0, p.balanceHuber / std::max(r, 1e-9));
            }
            for (int it = 0; it < 2000; ++it) {
                double moved = 0;
                for (uint32_t t : order) {
                    const auto& es = edgesOf[t];
                    double wsum = 0;
                    std::array<double, 3> acc{0, 0, 0};
                    for (const Edge& e : es) { const auto& go = gain[e.other]; for (size_t c = 0; c < 3; ++c) acc[c] += e.w * (go[c] + e.d[c]); wsum += e.w; }
                    auto& g = gain[t];
                    for (size_t c = 0; c < 3; ++c) { const double v = std::clamp(acc[c] / (wsum * (1.0 + p.balanceRidge)), -bcap, bcap); moved = std::max(moved, std::abs(v - g[c])); g[c] = v; }
                }
                if (moved < 1e-7) break;
            }
            }
            // each photo's tile (a photo two tiles draw from is left alone)
            std::vector<int64_t> tileOfImage(scene.images.size(), -1);
            for (size_t t = 0; t < sc.imageOfTri.size() && t < triTile.size(); ++t) {
                const int32_t im = sc.imageOfTri[t];
                if (im < 0) continue;
                int64_t& o = tileOfImage[static_cast<size_t>(im)];
                if (o == -1) o = triTile[t]; else if (o != static_cast<int64_t>(triTile[t])) o = -2;
            }
            double lsum = 0;
            for (uint32_t t : order) { const auto& g = gain[t]; for (size_t c = 0; c < 3; ++c) { lsum += g[c]; st.balanceMaxGain = std::max(st.balanceMaxGain, std::exp(std::abs(g[c]))); } }
            st.tilesBalanced = order.size();
            st.balanceMeanLogGain = order.empty() ? 0.0 : lsum / (3.0 * static_cast<double>(order.size()));
            scan_rectifier::detail::parallelFor(scene.images.size(), threads, 1, [&](size_t i0, size_t i1, unsigned) {
                for (size_t im = i0; im < i1; ++im) {
                    if (tileOfImage[im] < 0) continue;
                    auto git = gain.find(static_cast<uint32_t>(tileOfImage[im]));
                    if (git == gain.end()) continue;
                    const double g[3] = {std::exp(git->second[0]), std::exp(git->second[1]), std::exp(git->second[2])};
                    auto& img = scene.images[im].pixels;
                    const size_t N = static_cast<size_t>(img.width) * img.height;
                    bool any = false;
                    for (size_t t = 0; t < N; ++t) {
                        uint8_t* px = &img.data[t * static_cast<size_t>(img.channels)];
                        for (int c = 0; c < std::min(3, img.channels); ++c) {
                            const int v = std::clamp(static_cast<int>(std::lround(255.0 * toSrgb(toLinear(px[c] / 255.0) * g[img.channels >= 3 ? c : 1]))), 0, 255);
                            if (v != px[c]) any = true;
                            px[c] = static_cast<uint8_t>(v);
                        }
                    }
                    if (any) balanced[im] = 1;
                }
            });
            before = sample();
        }
        std::vector<uint64_t> matched;
        std::unordered_map<uint64_t, std::array<double, 3>> rawLg;   // side 0 gets +lg, side 1 -lg
        const double cap = std::log(p.maxGain);
        for (const auto& [k, v] : before) {
            if (v[0].n < p.minTexels || v[1].n < p.minTexels) continue;
            matched.push_back(k);
            auto lg = [&](double a, double b) { return std::clamp(0.5 * (std::log(std::max(b, 1e-4)) - std::log(std::max(a, 1e-4))), -cap, cap); };
            rawLg[k] = {lg(v[0].r / v[0].n, v[1].r / v[1].n), lg(v[0].g / v[0].n, v[1].g / v[1].n), lg(v[0].b / v[0].n, v[1].b / v[1].n)};
        }
        std::sort(matched.begin(), matched.end());
        st.binsMatched = matched.size();
        stepPercentiles(before, matched, st.dEBeforeP50, st.dEBeforeP90);
        if (p.balance) { st.dEBalancedP50 = st.dEBeforeP50; st.dEBalancedP90 = st.dEBeforeP90; st.dEBeforeP50 = rawP50; st.dEBeforeP90 = rawP90; }
        if (!p.feather) rawLg.clear();
        auto unpack = [](uint64_t k, uint32_t& cut, int64_t& ia, int64_t& ib, int& oct) {
            cut = static_cast<uint32_t>(k >> 40); ia = static_cast<int64_t>((k >> 24) & 0xFFFF) - 32768; ib = static_cast<int64_t>((k >> 8) & 0xFFFF) - 32768; oct = static_cast<int>(k & 0xFF);
        };
        // a bin's levelling: its own and its neighbours' (one bin either way, same facing), weighted by texels, its own twice;
        // worked out before the threads for every bin a band texel can reach (the cache is read-only below)
        std::unordered_map<uint64_t, std::array<double, 3>> level;
        {
            std::unordered_set<uint64_t> keys;
            for (uint64_t k : matched) {
                uint32_t cut; int64_t ia, ib; int oct;
                unpack(k, cut, ia, ib, oct);
                const int reach = static_cast<int>(std::ceil(p.bandM / p.binM)) + 1;
                for (int64_t da = -reach; da <= reach; ++da) for (int64_t db = -reach; db <= reach; ++db) keys.insert(binKey(cut, ia + da, ib + db, oct));
            }
            for (uint64_t key : keys) {
                uint32_t cut; int64_t ia, ib; int oct;
                unpack(key, cut, ia, ib, oct);
                double w = 0;
                std::array<double, 3> out{0, 0, 0};
                for (int64_t da = -1; da <= 1; ++da) for (int64_t db = -1; db <= 1; ++db) {
                    auto it = rawLg.find(binKey(cut, ia + da, ib + db, oct));
                    if (it == rawLg.end()) continue;
                    const auto& s = before.at(it->first);
                    const double ww = static_cast<double>(std::min(s[0].n, s[1].n)) * (da == 0 && db == 0 ? 2.0 : 1.0);
                    for (int c = 0; c < 3; ++c) out[static_cast<size_t>(c)] += it->second[static_cast<size_t>(c)] * ww;
                    w += ww;
                }
                if (!(w > 0)) continue;
                for (auto& v : out) v /= w;
                level[key] = out;
            }
        }
        // ---- apply: per photo a log-gain per texel, each cut counted once per texel, the total capped, then rewritten
        std::vector<std::vector<float>> acc(scene.images.size());
        std::vector<std::unordered_set<uint64_t>> applied(scene.images.size());   // (texel, cut) pairs counted
        std::vector<std::mutex> imageLock(scene.images.size());
        scan_rectifier::detail::parallelFor(tiles.size(), threads, 1, [&](size_t i0, size_t i1, unsigned) {
            for (size_t i = i0; i < i1; ++i) visitBand(scene, sc, tiles[i], p.bandM, p.crossCos, [&](const BandTexel& b) {
                // the levelling between the four nearest bin centres (bilinear, over those that have one), so it never steps at a bin's edge
                const SeamCut& C = sc.cuts[b.cut];
                const V3 r = b.q - C.c;
                const double fa = r.dot(C.a) / p.binM - 0.5, fb = r.dot(C.b) / p.binM - 0.5;
                const int64_t ia = static_cast<int64_t>(std::floor(fa)), ib = static_cast<int64_t>(std::floor(fb));
                const double wa = fa - static_cast<double>(ia), wb = fb - static_cast<double>(ib);
                std::array<double, 3> lg{0, 0, 0};
                bool any = false;
                // a bin with no levelling counts as none, so the levelling fades out over a bin where the read ends
                for (int da = 0; da <= 1; ++da) for (int db = 0; db <= 1; ++db) {
                    auto it = level.find(binKey(b.cut, ia + da, ib + db, 0));
                    if (it == level.end()) continue;
                    const double w = (da ? wa : 1 - wa) * (db ? wb : 1 - wb);
                    for (int c = 0; c < 3; ++c) lg[static_cast<size_t>(c)] += w * it->second[static_cast<size_t>(c)];
                    any = true;
                }
                if (!any) return;
                const double w = 0.5 * (1.0 + std::cos(M_PI * std::min(b.d / p.bandM, 1.0)));
                const double sg = b.side == 0 ? 1.0 : -1.0;
                std::lock_guard<std::mutex> lock(imageLock[static_cast<size_t>(b.image)]);
                auto& a = acc[static_cast<size_t>(b.image)];
                const auto& img = scene.images[static_cast<size_t>(b.image)].pixels;
                if (a.empty()) a.assign(static_cast<size_t>(img.width) * img.height * 3, std::numeric_limits<float>::quiet_NaN());
                if (!applied[static_cast<size_t>(b.image)].insert((static_cast<uint64_t>(b.texel) << 24) | b.cut).second) return;
                float* t = &a[b.texel * 3];
                if (std::isnan(t[0])) t[0] = t[1] = t[2] = 0.0f;
                for (int c = 0; c < 3; ++c) t[c] += static_cast<float>(sg * w * lg[static_cast<size_t>(c)]);
            });
        });
        double maxGainSeen = 1.0;
        for (size_t im = 0; im < scene.images.size(); ++im) {
            if (acc[im].empty() && !balanced[im]) continue;
            auto& img = scene.images[im].pixels;
            const size_t N = static_cast<size_t>(img.width) * img.height;
            size_t changed = balanced[im] ? N : 0;
            for (size_t t = 0; t < N && !acc[im].empty(); ++t) {
                if (std::isnan(acc[im][t * 3])) continue;
                uint8_t* px = &img.data[t * static_cast<size_t>(img.channels)];
                bool any = false;
                for (int c = 0; c < std::min(3, img.channels); ++c) {
                    const double g = std::exp(std::clamp(static_cast<double>(acc[im][t * 3 + static_cast<size_t>(c)]), -cap, cap));
                    maxGainSeen = std::max(maxGainSeen, std::max(g, 1.0 / g));
                    const int v = std::clamp(static_cast<int>(std::lround(255.0 * toSrgb(toLinear(px[c] / 255.0) * g))), 0, 255);
                    if (v != px[c]) any = true;
                    px[c] = static_cast<uint8_t>(v);
                }
                if (any && !balanced[im]) ++changed;
            }
            if (changed) {
                ++st.imagesChanged;
                st.changedImages.push_back(static_cast<uint32_t>(im));
                st.texelsChanged += changed;
                // written back in the format it came in (a JPEG stays a JPEG, at about its size)
                if (scene.images[im].mimeType == "image/jpeg") scene.images[im].encoded = jpeg::encode(img, p.jpegQuality);
                else { scene.images[im].encoded = png::encode(img, 6); scene.images[im].mimeType = "image/png"; }
            }
        }
        st.maxGain = maxGainSeen;
        const BinMap after = sample();
        stepPercentiles(after, matched, st.dEAfterP50, st.dEAfterP90);
        return st;
    }
    /** The picture offset across every cut two tiles share (TileSeamOffsetParams): a measure only, nothing is changed. */
    static TileSeamOffsetStats measureSeamOffsets(const gltf::GltfScene& scene, const std::vector<uint32_t>& triTile, const std::vector<TileBox>& boxes, const TileSeamOffsetParams& p = {}) {
        TileSeamOffsetStats st;
        if (triTile.size() != scene.mesh.indices.size() / 3) return st;
        const SeamCuts sc = seamCuts(scene, triTile, boxes, p.faceMatchM, p.threads);
        st.cuts = sc.cuts.size();
        if (sc.cuts.empty()) return st;
        const int cellsPer = std::max(8, static_cast<int>(std::lround(p.segmentM / p.cellM)));
        struct Seg { std::vector<double> sum[2]; std::vector<uint32_t> n[2]; double texArea{0}; size_t texels{0}; };
        std::unordered_map<uint64_t, Seg> segs;   // (cut, facing, piece along the wall)
        for (uint32_t tile : tilesWithCuts(sc)) visitBand(scene, sc, tile, p.sampleM, p.crossCos, [&](const BandTexel& b) {
            const SeamCut& C = sc.cuts[b.cut];
            const int oct = facingOctant(C, b.n);
            // along the wall in the cut's plane, by the facing's own direction (the same for both tiles' triangles of it)
            const double th = (oct + 0.5) * (M_PI / 4.0) - M_PI;
            const V3 t = C.a * (-std::sin(th)) + C.b * std::cos(th);
            const double sAlong = (b.q - C.c).dot(t) / p.cellM;
            const int64_t cell = static_cast<int64_t>(std::floor(sAlong)), piece = cell >= 0 ? cell / cellsPer : -((-cell + cellsPer - 1) / cellsPer);
            Seg& sg = segs[(static_cast<uint64_t>(b.cut) << 32) | (static_cast<uint64_t>(oct) << 28) | static_cast<uint64_t>((piece + (1 << 20)) & 0xFFFFFFF)];
            if (sg.sum[0].empty()) for (int k = 0; k < 2; ++k) { sg.sum[k].assign(static_cast<size_t>(cellsPer), 0.0); sg.n[k].assign(static_cast<size_t>(cellsPer), 0u); }
            const size_t i = static_cast<size_t>(cell - piece * cellsPer);
            const auto& img = scene.images[static_cast<size_t>(b.image)].pixels;
            const uint8_t* px = &img.data[b.texel * static_cast<size_t>(img.channels)];
            const double grey = img.channels >= 3 ? 0.299 * px[0] + 0.587 * px[1] + 0.114 * px[2] : px[0];
            sg.sum[b.side][i] += grey; sg.n[b.side][i]++;
            // the texel's size on the surface, from its triangle (area in the world over area in texels)
            const auto& mesh = scene.mesh;
            const uint32_t i0 = mesh.indices[3 * b.tri], i1 = mesh.indices[3 * b.tri + 1], i2 = mesh.indices[3 * b.tri + 2];
            auto vp = [&](uint32_t v) { const auto& q = mesh.vertices[v].position; return V3{q.x, q.y, q.z}; };
            const double aw = 0.5 * (vp(i1) - vp(i0)).cross(vp(i2) - vp(i0)).norm();
            const auto& u0 = mesh.vertices[i0].uv; const auto& u1 = mesh.vertices[i1].uv; const auto& u2 = mesh.vertices[i2].uv;
            const double at = 0.5 * std::abs((u1.x - u0.x) * (u2.y - u0.y) - (u2.x - u0.x) * (u1.y - u0.y)) * img.width * img.height;
            if (at > 1e-9) { sg.texArea += aw / at; sg.texels++; }
        });
        auto pct = [](std::vector<double> v, double q) { if (v.empty()) return 0.0; std::sort(v.begin(), v.end()); return v[std::min(v.size() - 1, static_cast<size_t>(q * static_cast<double>(v.size())))]; };
        const int maxShift = std::max(1, static_cast<int>(std::lround(p.maxShiftM / p.cellM)));
        std::vector<double> zero, shiftM, shiftTex, offShift, offGain, texM;
        struct PerCut { std::vector<double> zero, shiftM, shiftTex; size_t off{0}; };
        std::unordered_map<uint32_t, PerCut> byCut;
        std::vector<uint64_t> keys;
        for (const auto& kv : segs) keys.push_back(kv.first);
        std::sort(keys.begin(), keys.end());
        for (uint64_t key : keys) {
            const Seg& sg = segs[key];
            std::vector<double> a(static_cast<size_t>(cellsPer), std::numeric_limits<double>::quiet_NaN()), b = a;
            size_t both = 0;
            for (int i = 0; i < cellsPer; ++i) {
                if (sg.n[0][static_cast<size_t>(i)]) a[static_cast<size_t>(i)] = sg.sum[0][static_cast<size_t>(i)] / sg.n[0][static_cast<size_t>(i)];
                if (sg.n[1][static_cast<size_t>(i)]) b[static_cast<size_t>(i)] = sg.sum[1][static_cast<size_t>(i)] / sg.n[1][static_cast<size_t>(i)];
                if (sg.n[0][static_cast<size_t>(i)] && sg.n[1][static_cast<size_t>(i)]) ++both;
            }
            if (both < p.minCells) continue;
            ++st.segmentsRead;
            // correlation of a against b slid by k cells; NaN when too few cells overlap or either has no spread
            auto ncc = [&](int k, double* spreadA = nullptr, double* spreadB = nullptr) {
                double sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0; size_t n = 0;
                for (int i = 0; i < cellsPer; ++i) {
                    const int j = i + k;
                    if (j < 0 || j >= cellsPer) continue;
                    const double x = a[static_cast<size_t>(i)], y = b[static_cast<size_t>(j)];
                    if (std::isnan(x) || std::isnan(y)) continue;
                    sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y; ++n;
                }
                if (n < p.minCells) return std::numeric_limits<double>::quiet_NaN();
                const double va = saa / n - (sa / n) * (sa / n), vb = sbb / n - (sb / n) * (sb / n);
                if (spreadA) *spreadA = std::sqrt(std::max(va, 0.0));
                if (spreadB) *spreadB = std::sqrt(std::max(vb, 0.0));
                if (!(va > 1e-6 && vb > 1e-6)) return std::numeric_limits<double>::quiet_NaN();
                return (sab / n - (sa / n) * (sb / n)) / std::sqrt(va * vb);
            };
            double spA = 0, spB = 0;
            const double z = ncc(0, &spA, &spB);
            if (std::isnan(z) || spA < p.minContrast || spB < p.minContrast) continue;
            int bk = 0; double bv = z;
            std::vector<double> at(static_cast<size_t>(2 * maxShift + 1), std::numeric_limits<double>::quiet_NaN());
            for (int k = -maxShift; k <= maxShift; ++k) { const double v = ncc(k); at[static_cast<size_t>(k + maxShift)] = v; if (!std::isnan(v) && v > bv) { bv = v; bk = k; } }
            // the peak between cells, by the parabola through it and its neighbours
            double sub = 0;
            if (bk > -maxShift && bk < maxShift) {
                const double l = at[static_cast<size_t>(bk - 1 + maxShift)], r = at[static_cast<size_t>(bk + 1 + maxShift)];
                if (!std::isnan(l) && !std::isnan(r) && (l - 2 * bv + r) < -1e-9) sub = std::clamp(0.5 * (l - r) / (l - 2 * bv + r), -0.5, 0.5);
            }
            const double shift = std::abs((bk + sub) * p.cellM), tex = sg.texels ? std::sqrt(sg.texArea / static_cast<double>(sg.texels)) : 0.0;
            const bool off = bv >= p.clearNcc && bv - z >= p.clearGain && std::abs(bk) >= 1;
            ++st.segments;
            zero.push_back(z); shiftM.push_back(shift); if (tex > 0) { shiftTex.push_back(shift / tex); texM.push_back(tex); }
            PerCut& pc = byCut[static_cast<uint32_t>(key >> 32)];
            pc.zero.push_back(z); pc.shiftM.push_back(shift); if (tex > 0) pc.shiftTex.push_back(shift / tex);
            if (off) { ++st.segmentsOff; ++pc.off; offShift.push_back(shift); offGain.push_back(bv - z); }
        }
        st.nccAtZeroP50 = pct(zero, 0.5); st.nccAtZeroP10 = pct(zero, 0.1);
        st.shiftP50M = pct(shiftM, 0.5); st.shiftP90M = pct(shiftM, 0.9); st.shiftP50Texels = pct(shiftTex, 0.5); st.shiftP90Texels = pct(shiftTex, 0.9);
        st.offShiftP50M = pct(offShift, 0.5); st.offGainP50 = pct(offGain, 0.5); st.texelP50M = pct(texM, 0.5);
        std::vector<uint32_t> cutIds;
        for (const auto& kv : byCut) cutIds.push_back(kv.first);
        std::sort(cutIds.begin(), cutIds.end());
        for (uint32_t k : cutIds) {
            const PerCut& pc = byCut[k];
            TileSeamCutOffset c;
            c.tiles[0] = sc.cuts[k].tile[0]; c.tiles[1] = sc.cuts[k].tile[1]; c.u = sc.cuts[k].u; c.o = sc.cuts[k].o;
            c.segments = pc.zero.size(); c.segmentsOff = pc.off;
            c.nccAtZeroP50 = pct(pc.zero, 0.5); c.shiftP50M = pct(pc.shiftM, 0.5); c.shiftP50Texels = pct(pc.shiftTex, 0.5);
            st.perCut.push_back(c);
        }
        return st;
    }
    static std::string offsetStatsJson(const TileSeamOffsetStats& s) {
        char b[640];
        std::snprintf(b, sizeof b, "\"cuts\": %zu, \"segmentsRead\": %zu, \"segments\": %zu, \"segmentsOff\": %zu, \"nccAtZero\": [%.3f, %.3f], \"shiftM\": [%.3f, %.3f], \"shiftTexels\": [%.2f, %.2f], \"offShiftP50M\": %.3f, \"offGainP50\": %.3f, \"texelP50M\": %.3f, \"perCut\": [",
                      s.cuts, s.segmentsRead, s.segments, s.segmentsOff, s.nccAtZeroP50, s.nccAtZeroP10, s.shiftP50M, s.shiftP90M, s.shiftP50Texels, s.shiftP90Texels, s.offShiftP50M, s.offGainP50, s.texelP50M);
        std::string js = b;
        for (size_t i = 0; i < s.perCut.size(); ++i) {
            const auto& c = s.perCut[i];
            std::snprintf(b, sizeof b, "%s{\"tiles\": [%u, %u], \"u\": [%.4f, %.4f, %.4f], \"o\": %.3f, \"segments\": %zu, \"segmentsOff\": %zu, \"nccAtZero\": %.3f, \"shiftM\": %.3f, \"shiftTexels\": %.2f}",
                          i ? ", " : "", c.tiles[0], c.tiles[1], c.u.x, c.u.y, c.u.z, c.o, c.segments, c.segmentsOff, c.nccAtZeroP50, c.shiftP50M, c.shiftP50Texels);
            js += b;
        }
        return js + "]";
    }
private:
    /** A rim point matched to the other tile's rim: its position group and the in-plane vector to the other rim. */
    struct RimMatch { uint32_t g; V3 step; double gap; double len; };
    struct CutRims { std::vector<RimMatch> side[2]; double rimLen{0}; };
    /**
     * Per cut: each tile's rim (open border edges of surfaces crossing the cut, near its plane, inside its rectangle), and
     * for every rim point the nearest point of the other tile's rim in the cut plane, when within the pair's tolerance and
     * running parallel there.
     */
    static std::vector<CutRims> matchRims(const geometry::ScratchboxMesh& mesh, const std::vector<uint32_t>& triTile, const std::vector<SeamCut>& cuts,
                                          const std::vector<double>& tileErrorM, const TileSeamBlendParams& p, const Topology& topo, const OpenBorder& ob, unsigned threads) {
        std::vector<CutRims> out(cuts.size());
        auto vp = [&](uint32_t v) { const auto& q = mesh.vertices[v].position; return V3{q.x, q.y, q.z}; };
        // each tile's open border edges on surfaces (their owner triangle's normal kept)
        struct RimEdge { uint32_t a, b; V3 n; };
        std::unordered_map<uint32_t, std::vector<RimEdge>> edgesOfTile;
        for (const auto& e : ob.edges) {
            const uint32_t t = e.tri, tile = t < triTile.size() ? triTile[t] : 0u;
            const V3 A = vp(mesh.indices[3 * t]), B = vp(mesh.indices[3 * t + 1]), C = vp(mesh.indices[3 * t + 2]);
            V3 n = (B - A).cross(C - A);
            if (!(n.norm() > 1e-12)) continue;
            edgesOfTile[tile].push_back({e.a, e.b, n.normalized()});
        }
        scan_rectifier::detail::parallelFor(cuts.size(), threads, 4, [&](size_t k0, size_t k1, unsigned) {
            for (size_t k = k0; k < k1; ++k) {
                const SeamCut& C = cuts[k];
                const double ea = C.tile[0] < tileErrorM.size() ? tileErrorM[C.tile[0]] : -1.0, eb = C.tile[1] < tileErrorM.size() ? tileErrorM[C.tile[1]] : -1.0;
                if (!(ea > 0 && eb > 0)) continue;
                const double tol = std::min(p.capM, std::min(ea, eb));
                struct Seg { uint32_t ga, gb; double ax, ay, bx, by, ha, hb, nx, ny; };
                std::vector<Seg> rim[2];
                for (int s = 0; s < 2; ++s) {
                    auto it = edgesOfTile.find(C.tile[s]);
                    if (it == edgesOfTile.end()) continue;
                    for (const RimEdge& e : it->second) {
                        if (std::abs(e.n.dot(C.u)) > p.crossCos) continue;
                        const V3 A = topo.gpos[e.a] - C.c, B = topo.gpos[e.b] - C.c;
                        const double ha = A.dot(C.u) + (C.u.dot(C.c) - C.o), hb = B.dot(C.u) + (C.u.dot(C.c) - C.o);
                        if (std::abs(ha) > p.bandM || std::abs(hb) > p.bandM) continue;
                        const double ax = A.dot(C.a), ay = A.dot(C.b), bx = B.dot(C.a), by = B.dot(C.b);
                        if (std::abs(ax) > C.ha + p.marginM || std::abs(ay) > C.hb + p.marginM || std::abs(bx) > C.ha + p.marginM || std::abs(by) > C.hb + p.marginM) continue;
                        // an edge running along the cut's normal is a wall's side, not its rim
                        const double l2 = std::hypot(bx - ax, by - ay);
                        if (l2 < 0.5 * (topo.gpos[e.b] - topo.gpos[e.a]).norm()) continue;
                        rim[s].push_back({e.a, e.b, ax, ay, bx, by, ha, hb, e.n.dot(C.a), e.n.dot(C.b)});
                        out[k].rimLen += l2;
                    }
                }
                if (rim[0].empty() || rim[1].empty()) continue;
                for (int s = 0; s < 2; ++s) {
                    const auto& mine = rim[s]; const auto& other = rim[1 - s];
                    std::unordered_map<uint32_t, RimMatch> best;
                    for (const Seg& e : mine) {
                        const double tx = e.bx - e.ax, ty = e.by - e.ay, tl = std::hypot(tx, ty);
                        if (!(tl > 1e-9)) continue;
                        for (int end = 0; end < 2; ++end) {
                            const uint32_t g = end ? e.gb : e.ga;
                            const double px = end ? e.bx : e.ax, py = end ? e.by : e.ay, ph = end ? e.hb : e.ha;
                            double bd = tol, bw = 1e300, qx = 0, qy = 0, qh = 0;
                            bool found = false;
                            for (const Seg& o : other) {
                                const double ox = o.bx - o.ax, oy = o.by - o.ay, ol2 = ox * ox + oy * oy;
                                if (!(ol2 > 1e-12)) continue;
                                if (std::abs(tx * ox + ty * oy) < p.parallelCos * tl * std::sqrt(ol2)) continue;
                                // the two faces of a thin wall run parallel a few centimetres apart: a rim meets one facing its own way
                                if (e.nx * o.nx + e.ny * o.ny <= 0) continue;
                                const double t = std::clamp(((px - o.ax) * ox + (py - o.ay) * oy) / ol2, 0.0, 1.0);
                                const double cx = o.ax + ox * t, cy = o.ay + oy * t, d = std::hypot(px - cx, py - cy);
                                // the other rim is the one nearest in space: an opening's edge further up the same wall lies as near in the cut plane
                                const double oh = o.ha + (o.hb - o.ha) * t, w = std::hypot(d, oh - ph);
                                if (!(d < tol && w < bw)) continue;
                                bw = w;
                                // past the other rim's end the way there is across it only, never along it (a rim is not stretched to reach)
                                const double across = ((px - cx) * -oy + (py - cy) * ox) / ol2;
                                bd = d; qx = px - across * -oy; qy = py - across * ox; qh = oh; found = true;
                            }
                            if (!found) continue;
                            auto it = best.find(g);
                            if (it != best.end() && it->second.step.norm() <= bd) { it->second.len += 0.5 * tl; continue; }
                            const double carried = it != best.end() ? it->second.len : 0.0;
                            best[g] = RimMatch{g, C.a * (qx - px) + C.b * (qy - py), qh - ph, carried + 0.5 * tl};
                        }
                    }
                    for (auto& kv : best) out[k].side[s].push_back(kv.second);
                    std::sort(out[k].side[s].begin(), out[k].side[s].end(), [](const RimMatch& x, const RimMatch& y) { return x.g < y.g; });
                }
            }
        });
        return out;
    }
    /** Moves each position by disp, taking back (to nothing) the moves that turn a triangle by more than maxTurnDeg or inside out. */
    static void applyMoves(geometry::ScratchboxMesh& mesh, const Topology& topo, std::vector<V3>& disp, double maxTurnDeg, size_t& moved, size_t& reverted, double& maxMoveM, double sliverM = 0.0) {
        const size_t G = topo.gpos.size(), F = mesh.indices.size() / 3;
        std::vector<uint32_t> memberStart(G + 1, 0), members(mesh.vertices.size());
        for (uint32_t v = 0; v < mesh.vertices.size(); ++v) memberStart[topo.groupOf[v] + 1]++;
        for (size_t g = 0; g < G; ++g) memberStart[g + 1] += memberStart[g];
        { std::vector<uint32_t> fill(memberStart.begin(), memberStart.end() - 1); for (uint32_t v = 0; v < mesh.vertices.size(); ++v) members[fill[topo.groupOf[v]]++] = v; }
        const double maxTurnCos = std::cos(maxTurnDeg * M_PI / 180.0);
        for (int pass = 0; pass < 3; ++pass) {
            size_t rev = 0;
            for (size_t t = 0; t < F; ++t) {
                const uint32_t g0 = topo.groupOf[mesh.indices[3 * t]], g1 = topo.groupOf[mesh.indices[3 * t + 1]], g2 = topo.groupOf[mesh.indices[3 * t + 2]];
                if (disp[g0].norm() == 0 && disp[g1].norm() == 0 && disp[g2].norm() == 0) continue;
                const V3 n0 = (topo.gpos[g1] - topo.gpos[g0]).cross(topo.gpos[g2] - topo.gpos[g0]);
                const V3 a = topo.gpos[g0] + disp[g0], b = topo.gpos[g1] + disp[g1], c = topo.gpos[g2] + disp[g2];
                const V3 n1 = (b - a).cross(c - a);
                const double l0 = n0.norm(), l1 = n1.norm();
                if (!(l0 > 1e-14)) continue;
                if (l1 > 1e-14 && n0.dot(n1) >= maxTurnCos * l0 * l1) continue;
                // a triangle no wider than sliverM is no surface to keep facing its way: the cut left it, and the weld drops it
                if (sliverM > 0) {
                    const double longest = std::max({(topo.gpos[g1] - topo.gpos[g0]).norm(), (topo.gpos[g2] - topo.gpos[g1]).norm(), (topo.gpos[g0] - topo.gpos[g2]).norm()});
                    if (l0 <= sliverM * longest) continue;
                }
                for (uint32_t g : {g0, g1, g2}) if (disp[g].norm() > 0) { disp[g] = V3{}; ++rev; }
            }
            reverted += rev;
            if (!rev) break;
        }
        for (uint32_t g = 0; g < G; ++g) {
            const double l = disp[g].norm();
            if (!(l > 1e-6)) continue;
            const V3 to = topo.gpos[g] + disp[g];
            for (uint32_t m = memberStart[g]; m < memberStart[g + 1]; ++m) mesh.vertices[members[m]].position = geometry::Vec3(static_cast<float>(to.x), static_cast<float>(to.y), static_cast<float>(to.z));
            ++moved;
            maxMoveM = std::max(maxMoveM, l);
        }
    }
    static std::vector<TileSeamCutScore> scoreCuts(const std::vector<SeamCut>& cuts, const std::vector<CutRims>& rims) {
        std::vector<TileSeamCutScore> out;
        for (size_t k = 0; k < cuts.size(); ++k) {
            if (!(rims[k].rimLen > 0)) continue;
            TileSeamCutScore sc;
            sc.tiles[0] = cuts[k].tile[0]; sc.tiles[1] = cuts[k].tile[1]; sc.u = cuts[k].u; sc.o = cuts[k].o;
            sc.rimLengthM = rims[k].rimLen;
            std::vector<double> steps, gaps;
            for (int s = 0; s < 2; ++s) for (const RimMatch& m : rims[k].side[s]) { steps.push_back(m.step.norm()); gaps.push_back(std::abs(m.gap)); sc.matchedLengthM += m.len; }
            auto pct = [](std::vector<double>& v, double q) { if (v.empty()) return 0.0; const size_t i = std::min(v.size() - 1, static_cast<size_t>(q * static_cast<double>(v.size()))); std::nth_element(v.begin(), v.begin() + static_cast<std::ptrdiff_t>(i), v.end()); return v[i]; };
            sc.stepP50M = pct(steps, 0.5); sc.stepP90M = pct(steps, 0.9); sc.gapP50M = pct(gaps, 0.5);
            out.push_back(sc);
        }
        return out;
    }

public:
    /** The per-cut scores of the mesh as it is (rim length, how much of it finds the other tile's rim, step and gap). */
    static std::vector<TileSeamCutScore> measureCuts(const geometry::ScratchboxMesh& mesh, const std::vector<uint32_t>& triTile, const std::vector<TileBox>& boxes,
                                                     const std::vector<double>& tileErrorM, const TileSeamBlendParams& p = {}) {
        const std::vector<SeamCut> cuts = boxCuts(boxes, p.faceMatchM);
        const Topology topo = topology(mesh);
        const OpenBorder ob = openBorder(mesh, topo);
        return scoreCuts(cuts, matchRims(mesh, triTile, cuts, tileErrorM, p, topo, ob, scan_rectifier::detail::resolveThreads(p.threads)));
    }

    /**
     * Step blend: at every cut, each tile's surface moves toward the other's by half the step measured at its rim (in the
     * cut plane, so along the wall's own normal mostly), faded to nothing over falloffM from the rim along the cut's
     * normal: the two walls meet on one surface at the cut and keep their own away from it, so no ridge is left there. A
     * vertex follows the matched rim point nearest it in the cut plane (within wallReachM: the same wall). Nothing moves
     * further than half the pair's tolerance (the smaller of the two tiles' stated errors, capped); a move turning a
     * triangle by more than maxTurnDeg is taken back. Positions only: UVs, materials and topology are untouched.
     */
    static TileSeamBlendStats blendCutSteps(geometry::ScratchboxMesh& mesh, const std::vector<uint32_t>& triTile, const std::vector<TileBox>& boxes,
                                            const std::vector<double>& tileErrorM, const TileSeamBlendParams& p = {}) {
        TileSeamBlendStats st;
        const unsigned threads = scan_rectifier::detail::resolveThreads(p.threads);
        const std::vector<SeamCut> cuts = boxCuts(boxes, p.faceMatchM);
        st.cuts = cuts.size();
        const Topology topo = topology(mesh);
        const OpenBorder ob = openBorder(mesh, topo);
        const std::vector<CutRims> rims = matchRims(mesh, triTile, cuts, tileErrorM, p, topo, ob, threads);
        st.before = scoreCuts(cuts, rims);
        const size_t G = topo.gpos.size(), F = mesh.indices.size() / 3;
        const std::vector<uint32_t> gTile = groupTiles(mesh, topo, triTile);
        // each tile's positions, to find those near a cut
        std::unordered_map<uint32_t, std::vector<uint32_t>> groupsOfTile;
        for (uint32_t g = 0; g < G; ++g) if (gTile[g] != kMixedTile && gTile[g] != kMixedTile - 1) groupsOfTile[gTile[g]].push_back(g);
        std::vector<V3> disp(G);
        std::vector<std::mutex> lockOf(64);
        scan_rectifier::detail::parallelFor(cuts.size(), threads, 4, [&](size_t k0, size_t k1, unsigned) {
            for (size_t k = k0; k < k1; ++k) {
                const SeamCut& C = cuts[k];
                for (int s = 0; s < 2; ++s) {
                    const auto& ms = rims[k].side[s];
                    if (ms.empty()) continue;
                    auto it = groupsOfTile.find(C.tile[s]);
                    if (it == groupsOfTile.end()) continue;
                    // the matched rim points in the cut plane, with their height along the normal
                    struct R { double x, y, h; V3 step; };
                    std::vector<R> rs;
                    rs.reserve(ms.size());
                    for (const RimMatch& m : ms) { const V3 d = topo.gpos[m.g] - C.c; rs.push_back({d.dot(C.a), d.dot(C.b), d.dot(C.u), m.step}); }
                    for (uint32_t g : it->second) {
                        const V3 d = topo.gpos[g] - C.c;
                        const double h = d.dot(C.u) + (C.u.dot(C.c) - C.o);
                        if (std::abs(h) > p.bandM + p.falloffM) continue;
                        const double x = d.dot(C.a), y = d.dot(C.b);
                        if (std::abs(x) > C.ha + p.marginM + p.wallReachM || std::abs(y) > C.hb + p.marginM + p.wallReachM) continue;
                        double bd = p.wallReachM; const R* br = nullptr;
                        for (const R& r : rs) { const double dd = std::hypot(x - r.x, y - r.y); if (dd < bd) { bd = dd; br = &r; } }
                        if (!br) continue;
                        const double along = std::abs(d.dot(C.u) - br->h);
                        if (along >= p.falloffM) continue;
                        const double w = 0.5 * (1.0 + std::cos(M_PI * along / p.falloffM));
                        std::lock_guard<std::mutex> lock(lockOf[g % lockOf.size()]);
                        disp[g] += br->step * (0.5 * w);
                    }
                }
            }
        });
        // no position further than half the cap (two cuts meeting at a corner add up)
        for (uint32_t g = 0; g < G; ++g) { const double l = disp[g].norm(); if (l > 0.5 * p.capM) disp[g] = disp[g] * (0.5 * p.capM / l); }
        applyMoves(mesh, topo, disp, p.maxTurnDeg, st.positionsMoved, st.reverted, st.maxMoveM);
        st.after = measureCuts(mesh, triTile, boxes, tileErrorM, p);
        for (const auto& sc : st.before) if (sc.matchedLengthM > 0) ++st.cutsMatched;
        return st;
    }
    /**
     * Rim zip: at every cut, each tile's rim point moves halfway to the point of the other tile's rim it was matched to (in
     * the cut plane and along the cut's normal), so the two rims lie on one line and the vertex weld and the T-junction
     * split that follow join them. Where one rim has a point the other has none for, that point alone can move, and
     * half its way leaves it half as far off: so the zip runs zipRounds times, each from the rims as the last left them. A point moves only when its whole way to the other rim is within the pair's tolerance
     * (the smaller of the two tiles' stated errors, capped): a wider opening is left for what it is. Rims are matched only
     * where they run parallel and face the same way, so a thin wall's two faces stay apart. A move turning a triangle by
     * more than maxTurnDeg is taken back. Rim positions only: UVs, materials and topology are untouched.
     */
    static TileSeamZipStats zipCutRims(geometry::ScratchboxMesh& mesh, const std::vector<uint32_t>& triTile, const std::vector<TileBox>& boxes,
                                       const std::vector<double>& tileErrorM, const TileSeamBlendParams& p = {}) {
        TileSeamZipStats st;
        const unsigned threads = scan_rectifier::detail::resolveThreads(p.threads);
        const std::vector<SeamCut> cuts = boxCuts(boxes, p.faceMatchM);
        st.cuts = cuts.size();
        const size_t V = mesh.vertices.size();
        std::vector<geometry::Vec3> start(V);
        for (size_t v = 0; v < V; ++v) start[v] = mesh.vertices[v].position;
        // the cut that first moved a point (by one of its vertices), for the report
        std::vector<int32_t> cutOf(V, -1);
        for (int round = 0; round < std::max(1, p.zipRounds); ++round) {
            const Topology topo = topology(mesh);
            const OpenBorder ob = openBorder(mesh, topo);
            const std::vector<CutRims> rims = matchRims(mesh, triTile, cuts, tileErrorM, p, topo, ob, threads);
            if (round == 0) st.before = scoreCuts(cuts, rims);
            const size_t G = topo.gpos.size();
            std::vector<V3> disp(G);
            std::vector<uint32_t> count(G, 0);
            std::vector<double> reach(G, 0.0);
            size_t beyond = 0;
            for (size_t k = 0; k < cuts.size(); ++k) {
                const SeamCut& C = cuts[k];
                const double ea = C.tile[0] < tileErrorM.size() ? tileErrorM[C.tile[0]] : -1.0, eb = C.tile[1] < tileErrorM.size() ? tileErrorM[C.tile[1]] : -1.0;
                if (!(ea > 0 && eb > 0)) continue;
                const double tol = std::min(p.capM, std::min(ea, eb));
                for (int s = 0; s < 2; ++s) for (const RimMatch& m : rims[k].side[s]) {
                    const V3 way = m.step + C.u * m.gap;
                    if (way.norm() > tol) { ++beyond; continue; }
                    disp[m.g] += way * 0.5;
                    count[m.g]++;
                    reach[m.g] = reach[m.g] > 0 ? std::min(reach[m.g], tol) : tol;
                }
            }
            if (round == 0) st.beyondError = beyond;
            // a point on two cuts (a corner) takes the mean of its two moves
            for (uint32_t g = 0; g < G; ++g) if (count[g] > 1) disp[g] = disp[g] * (1.0 / count[g]);
            std::vector<uint32_t> firstVertex(G, UINT32_MAX);
            for (uint32_t v = 0; v < V; ++v) if (firstVertex[topo.groupOf[v]] == UINT32_MAX) firstVertex[topo.groupOf[v]] = v;
            // over all the rounds no point ends further from where it started than its pair's tolerance
            for (uint32_t g = 0; g < G; ++g) {
                if (!count[g]) continue;
                const auto& a = start[firstVertex[g]];
                const V3 total = topo.gpos[g] + disp[g] - V3{a.x, a.y, a.z};
                if (total.norm() > reach[g]) disp[g] = V3{};
            }
            size_t moved = 0; double far = 0;
            applyMoves(mesh, topo, disp, p.maxTurnDeg, moved, st.reverted, far, p.zipSliverM);
            if (!moved) break;
            for (size_t k = 0; k < cuts.size(); ++k) for (int s = 0; s < 2; ++s) for (const RimMatch& m : rims[k].side[s])
                if (disp[m.g].norm() > 1e-6 && cutOf[firstVertex[m.g]] < 0) cutOf[firstVertex[m.g]] = static_cast<int32_t>(k);
        }
        std::vector<TileSeamCutMove> moves(cuts.size());
        std::vector<double> sum(cuts.size(), 0.0);
        for (size_t v = 0; v < V; ++v) {
            if (cutOf[v] < 0) continue;
            const auto& a = start[v]; const auto& b = mesh.vertices[v].position;
            const double l = std::sqrt(double(a.x - b.x) * (a.x - b.x) + double(a.y - b.y) * (a.y - b.y) + double(a.z - b.z) * (a.z - b.z));
            if (!(l > 1e-6)) continue;
            TileSeamCutMove& mv = moves[static_cast<size_t>(cutOf[v])];
            ++mv.points; sum[static_cast<size_t>(cutOf[v])] += l; mv.maxMoveM = std::max(mv.maxMoveM, l);
            ++st.positionsMoved; st.maxMoveM = std::max(st.maxMoveM, l);
        }
        for (size_t k = 0; k < cuts.size(); ++k) {
            TileSeamCutMove& mv = moves[k];
            if (!mv.points) continue;
            mv.tiles[0] = cuts[k].tile[0]; mv.tiles[1] = cuts[k].tile[1]; mv.u = cuts[k].u; mv.o = cuts[k].o;
            mv.meanMoveM = sum[k] / static_cast<double>(mv.points);
            st.perCut.push_back(mv);
        }
        st.cutsZipped = st.perCut.size();
        st.after = measureCuts(mesh, triTile, boxes, tileErrorM, p);
        return st;
    }
    static std::string zipStatsJson(const TileSeamZipStats& s) {
        std::string js = "\"cuts\": " + std::to_string(s.cuts) + ", \"cutsZipped\": " + std::to_string(s.cutsZipped) + ", \"positionsMoved\": " + std::to_string(s.positionsMoved) +
            ", \"beyondError\": " + std::to_string(s.beyondError) + ", \"reverted\": " + std::to_string(s.reverted) + ", \"maxMoveM\": " + std::to_string(s.maxMoveM) + ", \"perCut\": [";
        for (size_t i = 0; i < s.perCut.size(); ++i) {
            const auto& m = s.perCut[i];
            js += std::string(i ? ", " : "") + "{\"tiles\": [" + std::to_string(m.tiles[0]) + ", " + std::to_string(m.tiles[1]) + "], \"u\": [" + std::to_string(m.u.x) + ", " + std::to_string(m.u.y) + ", " + std::to_string(m.u.z) +
                "], \"o\": " + std::to_string(m.o) + ", \"points\": " + std::to_string(m.points) + ", \"meanMoveM\": " + std::to_string(m.meanMoveM) + ", \"maxMoveM\": " + std::to_string(m.maxMoveM) + "}";
        }
        return js + "]";
    }
    /** The scores as a JSON array, and their totals (length-weighted) for a one-line report. */
    static std::string cutScoresJson(const std::vector<TileSeamCutScore>& v) {
        std::string js = "[";
        for (size_t i = 0; i < v.size(); ++i) {
            const auto& s = v[i];
            char b[320];
            std::snprintf(b, sizeof b, "%s{\"tiles\": [%u, %u], \"u\": [%.3f, %.3f, %.3f], \"o\": %.3f, \"rimLengthM\": %.2f, \"matchedLengthM\": %.2f, \"stepP50M\": %.4f, \"stepP90M\": %.4f, \"gapP50M\": %.4f}",
                          i ? ", " : "", s.tiles[0], s.tiles[1], s.u.x, s.u.y, s.u.z, s.o, s.rimLengthM, s.matchedLengthM, s.stepP50M, s.stepP90M, s.gapP50M);
            js += b;
        }
        return js + "]";
    }
    static std::string cutTotalsJson(const std::vector<TileSeamCutScore>& v) {
        double rim = 0, matched = 0, step = 0, gap = 0, worst = 0;
        for (const auto& s : v) { rim += s.rimLengthM; matched += s.matchedLengthM; step += s.stepP50M * s.matchedLengthM; gap += s.gapP50M * s.matchedLengthM; worst = std::max(worst, s.stepP90M); }
        char b[256];
        std::snprintf(b, sizeof b, "\"cuts\": %zu, \"rimLengthM\": %.1f, \"matchedLengthM\": %.1f, \"meanStepM\": %.4f, \"meanGapM\": %.4f, \"worstStepP90M\": %.4f", v.size(), rim, matched, matched > 0 ? step / matched : 0.0, matched > 0 ? gap / matched : 0.0, worst);
        return b;
    }

    /** The cuts two tiles' boxes share, as a JSON array (the mesh's frame), for the stages after the seam stage. */
    static std::string cutsJson(const std::vector<TileBox>& boxes, double faceMatchM = TileSeamToneParams{}.faceMatchM) {
        auto v3 = [](const V3& v) { char b[96]; std::snprintf(b, sizeof b, "[%.4f, %.4f, %.4f]", v.x, v.y, v.z); return std::string(b); };
        std::string js = "[";
        bool first = true;
        for (const SeamCut& c : boxCuts(boxes, faceMatchM)) {
            char b[96]; std::snprintf(b, sizeof b, ", \"o\": %.4f, \"ha\": %.3f, \"hb\": %.3f}", c.o, c.ha, c.hb);
            js += (first ? "" : ", ") + std::string("{\"tiles\": [") + std::to_string(c.tile[0]) + ", " + std::to_string(c.tile[1]) + "], \"u\": " + v3(c.u) + ", \"c\": " + v3(c.c) + ", \"a\": " + v3(c.a) + ", \"b\": " + v3(c.b) + b;
            first = false;
        }
        return js + "]";
    }
    static std::string toneStatsJson(const TileSeamToneStats& s) {
        char b[256];
        std::snprintf(b, sizeof b, "\"cuts\": %zu, \"binsMatched\": %zu, \"imagesChanged\": %zu, \"texelsChanged\": %zu, \"maxGain\": %.4f, \"dEBefore\": [%.2f, %.2f], \"dEAfter\": [%.2f, %.2f]",
                      s.cuts, s.binsMatched, s.imagesChanged, s.texelsChanged, s.maxGain, s.dEBeforeP50, s.dEBeforeP90, s.dEAfterP50, s.dEAfterP90);
        std::string js = b;
        if (s.tilesBalanced) {
            std::snprintf(b, sizeof b, ", \"balance\": {\"tiles\": %zu, \"cuts\": %zu, \"maxGain\": %.4f, \"meanLogGain\": %.5f, \"dEAfter\": [%.2f, %.2f]}",
                          s.tilesBalanced, s.balanceCuts, s.balanceMaxGain, s.balanceMeanLogGain, s.dEBalancedP50, s.dEBalancedP90);
            js += b;
        }
        return js;
    }

    /** The stats as a JSON object body (no braces), for CLI reports. */
    static std::string statsJson(const TileSeamWeldStats& s) {
        auto num = [](double v) { char b[64]; std::snprintf(b, sizeof b, "%.9g", v); return std::string(b); };
        std::string js = "\"vertices\": " + std::to_string(s.vertexCount) + ", \"triangles\": " + std::to_string(s.triangleCount) +
            ", \"groups\": " + std::to_string(s.groupCount) + ", \"pieces\": " + std::to_string(s.pieceCount) +
            ", \"boundaryGroups\": " + std::to_string(s.boundaryGroups) + ", \"boundaryEdges\": " + std::to_string(s.boundaryEdges) +
            ", \"contactsFound\": " + std::to_string(s.contactsFound) + ", \"groupsWelded\": " + std::to_string(s.groupsWelded) +
            ", \"vertsWelded\": " + std::to_string(s.vertsWelded) + ", \"groupsReverted\": " + std::to_string(s.groupsReverted) +
            ", \"chainedWelds\": " + std::to_string(s.chainedWelds) + ", \"stripPiecesDropped\": " + std::to_string(s.stripPiecesDropped) +
            ", \"stripTrianglesDropped\": " + std::to_string(s.stripTrianglesDropped) + ", \"trianglesDropped\": " + std::to_string(s.trianglesDropped) +
            ", \"trianglesCollapsed\": " + std::to_string(s.trianglesCollapsed) +
            ", \"meanWeldDisplacementM\": " + num(s.meanWeldDisplacementM) + ", \"maxWeldDisplacementM\": " + num(s.maxWeldDisplacementM) +
            ", \"gapHistogramEdges_m\": [0, 0.001, 0.005, 0.01, 0.03, 0.1], \"gapHistogram\": [";
        for (size_t k = 0; k < s.gapHistogram.size(); ++k) js += (k ? ", " : "") + std::to_string(s.gapHistogram[k]);
        js += "]";
        return js;
    }
};

} // namespace tile_seam_weld
} // namespace scratchbox

#endif // SCRATCHBOX_TILE_SEAM_WELD_HPP
