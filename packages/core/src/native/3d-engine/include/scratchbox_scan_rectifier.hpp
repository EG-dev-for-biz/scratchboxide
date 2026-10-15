/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_SCAN_RECTIFIER_HPP
#define SCRATCHBOX_SCAN_RECTIFIER_HPP

/**
 * Scan rectifier: a bounded, position-only clean-up kernel for real photogrammetric tile scans
 * (for example Google Photorealistic 3D Tiles extracted to a local ENU frame, y = up).
 *
 * The scan is kept. Nothing is synthesised and nothing is replaced. The kernel only
 *   - flags fully enclosed interior shells. A face is culled only when it is hidden under BOTH a
 *     two-sided rule (back faces occlude: the repo path tracer) and a single-sided rule (back faces are
 *     transparent: the tile's single-sided materials in three.js / model-viewer). Tests: escape rays
 *     from origins spread over the face, a reach test for rays landing on open street ground or any
 *     open-air walkable surface (courts, plazas, flat roofs), a camera rig, and sight lines to viewer
 *     sites on every open-air walkable surface,
 *   - moves vertex positions a bounded distance onto robustly fitted planes (walls snap to the
 *     orientation their neighbourhood agrees on), their intersection lines (corners, cornices) and
 *     points, and onto per-footprint tier heights (area-density modes) that are supported next to
 *     the roof being moved; relief sheets (narrow, tall, flat strips standing off the wall's main plane:
 *     piers, pilasters) ride on their wall's snapped plane at their own step instead of being pressed in,
 *   - keeps chunk seams closed: every T-junction found at the input positions is a constraint of a
 *     least-squares solve of the snapped displacements, and small gaps are closed,
 *   - guards every kept triangle (no flips, no collapse-free shrinking, bounded texture stretch), every
 *     >= 45 degree input crease (no step is flattened, no two faces fold back onto each other) and every
 *     pair of back-to-back faces (the two sides of a thin wall keep their order); guards shrink targets
 *     and re-solve, then reduced moves are restored as far as no damage returns,
 *   - keeps bevels that collapse as millimetre slivers (no topology change); only when that is
 *     impossible is a triangle flagged 2 (dropped).
 * Vertex order, triangle order, UVs, materials and images are untouched; the caller patches
 * POSITION and drops flagged triangles (see the SBRX sidecar written by writeSidecar()).
 *
 * Every parameter that describes the scene (orientation families, ground, footprints, planes,
 * tier heights) is derived from the scan at runtime. There are no scene constants, no closed
 * taxonomies, and no string branching: the only tunables are continuous metric tolerances.
 *
 * The counters in ScanRectifierStats are operational bookkeeping (what the kernel did), not
 * quality measurements. Geometric quality must be measured by independent code.
 */

#include "scratchbox_bvh.hpp"
#include "scratchbox_gltf_scene.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <functional>
#include <limits>
#include <map>
#include <iterator>
#include <numeric>
#include <queue>
#include <sstream>
#include <string>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

namespace scratchbox {
namespace scan_rectifier {

// ============================================================================
// Small double-precision vector helpers (the scan is float32; fits run in double)
// ============================================================================
struct V3 {
    double x{0}, y{0}, z{0};
    constexpr V3() = default;
    constexpr V3(double a, double b, double c) : x(a), y(b), z(c) {}
    V3 operator+(const V3& o) const { return {x + o.x, y + o.y, z + o.z}; }
    V3 operator-(const V3& o) const { return {x - o.x, y - o.y, z - o.z}; }
    V3 operator*(double s) const { return {x * s, y * s, z * s}; }
    V3& operator+=(const V3& o) { x += o.x; y += o.y; z += o.z; return *this; }
    double dot(const V3& o) const { return x * o.x + y * o.y + z * o.z; }
    V3 cross(const V3& o) const { return {y * o.z - z * o.y, z * o.x - x * o.z, x * o.y - y * o.x}; }
    double norm() const { return std::sqrt(x * x + y * y + z * z); }
    V3 normalized() const { double l = norm(); return l > 1e-300 ? V3{x / l, y / l, z / l} : V3{0, 0, 0}; }
};

constexpr uint8_t kFlagHidden = 0;
constexpr uint8_t kFlagKeep = 1;
constexpr uint8_t kFlagDegenerate = 2;
constexpr uint32_t kSidecarVersion = 1;

// ============================================================================
// Parameters (continuous metric tolerances only)
// ============================================================================
struct ScanRectifierParams {
    // --- worker threads (0 = hardware concurrency)
    int threads{0};
    uint64_t seed{0x5ca9u};

    // --- D1 weld map
    double weldEpsilon{1e-3};

    // --- D2 hidden-surface cull
    bool cullHidden{true};
    bool singleSidedVisibility{true};   // a face is also visible when a back-face-culling viewer sees it: only its front
                                        // side counts and only triangles whose front faces the viewer occlude (the
                                        // tile's materials are single-sided). Culling needs hidden under both rules.
    double horizonSlack{0.0};           // single-sided escape rays may dip at most this far below the horizon (dir.y)
    int visibilityRays{192};            // uniform-hemisphere rays per side of each triangle
    double visibilityOffset{0.01};      // origin offset along the face normal (m)
    bool visibilitySpreadOrigins{true}; // each ray starts at its own low-discrepancy point on the face (a face that
                                        // pokes through another surface is exterior if any part of it escapes);
                                        // false = the three fixed interior points of plan D2
    double visibilityOriginMargin{0.05};// barycentric shrink toward the centroid so origins stay off the edges
    double escapeDistance{3000.0};      // a ray escapes when it hits nothing within this range (m)
    int rigCameras{48};                 // camera-rig guard: one third aerial, the rest street level
    int rigAerialResolution{768};       // square pinhole image per aerial camera
    int rigStreetWidth{1024};           // equirectangular width per street camera (height = width / 2)
    double rigAerialFovDeg{60.0};
    double rigStreetEyeMin{1.7};
    double rigStreetEyeMax{2.5};
    double rigStreetMargin{15.0};       // street cameras stay this far inside the tile footprint (m)
    bool streetReach{true};             // a face whose escape ray first lands on open street ground is exterior
    double streetReachMinGroundNy{0.7}; // the landing surface must be near-horizontal (|ny| >= this)
    // Outdoor viewers generalise "street": any open-air walkable surface (a court floor, a plaza, a
    // flat roof) is a place someone can stand. Open air = the top-most surface of the whole scan at
    // that spot (nothing above it), near-horizontal and locally flat.
    bool outdoorReach{true};            // street reach also accepts a landing on any open-air walkable surface
    double outdoorTopTolerance{0.3};    // the landing point lies within this of the top surface (m)
    double outdoorFlatTolerance{0.6};   // and its 3x3 top-surface neighbourhood within this of the landing height (m)
    double outdoorSiteSpacing{6.0};     // sight-line guard: one viewer site per block of this size (0 = off; needs the rig)
    double outdoorEyeHeight{1.7};
    double outdoorSiteRange{200.0};     // sites farther than this from a face are not tested (m)
    double outdoorExhaustiveRadius{50.0};  // every site in front of a face within this distance is tested (m)
    int outdoorSitesPerRing{12};        // farther away: sites tested per distance ring and side, spread in azimuth
    double outdoorSampleArea{0.5};      // one sight-line origin per this much face area (m^2), clamped below; each
    int outdoorMinSamples{4};           // site is tried from outdoorSamplesPerSite of them in rotation, so the
    int outdoorMaxSamples{32};          // origins cover the whole face at a cost proportional to the sites
    int outdoorSamplesPerSite{3};
    bool nadirGuard{true};              // the top-most surface of the whole scan in any DSM cell is seen from straight
                                        // above (open air over it), e.g. the floor of a roofless enclosure
    // Iteration aid: a previous run's per-triangle visibility (non-zero = visible). When it has one entry per
    // triangle the D2 tests are skipped and these flags are used as they are.
    std::vector<uint8_t> precomputedVisibility;

    // --- D3 ground (DTM) and footprints (metrics/targets only, never used to move geometry)
    double dsmCell{0.5};
    double dtmCell{8.0};
    double dtmPercentile{0.10};
    double dtmOpeningRadius{48.0};      // morphological opening radius; removes structures narrower than 2x (m)
    double openGroundTolerance{1.0};    // |DSM - DTM| below this is open ground (street camera sites)
    double footprintMinHeight{3.0};
    double heroMinHeight{20.0};
    double anchorX{0.0};                // hero anchor in the tile frame (the ENU origin by default)
    double anchorZ{0.0};
    double groundPlaneRadius{80.0};
    double groundHuber{0.15};

    // --- D4 orientation families
    double familyMaxAbsNy{0.15};
    double familyMinArea{0.5};
    double familyBinDeg{0.5};
    int familySmoothBins{5};
    double familyMinRatio{0.15};
    double familyMinSeparationDeg{5.0};
    double familyRefineDeg{2.0};

    // --- D5 planar regions
    double wallMaxAbsNy{0.2};
    double roofMinNy{0.985};
    double offsetTolerance{0.3};
    double regionAabbGrow{1.0};
    double normalAgreementDeg{15.0};
    double minWallArea{15.0};
    double minRoofArea{10.0};
    double planeHuber{0.15};
    int planeIrlsIterations{12};
    double familySnapDeg{1.5};
    double plumbSnapDeg{1.5};
    double maxSnapInducedDisplacement{0.25};  // an orientation snap may not move the fitted plane more than this anywhere on the region (m)
    double maxRegionRms{0.35};
    double regionHashCell{4.0};
    int minRegionTriangles{2};          // a lone triangle defines its own plane trivially; it is not evidence of a face
    // A proximity component whose triangle offsets form two crisp levels (a step, a recess, a setback
    // lip) is split into one region per level, so snapping never merges parallel faces a step apart.
    double splitMinStep{0.15};          // the two level means differ by at least this (m)
    double splitMinSeparation{0.75};    // between-level variance / total variance (Otsu criterion)
    double splitMinPartArea{2.0};       // each level holds at least this much area (m^2)
    double splitMaxLevelRms{0.35};      // each level's VERTEX offsets stay within this share of the step (rms): a crinkled
                                        // face of large tilted triangles has bimodal centroids but no two sheets
    int splitMaxDepth{3};
    // Relief sheets: inside a region, flat triangles parallel to it that stand a step off the surface around
    // them (a pier, a pilaster strip, a recessed panel, a second roof level) ride on the region's snapped plane
    // at that step, so snapping straightens them with their surroundings instead of pressing them into the main
    // face. Crinkle (tilted or warped triangles) is not a sheet and is still flattened.
    bool extractSheets{true};
    double sheetMinRelief{0.08};        // the step to the surrounding surface is at least this (m)
    double sheetMinMainRelief{0.1};     // ...and the sheet stands at least this far off the wall's main plane (m)
    double sheetMaxAngleDeg{4.0};       // sheet triangle: normal within this of the region's mean normal
    double sheetMaxWidth{3.0};          // a sheet is at most this wide across the wall (piers, pilasters, strips; m)
    double sheetMinAspect{3.0};         // ...and at least this many times as tall as it is wide
    double sheetFlatSpread{0.08};       // its vertices lie within max(this, sheetMaxSpreadOfRelief x |step|) of
    double sheetMaxSpreadOfRelief{1.0}; // one level along the wall normal (m)
    double sheetLevelTol{0.05};         // triangles of one sheet agree on their level within this (m)
    double sheetMinArea{3.0};           // a sheet holds at least this much area (m^2)
    double sheetRingWidth{3.0};         // its relief is measured against the front-most surface between
    double sheetRingInner{0.5};         // these distances of it (m, in plane)
    bool sheetRingFrontMost{true};       // true: the ring level is the median of the front-most surface per cell;
                                        // false: the median of every sampled point (robust to slivers sticking out)
    double sheetRingSpacing{0.5};       // sample spacing on that surface (m)
    double sheetMinRingArea{2.0};       // the surface around it must hold at least this much sampled area (m^2)
    // Walls snap to the orientation their neighbourhood agrees on (area-weighted, distance-weighted
    // consensus of nearby walls of the same family), so walls of one building end up mutually parallel
    // and long walls, which dominate the consensus, barely rotate.
    double localOrientationRadius{45.0};    // neighbourhood radius (m)
    double localOrientationSigma{15.0};     // Gaussian distance weight (m)
    double localOrientationWindowDeg{3.0};  // only walls within this of the region's own azimuth (mod 90) vote
    double crossFootprintWeight{0.15};      // walls of another footprint vote with this factor
    double familyLockDeg{0.3};              // a consensus this close to a global family takes the family exactly

    // Narrow relief: a crisp panel framed by other surfaces at both sides (a frontispiece's bay between its pylons, a
    // recessed strip between piers) standing at least reliefMinStep off its wall is snapped at its own level
    double reliefMinStep{0.05};         // m (0 = off)
    double reliefPanelMaxWidth{6.0};    // the panel is at most this wide between its frames (m)
    double reliefPanelMinHeight{2.0};   // ...and framed over at least this much of the wall's height (m)
    double reliefCrispDeg{3.5};         // its faces are within this of the wall's plane (crinkle is not relief)
    double reliefRasterCell{0.2};       // m
    double reliefSlab{1.5};             // only surfaces within this of the plane are part of the wall's visible surface (m)
    // Proud blocks: a patch of a wall region standing at least proudBlockMinRelief off the region's plane (out or in)
    // whose outline runs, over at least proudBlockMinRiserShare of its length, along creases to risers (faces within
    // acos(proudBlockRiserMaxDot) of perpendicular to the wall that reach back toward it by at least the relief) is an
    // element the scan shows standing out with its own sides (a keystone, a medallion, a pedestal, a deep reveal). Its
    // offset is kept: a block whose vertices lie within max(proudBlockFlatSpread, proudBlockFlatSpreadOfRelief x its
    // level) of one level snaps onto the wall's plane at that level (like a relief panel); any other block is left where
    // it was scanned. Crinkle bumps meet the wall's own faces and melt slopes have no risers, so both still snap; a patch
    // larger than proudBlockMaxRegionShare of its region is the wall itself, badly fitted.
    double proudBlockMinRelief{0.08};   // m (0 = off)
    double proudBlockMinRiserShare{0.6};
    double proudBlockFlatSpread{0.05};  // m
    double proudBlockFlatSpreadOfRelief{0.5};
    double proudBlockRiserMaxDot{0.5};
    double proudBlockMinArea{0.25};     // m^2
    double proudBlockMaxRegionShare{0.5};

    // --- D6 constrained snapping
    bool snap{true};
    double tauWall{0.5};
    double tauRoof{0.4};
    double tauCorner{0.7};
    double supportGrow{0.7};
    double fullStrengthFraction{0.6};
    double cornerMinAngleDeg{30.0};
    double maxDisplacement{0.75};
    double snapDeadBand{0.05};          // moves shorter than this (a small fraction of a texel) are not applied
    // Melted facets: a vertex of a wall region whose offset from the region's plane is carried by faces tilted against
    // that plane (a scan facet sagging from the plane toward one vertex, not a parallel relief level) is captured with
    // full strength up to meltCaptureRange instead of fading out at tau. "Tilted" means: of the vertex's own faces in the
    // region, at most meltMaxParallelShare of the area lies within meltParallelDeg of the plane. 0 = off.
    double meltCaptureRange{0.7};
    double meltParallelDeg{2.0};
    double meltMaxParallelShare{0.25};
    bool foreignPlaneSnap{false};       // also pull vertices that belong to no region onto a nearby plane (off: only
                                        // region vertices move; foreign planes still form their corner/cornice lines)
    bool seamPartnerSnap{true};         // ...except chunk-seam vertices: they may snap onto a nearby plane, so the two
                                        // sides of a seam on one facade move together instead of meeting halfway
    double foreignMinFacingDot{-0.5};   // a plane the vertex does not belong to is never a target when it faces away
                                        // from every visible face of the vertex (dot below this): the other side of a
                                        // thin wall or fin is a different surface
    bool rejectUnlevelableRoofs{true};  // a near-level roof region that cannot be levelled within the induced-motion
                                        // bound is several levels fused by proximity: it is not snapped at all

    // --- D7 tier / slab alignment
    bool alignTiers{true};
    double tierBin{0.1};
    double tierRoofTolerance{0.4};
    double tierParapetTolerance{0.3};
    double tierMinPeakArea{20.0};
    double tierUpMinNy{0.9};
    double tierCapMinNy{0.5};
    double tierRegionMinFootprintShare{0.5};  // share of a roof region's area that must lie in the footprint
    // Tier heights are modes of the up-facing area density (mean shift), so two real levels a few
    // decimetres apart stay two levels instead of being merged into one averaged peak.
    double tierModeBandwidth{0.06};     // Gaussian kernel (m)
    double tierModeMerge{0.12};         // modes closer than this are one level (m)
    double tierModeHalfWidth{0.1};      // a mode's area is the up-facing area within this of it (m)
    // A tier height is a target only where it is supported nearby: footprints are DSM components that can span
    // several abutting buildings, so a level of one building must not pull the roofs of its neighbour.
    double tierLocalRadius{6.0};        // support is searched this far around the roof region / parapet vertex (m)
    double tierLocalMinArea{8.0};       // up-facing area within tierModeHalfWidth of the level needed there (m^2)

    // --- D8 chunk seams: T-junction contacts move coherently, small gaps are closed
    bool closeTJunctions{true};
    double tJunctionTolerance{0.03};    // contacts with an input gap up to this are closed
    double seamContactTolerance{0.05};  // a boundary vertex this close to a foreign boundary edge is a seam contact
    bool seamInteriorPartners{false};   // a boundary vertex may also pair with an interior kept edge (couples far more)
    bool seamWithinPiece{false};        // partners may lie in the vertex's own connected piece (only the edges of the
                                        // vertex's own triangles excluded); default: other pieces only
    bool seamSecondPass{true};          // bevels that collapse expose new chunk borders: rebuild the contacts on the
                                        // final kept set and solve once more
    double seamFaceTolerance{0.0};      // > 0: points of a boundary edge this close to a face of another piece (a chunk
                                        // border running across another chunk) are tied to that face inside the seam
                                        // solve (couples far more vertices than the stitch below; off by default)
    double seamFaceMaxAngleDeg{90.0};   // ...when that face's normal is within this angle of the edge's own face
    int seamFaceSamples{5};             // points per boundary edge tested against other pieces' faces
    bool seamFollowFaces{true};         // a border vertex on another piece's face follows that face along its normal
                                        // (one-way: the face is not pulled toward the border); false = a symmetric tie
    double seamFollowEpsilon{1e-3};     // the follower's own target weight along the followed normal (relative)
    bool seamGuardThroughFaces{false};  // guards hold back the faces a damaged follower lies on too
    bool seamProjectedContacts{true};   // contacts bind only the directions that open a gap: a vertex on a face may
                                        // slide along the face, one on an edge along the edge (false = all three axes)
    double seamStiffness{1000.0};       // penalty weight of a contact relative to a vertex's own target
    double seamFreeWeight{1.0};         // weight of "stay as scanned" for a seam vertex the snapping did not move
                                        // (a guard's target always weighs 1). Below 1 an unsnapped partner follows the
                                        // snapped side more, but a T-vertex near the end of a long partner edge then
                                        // levers that edge's far end; the displacement budget is enforced either way.
    int seamSolverIterations{4000};
    bool seamCoherence{true};           // false = vertices on either side of a seam move independently (old behaviour)

    // Stitch (after the guards): a chunk border that lay on a face of another piece at the input is put back on it by
    // moving the border vertices alone, as far as no face, crease or opposed pair around them is damaged
    double seamStitchTolerance{0.015};  // points of a boundary edge this close to another piece's face (0 = off)
    int seamStitchSamples{5};           // points per boundary edge
    double seamStitchEpsilon{1e-3};     // weight of an unsnapped vertex's own position in the stitch
    double seamStitchSnappedWeight{1.0};// weight of a snapped vertex's position (large = snapped vertices never move)
    double seamStitchMaxFoldDeg{15.0};  // a stitch never makes a fold through a moved vertex sharper than this and than before
    int seamStitchMaxIterations{4000};  // PCG iteration cap per stitch component solve
    bool seamStitchTies{true};          // the stitch keeps the chunk-seam T-junction contacts in its system (stiff: slow)
    // Building footprints (e.g. from Google Vector Tiles) as closed x/z rings in the mesh frame. When given, a vertex
    // the solve left unsnapped that lies outside every footprint (or within footprintGroundMargin of one) is ground:
    // the stitch holds it, so a T-junction tie to a flattened wall base cannot drag the street sideways.
    std::vector<std::vector<std::pair<double, double>>> buildingFootprintsXZ;
    double footprintGroundMargin{0.5};

    // --- D9 guards
    double guardMinNormalDot{0.2};
    double guardMinAreaRatio{0.1};
    double guardMaxTurnDeg{0.0};        // a kept triangle that keeps its area may not turn more than this (0 = off:
                                        // flattening a crinkle spike into its plane is a large turn by design)
    double guardTurnMinAreaRatio{0.25}; // (triangles shrinking below this share of their area are collapsing bevels)
    // In-plane faces: a kept face of a plane region whose input normal lies within guardPlaneFaceDeg of the region's
    // snapped plane has no crinkle to flatten. It may not end more than guardPlaneMaxTurnDeg off that plane (0 = off):
    // a long sliver whose corners are pulled by different amounts (one corner held by a chunk-seam contact, the
    // others snapped) would otherwise tilt out of its wall and show as a crease across it.
    double guardPlaneFaceDeg{5.0};
    double guardPlaneMaxTurnDeg{6.0};
    double guardMaxStretch{2.0};        // largest in-plane stretch of a kept triangle (texture magnification)
    double creaseKeepDeg{45.0};         // an input crease at least this sharp is protected (0 = off): it may not end
    double creaseMaxSoftenDeg{10.0};    // below creaseKeepDeg after losing more than this many degrees of its angle,
    bool creaseExemptLineSnaps{true};   // vertices snapped onto a vertical corner line (two walls) or a corner point are
                                        // never held back by the crease guard (cornice lines and single planes are)
    double creaseShrinkExempt{0.3};     // unless one of its two faces shrinks below this share of its area (a bevel
                                        // collapsing into a sharp corner; a flattened step keeps its area)
    double creaseMaxSharpenDeg{-1.0};   // >= 0: an input fold below creaseKeepDeg may not end at or above it after
                                        // gaining more than this many degrees (no noise fold becomes a crease)
    // Opposed sheets: two faces back to back (the two sides of a thin wall, parapet or fin) keep their order. A
    // pair is found at the input by a ray from a face into its own back; after the edit the front face must stay
    // in front of the other by at least min(opposedKeepFraction x input gap, opposedKeepMin).
    bool guardOpposed{true};
    double opposedMaxGap{1.5};          // pairs up to this far apart (m)
    double opposedMaxDot{-0.5};         // the two normals face away from each other (dot at most this)
    double opposedKeepFraction{0.5};
    double opposedKeepMin{0.05};
    double opposedMinApproach{0.01};    // ...and only once they came closer than in the input by more than this (m)
    double opposedSampleArea{4.0};      // one extra ray origin per this much face area (4 to 16 per face)
    int opposedZeroPasses{1};           // pairs the targeted relief cannot fix are zeroed with 1 (then 3) rings of seam
                                        // neighbours (this many zeroing passes); never with a whole seam component
    bool opposedEscalate{false};        // ...unless this is set (whole components; costs far more snapping)
    double guardFoldDeg{165.0};         // an input crease may not fold to at least this angle between its normals
                                        // (two faces folded back onto each other) unless it already was
    int guardIterations{6};
    bool guardRestore{true};            // after the guards, reduced off-seam moves are restored as far as no damage returns
    int guardRestoreRounds{3};
    double collapseFromArea{1e-3};
    double collapseToArea{1e-4};        // a kept triangle collapses below max(collapseToArea,
    double collapseToRatio{0.01};       // collapseToRatio x its input area) when the slit it leaves is also
    double collapseMaxSlit{0.002};      // narrower than this (2 x area / longest edge, m)
    // A collapsing bevel is kept as a sliver of this residual width instead of being dropped (dropping leaves
    // T-junction slits and changes the topology); only when that is impossible is it flagged 2 and dropped.
    bool keepCollapsedSlivers{true};
    double collapseKeepWidth{0.002};    // residual width across the sliver's longest edge (m)
    double collapseKeepArea{1.5e-4};    // and residual area (m^2)
    double collapseMaxNudge{0.02};      // the apex moves at most this far to reach them (m)

    // --- D10 optional crease-preserving denoise of unclassified surfaces (off by default)
    bool denoise{false};
    double denoiseSigmaSpatial{2.0};
    double denoiseSigmaNormal{0.35};
    int denoiseIterations{5};
    double denoiseMaxMove{0.15};
    double denoiseMaxAbsNy{0.5};        // only vertices whose visible faces are all at least this steep (|ny| below)
};

struct OrientationFamily {
    double azimuthDeg{0};   // atan2(nz, nx) mod 90, degrees
    double weight{0};       // supporting facade area (m^2)
};

struct TierPeakInfo {
    double y{0};
    double area{0};
};

struct ScanRectifierStats {
    // input
    size_t vertexCount{0}, triangleCount{0}, weldGroups{0}, rawComponents{0};
    // D2
    size_t escapeVisible{0}, singleSidedEscape{0}, streetReachRescued{0}, outdoorReachRescued{0}, singleSidedReach{0};
    size_t rigRescued{0}, sightLineRescued{0}, nadirRescued{0}, hiddenTriangles{0};
    bool visibilityPrecomputed{false};
    double hiddenArea{0}, totalArea{0};
    int rigAerialCameras{0}, rigStreetCameras{0};
    size_t outdoorSites{0};
    std::vector<std::array<double, 3>> rigStreetSites;
    // D3
    bool groundOk{false};
    double groundPlaneA{0}, groundPlaneBx{0}, groundPlaneBz{0}, groundAtAnchor{0};
    size_t groundPlaneSamples{0};
    double dtmMin{0}, dtmMax{0};
    size_t footprints{0};
    bool heroFound{false};
    double heroArea{0}, heroMaxHeight{0};
    double heroMinX{0}, heroMaxX{0}, heroMinZ{0}, heroMaxZ{0};
    std::vector<TierPeakInfo> heroTierPeaks;
    size_t tierPeaksTotal{0}, footprintsWithPeaks{0};
    // D4
    std::vector<OrientationFamily> families;
    // D5
    size_t wallCandidates{0}, roofCandidates{0};
    size_t wallRegions{0}, roofRegions{0}, rejectedSmall{0}, rejectedRms{0};
    size_t familySnapped{0}, plumbSnapped{0}, levelSnapped{0}, snapRejectedInduced{0};
    size_t levelSplits{0}, localOrientationSnapped{0}, familyLocked{0};
    size_t sheets{0}, rejectedUnlevelable{0}, orientationOffFamily{0}, reliefProtectedVertices{0}, reliefPanelFaces{0};
    double reliefPanelArea{0};
    size_t proudBlocks{0}, proudBlocksLevelled{0}, proudBlockFaces{0}, proudBlockGroups{0}, proudBlockFrozenGroups{0};
    double proudBlockArea{0};
    double sheetArea{0};
    double localOrientationMaxRotationDeg{0};
    double regionArea{0};
    // D6/D7
    size_t tierAlignedRoofs{0}, parapetGroups{0}, tierRejectedUnsupported{0};
    size_t foreignRejectedFacing{0};
    size_t movableGroups{0}, snappedGroups1{0}, snappedGroups2{0}, snappedGroups3{0}, cappedGroups{0};
    // D9
    int guardIterationsUsed{0};
    size_t guardHalvings{0}, guardReverted{0}, collapsedTriangles{0};
    size_t guardFlip{0}, guardShrink{0}, guardTurn{0}, guardStretch{0}, guardCrease{0}, guardBudget{0}, protectedCreases{0};
    size_t guardComponentReverts{0}, guardClosureDropped{0}, guardResidualReverted{0};
    size_t opposedPairs{0}, guardOpposed{0}, guardFold{0}, opposedRelieved{0}, opposedResidual{0}, guardRestored{0}, guardSeamRestored{0}, guardSeamRestoreFixes{0};
    std::array<size_t, 8> residualReasons{};  // damage left for the last resort: budget, flip, shrink, stretch, crease, fold, turn, opposed
    size_t collapseCandidates{0}, collapseKeptAsSlivers{0};
    // D8
    size_t boundaryGroups{0}, seamContacts{0}, seamFaceContacts{0}, seamFollowers{0}, tJunctionsClosed{0}, seamComponents{0}, seamLargestComponent{0};
    int seamSolves{0}, seamPasses{1};
    size_t seamSolverIterationsUsed{0}, seamSolverIterationsMax{0};
    size_t stitchSamples{0}, stitchedGroups{0}, stitchHeld{0}, stitchGroundHeld{0};
    double seamMaxResidual{0};
    std::array<size_t, 6> gapHistogramBefore{}, gapHistogramAfter{};
    // D10
    size_t denoisedGroups{0};
    // bookkeeping
    size_t movedGroups{0};
    std::vector<std::pair<std::string, double>> timingsMs;
};

struct ScanRectifierResult {
    bool ok{false};
    std::string error;
    std::vector<float> positions;   // 3V, GlbSceneReader vertex order
    std::vector<uint8_t> flags;     // T: 1 keep, 0 hidden, 2 degenerate
    ScanRectifierStats stats;
    // diagnostics (not part of the sidecar)
    std::vector<int32_t> triangleRegion;  // T: plane region id or -1
    std::vector<std::array<double, 16>> regionPlanes;  // cls, nx, ny, nz, d, area, rms, level(+2 sheet), tau, t1x, t1y, t1z, lo1, hi1, lo2, hi2
    std::vector<uint32_t> groupOfVertex;               // V: weld group
    std::vector<float> groupSnapTarget;                // 3G: displacement the snapping asked for
    std::vector<float> groupDelta;                     // 3G: final displacement
    std::vector<uint8_t> groupInfo;                    // G: bit0 on a seam, bit1 guard-marked, bits2-4 snap kind (1 plane, 2 line, 3 point)
    std::vector<uint8_t> groupGuardReasons;            // G: bit0 budget, 1 flip, 2 shrink, 3 stretch, 4 crease, 5 seam neighbour, 6 turn
    std::vector<uint8_t> groupProudBlock;              // G: vertex of a proud block: 1 left where it was scanned, 2 snapped at the block's level
    std::vector<std::array<double, 3>> outdoorSites;   // sight-line viewer eyes
    std::vector<std::array<float, 4>> opposedPairs;    // t, u, input gap, violated by the unguarded solve (0/1)
    std::vector<std::array<float, 16>> seamContacts;   // nv, ns, v0..v4, w0..w4, kind (0 vertex on edge, 1 edge on face), follow, mode, input gap
};

// ============================================================================
// Implementation details
// ============================================================================
namespace detail {

inline unsigned resolveThreads(int requested) {
    unsigned hw = std::max(1u, std::thread::hardware_concurrency());
    if (requested <= 0) return hw;
    return static_cast<unsigned>(requested);
}

/** Dynamic-chunked parallel for over [0, n). fn(begin, end, threadIndex). */
inline void parallelFor(size_t n, unsigned threads, size_t chunk, const std::function<void(size_t, size_t, unsigned)>& fn) {
    if (n == 0) return;
    threads = std::max(1u, std::min<unsigned>(threads, static_cast<unsigned>((n + chunk - 1) / chunk)));
    if (threads == 1) { fn(0, n, 0); return; }
    std::atomic<size_t> next{0};
    std::vector<std::thread> pool;
    pool.reserve(threads);
    for (unsigned t = 0; t < threads; ++t) {
        pool.emplace_back([&, t]() {
            for (;;) {
                size_t b = next.fetch_add(chunk);
                if (b >= n) break;
                fn(b, std::min(n, b + chunk), t);
            }
        });
    }
    for (auto& th : pool) th.join();
}

inline uint64_t mix64(uint64_t z) {
    z += 0x9e3779b97f4a7c15ull;
    z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9ull;
    z = (z ^ (z >> 27)) * 0x94d049bb133111ebull;
    return z ^ (z >> 31);
}

inline double u01(uint64_t h) { return static_cast<double>(h >> 11) * (1.0 / 9007199254740992.0); }

inline double radicalInverse2(uint32_t bits) {
    bits = (bits << 16u) | (bits >> 16u);
    bits = ((bits & 0x55555555u) << 1u) | ((bits & 0xAAAAAAAAu) >> 1u);
    bits = ((bits & 0x33333333u) << 2u) | ((bits & 0xCCCCCCCCu) >> 2u);
    bits = ((bits & 0x0F0F0F0Fu) << 4u) | ((bits & 0xF0F0F0F0u) >> 4u);
    bits = ((bits & 0x00FF00FFu) << 8u) | ((bits & 0xFF00FF00u) >> 8u);
    return static_cast<double>(bits) * 2.3283064365386963e-10;
}

inline double radicalInverse(uint32_t base, uint32_t k) {
    double inv = 1.0 / base, f = inv, r = 0.0;
    while (k) { r += f * (k % base); k /= base; f *= inv; }
    return r;
}

inline void orthonormalBasis(const V3& n, V3& t, V3& b) {
    V3 ref = std::abs(n.y) < 0.9 ? V3{0, 1, 0} : V3{1, 0, 0};
    t = ref.cross(n).normalized();
    b = n.cross(t);
}

inline double wrapPeriod(double a, double period) {
    double r = std::fmod(a, period);
    if (r < 0) r += period;
    return r;
}

/** Signed difference a - b wrapped into [-period/2, period/2). */
inline double wrapDiff(double a, double b, double period) {
    double d = wrapPeriod(a - b + 0.5 * period, period) - 0.5 * period;
    return d;
}

inline double degToRad(double d) { return d * 3.14159265358979323846 / 180.0; }
inline double radToDeg(double r) { return r * 180.0 / 3.14159265358979323846; }

struct UnionFind {
    std::vector<uint32_t> parent;
    explicit UnionFind(size_t n) : parent(n) { std::iota(parent.begin(), parent.end(), 0u); }
    uint32_t find(uint32_t a) {
        while (parent[a] != a) { parent[a] = parent[parent[a]]; a = parent[a]; }
        return a;
    }
    void unite(uint32_t a, uint32_t b) {
        a = find(a); b = find(b);
        if (a == b) return;
        if (a < b) parent[b] = a; else parent[a] = b;
    }
};

/** Symmetric 3x3 eigen decomposition (cyclic Jacobi). Eigenvalues ascending; vectors are columns. */
inline void symmetricEigen3(const double A_in[3][3], double evals[3], V3 evecs[3]) {
    double a[3][3];
    double v[3][3] = {{1, 0, 0}, {0, 1, 0}, {0, 0, 1}};
    std::memcpy(a, A_in, sizeof(a));
    for (int sweep = 0; sweep < 50; ++sweep) {
        double off = a[0][1] * a[0][1] + a[0][2] * a[0][2] + a[1][2] * a[1][2];
        if (off < 1e-30) break;
        for (int p = 0; p < 2; ++p) {
            for (int q = p + 1; q < 3; ++q) {
                if (std::abs(a[p][q]) < 1e-300) continue;
                double theta = (a[q][q] - a[p][p]) / (2.0 * a[p][q]);
                double t = (theta >= 0 ? 1.0 : -1.0) / (std::abs(theta) + std::sqrt(theta * theta + 1.0));
                double c = 1.0 / std::sqrt(t * t + 1.0), s = t * c;
                for (int k = 0; k < 3; ++k) {
                    double akp = a[k][p], akq = a[k][q];
                    a[k][p] = c * akp - s * akq;
                    a[k][q] = s * akp + c * akq;
                }
                for (int k = 0; k < 3; ++k) {
                    double apk = a[p][k], aqk = a[q][k];
                    a[p][k] = c * apk - s * aqk;
                    a[q][k] = s * apk + c * aqk;
                }
                for (int k = 0; k < 3; ++k) {
                    double vkp = v[k][p], vkq = v[k][q];
                    v[k][p] = c * vkp - s * vkq;
                    v[k][q] = s * vkp + c * vkq;
                }
            }
        }
    }
    int idx[3] = {0, 1, 2};
    std::sort(idx, idx + 3, [&](int i, int j) { return a[i][i] < a[j][j]; });
    for (int k = 0; k < 3; ++k) {
        evals[k] = a[idx[k]][idx[k]];
        evecs[k] = V3{v[0][idx[k]], v[1][idx[k]], v[2][idx[k]]};
    }
}

/** Weighted plane fit: returns unit normal (smallest-variance direction) and d with n.p = d. */
inline bool weightedPlane(const std::vector<V3>& pts, const std::vector<double>& w, V3& n, double& d) {
    double sw = 0;
    V3 mu;
    for (size_t i = 0; i < pts.size(); ++i) { sw += w[i]; mu += pts[i] * w[i]; }
    if (sw <= 0) return false;
    mu = mu * (1.0 / sw);
    double C[3][3] = {{0, 0, 0}, {0, 0, 0}, {0, 0, 0}};
    for (size_t i = 0; i < pts.size(); ++i) {
        V3 q = pts[i] - mu;
        double c[3] = {q.x, q.y, q.z};
        for (int r = 0; r < 3; ++r) for (int s = 0; s < 3; ++s) C[r][s] += w[i] * c[r] * c[s];
    }
    double ev[3];
    V3 vec[3];
    symmetricEigen3(C, ev, vec);
    n = vec[0].normalized();
    d = n.dot(mu);
    return n.norm() > 0.5;
}

/** Huber M-estimate of location of values (initialised at the weighted median). */
inline double huberLocation(const std::vector<double>& vals, const std::vector<double>& w, double delta, int iterations = 20) {
    if (vals.empty()) return 0.0;
    std::vector<size_t> order(vals.size());
    std::iota(order.begin(), order.end(), 0);
    std::sort(order.begin(), order.end(), [&](size_t a, size_t b) { return vals[a] < vals[b]; });
    double total = 0;
    for (double x : w) total += x;
    double acc = 0, loc = vals[order.back()];
    for (size_t i : order) { acc += w[i]; if (acc >= 0.5 * total) { loc = vals[i]; break; } }
    for (int it = 0; it < iterations; ++it) {
        double sw = 0, s = 0;
        for (size_t i = 0; i < vals.size(); ++i) {
            double r = std::abs(vals[i] - loc);
            double hw = r <= delta ? 1.0 : delta / r;
            sw += w[i] * hw;
            s += w[i] * hw * vals[i];
        }
        if (sw <= 0) break;
        double nl = s / sw;
        if (std::abs(nl - loc) < 1e-7) { loc = nl; break; }
        loc = nl;
    }
    return loc;
}

/** Solve G x = r for a small symmetric positive (semi)definite system, k <= 3. Returns false when singular. */
inline bool solveSmall(int k, const double G[3][3], const double r[3], double x[3]) {
    double a[3][4];
    for (int i = 0; i < k; ++i) { for (int j = 0; j < k; ++j) a[i][j] = G[i][j]; a[i][k] = r[i]; }
    for (int c = 0; c < k; ++c) {
        int piv = c;
        for (int i = c + 1; i < k; ++i) if (std::abs(a[i][c]) > std::abs(a[piv][c])) piv = i;
        if (std::abs(a[piv][c]) < 1e-9) return false;
        if (piv != c) for (int j = 0; j <= k; ++j) std::swap(a[c][j], a[piv][j]);
        for (int i = 0; i < k; ++i) {
            if (i == c) continue;
            double f = a[i][c] / a[c][c];
            for (int j = c; j <= k; ++j) a[i][j] -= f * a[c][j];
        }
    }
    for (int i = 0; i < k; ++i) x[i] = a[i][k] / a[i][i];
    return true;
}

/** 2D raster grid over the tile's XZ footprint. */
struct Grid2 {
    double x0{0}, z0{0}, cell{1};
    int nx{0}, nz{0};
    std::vector<float> v;
    void init(double minX, double minZ, double maxX, double maxZ, double c, float fill) {
        cell = c; x0 = minX; z0 = minZ;
        nx = std::max(1, static_cast<int>(std::ceil((maxX - minX) / c)) + 1);
        nz = std::max(1, static_cast<int>(std::ceil((maxZ - minZ) / c)) + 1);
        v.assign(static_cast<size_t>(nx) * nz, fill);
    }
    int ix(double x) const { return static_cast<int>(std::floor((x - x0) / cell)); }
    int iz(double z) const { return static_cast<int>(std::floor((z - z0) / cell)); }
    bool inside(int i, int k) const { return i >= 0 && k >= 0 && i < nx && k < nz; }
    float& at(int i, int k) { return v[static_cast<size_t>(k) * nx + i]; }
    float at(int i, int k) const { return v[static_cast<size_t>(k) * nx + i]; }
    double cx(int i) const { return x0 + (i + 0.5) * cell; }
    double cz(int k) const { return z0 + (k + 0.5) * cell; }
    /** Bilinear sample at cell centres (clamped). */
    double sample(double x, double z) const {
        double fx = (x - x0) / cell - 0.5, fz = (z - z0) / cell - 0.5;
        fx = std::clamp(fx, 0.0, static_cast<double>(nx - 1));
        fz = std::clamp(fz, 0.0, static_cast<double>(nz - 1));
        int i0 = static_cast<int>(std::floor(fx)), k0 = static_cast<int>(std::floor(fz));
        int i1 = std::min(i0 + 1, nx - 1), k1 = std::min(k0 + 1, nz - 1);
        double tx = fx - i0, tz = fz - k0;
        double a = at(i0, k0) * (1 - tx) + at(i1, k0) * tx;
        double b = at(i0, k1) * (1 - tx) + at(i1, k1) * tx;
        return a * (1 - tz) + b * tz;
    }
};

/** Separable square-window min or max filter that ignores NaN cells. */
inline void minMaxFilter(Grid2& g, int radius, bool takeMin) {
    if (radius <= 0) return;
    const float nan = std::numeric_limits<float>::quiet_NaN();
    std::vector<float> tmp(g.v.size(), nan);
    for (int k = 0; k < g.nz; ++k) {
        for (int i = 0; i < g.nx; ++i) {
            float best = nan;
            for (int j = std::max(0, i - radius); j <= std::min(g.nx - 1, i + radius); ++j) {
                float val = g.at(j, k);
                if (std::isnan(val)) continue;
                if (std::isnan(best) || (takeMin ? val < best : val > best)) best = val;
            }
            tmp[static_cast<size_t>(k) * g.nx + i] = best;
        }
    }
    for (int k = 0; k < g.nz; ++k) {
        for (int i = 0; i < g.nx; ++i) {
            float best = nan;
            for (int j = std::max(0, k - radius); j <= std::min(g.nz - 1, k + radius); ++j) {
                float val = tmp[static_cast<size_t>(j) * g.nx + i];
                if (std::isnan(val)) continue;
                if (std::isnan(best) || (takeMin ? val < best : val > best)) best = val;
            }
            g.at(i, k) = best;
        }
    }
}

/**
 * Symmetric positive definite matrix of 3x3 blocks (lower triangle stored per row) with a block incomplete Cholesky
 * IC(0) preconditioner. Penalty systems from seam ties and stitch samples are stiff (contact weights >> the weak priors
 * of unsnapped vertices) and their coupling graph is mostly chains, which IC(0) factors almost exactly; plain Jacobi
 * PCG needs thousands of iterations there.
 */
struct BlockSpd {
    struct M3 {
        double a[9]{0, 0, 0, 0, 0, 0, 0, 0, 0};
        V3 mul(const V3& v) const { return {a[0] * v.x + a[1] * v.y + a[2] * v.z, a[3] * v.x + a[4] * v.y + a[5] * v.z, a[6] * v.x + a[7] * v.y + a[8] * v.z}; }
        V3 mulT(const V3& v) const { return {a[0] * v.x + a[3] * v.y + a[6] * v.z, a[1] * v.x + a[4] * v.y + a[7] * v.z, a[2] * v.x + a[5] * v.y + a[8] * v.z}; }
        M3& operator+=(const M3& o) { for (int i = 0; i < 9; ++i) a[i] += o.a[i]; return *this; }
        M3 transposed() const { M3 t; for (int r = 0; r < 3; ++r) for (int c = 0; c < 3; ++c) t.a[c * 3 + r] = a[r * 3 + c]; return t; }
        static M3 outer(const V3& u, const V3& v, double k) {
            M3 m;
            const double U[3] = {u.x, u.y, u.z}, W[3] = {v.x, v.y, v.z};
            for (int r = 0; r < 3; ++r) for (int c = 0; c < 3; ++c) m.a[r * 3 + c] = k * U[r] * W[c];
            return m;
        }
        static M3 identity(double k) { M3 m; m.a[0] = m.a[4] = m.a[8] = k; return m; }
    };
    struct Off { uint32_t j; M3 A, L; };
    size_t m{0};
    std::vector<M3> D, Ld;           // diagonal blocks of A and of the factor
    std::vector<std::vector<Off>> rows;  // row i: blocks (i, j) with j < i, sorted by j
    std::vector<std::pair<uint64_t, M3>> pending;

    void init(size_t n) { m = n; D.assign(n, M3{}); rows.assign(n, {}); pending.clear(); }
    /** Adds block B at (i, j) and, symmetrically, B^T at (j, i). */
    void add(uint32_t i, uint32_t j, const M3& B) {
        if (i == j) { M3 s = B; s += B.transposed(); for (double& x : s.a) x *= 0.5; D[i] += s; return; }
        if (i > j) pending.push_back({(static_cast<uint64_t>(i) << 32) | j, B});
        else pending.push_back({(static_cast<uint64_t>(j) << 32) | i, B.transposed()});
    }
    void finalize() {
        std::sort(pending.begin(), pending.end(), [](const auto& x, const auto& y) { return x.first < y.first; });
        for (size_t k = 0; k < pending.size();) {
            size_t e = k;
            M3 sum;
            while (e < pending.size() && pending[e].first == pending[k].first) { sum += pending[e].second; ++e; }
            const uint32_t i = static_cast<uint32_t>(pending[k].first >> 32), j = static_cast<uint32_t>(pending[k].first & 0xffffffffu);
            rows[i].push_back({j, sum, M3{}});
            k = e;
        }
        pending.clear();
        pending.shrink_to_fit();
    }
    void mul(const std::vector<V3>& x, std::vector<V3>& y) const {
        for (size_t i = 0; i < m; ++i) y[i] = D[i].mul(x[i]);
        for (size_t i = 0; i < m; ++i)
            for (const Off& o : rows[i]) { y[i] += o.A.mul(x[o.j]); y[o.j] += o.A.mulT(x[i]); }
    }
    static bool chol3(const M3& A, M3& L) {
        L = M3{};
        const double l00s = A.a[0];
        if (!(l00s > 0)) return false;
        const double l00 = std::sqrt(l00s), l10 = A.a[3] / l00, l20 = A.a[6] / l00;
        const double l11s = A.a[4] - l10 * l10;
        if (!(l11s > 0)) return false;
        const double l11 = std::sqrt(l11s), l21 = (A.a[7] - l20 * l10) / l11;
        const double l22s = A.a[8] - l20 * l20 - l21 * l21;
        if (!(l22s > 0)) return false;
        L.a[0] = l00; L.a[3] = l10; L.a[4] = l11; L.a[6] = l20; L.a[7] = l21; L.a[8] = std::sqrt(l22s);
        return true;
    }
    static V3 lowerSolve(const M3& L, const V3& b) {  // L y = b
        const double y0 = b.x / L.a[0], y1 = (b.y - L.a[3] * y0) / L.a[4], y2 = (b.z - L.a[6] * y0 - L.a[7] * y1) / L.a[8];
        return {y0, y1, y2};
    }
    static V3 upperSolve(const M3& L, const V3& b) {  // L^T z = b
        const double z2 = b.z / L.a[8], z1 = (b.y - L.a[7] * z2) / L.a[4], z0 = (b.x - L.a[3] * z1 - L.a[6] * z2) / L.a[0];
        return {z0, z1, z2};
    }
    /** IC(0): the factor keeps the pattern of A. A pivot block that is not positive definite falls back to its own block. */
    size_t factor() {
        Ld.assign(m, M3{});
        size_t fallbacks = 0;
        for (size_t i = 0; i < m; ++i) {
            auto& ri = rows[i];
            for (size_t a = 0; a < ri.size(); ++a) {
                const uint32_t j = ri[a].j;
                M3 B = ri[a].A;
                // subtract sum_k L_ik L_jk^T over k < j present in both rows
                const auto& rj = rows[j];
                size_t p = 0, q = 0;
                while (p < a && q < rj.size()) {
                    if (ri[p].j < rj[q].j) ++p;
                    else if (ri[p].j > rj[q].j) ++q;
                    else {
                        const M3& X = ri[p].L;
                        const M3& Y = rj[q].L;
                        for (int r = 0; r < 3; ++r) for (int c = 0; c < 3; ++c) {
                            double s = 0;
                            for (int k = 0; k < 3; ++k) s += X.a[r * 3 + k] * Y.a[c * 3 + k];
                            B.a[r * 3 + c] -= s;
                        }
                        ++p; ++q;
                    }
                }
                // L_ij = B L_jj^{-T}: every row x of L_ij solves L_jj x^T = b^T
                M3 Lij;
                for (int r = 0; r < 3; ++r) {
                    const V3 x = lowerSolve(Ld[j], V3{B.a[r * 3], B.a[r * 3 + 1], B.a[r * 3 + 2]});
                    Lij.a[r * 3] = x.x; Lij.a[r * 3 + 1] = x.y; Lij.a[r * 3 + 2] = x.z;
                }
                ri[a].L = Lij;
            }
            M3 S = D[i];
            for (const Off& o : ri)
                for (int r = 0; r < 3; ++r) for (int c = 0; c < 3; ++c) {
                    double s = 0;
                    for (int k = 0; k < 3; ++k) s += o.L.a[r * 3 + k] * o.L.a[c * 3 + k];
                    S.a[r * 3 + c] -= s;
                }
            if (!chol3(S, Ld[i])) {
                ++fallbacks;
                for (Off& o : ri) o.L = M3{};
                if (!chol3(D[i], Ld[i])) Ld[i] = M3::identity(std::sqrt(std::max(1e-30, (D[i].a[0] + D[i].a[4] + D[i].a[8]) / 3.0)));
            }
        }
        return fallbacks;
    }
    /** z = (L L^T)^{-1} r */
    void apply(const std::vector<V3>& r, std::vector<V3>& z) const {
        for (size_t i = 0; i < m; ++i) {
            V3 s = r[i];
            for (const Off& o : rows[i]) s = s - o.L.mul(z[o.j]);
            z[i] = lowerSolve(Ld[i], s);
        }
        for (size_t ii = m; ii-- > 0;) {
            z[ii] = upperSolve(Ld[ii], z[ii]);
            for (const Off& o : rows[ii]) z[o.j] = z[o.j] - o.L.mulT(z[ii]);
        }
    }
};

/**
 * Exact sparse Cholesky of a BlockSpd (3x3 blocks) with a greedy minimum-degree ordering. Seam and stitch systems are
 * stiff (contact weights 1e6 x the weakest priors), so iterative solvers need thousands of iterations; their graphs are
 * sparse and chain-like, so the exact factor has little fill and solves them in one pass.
 */
struct SparseBlockCholesky {
    using M3 = BlockSpd::M3;
    struct Entry { uint32_t row; M3 L; };
    size_t m{0};
    std::vector<uint32_t> perm, pos;      // position -> node, node -> position
    std::vector<std::vector<Entry>> col;  // per position k: rows i > k (positions, ascending) with L_ik
    std::vector<M3> Lkk;
    std::vector<std::pair<uint32_t, uint32_t>> scatter;  // per off-diagonal block of A (row-major order): (k, entry), high bit = transpose
    size_t fill{0};
    bool analyzed{false};

    /** Symbolic phase (depends on the pattern of A only): greedy minimum-degree ordering and the filled pattern. */
    bool analyze(const BlockSpd& A, size_t maxFill = 50000000) {
        m = A.m;
        analyzed = false;
        std::vector<std::vector<uint32_t>> adj(m);
        for (size_t i = 0; i < m; ++i)
            for (const auto& o : A.rows[i]) { adj[i].push_back(o.j); adj[o.j].push_back(static_cast<uint32_t>(i)); }
        for (auto& a : adj) { std::sort(a.begin(), a.end()); a.erase(std::unique(a.begin(), a.end()), a.end()); }
        perm.clear(); perm.reserve(m);
        pos.assign(m, UINT32_MAX);
        std::vector<std::vector<uint32_t>> pattern(m);
        using QE = std::pair<size_t, uint32_t>;
        std::priority_queue<QE, std::vector<QE>, std::greater<QE>> heap;
        for (size_t i = 0; i < m; ++i) heap.push({adj[i].size(), static_cast<uint32_t>(i)});
        std::vector<uint32_t> merged;
        fill = 0;
        while (!heap.empty()) {
            const auto [deg, v] = heap.top();
            heap.pop();
            if (pos[v] != UINT32_MAX || deg != adj[v].size()) continue;
            pos[v] = static_cast<uint32_t>(perm.size());
            perm.push_back(v);
            std::vector<uint32_t> N = std::move(adj[v]);
            adj[v] = {};
            fill += N.size();
            if (fill > maxFill) return false;
            for (uint32_t u : N) {
                merged.clear();
                std::set_union(adj[u].begin(), adj[u].end(), N.begin(), N.end(), std::back_inserter(merged));
                auto& au = adj[u];
                au.clear();
                for (uint32_t w : merged) if (w != u && w != v) au.push_back(w);
                heap.push({au.size(), u});
            }
            pattern[v] = std::move(N);
        }
        col.assign(m, {});
        for (size_t k = 0; k < m; ++k) {
            auto& c = col[k];
            c.reserve(pattern[perm[k]].size());
            for (uint32_t u : pattern[perm[k]]) c.push_back({pos[u], M3{}});
            std::sort(c.begin(), c.end(), [](const Entry& a, const Entry& b) { return a.row < b.row; });
        }
        scatter.clear();
        for (size_t i = 0; i < m; ++i)
            for (const auto& o : A.rows[i]) {
                const uint32_t pi = pos[i], pj = pos[o.j];
                const uint32_t k = std::min(pi, pj), row = std::max(pi, pj);
                const uint32_t e = findIndex(k, row);
                if (e == UINT32_MAX) return false;
                scatter.push_back({k, e | (pi > pj ? 0u : 0x80000000u)});
            }
        analyzed = true;
        return true;
    }
    uint32_t findIndex(uint32_t k, uint32_t row) const {
        const auto& c = col[k];
        auto it = std::lower_bound(c.begin(), c.end(), row, [](const Entry& e, uint32_t r) { return e.row < r; });
        return (it != c.end() && it->row == row) ? static_cast<uint32_t>(it - c.begin()) : UINT32_MAX;
    }
    /** Numeric phase: factors A + diag(diagAdd) (diagAdd per node, times the identity). */
    bool numeric(const BlockSpd& A, const std::vector<double>& diagAdd, const std::vector<M3>* blockAdd = nullptr) {
        if (!analyzed) return false;
        std::vector<M3> diag(m);
        for (size_t k = 0; k < m; ++k) {
            diag[k] = A.D[perm[k]];
            if (blockAdd) diag[k] += (*blockAdd)[perm[k]];
            else {
                const double w = diagAdd.empty() ? 0.0 : diagAdd[perm[k]];
                diag[k].a[0] += w; diag[k].a[4] += w; diag[k].a[8] += w;
            }
            for (Entry& e : col[k]) e.L = M3{};
        }
        size_t si = 0;
        for (size_t i = 0; i < m; ++i)
            for (const auto& o : A.rows[i]) {
                const auto& sc = scatter[si++];
                M3& t = col[sc.first][sc.second & 0x7fffffffu].L;
                if (sc.second & 0x80000000u) t += o.A.transposed(); else t += o.A;
            }
        Lkk.assign(m, M3{});
        for (size_t k = 0; k < m; ++k) {
            if (!BlockSpd::chol3(diag[k], Lkk[k])) return false;
            auto& c = col[k];
            for (Entry& e : c) {
                M3 Lik;
                for (int r = 0; r < 3; ++r) {
                    const V3 x = BlockSpd::lowerSolve(Lkk[k], V3{e.L.a[r * 3], e.L.a[r * 3 + 1], e.L.a[r * 3 + 2]});
                    Lik.a[r * 3] = x.x; Lik.a[r * 3 + 1] = x.y; Lik.a[r * 3 + 2] = x.z;
                }
                e.L = Lik;
            }
            for (size_t a = 0; a < c.size(); ++a) {
                const M3& Lj = c[a].L;
                const uint32_t j = c[a].row;
                // column j holds every later row of column k (minimum-degree fill): walk both sorted lists together
                auto& cj = col[j];
                size_t q = 0;
                for (size_t b = a; b < c.size(); ++b) {
                    const M3& Li = c[b].L;
                    M3 U;
                    for (int r = 0; r < 3; ++r) for (int qq = 0; qq < 3; ++qq) {
                        double sum = 0;
                        for (int t = 0; t < 3; ++t) sum += Li.a[r * 3 + t] * Lj.a[qq * 3 + t];
                        U.a[r * 3 + qq] = sum;
                    }
                    if (b == a) { for (int t = 0; t < 9; ++t) diag[j].a[t] -= U.a[t]; continue; }
                    const uint32_t i = c[b].row;
                    while (q < cj.size() && cj[q].row < i) ++q;
                    if (q >= cj.size() || cj[q].row != i) return false;
                    for (int t = 0; t < 9; ++t) cj[q].L.a[t] -= U.a[t];
                }
            }
        }
        return true;
    }
    void solve(const std::vector<V3>& b, std::vector<V3>& x) const {
        std::vector<V3> y(m);
        for (size_t k = 0; k < m; ++k) y[k] = b[perm[k]];
        for (size_t k = 0; k < m; ++k) {
            y[k] = BlockSpd::lowerSolve(Lkk[k], y[k]);
            for (const Entry& e : col[k]) y[e.row] = y[e.row] - e.L.mul(y[k]);
        }
        for (size_t k = m; k-- > 0;) {
            V3 s = y[k];
            for (const Entry& e : col[k]) s = s - e.L.mulT(y[e.row]);
            y[k] = BlockSpd::upperSolve(Lkk[k], s);
        }
        x.resize(m);
        for (size_t k = 0; k < m; ++k) x[perm[k]] = y[k];
    }
};

struct CellKeyHash {
    size_t operator()(int64_t k) const { return static_cast<size_t>(mix64(static_cast<uint64_t>(k))); }
};

inline int64_t cellKey(int64_t i, int64_t j, int64_t k) {
    const int64_t off = 1 << 20;
    return ((i + off) & 0x1FFFFF) | (((j + off) & 0x1FFFFF) << 21) | (((k + off) & 0x1FFFFF) << 42);
}

} // namespace detail

// ============================================================================
// Compact BVH for single-sided visibility queries (back faces transparent)
// ============================================================================
class SidedBvh {
public:
    void build(const std::vector<V3>& P, const std::vector<std::array<uint32_t, 3>>& tri, const std::vector<V3>& triN) {
        P_ = &P; tri_ = &tri; N_ = &triN;
        const size_t F = tri.size();
        order_.resize(F);
        std::iota(order_.begin(), order_.end(), 0u);
        cen_.resize(F);
        for (size_t t = 0; t < F; ++t) cen_[t] = (P[tri[t][0]] + P[tri[t][1]] + P[tri[t][2]]) * (1.0 / 3.0);
        nodes_.clear();
        nodes_.reserve(F / 2 + 16);
        if (F) buildRec(0, static_cast<uint32_t>(F));
    }

    /** Any triangle whose front faces a viewer down the ray (n.d > 0) at t in (tMin, tMax). */
    bool anyFront(const V3& o, const V3& d, double tMin, double tMax) const {
        bool found = false;
        traverse(o, d, tMax, [&](uint32_t t, double th, double& limit) {
            if (th <= tMin || (*N_)[t].dot(d) <= 0) return false;
            found = true; limit = th; return true;
        });
        return found;
    }

    /** Any triangle (either side) at t in (tMin, tMax): an occlusion query, stops at the first hit. */
    bool anyHit(const V3& o, const V3& d, double tMin, double tMax) const {
        bool found = false;
        traverse(o, d, tMax, [&](uint32_t, double th, double& limit) {
            if (th <= tMin) return false;
            found = true; limit = th; return true;
        });
        return found;
    }

    /** Closest triangle at t in (tMin, tMax) accepted by pred(tri); -1 when none. */
    template <class Pred>
    int64_t closest(const V3& o, const V3& d, double tMin, double tMax, double& tOut, Pred pred) const {
        int64_t best = -1;
        double bt = tMax;
        traverse(o, d, tMax, [&](uint32_t t, double th, double& limit) {
            if (th <= tMin || th >= bt || !pred(t)) return false;
            bt = th; best = t; limit = th; return false;
        });
        tOut = bt;
        return best;
    }

private:
    struct Node { double lo[3], hi[3]; uint32_t left{0}, right{0}, start{0}, count{0}; };
    const std::vector<V3>* P_{nullptr};
    const std::vector<std::array<uint32_t, 3>>* tri_{nullptr};
    const std::vector<V3>* N_{nullptr};
    std::vector<uint32_t> order_;
    std::vector<V3> cen_;
    std::vector<Node> nodes_;

    uint32_t buildRec(uint32_t s, uint32_t e) {
        Node nd;
        double clo[3] = {1e300, 1e300, 1e300}, chi[3] = {-1e300, -1e300, -1e300};
        for (int k = 0; k < 3; ++k) { nd.lo[k] = 1e300; nd.hi[k] = -1e300; }
        for (uint32_t i = s; i < e; ++i) {
            const uint32_t t = order_[i];
            for (int v = 0; v < 3; ++v) {
                const V3& q = (*P_)[(*tri_)[t][v]];
                const double c[3] = {q.x, q.y, q.z};
                for (int k = 0; k < 3; ++k) { nd.lo[k] = std::min(nd.lo[k], c[k]); nd.hi[k] = std::max(nd.hi[k], c[k]); }
            }
            const double c[3] = {cen_[t].x, cen_[t].y, cen_[t].z};
            for (int k = 0; k < 3; ++k) { clo[k] = std::min(clo[k], c[k]); chi[k] = std::max(chi[k], c[k]); }
        }
        const uint32_t id = static_cast<uint32_t>(nodes_.size());
        nodes_.push_back(nd);
        if (e - s <= 4) { nodes_[id].start = s; nodes_[id].count = e - s; return id; }
        int ax = 0;
        for (int k = 1; k < 3; ++k) if (chi[k] - clo[k] > chi[ax] - clo[ax]) ax = k;
        const uint32_t m = (s + e) / 2;
        auto key = [&](uint32_t t) { return ax == 0 ? cen_[t].x : (ax == 1 ? cen_[t].y : cen_[t].z); };
        std::nth_element(order_.begin() + s, order_.begin() + m, order_.begin() + e, [&](uint32_t a, uint32_t b) {
            const double ka = key(a), kb = key(b);
            return ka != kb ? ka < kb : a < b;
        });
        const uint32_t l = buildRec(s, m);
        const uint32_t r = buildRec(m, e);
        nodes_[id].left = l; nodes_[id].right = r; nodes_[id].count = 0;
        return id;
    }

    /** Moller-Trumbore, two-sided; returns t or a negative value. */
    double hitT(uint32_t t, const V3& o, const V3& d) const {
        const V3& a = (*P_)[(*tri_)[t][0]];
        const V3 e1 = (*P_)[(*tri_)[t][1]] - a, e2 = (*P_)[(*tri_)[t][2]] - a;
        const V3 pv = d.cross(e2);
        const double det = e1.dot(pv);
        if (std::abs(det) < 1e-14) return -1;
        const double inv = 1.0 / det;
        const V3 tv = o - a;
        const double u = tv.dot(pv) * inv;
        if (u < 0 || u > 1) return -1;
        const V3 qv = tv.cross(e1);
        const double v = d.dot(qv) * inv;
        if (v < 0 || u + v > 1) return -1;
        return e2.dot(qv) * inv;
    }

    /** visit(tri, t, limit&) -> true stops the traversal; it may shrink limit. */
    template <class Visit>
    void traverse(const V3& o, const V3& d, double tMax, Visit visit) const {
        if (nodes_.empty()) return;
        const double oo[3] = {o.x, o.y, o.z};
        const double inv[3] = {1.0 / d.x, 1.0 / d.y, 1.0 / d.z};
        double limit = tMax;
        uint32_t stack[128];
        int sp = 0;
        stack[sp++] = 0;
        while (sp) {
            const Node& n = nodes_[stack[--sp]];
            double t0 = 0, t1 = limit;
            bool miss = false;
            for (int k = 0; k < 3 && !miss; ++k) {
                double a = (n.lo[k] - oo[k]) * inv[k], b = (n.hi[k] - oo[k]) * inv[k];
                if (a > b) std::swap(a, b);
                t0 = std::max(t0, a); t1 = std::min(t1, b);
                if (t0 > t1) miss = true;
            }
            if (miss) continue;
            if (n.count) {
                for (uint32_t i = n.start; i < n.start + n.count; ++i) {
                    const uint32_t t = order_[i];
                    const double th = hitT(t, o, d);
                    if (th <= 0 || th >= limit) continue;
                    if (visit(t, th, limit)) return;
                }
            } else {
                stack[sp++] = n.left;
                stack[sp++] = n.right;
            }
        }
    }
};

// ============================================================================
// Planar region model
// ============================================================================
struct PlaneRegion {
    int cls{0};              // 0 wall, 1 roof (a geometric class from the normal, not a semantic label)
    V3 n;                    // unit normal
    double d{0};             // plane: n.p = d
    double area{0};
    double rms{0};
    double tau{0};
    V3 t1, t2;               // in-plane axes of the support box
    double lo1{0}, hi1{0}, lo2{0}, hi2{0};
    V3 centroid;
    bool level{false};       // roof snapped to exactly horizontal
    bool sheet{false};       // a relief sheet split off a larger region at its own level
    int triangleCount{0};
};

// ============================================================================
// The kernel
// ============================================================================
class ScanRectifier {
public:
    static ScanRectifierResult rectifyFile(const std::string& path, const ScanRectifierParams& params) {
        ScanRectifierResult res;
        auto t0 = Clock::now();
        gltf::GltfScene scene = gltf::GlbSceneReader::readFile(path);
        if (!scene.ok) {
            res.error = "failed to read GLB '" + path + "': " + scene.error;
            return res;
        }
        double loadMs = msSince(t0);
        res = rectifyMesh(scene.mesh, params);
        res.stats.timingsMs.insert(res.stats.timingsMs.begin(), {"load", loadMs});
        return res;
    }

    /** Rectify a merged world-space mesh (GlbSceneReader order). Only positions and indices are used. */
    static ScanRectifierResult rectifyMesh(const geometry::ScratchboxMesh& mesh, const ScanRectifierParams& params) {
        Kernel k(mesh, params);
        return k.run();
    }

    static bool writeSidecar(const std::string& path, const ScanRectifierResult& r, std::string* error = nullptr) {
        std::ofstream f(path, std::ios::binary | std::ios::trunc);
        if (!f) { if (error) *error = "cannot open " + path; return false; }
        const char magic[4] = {'S', 'B', 'R', 'X'};
        uint32_t version = kSidecarVersion;
        uint32_t V = static_cast<uint32_t>(r.positions.size() / 3);
        uint32_t T = static_cast<uint32_t>(r.flags.size());
        f.write(magic, 4);
        f.write(reinterpret_cast<const char*>(&version), 4);
        f.write(reinterpret_cast<const char*>(&V), 4);
        f.write(reinterpret_cast<const char*>(&T), 4);
        f.write(reinterpret_cast<const char*>(r.positions.data()), static_cast<std::streamsize>(r.positions.size() * sizeof(float)));
        f.write(reinterpret_cast<const char*>(r.flags.data()), static_cast<std::streamsize>(r.flags.size()));
        if (!f) { if (error) *error = "write failed for " + path; return false; }
        return true;
    }

    static std::string statsJson(const ScanRectifierResult& r, const ScanRectifierParams& p, const std::string& input = "") {
        const auto& s = r.stats;
        std::ostringstream o;
        o.setf(std::ios::fixed);
        o.precision(6);
        auto arr = [&](const auto& a) {
            o << "[";
            for (size_t i = 0; i < a.size(); ++i) o << (i ? "," : "") << a[i];
            o << "]";
        };
        o << "{\n";
        o << "  \"format\": \"SBRX\", \"version\": " << kSidecarVersion << ",\n";
        o << "  \"input\": \"" << jsonEscape(input) << "\",\n";
        o << "  \"note\": \"operational counters of the editing kernel; geometric quality must be measured independently\",\n";
        o << "  \"params\": {"
          << "\"threads\": " << p.threads << ", \"weldEpsilon\": " << p.weldEpsilon
          << ", \"cullHidden\": " << (p.cullHidden ? "true" : "false") << ", \"visibilityRays\": " << p.visibilityRays
          << ", \"visibilityOffset\": " << p.visibilityOffset << ", \"escapeDistance\": " << p.escapeDistance
          << ", \"rigCameras\": " << p.rigCameras << ", \"rigAerialResolution\": " << p.rigAerialResolution
          << ", \"rigStreetWidth\": " << p.rigStreetWidth << ", \"streetReach\": " << (p.streetReach ? "true" : "false") << ", \"streetReachMinGroundNy\": " << p.streetReachMinGroundNy
          << ", \"visibilitySpreadOrigins\": " << (p.visibilitySpreadOrigins ? "true" : "false") << ", \"visibilityOriginMargin\": " << p.visibilityOriginMargin
          << ", \"singleSidedVisibility\": " << (p.singleSidedVisibility ? "true" : "false") << ", \"horizonSlack\": " << p.horizonSlack
          << ", \"outdoorReach\": " << (p.outdoorReach ? "true" : "false") << ", \"outdoorTopTolerance\": " << p.outdoorTopTolerance
          << ", \"outdoorFlatTolerance\": " << p.outdoorFlatTolerance << ", \"outdoorSiteSpacing\": " << p.outdoorSiteSpacing
          << ", \"outdoorEyeHeight\": " << p.outdoorEyeHeight << ", \"outdoorSiteRange\": " << p.outdoorSiteRange
          << ", \"outdoorSitesPerRing\": " << p.outdoorSitesPerRing << ", \"outdoorExhaustiveRadius\": " << p.outdoorExhaustiveRadius << ", \"outdoorSampleArea\": " << p.outdoorSampleArea
          << ", \"splitMinStep\": " << p.splitMinStep << ", \"splitMinSeparation\": " << p.splitMinSeparation
          << ", \"splitMinPartArea\": " << p.splitMinPartArea << ", \"splitMaxLevelRms\": " << p.splitMaxLevelRms << ", \"localOrientationRadius\": " << p.localOrientationRadius
          << ", \"localOrientationSigma\": " << p.localOrientationSigma << ", \"localOrientationWindowDeg\": " << p.localOrientationWindowDeg
          << ", \"crossFootprintWeight\": " << p.crossFootprintWeight << ", \"familyLockDeg\": " << p.familyLockDeg
          << ", \"tierModeBandwidth\": " << p.tierModeBandwidth << ", \"tierModeMerge\": " << p.tierModeMerge
          << ", \"seamContactTolerance\": " << p.seamContactTolerance << ", \"seamStiffness\": " << p.seamStiffness
          << ", \"seamFreeWeight\": " << p.seamFreeWeight << ", \"seamFaceTolerance\": " << p.seamFaceTolerance
          << ", \"seamFaceMaxAngleDeg\": " << p.seamFaceMaxAngleDeg << ", \"seamFaceSamples\": " << p.seamFaceSamples
          << ", \"seamStitchTolerance\": " << p.seamStitchTolerance << ", \"seamStitchSamples\": " << p.seamStitchSamples << ", \"seamStitchEpsilon\": " << p.seamStitchEpsilon
          << ", \"seamProjectedContacts\": " << (p.seamProjectedContacts ? "true" : "false")
          << ", \"seamFollowFaces\": " << (p.seamFollowFaces ? "true" : "false") << ", \"seamFollowEpsilon\": " << p.seamFollowEpsilon
          << ", \"seamInteriorPartners\": " << (p.seamInteriorPartners ? "true" : "false")
          << ", \"seamCoherence\": " << (p.seamCoherence ? "true" : "false")
          << ", \"guardMaxTurnDeg\": " << p.guardMaxTurnDeg << ", \"guardTurnMinAreaRatio\": " << p.guardTurnMinAreaRatio
          << ", \"guardPlaneFaceDeg\": " << p.guardPlaneFaceDeg << ", \"guardPlaneMaxTurnDeg\": " << p.guardPlaneMaxTurnDeg
          << ", \"guardMaxStretch\": " << p.guardMaxStretch << ", \"creaseKeepDeg\": " << p.creaseKeepDeg
          << ", \"creaseMaxSoftenDeg\": " << p.creaseMaxSoftenDeg << ", \"creaseShrinkExempt\": " << p.creaseShrinkExempt
          << ", \"creaseExemptLineSnaps\": " << (p.creaseExemptLineSnaps ? "true" : "false") << ", \"creaseMaxSharpenDeg\": " << p.creaseMaxSharpenDeg
          << ", \"seamPartnerSnap\": " << (p.seamPartnerSnap ? "true" : "false")
          << ", \"dsmCell\": " << p.dsmCell << ", \"dtmCell\": " << p.dtmCell << ", \"dtmOpeningRadius\": " << p.dtmOpeningRadius
          << ", \"footprintMinHeight\": " << p.footprintMinHeight << ", \"heroMinHeight\": " << p.heroMinHeight
          << ", \"anchorX\": " << p.anchorX << ", \"anchorZ\": " << p.anchorZ
          << ", \"wallMaxAbsNy\": " << p.wallMaxAbsNy << ", \"roofMinNy\": " << p.roofMinNy
          << ", \"offsetTolerance\": " << p.offsetTolerance << ", \"regionAabbGrow\": " << p.regionAabbGrow
          << ", \"normalAgreementDeg\": " << p.normalAgreementDeg << ", \"minWallArea\": " << p.minWallArea
          << ", \"minRoofArea\": " << p.minRoofArea << ", \"planeHuber\": " << p.planeHuber
          << ", \"familySnapDeg\": " << p.familySnapDeg << ", \"plumbSnapDeg\": " << p.plumbSnapDeg
          << ", \"maxSnapInducedDisplacement\": " << p.maxSnapInducedDisplacement << ", \"maxRegionRms\": " << p.maxRegionRms
          << ", \"snap\": " << (p.snap ? "true" : "false") << ", \"tauWall\": " << p.tauWall << ", \"tauRoof\": " << p.tauRoof
          << ", \"tauCorner\": " << p.tauCorner << ", \"supportGrow\": " << p.supportGrow
          << ", \"fullStrengthFraction\": " << p.fullStrengthFraction << ", \"cornerMinAngleDeg\": " << p.cornerMinAngleDeg
          << ", \"meltCaptureRange\": " << p.meltCaptureRange << ", \"meltParallelDeg\": " << p.meltParallelDeg << ", \"meltMaxParallelShare\": " << p.meltMaxParallelShare
          << ", \"maxDisplacement\": " << p.maxDisplacement << ", \"snapDeadBand\": " << p.snapDeadBand
          << ", \"foreignPlaneSnap\": " << (p.foreignPlaneSnap ? "true" : "false") << ", \"minRegionTriangles\": " << p.minRegionTriangles
          << ", \"alignTiers\": " << (p.alignTiers ? "true" : "false") << ", \"tierRoofTolerance\": " << p.tierRoofTolerance
          << ", \"tierParapetTolerance\": " << p.tierParapetTolerance << ", \"tierMinPeakArea\": " << p.tierMinPeakArea
          << ", \"tierRegionMinFootprintShare\": " << p.tierRegionMinFootprintShare
          << ", \"closeTJunctions\": " << (p.closeTJunctions ? "true" : "false") << ", \"tJunctionTolerance\": " << p.tJunctionTolerance
          << ", \"guardMinNormalDot\": " << p.guardMinNormalDot << ", \"guardMinAreaRatio\": " << p.guardMinAreaRatio
          << ", \"guardIterations\": " << p.guardIterations << ", \"guardRestore\": " << (p.guardRestore ? "true" : "false") << ", \"guardRestoreRounds\": " << p.guardRestoreRounds << ", \"collapseFromArea\": " << p.collapseFromArea
          << ", \"collapseToArea\": " << p.collapseToArea << ", \"collapseToRatio\": " << p.collapseToRatio << ", \"collapseMaxSlit\": " << p.collapseMaxSlit
          << ", \"nadirGuard\": " << (p.nadirGuard ? "true" : "false") << ", \"extractSheets\": " << (p.extractSheets ? "true" : "false")
          << ", \"sheetMinRelief\": " << p.sheetMinRelief << ", \"sheetMinMainRelief\": " << p.sheetMinMainRelief << ", \"sheetMaxAngleDeg\": " << p.sheetMaxAngleDeg << ", \"sheetFlatSpread\": " << p.sheetFlatSpread << ", \"sheetMaxWidth\": " << p.sheetMaxWidth << ", \"sheetMinAspect\": " << p.sheetMinAspect << ", \"sheetMaxSpreadOfRelief\": " << p.sheetMaxSpreadOfRelief
          << ", \"sheetLevelTol\": " << p.sheetLevelTol << ", \"sheetMinArea\": " << p.sheetMinArea
          << ", \"sheetRingWidth\": " << p.sheetRingWidth << ", \"sheetRingInner\": " << p.sheetRingInner << ", \"sheetRingFrontMost\": " << (p.sheetRingFrontMost ? "true" : "false") << ", \"sheetRingSpacing\": " << p.sheetRingSpacing << ", \"sheetMinRingArea\": " << p.sheetMinRingArea
          << ", \"foreignMinFacingDot\": " << p.foreignMinFacingDot << ", \"rejectUnlevelableRoofs\": " << (p.rejectUnlevelableRoofs ? "true" : "false")
          << ", \"tierLocalRadius\": " << p.tierLocalRadius << ", \"tierLocalMinArea\": " << p.tierLocalMinArea
          << ", \"guardOpposed\": " << (p.guardOpposed ? "true" : "false") << ", \"opposedMaxGap\": " << p.opposedMaxGap << ", \"opposedMaxDot\": " << p.opposedMaxDot
          << ", \"opposedEscalate\": " << (p.opposedEscalate ? "true" : "false") << ", \"opposedZeroPasses\": " << p.opposedZeroPasses << ", \"opposedKeepFraction\": " << p.opposedKeepFraction << ", \"opposedKeepMin\": " << p.opposedKeepMin << ", \"opposedMinApproach\": " << p.opposedMinApproach << ", \"guardFoldDeg\": " << p.guardFoldDeg
          << ", \"keepCollapsedSlivers\": " << (p.keepCollapsedSlivers ? "true" : "false") << ", \"collapseKeepWidth\": " << p.collapseKeepWidth
          << ", \"collapseKeepArea\": " << p.collapseKeepArea << ", \"collapseMaxNudge\": " << p.collapseMaxNudge
          << ", \"denoise\": " << (p.denoise ? "true" : "false")
          << ", \"denoiseMaxAbsNy\": " << p.denoiseMaxAbsNy << ", \"denoiseMaxMove\": " << p.denoiseMaxMove
          << "},\n";
        o << "  \"input_counts\": {\"vertices\": " << s.vertexCount << ", \"triangles\": " << s.triangleCount
          << ", \"weldGroups\": " << s.weldGroups << ", \"rawComponents\": " << s.rawComponents << "},\n";
        o << "  \"visibility\": {\"escapeVisible\": " << s.escapeVisible << ", \"streetReachRescued\": " << s.streetReachRescued
          << ", \"outdoorReachRescued\": " << s.outdoorReachRescued << ", \"singleSidedEscape\": " << s.singleSidedEscape
          << ", \"singleSidedReach\": " << s.singleSidedReach
          << ", \"rigRescued\": " << s.rigRescued << ", \"sightLineRescued\": " << s.sightLineRescued << ", \"nadirRescued\": " << s.nadirRescued
          << ", \"precomputed\": " << (s.visibilityPrecomputed ? "true" : "false") << ", \"outdoorSites\": " << s.outdoorSites
          << ", \"hiddenTriangles\": " << s.hiddenTriangles << ", \"hiddenArea\": " << s.hiddenArea
          << ", \"totalArea\": " << s.totalArea << ", \"rigAerialCameras\": " << s.rigAerialCameras
          << ", \"rigStreetCameras\": " << s.rigStreetCameras << ", \"rigStreetSites\": [";
        for (size_t i = 0; i < s.rigStreetSites.size(); ++i) {
            o << (i ? "," : "") << "[" << s.rigStreetSites[i][0] << "," << s.rigStreetSites[i][1] << "," << s.rigStreetSites[i][2] << "]";
        }
        o << "]},\n";
        o << "  \"ground\": {\"ok\": " << (s.groundOk ? "true" : "false") << ", \"localPlane\": {\"a\": " << s.groundPlaneA
          << ", \"bx\": " << s.groundPlaneBx << ", \"bz\": " << s.groundPlaneBz << ", \"samples\": " << s.groundPlaneSamples
          << "}, \"atAnchor\": " << s.groundAtAnchor << ", \"dtmMin\": " << s.dtmMin << ", \"dtmMax\": " << s.dtmMax << "},\n";
        o << "  \"footprints\": {\"count\": " << s.footprints << ", \"withTierPeaks\": " << s.footprintsWithPeaks
          << ", \"tierPeaksTotal\": " << s.tierPeaksTotal << ", \"hero\": {\"found\": " << (s.heroFound ? "true" : "false")
          << ", \"area\": " << s.heroArea << ", \"maxHeightAboveGround\": " << s.heroMaxHeight
          << ", \"bboxX\": [" << s.heroMinX << "," << s.heroMaxX << "], \"bboxZ\": [" << s.heroMinZ << "," << s.heroMaxZ
          << "], \"tierPeaks\": [";
        for (size_t i = 0; i < s.heroTierPeaks.size(); ++i) {
            o << (i ? "," : "") << "{\"y\": " << s.heroTierPeaks[i].y << ", \"area\": " << s.heroTierPeaks[i].area << "}";
        }
        o << "]}},\n";
        o << "  \"families\": [";
        for (size_t i = 0; i < s.families.size(); ++i) {
            o << (i ? "," : "") << "{\"azimuthDeg_atan2_nz_nx_mod90\": " << s.families[i].azimuthDeg << ", \"area\": " << s.families[i].weight << "}";
        }
        o << "],\n";
        o << "  \"regions\": {\"wallCandidates\": " << s.wallCandidates << ", \"roofCandidates\": " << s.roofCandidates
          << ", \"wallRegions\": " << s.wallRegions << ", \"roofRegions\": " << s.roofRegions
          << ", \"rejectedSmall\": " << s.rejectedSmall << ", \"rejectedRms\": " << s.rejectedRms
          << ", \"familySnapped\": " << s.familySnapped << ", \"plumbSnapped\": " << s.plumbSnapped
          << ", \"levelSnapped\": " << s.levelSnapped << ", \"orientationSnapRejectedInduced\": " << s.snapRejectedInduced
          << ", \"levelSplits\": " << s.levelSplits << ", \"localOrientationSnapped\": " << s.localOrientationSnapped
          << ", \"familyLocked\": " << s.familyLocked << ", \"localOrientationMaxRotationDeg\": " << s.localOrientationMaxRotationDeg
          << ", \"reliefSheets\": " << s.sheets << ", \"reliefSheetArea\": " << s.sheetArea << ", \"rejectedUnlevelableRoofs\": " << s.rejectedUnlevelable << ", \"orientationOffFamily\": " << s.orientationOffFamily << ", \"reliefPanelFaces\": " << s.reliefPanelFaces << ", \"reliefPanelArea\": " << s.reliefPanelArea << ", \"reliefPanelVertices\": " << s.reliefProtectedVertices
          << ", \"proudBlocks\": " << s.proudBlocks << ", \"proudBlocksLevelled\": " << s.proudBlocksLevelled << ", \"proudBlockFaces\": " << s.proudBlockFaces
          << ", \"proudBlockArea\": " << s.proudBlockArea << ", \"proudBlockGroups\": " << s.proudBlockGroups << ", \"proudBlockFrozenGroups\": " << s.proudBlockFrozenGroups
          << ", \"area\": " << s.regionArea << "},\n";
        o << "  \"snapping\": {\"movableGroups\": " << s.movableGroups << ", \"onePlane\": " << s.snappedGroups1
          << ", \"line\": " << s.snappedGroups2 << ", \"point\": " << s.snappedGroups3 << ", \"capped\": " << s.cappedGroups
          << ", \"tierAlignedRoofs\": " << s.tierAlignedRoofs << ", \"tierRejectedUnsupported\": " << s.tierRejectedUnsupported
          << ", \"parapetGroups\": " << s.parapetGroups << ", \"foreignPlanesRejectedFacing\": " << s.foreignRejectedFacing
          << ", \"movedGroups\": " << s.movedGroups << "},\n";
        o << "  \"guards\": {\"iterations\": " << s.guardIterationsUsed << ", \"halvings\": " << s.guardHalvings
          << ", \"revertedGroups\": " << s.guardReverted << ", \"collapsedTrianglesFlagged\": " << s.collapsedTriangles
          << ", \"protectedCreases\": " << s.protectedCreases
          << ", \"firstPassReasons\": {\"flip\": " << s.guardFlip << ", \"shrink\": " << s.guardShrink << ", \"turn\": " << s.guardTurn
          << ", \"stretch\": " << s.guardStretch << ", \"crease\": " << s.guardCrease << ", \"displacementBudget\": " << s.guardBudget << "}"
          << ", \"componentReverts\": " << s.guardComponentReverts << ", \"closureDropped\": " << s.guardClosureDropped
          << ", \"residualReverted\": " << s.guardResidualReverted << ", \"opposedPairs\": " << s.opposedPairs
          << ", \"firstPassOpposed\": " << s.guardOpposed << ", \"opposedRelieved\": " << s.opposedRelieved << ", \"opposedResidual\": " << s.opposedResidual << ", \"firstPassFold\": " << s.guardFold
          << ", \"residualReasons_budget_flip_shrink_stretch_crease_fold_turn_opposed\": [" << s.residualReasons[0] << "," << s.residualReasons[1] << "," << s.residualReasons[2] << "," << s.residualReasons[3]
          << "," << s.residualReasons[4] << "," << s.residualReasons[5] << "," << s.residualReasons[6] << "," << s.residualReasons[7] << "]"
          << ", \"restoredGroups\": " << s.guardRestored << ", \"restoredSeamGroups\": " << s.guardSeamRestored << ", \"collapseCandidates\": " << s.collapseCandidates << ", \"collapseKeptAsSlivers\": " << s.collapseKeptAsSlivers << "},\n";
        o << "  \"seams\": {\"boundaryGroups\": " << s.boundaryGroups << ", \"contacts\": " << s.seamContacts
          << ", \"faceContacts\": " << s.seamFaceContacts << ", \"followers\": " << s.seamFollowers << ", \"stitchSamples\": " << s.stitchSamples << ", \"stitchedGroups\": " << s.stitchedGroups << ", \"stitchHeld\": " << s.stitchHeld << ", \"stitchGroundHeld\": " << s.stitchGroundHeld << ", \"closedAtInput\": " << s.tJunctionsClosed << ", \"components\": " << s.seamComponents
          << ", \"largestComponent\": " << s.seamLargestComponent << ", \"solves\": " << s.seamSolves << ", \"passes\": " << s.seamPasses
          << ", \"maxConstraintResidual_m\": " << s.seamMaxResidual
          << ", \"gapHistogramEdges_m\": [0,0.001,0.005,0.01,0.03,0.1], \"gapHistogramBefore\": ";
        arr(s.gapHistogramBefore);
        o << ", \"gapHistogramAfter\": ";
        arr(s.gapHistogramAfter);
        o << "},\n";
        o << "  \"denoise\": {\"groups\": " << s.denoisedGroups << "},\n";
        o << "  \"timingsMs\": {";
        for (size_t i = 0; i < s.timingsMs.size(); ++i) {
            o << (i ? ", " : "") << "\"" << jsonEscape(s.timingsMs[i].first) << "\": " << s.timingsMs[i].second;
        }
        o << "}\n}\n";
        return o.str();
    }

private:
    using Clock = std::chrono::steady_clock;
    static double msSince(Clock::time_point t) {
        return std::chrono::duration<double, std::milli>(Clock::now() - t).count();
    }
    static std::string jsonEscape(const std::string& s) {
        std::string o;
        for (char c : s) {
            if (c == '"' || c == '\\') { o += '\\'; o += c; }
            else if (static_cast<unsigned char>(c) < 0x20) { char b[8]; std::snprintf(b, sizeof(b), "\\u%04x", c); o += b; }
            else o += c;
        }
        return o;
    }

    struct Candidate {
        V3 n;
        double d{0}, res{0}, tau{0};
        double area{0};   // supporting area of the plane (structural dominance)
        bool own{false};  // the plane of a region one of the group's own triangles belongs to
        bool sheet{false};// a relief sheet's plane
        bool melt{false}; // an own wall plane the vertex sags away from along tilted faces: full strength (meltCaptureRange)
    };

    class Kernel {
    public:
        Kernel(const geometry::ScratchboxMesh& m, const ScanRectifierParams& p) : mesh(m), P(p) {
            threads = detail::resolveThreads(p.threads);
        }

        ScanRectifierResult run() {
            ScanRectifierResult out;
            V = mesh.vertices.size();
            F = mesh.indices.size() / 3;
            if (V == 0 || F == 0) { out.error = "mesh has no triangles"; return out; }
            S.vertexCount = V;
            S.triangleCount = F;
            auto t = Clock::now();
            loadGeometry();
            buildWeldGroups();
            buildRawComponents();
            S.timingsMs.push_back({"weld_and_topology", msSince(t)});

            t = Clock::now();
            bvh::BvhTree tree;
            const bool precomputed = P.cullHidden && P.precomputedVisibility.size() == F;
            if (!precomputed) {  // the BVH serves the escape-ray visibility tests only
                tree.build(mesh);
                S.timingsMs.push_back({"bvh_build", msSince(t)});
            }

            t = Clock::now();
            if (sided() || P.guardOpposed) sbvh.build(P0, tri, triN0);
            if (P.cullHidden && P.precomputedVisibility.size() == F) {
                // iteration aid: the D2 result of an earlier run on the same scan
                visible.assign(F, 0);
                for (size_t q = 0; q < F; ++q) visible[q] = P.precomputedVisibility[q] ? 1 : 0;
                escape = visible;
                S.visibilityPrecomputed = true;
                finalizeHiddenFlags();
                S.timingsMs.push_back({"visibility_precomputed", msSince(t)});
            } else {
                computeEscapeVisibility(tree);
                applySingleSidedEscape();
                S.timingsMs.push_back({"escape_visibility", msSince(t)});

                t = Clock::now();
                buildTopSurface();
                buildDsmAndGround(escape);
                S.timingsMs.push_back({"dsm_dtm", msSince(t)});

                t = Clock::now();
                applyStreetReachGuard(tree);
                S.timingsMs.push_back({"street_reach", msSince(t)});

                t = Clock::now();
                applyRigGuard(tree);
                applyNadirGuard();
                S.timingsMs.push_back({"rig_guard", msSince(t)});

                t = Clock::now();
                applySightLineGuard(tree);
                finalizeHiddenFlags();
                S.timingsMs.push_back({"sight_lines", msSince(t)});
            }

            t = Clock::now();
            buildDsmAndGround(visible);  // refresh with the final visible set
            buildFootprints();
            S.timingsMs.push_back({"footprints", msSince(t)});

            t = Clock::now();
            detectFamilies();
            S.timingsMs.push_back({"families", msSince(t)});

            t = Clock::now();
            buildRegions();
            S.timingsMs.push_back({"regions", msSince(t)});

            t = Clock::now();
            buildTierPeaks();
            S.timingsMs.push_back({"tiers", msSince(t)});

            t = Clock::now();
            buildReliefProtection();
            buildProudBlocks();
            S.timingsMs.push_back({"relief_protection", msSince(t)});

            t = Clock::now();
            buildSeamContacts();
            buildProtectedCreases();
            buildOpposedPairs();
            S.timingsMs.push_back({"seam_contacts_creases_opposed_pairs", msSince(t)});

            // snapping and denoising write per-group targets; the seam solve and the guards turn
            // them into the final displacements
            delta.assign(G, V3{});
            if (P.snap) {
                t = Clock::now();
                snapGroups();
                S.timingsMs.push_back({"snap", msSince(t)});
            }
            if (P.denoise) {
                t = Clock::now();
                denoiseUnclassified();
                S.timingsMs.push_back({"denoise", msSince(t)});
            }
            target = delta;
            snapTarget0 = delta;
            targetWeight.assign(G, 1.0);
            for (size_t g = 0; g < G; ++g) if (!(target[g].norm() > 0)) targetWeight[g] = P.seamFreeWeight;
            t = Clock::now();
            solveWithGuards();
            restorePass();
            S.timingsMs.push_back({"seam_solve_and_guards", msSince(t)});
            debugFlips("first solve+restore");

            t = Clock::now();
            finalizeCollapseFlags();
            if (P.seamSecondPass && (P.seamCoherence || P.closeTJunctions) && S.collapsedTriangles > 0) {
                // contacts at the input positions over the final kept set (collapsed bevels excluded), then the
                // same targets (with the first pass's guard reductions) are solved and guarded again
                const std::vector<V3> keepTarget = target;
                const std::vector<double> keepWeight = targetWeight;
                S.tJunctionsClosed = 0; S.seamFaceContacts = 0; S.seamFollowers = 0; S.seamLargestComponent = 0;
                buildSeamContacts();
                for (size_t q = 0; q < F; ++q) if (flags[q] == kFlagDegenerate) flags[q] = kFlagKeep;
                target = keepTarget;
                targetWeight = keepWeight;
                solveWithGuards();
                restorePass();
                S.collapsedTriangles = 0;
                S.collapseCandidates = 0;
                S.collapseKeptAsSlivers = 0;
                finalizeCollapseFlags();
                ++S.seamPasses;
            }
            S.timingsMs.push_back({"final_flags_and_second_seam_pass", msSince(t)});
            debugFlips("second pass");
            t = Clock::now();
            stitchPass();
            gapHistogramAfter();
            S.timingsMs.push_back({"seam_stitch", msSince(t)});
            debugFlips("stitch");

            // output
            out.positions.resize(V * 3);
            for (size_t v = 0; v < V; ++v) {
                V3 q = P0[v] + delta[groupOf[v]];
                out.positions[v * 3 + 0] = static_cast<float>(q.x);
                out.positions[v * 3 + 1] = static_cast<float>(q.y);
                out.positions[v * 3 + 2] = static_cast<float>(q.z);
            }
            out.flags = flags;
            out.triangleRegion = triRegion;
            out.groupOfVertex = groupOf;
            out.groupProudBlock = proudBlockGroup;
            out.outdoorSites = siteEyes;
            for (const Contact& c : contacts) {
                std::array<float, 16> row{};
                row[0] = static_cast<float>(c.nv); row[1] = static_cast<float>(c.ns);
                for (int i = 0; i < 5; ++i) { row[2 + i] = i < c.nv ? static_cast<float>(c.v[i]) : -1.0f; row[7 + i] = i < c.nv ? static_cast<float>(c.w[i]) : 0.0f; }
                row[12] = c.kind; row[13] = c.follow ? 1.0f : 0.0f; row[14] = c.mode; row[15] = static_cast<float>(c.gap0);
                out.seamContacts.push_back(row);
            }
            for (size_t i = 0; i < opposed.size(); ++i) {
                out.opposedPairs.push_back({static_cast<float>(opposed[i].t), static_cast<float>(opposed[i].u), opposed[i].gap0,
                                            static_cast<float>((i < opposedFirstBad.size() ? opposedFirstBad[i] : 0) + (i < opposedBeforeZero.size() ? 2 * opposedBeforeZero[i] : 0) + (opposedViolated(opposed[i]) ? 4 : 0))});
            }
            out.groupSnapTarget.resize(G * 3);
            out.groupDelta.resize(G * 3);
            out.groupInfo.assign(G, 0);
            out.groupGuardReasons = everMarked.size() == G ? everMarked : std::vector<uint8_t>(G, 0);
            for (size_t g = 0; g < G; ++g) {
                out.groupSnapTarget[g * 3] = static_cast<float>(snapTarget0[g].x); out.groupSnapTarget[g * 3 + 1] = static_cast<float>(snapTarget0[g].y); out.groupSnapTarget[g * 3 + 2] = static_cast<float>(snapTarget0[g].z);
                out.groupDelta[g * 3] = static_cast<float>(delta[g].x); out.groupDelta[g * 3 + 1] = static_cast<float>(delta[g].y); out.groupDelta[g * 3 + 2] = static_cast<float>(delta[g].z);
                out.groupInfo[g] = static_cast<uint8_t>((!seamVar.empty() && seamVar[g] >= 0 ? 1 : 0) | (everMarked.empty() ? 0 : (everMarked[g] ? 2 : 0)) | ((snapKind.empty() ? 0 : (snapKind[g] & 7)) << 2));
            }
            for (const auto& R : regions) out.regionPlanes.push_back({static_cast<double>(R.cls), R.n.x, R.n.y, R.n.z, R.d, R.area, R.rms, (R.level ? 1.0 : 0.0) + (R.sheet ? 2.0 : 0.0), R.tau, R.t1.x, R.t1.y, R.t1.z, R.lo1, R.hi1, R.lo2, R.hi2});
            size_t moved = 0;
            for (size_t g = 0; g < G; ++g) if (delta[g].norm() > 0) ++moved;
            S.movedGroups = moved;
            out.stats = S;
            out.ok = true;
            return out;
        }

    private:
        const geometry::ScratchboxMesh& mesh;
        const ScanRectifierParams& P;
        unsigned threads{1};
        ScanRectifierStats S;

        size_t V{0}, F{0}, G{0};
        std::vector<V3> P0;                       // original vertex positions
        std::vector<std::array<uint32_t, 3>> tri; // raw vertex indices
        std::vector<std::array<uint32_t, 3>> triG;// weld groups
        std::vector<V3> triN0, triC0;
        std::vector<double> triA0;
        std::vector<uint32_t> groupOf;
        std::vector<V3> groupPos;
        std::vector<uint32_t> groupTriStart, groupTris;  // CSR group -> triangles
        std::vector<uint32_t> triComponent;
        std::vector<uint8_t> escape, visible, flags;
        V3 bbMin, bbMax;

        // ground / footprints
        detail::Grid2 dsm, dtm;
        std::vector<int32_t> footprintLabel;    // per DSM cell
        bool groundReady{false};
        SidedBvh sbvh;                          // single-sided queries (built when singleSidedVisibility)
        bool sided() const { return P.cullHidden && P.singleSidedVisibility; }
        // top surface of the whole scan (every triangle, culled or not): open air lies above it
        detail::Grid2 top;
        std::vector<float> topNy;               // |ny| of the triangle that forms the top in each cell
        std::vector<int32_t> topTri;            // the triangle that forms the top in each cell (-1 = none)
        bool topReady{false};

        std::vector<OrientationFamily> families;
        std::vector<PlaneRegion> regions;
        std::vector<int32_t> triRegion;
        std::unordered_map<int32_t, std::vector<TierPeakInfo>> tierPeaks;  // footprint -> peaks

        std::vector<V3> delta;  // per weld group displacement (final)
        std::vector<V3> target; // per weld group displacement the snapping asked for (guards shrink it)
        std::vector<double> targetWeight;  // weight of each group's target in the seam solve
        std::vector<V3> snapTarget0;        // diagnostics: the snapping's request before any guard
        std::vector<uint8_t> everMarked, snapKind;  // diagnostics
        std::vector<std::array<double, 3>> siteEyes;  // diagnostics

        // D8 seam contacts: Pi (sum_i w[i] delta[v[i]]) = Pi c. The first ns ids are the border side (positive weights:
        // a vertex, or a point of a boundary edge), the rest the partner side (negative weights: the two ends of an edge,
        // or the three corners of a face). Pi projects onto the directions in which the two sides may not separate:
        // all three (mode 0), the partner face's normal `ax` only (mode 1: the border may slide along the face), or the
        // plane normal to `ax` (mode 2: sliding along an edge). kind 0 = vertex on a border edge, 1 = edge on a face.
        struct Contact { uint32_t v[5]{}; double w[5]{}; int nv{0}; int ns{1}; V3 c; double gap0{0}; uint8_t kind{0}; uint8_t mode{0}; V3 ax; bool follow{false}; };
        static V3 projectContact(const Contact& c, const V3& v) {
            if (c.mode == 1) return c.ax * c.ax.dot(v);
            if (c.mode == 2) return v - c.ax * c.ax.dot(v);
            return v;
        }
        std::vector<Contact> contacts;
        std::vector<int32_t> seamVar;              // group -> solver variable (-1 = not on a seam)
        std::vector<uint32_t> seamGroups;          // solver variable -> group
        std::vector<int32_t> seamComponent;        // group -> contact-graph component (-1 = none)
        std::vector<uint8_t> contactClosed;        // per contact: closure offset active
        // boundary topology of the kept triangles (for the gap histograms)
        struct BEdge { uint32_t a, b, comp; };
        std::vector<BEdge> bEdges;
        std::vector<uint32_t> keptComponent;  // per triangle: connected piece of the kept surface (raw vertices)
        std::vector<uint32_t> bVerts, bVertComp;

        // D9 protected creases: welded edges of two kept triangles with an input dihedral >= creaseKeepDeg
        struct CreaseEdge { uint32_t t1, t2; uint32_t g[4]; double ang0Deg; bool real; };
        std::vector<CreaseEdge> creases;

        // ------------------------------------------------------------------
        void loadGeometry() {
            P0.resize(V);
            bbMin = V3{1e300, 1e300, 1e300};
            bbMax = V3{-1e300, -1e300, -1e300};
            for (size_t v = 0; v < V; ++v) {
                const auto& p = mesh.vertices[v].position;
                P0[v] = V3{p.x, p.y, p.z};
                bbMin = V3{std::min(bbMin.x, P0[v].x), std::min(bbMin.y, P0[v].y), std::min(bbMin.z, P0[v].z)};
                bbMax = V3{std::max(bbMax.x, P0[v].x), std::max(bbMax.y, P0[v].y), std::max(bbMax.z, P0[v].z)};
            }
            tri.resize(F);
            triN0.resize(F);
            triC0.resize(F);
            triA0.resize(F);
            for (size_t t = 0; t < F; ++t) {
                tri[t] = {mesh.indices[t * 3], mesh.indices[t * 3 + 1], mesh.indices[t * 3 + 2]};
                const V3 &a = P0[tri[t][0]], &b = P0[tri[t][1]], &c = P0[tri[t][2]];
                V3 n = (b - a).cross(c - a);
                double l = n.norm();
                triA0[t] = 0.5 * l;
                triN0[t] = l > 1e-300 ? n * (1.0 / l) : V3{0, 0, 0};
                triC0[t] = (a + b + c) * (1.0 / 3.0);
                S.totalArea += triA0[t];
            }
            flags.assign(F, kFlagKeep);
        }

        void buildWeldGroups() {
            struct K3 { int64_t x, y, z; bool operator==(const K3& o) const { return x == o.x && y == o.y && z == o.z; } };
            struct KH { size_t operator()(const K3& k) const {
                return static_cast<size_t>(detail::mix64(static_cast<uint64_t>(k.x) * 73856093ull ^ detail::mix64(static_cast<uint64_t>(k.y) * 19349663ull ^ detail::mix64(static_cast<uint64_t>(k.z)))));
            } };
            std::unordered_map<K3, uint32_t, KH> map;
            map.reserve(V * 2);
            groupOf.resize(V);
            const double inv = 1.0 / P.weldEpsilon;
            for (size_t v = 0; v < V; ++v) {
                K3 k{std::llround(P0[v].x * inv), std::llround(P0[v].y * inv), std::llround(P0[v].z * inv)};
                auto it = map.find(k);
                if (it == map.end()) {
                    uint32_t g = static_cast<uint32_t>(groupPos.size());
                    map.emplace(k, g);
                    groupPos.push_back(P0[v]);
                    groupOf[v] = g;
                } else {
                    groupOf[v] = it->second;
                }
            }
            G = groupPos.size();
            S.weldGroups = G;
            triG.resize(F);
            for (size_t t = 0; t < F; ++t) triG[t] = {groupOf[tri[t][0]], groupOf[tri[t][1]], groupOf[tri[t][2]]};
            groupTriStart.assign(G + 1, 0);
            for (size_t t = 0; t < F; ++t) for (int k = 0; k < 3; ++k) groupTriStart[triG[t][k] + 1]++;
            for (size_t g = 0; g < G; ++g) groupTriStart[g + 1] += groupTriStart[g];
            groupTris.resize(groupTriStart[G]);
            std::vector<uint32_t> fill(groupTriStart.begin(), groupTriStart.end() - 1);
            for (size_t t = 0; t < F; ++t) for (int k = 0; k < 3; ++k) groupTris[fill[triG[t][k]]++] = static_cast<uint32_t>(t);
        }

        void buildRawComponents() {
            detail::UnionFind uf(V);
            for (size_t t = 0; t < F; ++t) { uf.unite(tri[t][0], tri[t][1]); uf.unite(tri[t][0], tri[t][2]); }
            triComponent.resize(F);
            std::unordered_map<uint32_t, uint32_t> ids;
            for (size_t t = 0; t < F; ++t) {
                uint32_t r = uf.find(tri[t][0]);
                auto it = ids.find(r);
                if (it == ids.end()) it = ids.emplace(r, static_cast<uint32_t>(ids.size())).first;
                triComponent[t] = it->second;
            }
            S.rawComponents = ids.size();
        }

        // ------------------------------------------------------------------
        // Origin of visibility ray k on triangle t: a rotated (base 3, base 5) low-discrepancy point
        // over the face, or one of three fixed interior points when spread origins are off.
        V3 rayOrigin(size_t t, int k, double s3, double s4) const {
            const V3 &a = P0[tri[t][0]], &b = P0[tri[t][1]], &c = P0[tri[t][2]];
            double w0, w1, w2;
            if (P.visibilitySpreadOrigins) {
                double r1 = std::fmod(detail::radicalInverse(3, static_cast<uint32_t>(k) + 1u) + s3, 1.0);
                double r2 = std::fmod(detail::radicalInverse(5, static_cast<uint32_t>(k) + 1u) + s4, 1.0);
                double su = std::sqrt(r1);
                w0 = 1.0 - su; w1 = su * (1.0 - r2); w2 = su * r2;
                const double m = std::clamp(P.visibilityOriginMargin, 0.0, 1.0);
                w0 = (1.0 - m) * w0 + m / 3.0; w1 = (1.0 - m) * w1 + m / 3.0; w2 = (1.0 - m) * w2 + m / 3.0;
            } else {
                const int j = k % 3;
                w0 = j == 0 ? 4.0 / 6.0 : 1.0 / 6.0; w1 = j == 1 ? 4.0 / 6.0 : 1.0 / 6.0; w2 = j == 2 ? 4.0 / 6.0 : 1.0 / 6.0;
            }
            return a * w0 + b * w1 + c * w2;
        }

        // ------------------------------------------------------------------
        // D2: escape-ray visibility. A triangle is exterior when any of `visibilityRays`
        // uniform-hemisphere rays from either side escapes (hits nothing within escapeDistance).
        void computeEscapeVisibility(const bvh::BvhTree& tree) {
            escape.assign(F, 1);
            if (!P.cullHidden) { S.escapeVisible = F; visible = escape; return; }
            const int K = std::max(1, P.visibilityRays);
            std::vector<std::array<double, 2>> hammersley(static_cast<size_t>(K));
            for (int k = 0; k < K; ++k) hammersley[static_cast<size_t>(k)] = {(k + 0.5) / K, detail::radicalInverse2(static_cast<uint32_t>(k))};
            const float escapeDist = static_cast<float>(P.escapeDistance);
            const double off = P.visibilityOffset;
            detail::parallelFor(F, threads, 256, [&](size_t b, size_t e, unsigned) {
                for (size_t t = b; t < e; ++t) {
                    if (triA0[t] < 1e-10) { escape[t] = 1; continue; }
                    const V3 n = triN0[t];
                    V3 tu, tv;
                    detail::orthonormalBasis(n, tu, tv);
                    uint64_t h = detail::mix64(P.seed ^ (static_cast<uint64_t>(t) * 0x9E3779B97F4A7C15ull));
                    const double s1 = detail::u01(h), s2 = detail::u01(detail::mix64(h));
                    const double s3 = detail::u01(detail::mix64(h ^ 0xA5A5A5A5u)), s4 = detail::u01(detail::mix64(h ^ 0x5A5A5A5Au));
                    bool esc = false;
                    for (int k = 0; k < K && !esc; ++k) {
                        double u1 = std::fmod(hammersley[static_cast<size_t>(k)][0] + s1, 1.0);
                        double u2 = std::fmod(hammersley[static_cast<size_t>(k)][1] + s2, 1.0);
                        // uniform solid-angle hemisphere: grazing directions (the only way out from under a
                        // canopy or from a deep canyon wall) are sampled as often as normal ones
                        double cz = std::max(1e-3, u1), sz = std::sqrt(std::max(0.0, 1.0 - cz * cz));
                        double phi = 2.0 * 3.14159265358979323846 * u2;
                        double lx = sz * std::cos(phi), ly = sz * std::sin(phi), lz = cz;
                        for (int side = 0; side < 2 && !esc; ++side) {
                            double sg = side == 0 ? 1.0 : -1.0;
                            V3 dir = tu * lx + tv * ly + n * (lz * sg);
                            V3 o = rayOrigin(t, k, s3, s4) + n * (off * sg);
                            math::Ray ray(math::Vec3(static_cast<float>(o.x), static_cast<float>(o.y), static_cast<float>(o.z)),
                                          math::Vec3(static_cast<float>(dir.x), static_cast<float>(dir.y), static_cast<float>(dir.z)));
                            if (!tree.raycastAny(ray, escapeDist)) esc = true;
                        }
                    }
                    escape[t] = esc ? 1 : 0;
                }
            });
            size_t ev = 0;
            for (size_t t = 0; t < F; ++t) ev += escape[t];
            S.escapeVisible = ev;
            visible = escape;
        }

        // ------------------------------------------------------------------
        // D2 (single-sided): the tile's materials are single-sided, so a viewer sees a face only from its
        // front and sees through every back face. A face escapes when one of its front-hemisphere rays (at
        // or above the horizon: nobody stands under the terrain) meets no triangle whose front faces back
        // along the ray.
        void applySingleSidedEscape() {
            if (!sided()) return;
            std::vector<uint32_t> todo;
            for (size_t t = 0; t < F; ++t) if (!escape[t] && triA0[t] >= 1e-10) todo.push_back(static_cast<uint32_t>(t));
            const int K = std::max(1, P.visibilityRays);
            std::vector<std::array<double, 2>> hammersley(static_cast<size_t>(K));
            for (int k = 0; k < K; ++k) hammersley[static_cast<size_t>(k)] = {(k + 0.5) / K, detail::radicalInverse2(static_cast<uint32_t>(k))};
            std::vector<uint8_t> esc(todo.size(), 0);
            detail::parallelFor(todo.size(), threads, 64, [&](size_t b, size_t e, unsigned) {
                for (size_t i = b; i < e; ++i) {
                    const size_t t = todo[i];
                    const V3 n = triN0[t];
                    V3 tu, tv;
                    detail::orthonormalBasis(n, tu, tv);
                    uint64_t h = detail::mix64(P.seed ^ (static_cast<uint64_t>(t) * 0x9E3779B97F4A7C15ull));
                    const double s1 = detail::u01(h), s2 = detail::u01(detail::mix64(h));
                    const double s3 = detail::u01(detail::mix64(h ^ 0xA5A5A5A5u)), s4 = detail::u01(detail::mix64(h ^ 0x5A5A5A5Au));
                    for (int k = 0; k < K; ++k) {
                        double u1 = std::fmod(hammersley[static_cast<size_t>(k)][0] + s1, 1.0);
                        double u2 = std::fmod(hammersley[static_cast<size_t>(k)][1] + s2, 1.0);
                        double cz = std::max(1e-3, u1), sz = std::sqrt(std::max(0.0, 1.0 - cz * cz));
                        double phi = 2.0 * 3.14159265358979323846 * u2;
                        const V3 dir = tu * (sz * std::cos(phi)) + tv * (sz * std::sin(phi)) + n * cz;
                        if (dir.y < -P.horizonSlack) continue;
                        const V3 o = rayOrigin(t, k, s3, s4) + n * P.visibilityOffset;
                        if (!sbvh.anyFront(o, dir, 1e-4, P.escapeDistance)) { esc[i] = 1; break; }
                    }
                }
            });
            size_t n = 0;
            for (size_t i = 0; i < todo.size(); ++i) if (esc[i]) { escape[todo[i]] = 1; visible[todo[i]] = 1; ++n; }
            S.singleSidedEscape = n;
        }

        /**
         * Single-sided reach: follows a descending front-hemisphere ray through back faces until it meets a
         * triangle whose front faces back along it (blocked) or lands, from above, on near-horizontal open
         * ground or an open-air walkable surface (seen).
         */
        bool singleSidedLands(const V3& o, const V3& dir) const {
            double tcur = 1e-4;
            for (int step = 0; step < 32; ++step) {
                double th;
                const int64_t j = sbvh.closest(o, dir, tcur, 1e30, th, [&](uint32_t q) {
                    const double nd = triN0[q].dot(dir);
                    return nd > 0 || (nd < 0 && std::abs(triN0[q].y) >= P.streetReachMinGroundNy);
                });
                if (j < 0) return false;
                if (triN0[static_cast<size_t>(j)].dot(dir) > 0) return false;
                const V3 land = o + dir * th;
                if ((groundReady && isOpenGround(land, static_cast<uint32_t>(j))) || isOutdoorWalkable(land, static_cast<uint32_t>(j))) return true;
                tcur = th + 1e-4;
            }
            return false;
        }

        // ------------------------------------------------------------------
        // Top surface of the whole scan at DSM resolution, with the |ny| of the triangle forming it.
        // Built from every triangle: an enclosed shell is never the top-most surface, so this equals
        // the visible top surface except where the escape test wrongly hid an open-air floor.
        void buildTopSurface() {
            top.init(bbMin.x, bbMin.z, bbMax.x, bbMax.z, P.dsmCell, -std::numeric_limits<float>::infinity());
            topNy.assign(top.v.size(), 0.0f);
            topTri.assign(top.v.size(), -1);
            size_t curTri = 0;
            auto put = [&](int i, int k, float y, float ny) {
                float& cell = top.at(i, k);
                if (y > cell) {
                    cell = y;
                    topNy[static_cast<size_t>(k) * top.nx + i] = ny;
                    topTri[static_cast<size_t>(k) * top.nx + i] = static_cast<int32_t>(curTri);
                }
            };
            for (size_t t = 0; t < F; ++t) {
                if (triA0[t] < 1e-10) continue;
                curTri = t;
                const V3 &a = P0[tri[t][0]], &b = P0[tri[t][1]], &c = P0[tri[t][2]];
                const float ny = static_cast<float>(std::abs(triN0[t].y));
                for (const V3* q : {&a, &b, &c}) {
                    int i = top.ix(q->x), k = top.iz(q->z);
                    if (top.inside(i, k)) put(i, k, static_cast<float>(q->y), ny);
                }
                double det = (b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z);
                if (std::abs(det) < 1e-9) continue;
                double minX = std::min({a.x, b.x, c.x}), maxX = std::max({a.x, b.x, c.x});
                double minZ = std::min({a.z, b.z, c.z}), maxZ = std::max({a.z, b.z, c.z});
                int i0 = std::max(0, static_cast<int>(std::ceil((minX - top.x0) / top.cell - 0.5)));
                int i1 = std::min(top.nx - 1, static_cast<int>(std::floor((maxX - top.x0) / top.cell - 0.5)));
                int k0 = std::max(0, static_cast<int>(std::ceil((minZ - top.z0) / top.cell - 0.5)));
                int k1 = std::min(top.nz - 1, static_cast<int>(std::floor((maxZ - top.z0) / top.cell - 0.5)));
                for (int k = k0; k <= k1; ++k) {
                    double z = top.cz(k);
                    for (int i = i0; i <= i1; ++i) {
                        double x = top.cx(i);
                        double l1 = ((b.x - x) * (c.z - z) - (c.x - x) * (b.z - z)) / det;
                        double l2 = ((c.x - x) * (a.z - z) - (a.x - x) * (c.z - z)) / det;
                        double l3 = 1.0 - l1 - l2;
                        if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
                        put(i, k, static_cast<float>(l1 * a.y + l2 * b.y + l3 * c.y), ny);
                    }
                }
            }
            bool any = false;
            for (auto& v : top.v) { if (std::isinf(v)) v = std::numeric_limits<float>::quiet_NaN(); else any = true; }
            topReady = any;
        }

        /** An open-air walkable top-surface cell: near-horizontal and flat over its 3x3 neighbourhood. */
        bool walkableCell(int i, int k) const {
            if (!topReady || !top.inside(i, k)) return false;
            const float h = top.at(i, k);
            if (std::isnan(h) || topNy[static_cast<size_t>(k) * top.nx + i] < P.streetReachMinGroundNy) return false;
            for (int dk = -1; dk <= 1; ++dk) for (int di = -1; di <= 1; ++di) {
                if (!top.inside(i + di, k + dk)) return false;
                const float q = top.at(i + di, k + dk);
                if (std::isnan(q) || std::abs(q - h) > P.outdoorFlatTolerance) return false;
            }
            return true;
        }

        /**
         * A ray that lands (from above, on a near-horizontal face) on the top surface of an open-air
         * walkable spot passed through the open air above it: someone standing there sees its origin.
         */
        bool isOutdoorWalkable(const V3& p, uint32_t hitTriangle) const {
            if (!P.outdoorReach || !topReady || hitTriangle >= F) return false;
            if (std::abs(triN0[hitTriangle].y) < P.streetReachMinGroundNy) return false;
            const int i = top.ix(p.x), k = top.iz(p.z);
            if (!top.inside(i, k)) return false;
            const float h = top.at(i, k);
            if (std::isnan(h) || std::abs(p.y - h) > P.outdoorTopTolerance) return false;
            for (int dk = -1; dk <= 1; ++dk) for (int di = -1; di <= 1; ++di) {
                if (!top.inside(i + di, k + dk)) return false;
                const float q = top.at(i + di, k + dk);
                if (std::isnan(q) || std::abs(q - p.y) > P.outdoorFlatTolerance) return false;
            }
            return true;
        }

        // ------------------------------------------------------------------
        // D3: DSM (max height) from a triangle subset, robust DTM by percentile + opening.
        void buildDsmAndGround(const std::vector<uint8_t>& use) {
            const float nan = std::numeric_limits<float>::quiet_NaN();
            dsm.init(bbMin.x, bbMin.z, bbMax.x, bbMax.z, P.dsmCell, -std::numeric_limits<float>::infinity());
            for (size_t t = 0; t < F; ++t) {
                if (!use[t]) continue;
                const V3 &a = P0[tri[t][0]], &b = P0[tri[t][1]], &c = P0[tri[t][2]];
                for (const V3* q : {&a, &b, &c}) {
                    int i = dsm.ix(q->x), k = dsm.iz(q->z);
                    if (dsm.inside(i, k)) dsm.at(i, k) = std::max(dsm.at(i, k), static_cast<float>(q->y));
                }
                double minX = std::min({a.x, b.x, c.x}), maxX = std::max({a.x, b.x, c.x});
                double minZ = std::min({a.z, b.z, c.z}), maxZ = std::max({a.z, b.z, c.z});
                double det = (b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z);
                if (std::abs(det) < 1e-9) continue;
                int i0 = std::max(0, static_cast<int>(std::ceil((minX - dsm.x0) / dsm.cell - 0.5)));
                int i1 = std::min(dsm.nx - 1, static_cast<int>(std::floor((maxX - dsm.x0) / dsm.cell - 0.5)));
                int k0 = std::max(0, static_cast<int>(std::ceil((minZ - dsm.z0) / dsm.cell - 0.5)));
                int k1 = std::min(dsm.nz - 1, static_cast<int>(std::floor((maxZ - dsm.z0) / dsm.cell - 0.5)));
                for (int k = k0; k <= k1; ++k) {
                    double z = dsm.cz(k);
                    for (int i = i0; i <= i1; ++i) {
                        double x = dsm.cx(i);
                        double l1 = ((b.x - x) * (c.z - z) - (c.x - x) * (b.z - z)) / det;
                        double l2 = ((c.x - x) * (a.z - z) - (a.x - x) * (c.z - z)) / det;
                        double l3 = 1.0 - l1 - l2;
                        if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
                        float y = static_cast<float>(l1 * a.y + l2 * b.y + l3 * c.y);
                        if (y > dsm.at(i, k)) dsm.at(i, k) = y;
                    }
                }
            }
            for (auto& v : dsm.v) if (std::isinf(v)) v = nan;

            // DTM: low percentile per coarse cell, morphological opening, hole filling, light smoothing.
            dtm.init(bbMin.x, bbMin.z, bbMax.x, bbMax.z, P.dtmCell, nan);
            std::vector<std::vector<float>> bucket(dtm.v.size());
            for (int k = 0; k < dsm.nz; ++k) {
                for (int i = 0; i < dsm.nx; ++i) {
                    float y = dsm.at(i, k);
                    if (std::isnan(y)) continue;
                    int ci = dtm.ix(dsm.cx(i)), ck = dtm.iz(dsm.cz(k));
                    if (dtm.inside(ci, ck)) bucket[static_cast<size_t>(ck) * dtm.nx + ci].push_back(y);
                }
            }
            for (size_t c = 0; c < bucket.size(); ++c) {
                auto& b = bucket[c];
                if (b.size() < 4) continue;
                size_t kth = static_cast<size_t>(std::floor(P.dtmPercentile * (b.size() - 1)));
                std::nth_element(b.begin(), b.begin() + static_cast<long>(kth), b.end());
                dtm.v[c] = b[kth];
            }
            int r = static_cast<int>(std::ceil(P.dtmOpeningRadius / P.dtmCell));
            detail::minMaxFilter(dtm, r, true);
            detail::minMaxFilter(dtm, r, false);
            bool any = false;
            for (float v : dtm.v) if (!std::isnan(v)) { any = true; break; }
            if (!any) { groundReady = false; return; }
            for (int pass = 0; pass < dtm.nx + dtm.nz; ++pass) {
                bool hole = false;
                std::vector<float> nv = dtm.v;
                for (int k = 0; k < dtm.nz; ++k) for (int i = 0; i < dtm.nx; ++i) {
                    if (!std::isnan(dtm.at(i, k))) continue;
                    double s = 0; int n = 0;
                    for (int dk = -1; dk <= 1; ++dk) for (int di = -1; di <= 1; ++di) {
                        if (!dtm.inside(i + di, k + dk)) continue;
                        float q = dtm.at(i + di, k + dk);
                        if (!std::isnan(q)) { s += q; ++n; }
                    }
                    if (n) nv[static_cast<size_t>(k) * dtm.nx + i] = static_cast<float>(s / n); else hole = true;
                }
                dtm.v.swap(nv);
                if (!hole) break;
            }
            {
                std::vector<float> nv = dtm.v;
                for (int k = 0; k < dtm.nz; ++k) for (int i = 0; i < dtm.nx; ++i) {
                    double s = 0; int n = 0;
                    for (int dk = -1; dk <= 1; ++dk) for (int di = -1; di <= 1; ++di) {
                        if (!dtm.inside(i + di, k + dk)) continue;
                        s += dtm.at(i + di, k + dk); ++n;
                    }
                    nv[static_cast<size_t>(k) * dtm.nx + i] = static_cast<float>(s / n);
                }
                dtm.v.swap(nv);
            }
            S.dtmMin = 1e300; S.dtmMax = -1e300;
            for (float v : dtm.v) { S.dtmMin = std::min<double>(S.dtmMin, v); S.dtmMax = std::max<double>(S.dtmMax, v); }
            groundReady = true;
            S.groundOk = true;
            S.groundAtAnchor = dtm.sample(P.anchorX, P.anchorZ);
        }

        double groundAt(double x, double z) const { return groundReady ? dtm.sample(x, z) : bbMin.y; }

        // ------------------------------------------------------------------
        // D2 guard (street reach): the sky-escape test hides faces that only a pedestrian can see,
        // such as sidewalk-shed fascias and soffits in deep street canyons. A face is exterior when
        // one of its rays (same directions as the escape test) first lands on open street ground:
        // that segment is unobstructed and passes through eye height above the street, so an
        // observer standing there sees the face. Open ground = a near-horizontal surface hit within
        // openGroundTolerance of the DTM whose 3x3 DSM neighbourhood is also within that tolerance
        // (so the foot of a wall, which shares a DSM cell with the street outside, never counts).
        bool isOpenGround(const V3& p, uint32_t hitTriangle) const {
            if (hitTriangle >= F || std::abs(triN0[hitTriangle].y) < P.streetReachMinGroundNy) return false;
            const int i = dsm.ix(p.x), k = dsm.iz(p.z);
            const double g = groundAt(p.x, p.z);
            if (std::abs(p.y - g) > P.openGroundTolerance) return false;
            for (int dk = -1; dk <= 1; ++dk) for (int di = -1; di <= 1; ++di) {
                if (!dsm.inside(i + di, k + dk)) return false;
                float top = dsm.at(i + di, k + dk);
                if (std::isnan(top) || top - groundAt(dsm.cx(i + di), dsm.cz(k + dk)) > P.openGroundTolerance) return false;
            }
            return true;
        }

        void applyStreetReachGuard(const bvh::BvhTree& tree) {
            if (!P.cullHidden || !P.streetReach || !(groundReady || topReady)) return;
            std::vector<uint32_t> todo;
            for (size_t t = 0; t < F; ++t) if (!visible[t] && triA0[t] >= 1e-10) todo.push_back(static_cast<uint32_t>(t));
            const int K = std::max(1, P.visibilityRays);
            std::vector<std::array<double, 2>> hammersley(static_cast<size_t>(K));
            for (int k = 0; k < K; ++k) hammersley[static_cast<size_t>(k)] = {(k + 0.5) / K, detail::radicalInverse2(static_cast<uint32_t>(k))};
            const double off = P.visibilityOffset;
            std::vector<uint8_t> reach(todo.size(), 0);
            detail::parallelFor(todo.size(), threads, 64, [&](size_t b, size_t e, unsigned) {
                for (size_t i = b; i < e; ++i) {
                    const size_t t = todo[i];
                    const V3 n = triN0[t];
                    V3 tu, tv;
                    detail::orthonormalBasis(n, tu, tv);
                    uint64_t h = detail::mix64(P.seed ^ (static_cast<uint64_t>(t) * 0x9E3779B97F4A7C15ull));
                    const double s1 = detail::u01(h), s2 = detail::u01(detail::mix64(h));
                    const double s3 = detail::u01(detail::mix64(h ^ 0xA5A5A5A5u)), s4 = detail::u01(detail::mix64(h ^ 0x5A5A5A5Au));
                    uint8_t hitGround = 0;
                    for (int k = 0; k < K && !hitGround; ++k) {
                        double u1 = std::fmod(hammersley[static_cast<size_t>(k)][0] + s1, 1.0);
                        double u2 = std::fmod(hammersley[static_cast<size_t>(k)][1] + s2, 1.0);
                        double cz = std::max(1e-3, u1), sz = std::sqrt(std::max(0.0, 1.0 - cz * cz));
                        double phi = 2.0 * 3.14159265358979323846 * u2;
                        double lx = sz * std::cos(phi), ly = sz * std::sin(phi), lz = cz;
                        for (int side = 0; side < 2 && !hitGround; ++side) {
                            double sg = side == 0 ? 1.0 : -1.0;
                            V3 dir = tu * lx + tv * ly + n * (lz * sg);
                            if (dir.y >= 0) continue;  // only descending rays can land on the street
                            V3 o = rayOrigin(t, k, s3, s4) + n * (off * sg);
                            math::Ray ray(math::Vec3(static_cast<float>(o.x), static_cast<float>(o.y), static_cast<float>(o.z)),
                                          math::Vec3(static_cast<float>(dir.x), static_cast<float>(dir.y), static_cast<float>(dir.z)));
                            bvh::RayHit hit;
                            if (!tree.raycast(ray, hit) || !hit.hit) continue;
                            const V3 land = o + dir * static_cast<double>(hit.t);
                            if (groundReady && isOpenGround(land, hit.triangleIndex)) hitGround = 1;
                            else if (isOutdoorWalkable(land, hit.triangleIndex)) hitGround = 2;
                        }
                    }
                    if (!hitGround && sided()) {
                        for (int k = 0; k < K && !hitGround; ++k) {
                            double u1 = std::fmod(hammersley[static_cast<size_t>(k)][0] + s1, 1.0);
                            double u2 = std::fmod(hammersley[static_cast<size_t>(k)][1] + s2, 1.0);
                            double cz = std::max(1e-3, u1), sz = std::sqrt(std::max(0.0, 1.0 - cz * cz));
                            double phi = 2.0 * 3.14159265358979323846 * u2;
                            const V3 dir = tu * (sz * std::cos(phi)) + tv * (sz * std::sin(phi)) + n * cz;
                            if (dir.y >= 0) continue;
                            if (singleSidedLands(rayOrigin(t, k, s3, s4) + n * off, dir)) hitGround = 3;
                        }
                    }
                    reach[i] = hitGround;
                }
            });
            size_t rescued = 0, outdoor = 0, single = 0;
            for (size_t i = 0; i < todo.size(); ++i) {
                if (!reach[i]) continue;
                visible[todo[i]] = 1;
                if (reach[i] == 1) ++rescued; else if (reach[i] == 2) ++outdoor; else ++single;
            }
            S.streetReachRescued = rescued;
            S.outdoorReachRescued = outdoor;
            S.singleSidedReach = single;
        }

        // ------------------------------------------------------------------
        // D2 guard (sight lines): viewer sites on every open-air walkable surface (streets, courts,
        // plazas, flat roofs; one per outdoorSiteSpacing block, eye at outdoorEyeHeight). A face
        // still flagged hidden is exterior when an unobstructed segment joins a point on it to a site
        // in front of it. Sites are tested nearest first, a fixed number per distance ring spread in
        // azimuth, so deep courts and far plazas are both reached at a bounded cost.
        void applySightLineGuard(const bvh::BvhTree& tree) {
            if (!P.cullHidden || P.rigCameras <= 0 || P.outdoorSiteSpacing <= 0 || !topReady) return;
            std::vector<V3> sites;
            const int bs = std::max(1, static_cast<int>(std::lround(P.outdoorSiteSpacing / top.cell)));
            for (int bk = 0; bk < top.nz; bk += bs) {
                for (int bi = 0; bi < top.nx; bi += bs) {
                    int besti = -1, bestk = -1;
                    double bestD = 1e300;
                    const double cxB = top.x0 + (bi + 0.5 * bs) * top.cell, czB = top.z0 + (bk + 0.5 * bs) * top.cell;
                    for (int k = bk; k < std::min(top.nz, bk + bs); ++k) {
                        for (int i = bi; i < std::min(top.nx, bi + bs); ++i) {
                            const double x = top.cx(i), z = top.cz(k);
                            if (x < bbMin.x + P.rigStreetMargin || x > bbMax.x - P.rigStreetMargin) continue;
                            if (z < bbMin.z + P.rigStreetMargin || z > bbMax.z - P.rigStreetMargin) continue;
                            if (!walkableCell(i, k)) continue;
                            const double d = (x - cxB) * (x - cxB) + (z - czB) * (z - czB);
                            if (d < bestD) { bestD = d; besti = i; bestk = k; }
                        }
                    }
                    if (besti >= 0) sites.push_back(V3{top.cx(besti), top.at(besti, bestk) + P.outdoorEyeHeight, top.cz(bestk)});
                }
            }
            S.outdoorSites = sites.size();
            siteEyes.clear();
            for (const auto& q : sites) siteEyes.push_back({q.x, q.y, q.z});
            if (sites.empty()) return;
            // 2D hash of sites
            const double hc = std::max(10.0, P.outdoorSiteRange / 8.0);
            std::unordered_map<int64_t, std::vector<uint32_t>, detail::CellKeyHash> hash;
            auto hk = [&](double x, double z) { return detail::cellKey(static_cast<int64_t>(std::floor(x / hc)), 0, static_cast<int64_t>(std::floor(z / hc))); };
            for (uint32_t s = 0; s < sites.size(); ++s) hash[hk(sites[s].x, sites[s].z)].push_back(s);
            std::vector<uint32_t> todo;
            for (size_t t = 0; t < F; ++t) if (!visible[t] && triA0[t] >= 1e-6) todo.push_back(static_cast<uint32_t>(t));
            const double ringEdges[6] = {0.0, 12.0, 25.0, 50.0, 100.0, 1e300};
            const int nRings = 5;
            const int perRing = std::max(1, P.outdoorSitesPerRing);
            const double off = P.visibilityOffset;
            std::vector<uint8_t> seenBy(todo.size(), 0);
            detail::parallelFor(todo.size(), threads, 16, [&](size_t b, size_t e, unsigned) {
                std::vector<std::pair<double, uint32_t>> near;
                std::vector<std::vector<std::pair<double, uint32_t>>> rings(static_cast<size_t>(nRings));
                std::vector<uint32_t> chosen;
                for (size_t i = b; i < e; ++i) {
                    const size_t t = todo[i];
                    const V3 c = triC0[t], n = triN0[t];
                    double rad = 0;
                    for (int q = 0; q < 3; ++q) rad = std::max(rad, (P0[tri[t][q]] - c).norm());
                    const double R = P.outdoorSiteRange + rad;
                    uint64_t h = detail::mix64(P.seed ^ 0x51u ^ (static_cast<uint64_t>(t) * 0x9E3779B97F4A7C15ull));
                    const double s3 = detail::u01(h), s4 = detail::u01(detail::mix64(h));
                    const int ns = std::clamp(static_cast<int>(std::ceil(triA0[t] / std::max(1e-6, P.outdoorSampleArea))), P.outdoorMinSamples, P.outdoorMaxSamples);
                    bool vis = false;
                    for (int side = 0; side < 2 && !vis; ++side) {
                        const double sg = side == 0 ? 1.0 : -1.0;
                        for (auto& r : rings) r.clear();
                        const int64_t x0 = static_cast<int64_t>(std::floor((c.x - R) / hc)), x1 = static_cast<int64_t>(std::floor((c.x + R) / hc));
                        const int64_t z0 = static_cast<int64_t>(std::floor((c.z - R) / hc)), z1 = static_cast<int64_t>(std::floor((c.z + R) / hc));
                        for (int64_t gx = x0; gx <= x1; ++gx) for (int64_t gz = z0; gz <= z1; ++gz) {
                            auto it = hash.find(detail::cellKey(gx, 0, gz));
                            if (it == hash.end()) continue;
                            for (uint32_t s : it->second) {
                                const V3 v = sites[s] - c;
                                const double dh = std::sqrt(v.x * v.x + v.z * v.z);
                                if (dh > R || v.dot(n) * sg <= 0) continue;
                                int ring = 0;
                                while (ring + 1 < nRings && dh >= ringEdges[ring + 1]) ++ring;
                                rings[static_cast<size_t>(ring)].push_back({std::atan2(v.z, v.x), s});
                            }
                        }
                        chosen.clear();
                        size_t nearCount = 0;  // the first ring's sites are tried from every origin
                        for (int ri = 0; ri < nRings; ++ri) {
                            auto& r = rings[static_cast<size_t>(ri)];
                            if (r.empty()) continue;
                            std::sort(r.begin(), r.end());
                            const size_t m = r.size();
                            if (ri == 0) nearCount = m;
                            if (ringEdges[ri + 1] <= P.outdoorExhaustiveRadius || m <= static_cast<size_t>(perRing)) { for (auto& pr : r) chosen.push_back(pr.second); continue; }
                            for (int j = 0; j < perRing; ++j) chosen.push_back(r[(static_cast<size_t>(j) * m) / static_cast<size_t>(perRing)].second);
                        }
                        const int perFar = std::max(1, std::min(ns, P.outdoorSamplesPerSite));
                        for (size_t ci = 0; ci < chosen.size() && !vis; ++ci) {
                            const uint32_t s = chosen[ci];
                            const int per = ci < nearCount ? ns : perFar;
                            const int stride = std::max(1, ns / per);
                            for (int q = 0; q < per && !vis; ++q) {
                                const int k = static_cast<int>((ci * 7 + static_cast<size_t>(q * stride)) % static_cast<size_t>(ns));
                                const V3 o = rayOrigin(t, k, s3, s4) + n * (off * sg);
                                V3 v = sites[s] - o;
                                if (v.dot(n) * sg <= 0) continue;
                                const double dist = v.norm();
                                if (dist < 0.1) continue;
                                const V3 dir = v * (1.0 / dist);
                                math::Ray ray(math::Vec3(static_cast<float>(o.x), static_cast<float>(o.y), static_cast<float>(o.z)),
                                              math::Vec3(static_cast<float>(dir.x), static_cast<float>(dir.y), static_cast<float>(dir.z)));
                                if (!tree.raycastAny(ray, static_cast<float>(dist - 0.05))) { vis = true; break; }
                                // single-sided: the front side is seen through back faces
                                if (sg > 0 && sided() && !sbvh.anyFront(o, dir, 1e-4, dist - 0.05)) { vis = true; break; }
                            }
                        }
                    }
                    seenBy[i] = vis ? 1 : 0;
                }
            });
            size_t rescued = 0;
            for (size_t i = 0; i < todo.size(); ++i) if (seenBy[i]) { visible[todo[i]] = 1; ++rescued; }
            S.sightLineRescued = rescued;
        }

        // ------------------------------------------------------------------
        // D2 guard: a camera rig (aerial rings + street-level panoramas) marks every triangle it
        // sees directly as visible, rescuing deep-canyon faces the escape test can miss.
        void applyRigGuard(const bvh::BvhTree& tree) {
            if (!P.cullHidden || P.rigCameras <= 0) return;
            struct Cam { V3 pos; bool pano; V3 fwd, right, up; };
            std::vector<Cam> cams;
            const int aerial = std::max(0, P.rigCameras / 3);
            const int street = std::max(0, P.rigCameras - aerial);
            V3 c = (bbMin + bbMax) * 0.5;
            double R = 0.5 * (bbMax - bbMin).norm();
            double fovHalf = detail::degToRad(P.rigAerialFovDeg * 0.5);
            double dist = R / std::sin(fovHalf) * 1.02;
            const double ringElev[3] = {28.0, 52.0, 76.0};
            int perRing[3] = {aerial - 2 * (aerial / 3), aerial / 3, aerial / 3};
            for (int ring = 0; ring < 3; ++ring) {
                for (int j = 0; j < perRing[ring]; ++j) {
                    double az = 2.0 * 3.14159265358979323846 * (j + 0.5 * ring) / std::max(1, perRing[ring]);
                    double el = detail::degToRad(ringElev[ring]);
                    V3 dir{std::cos(el) * std::cos(az), std::sin(el), std::cos(el) * std::sin(az)};
                    Cam cam;
                    cam.pos = c + dir * dist;
                    cam.pano = false;
                    cam.fwd = (c - cam.pos).normalized();
                    cam.right = cam.fwd.cross(V3{0, 1, 0}).normalized();
                    cam.up = cam.right.cross(cam.fwd);
                    cams.push_back(cam);
                }
            }
            // street sites: open-ground DSM cells, farthest-point sampled from the anchor outward
            std::vector<std::pair<int, int>> open;
            if (groundReady) {
                for (int k = 0; k < dsm.nz; ++k) for (int i = 0; i < dsm.nx; ++i) {
                    float y = dsm.at(i, k);
                    if (std::isnan(y)) continue;
                    double x = dsm.cx(i), z = dsm.cz(k);
                    if (x < bbMin.x + P.rigStreetMargin || x > bbMax.x - P.rigStreetMargin) continue;
                    if (z < bbMin.z + P.rigStreetMargin || z > bbMax.z - P.rigStreetMargin) continue;
                    if (std::abs(y - groundAt(x, z)) > P.openGroundTolerance) continue;
                    // require a 3x3 neighbourhood of open ground so the eye is not against a wall
                    bool ok = true;
                    for (int dk = -1; dk <= 1 && ok; ++dk) for (int di = -1; di <= 1 && ok; ++di) {
                        if (!dsm.inside(i + di, k + dk)) { ok = false; break; }
                        float q = dsm.at(i + di, k + dk);
                        if (std::isnan(q) || std::abs(q - groundAt(dsm.cx(i + di), dsm.cz(k + dk))) > P.openGroundTolerance) ok = false;
                    }
                    if (ok) open.push_back({i, k});
                }
            }
            if (!open.empty() && street > 0) {
                std::vector<double> best(open.size(), 1e300);
                size_t cur = 0;
                double bd = 1e300;
                for (size_t j = 0; j < open.size(); ++j) {
                    double dx = dsm.cx(open[j].first) - P.anchorX, dz = dsm.cz(open[j].second) - P.anchorZ;
                    double d2 = dx * dx + dz * dz;
                    if (d2 < bd) { bd = d2; cur = j; }
                }
                for (int s = 0; s < street; ++s) {
                    int i = open[cur].first, k = open[cur].second;
                    double eye = street > 1 ? P.rigStreetEyeMin + (P.rigStreetEyeMax - P.rigStreetEyeMin) * (s % 2) : P.rigStreetEyeMin;
                    Cam cam;
                    cam.pos = V3{dsm.cx(i), dsm.at(i, k) + eye, dsm.cz(k)};
                    cam.pano = true;
                    cams.push_back(cam);
                    S.rigStreetSites.push_back({cam.pos.x, cam.pos.y, cam.pos.z});
                    double far = -1;
                    size_t nxt = cur;
                    for (size_t j = 0; j < open.size(); ++j) {
                        double dx = dsm.cx(open[j].first) - cam.pos.x, dz = dsm.cz(open[j].second) - cam.pos.z;
                        best[j] = std::min(best[j], dx * dx + dz * dz);
                        if (best[j] > far) { far = best[j]; nxt = j; }
                    }
                    if (far <= 0) break;
                    cur = nxt;
                }
            }
            S.rigAerialCameras = 0;
            S.rigStreetCameras = 0;
            for (const auto& cam : cams) (cam.pano ? S.rigStreetCameras : S.rigAerialCameras)++;

            // rows of all cameras form one work list
            struct Row { uint32_t cam; uint32_t row; };
            std::vector<Row> rows;
            for (uint32_t ci = 0; ci < cams.size(); ++ci) {
                uint32_t H = cams[ci].pano ? static_cast<uint32_t>(P.rigStreetWidth / 2) : static_cast<uint32_t>(P.rigAerialResolution);
                for (uint32_t r = 0; r < H; ++r) rows.push_back({ci, r});
            }
            std::vector<std::vector<uint8_t>> seen(threads, std::vector<uint8_t>(F, 0));
            const double tanHalf = std::tan(fovHalf);
            detail::parallelFor(rows.size(), threads, 4, [&](size_t b, size_t e, unsigned th) {
                auto& mark = seen[th];
                for (size_t ri = b; ri < e; ++ri) {
                    const Cam& cam = cams[rows[ri].cam];
                    uint32_t r = rows[ri].row;
                    int W = cam.pano ? P.rigStreetWidth : P.rigAerialResolution;
                    int H = cam.pano ? P.rigStreetWidth / 2 : P.rigAerialResolution;
                    for (int col = 0; col < W; ++col) {
                        V3 dir;
                        if (cam.pano) {
                            double phi = 2.0 * 3.14159265358979323846 * (col + 0.5) / W;
                            double theta = 3.14159265358979323846 * (r + 0.5) / H;
                            dir = V3{std::sin(theta) * std::cos(phi), std::cos(theta), std::sin(theta) * std::sin(phi)};
                        } else {
                            double sx = (2.0 * (col + 0.5) / W - 1.0) * tanHalf;
                            double sy = (1.0 - 2.0 * (r + 0.5) / H) * tanHalf;
                            dir = (cam.fwd + cam.right * sx + cam.up * sy).normalized();
                        }
                        math::Ray ray(math::Vec3(static_cast<float>(cam.pos.x), static_cast<float>(cam.pos.y), static_cast<float>(cam.pos.z)),
                                      math::Vec3(static_cast<float>(dir.x), static_cast<float>(dir.y), static_cast<float>(dir.z)));
                        bvh::RayHit hit;
                        if (tree.raycast(ray, hit) && hit.hit) mark[hit.triangleIndex] = 1;
                        if (sided()) {
                            // a back-face-culling camera sees the nearest triangle whose front faces it
                            double th;
                            const int64_t j = sbvh.closest(cam.pos, dir, 1e-4, 1e30, th, [&](uint32_t q) { return triN0[q].dot(dir) < 0; });
                            if (j >= 0) mark[static_cast<size_t>(j)] = 1;
                        }
                    }
                }
            });
            size_t rescued = 0;
            for (size_t t = 0; t < F; ++t) {
                if (visible[t]) continue;
                for (unsigned th = 0; th < threads; ++th) if (seen[th][t]) { visible[t] = 1; ++rescued; break; }
            }
            S.rigRescued = rescued;
        }

        // D2 guard (nadir): the triangle forming the top of the whole scan in a DSM cell has open air above it
        // up to the sky, so a viewer straight above sees it (the floor or a cap inside a roofless enclosure
        // whose opening is too narrow for the hemisphere rays to find).
        void applyNadirGuard() {
            if (!P.cullHidden || !P.nadirGuard || !topReady) return;
            size_t rescued = 0;
            for (size_t c = 0; c < topTri.size(); ++c) {
                const int32_t t = topTri[c];
                // (a face is culled only when hidden under both rules; the two-sided rule sees it from above)
                if (t < 0 || visible[static_cast<size_t>(t)]) continue;
                visible[static_cast<size_t>(t)] = 1;
                ++rescued;
            }
            S.nadirRescued = rescued;
        }

        // Every triangle no visibility test reached is flagged hidden (runs with or without the rig).
        void finalizeHiddenFlags() {
            if (!P.cullHidden) return;
            size_t hidden = 0;
            double ha = 0;
            for (size_t t = 0; t < F; ++t) {
                if (!visible[t]) { flags[t] = kFlagHidden; ++hidden; ha += triA0[t]; }
            }
            S.hiddenTriangles = hidden;
            S.hiddenArea = ha;
        }

        // ------------------------------------------------------------------
        void buildFootprints() {
            footprintLabel.assign(dsm.v.size(), -1);
            if (!groundReady) return;
            auto labelMask = [&](double minHeight, std::vector<int32_t>& lab) -> int32_t {
                lab.assign(dsm.v.size(), -1);
                int32_t next = 0;
                std::vector<int> stack;
                for (int k = 0; k < dsm.nz; ++k) for (int i = 0; i < dsm.nx; ++i) {
                    size_t id = static_cast<size_t>(k) * dsm.nx + i;
                    if (lab[id] >= 0) continue;
                    float y = dsm.v[id];
                    if (std::isnan(y) || y - groundAt(dsm.cx(i), dsm.cz(k)) <= minHeight) continue;
                    lab[id] = next;
                    stack.assign(1, static_cast<int>(id));
                    while (!stack.empty()) {
                        int cur = stack.back(); stack.pop_back();
                        int ci = cur % dsm.nx, ck = cur / dsm.nx;
                        const int di[4] = {1, -1, 0, 0}, dk[4] = {0, 0, 1, -1};
                        for (int q = 0; q < 4; ++q) {
                            int ni = ci + di[q], nk = ck + dk[q];
                            if (!dsm.inside(ni, nk)) continue;
                            size_t nid = static_cast<size_t>(nk) * dsm.nx + ni;
                            if (lab[nid] >= 0) continue;
                            float ny = dsm.v[nid];
                            if (std::isnan(ny) || ny - groundAt(dsm.cx(ni), dsm.cz(nk)) <= minHeight) continue;
                            lab[nid] = next;
                            stack.push_back(static_cast<int>(nid));
                        }
                    }
                    ++next;
                }
                return next;
            };
            S.footprints = static_cast<size_t>(labelMask(P.footprintMinHeight, footprintLabel));

            // hero: component above heroMinHeight containing (or nearest to) the anchor
            std::vector<int32_t> heroLab;
            labelMask(P.heroMinHeight, heroLab);
            int ai = dsm.ix(P.anchorX), ak = dsm.iz(P.anchorZ);
            int32_t hero = -1;
            double bestD = 1e300;
            int searchR = static_cast<int>(std::ceil(30.0 / dsm.cell));
            for (int dk = -searchR; dk <= searchR; ++dk) for (int di = -searchR; di <= searchR; ++di) {
                int i = ai + di, k = ak + dk;
                if (!dsm.inside(i, k)) continue;
                int32_t l = heroLab[static_cast<size_t>(k) * dsm.nx + i];
                if (l < 0) continue;
                double d2 = static_cast<double>(di) * di + static_cast<double>(dk) * dk;
                if (d2 < bestD) { bestD = d2; hero = l; }
            }
            if (hero >= 0) {
                S.heroFound = true;
                S.heroMinX = S.heroMinZ = 1e300; S.heroMaxX = S.heroMaxZ = -1e300;
                size_t cells = 0;
                for (int k = 0; k < dsm.nz; ++k) for (int i = 0; i < dsm.nx; ++i) {
                    size_t id = static_cast<size_t>(k) * dsm.nx + i;
                    if (heroLab[id] != hero) continue;
                    ++cells;
                    double x = dsm.cx(i), z = dsm.cz(k);
                    S.heroMinX = std::min(S.heroMinX, x); S.heroMaxX = std::max(S.heroMaxX, x);
                    S.heroMinZ = std::min(S.heroMinZ, z); S.heroMaxZ = std::max(S.heroMaxZ, z);
                    S.heroMaxHeight = std::max<double>(S.heroMaxHeight, dsm.v[id] - groundAt(x, z));
                }
                S.heroArea = cells * dsm.cell * dsm.cell;
                // the hero's footprint label in the 3 m mask (for its tier peaks)
                heroFootprint = footprintAt(0.5 * (S.heroMinX + S.heroMaxX), 0.5 * (S.heroMinZ + S.heroMaxZ));
                if (heroFootprint < 0) {
                    for (int k = 0; k < dsm.nz && heroFootprint < 0; ++k) for (int i = 0; i < dsm.nx; ++i) {
                        size_t id = static_cast<size_t>(k) * dsm.nx + i;
                        if (heroLab[id] == hero && footprintLabel[id] >= 0) { heroFootprint = footprintLabel[id]; break; }
                    }
                }
            }

            // local ground plane around the anchor (reporting only): IRLS Huber on open-ground cells
            std::vector<std::array<double, 3>> pts;
            for (int k = 0; k < dsm.nz; ++k) for (int i = 0; i < dsm.nx; ++i) {
                float y = dsm.at(i, k);
                if (std::isnan(y)) continue;
                double x = dsm.cx(i), z = dsm.cz(k);
                double dx = x - P.anchorX, dz = z - P.anchorZ;
                if (dx * dx + dz * dz > P.groundPlaneRadius * P.groundPlaneRadius) continue;
                if (std::abs(y - groundAt(x, z)) > 0.5) continue;
                pts.push_back({dx, static_cast<double>(y), dz});
            }
            S.groundPlaneSamples = pts.size();
            if (pts.size() >= 16) {
                double a = 0, bx = 0, bz = 0;
                std::vector<double> w(pts.size(), 1.0);
                for (int it = 0; it < 30; ++it) {
                    double M[3][3] = {{0, 0, 0}, {0, 0, 0}, {0, 0, 0}}, rhs[3] = {0, 0, 0};
                    for (size_t j = 0; j < pts.size(); ++j) {
                        double row[3] = {1.0, pts[j][0], pts[j][2]};
                        for (int r = 0; r < 3; ++r) { rhs[r] += w[j] * row[r] * pts[j][1]; for (int s = 0; s < 3; ++s) M[r][s] += w[j] * row[r] * row[s]; }
                    }
                    double x[3];
                    if (!detail::solveSmall(3, M, rhs, x)) break;
                    a = x[0]; bx = x[1]; bz = x[2];
                    for (size_t j = 0; j < pts.size(); ++j) {
                        double r = std::abs(pts[j][1] - (a + bx * pts[j][0] + bz * pts[j][2]));
                        w[j] = r <= P.groundHuber ? 1.0 : P.groundHuber / r;
                    }
                }
                S.groundPlaneA = a; S.groundPlaneBx = bx; S.groundPlaneBz = bz;
            }
        }
        int32_t heroFootprint{-1};

        int32_t footprintAt(double x, double z) const {
            if (footprintLabel.empty()) return -1;
            int i = dsm.ix(x), k = dsm.iz(z);
            if (!dsm.inside(i, k)) return -1;
            return footprintLabel[static_cast<size_t>(k) * dsm.nx + i];
        }

        // ------------------------------------------------------------------
        // D4: orientation families (every significant peak, never only the global one)
        void detectFamilies() {
            const int nb = std::max(4, static_cast<int>(std::lround(90.0 / P.familyBinDeg)));
            const double bw = 90.0 / nb;
            std::vector<double> h(static_cast<size_t>(nb), 0.0);
            std::vector<std::pair<double, double>> samples;  // (az mod 90, area)
            for (size_t t = 0; t < F; ++t) {
                if (!visible[t] || triA0[t] < P.familyMinArea) continue;
                const V3& n = triN0[t];
                if (std::abs(n.y) >= P.familyMaxAbsNy) continue;
                double az = detail::wrapPeriod(detail::radToDeg(std::atan2(n.z, n.x)), 90.0);
                samples.push_back({az, triA0[t]});
                int b = std::min(nb - 1, static_cast<int>(az / bw));
                h[static_cast<size_t>(b)] += triA0[t];
            }
            if (samples.empty()) return;
            std::vector<double> hs(static_cast<size_t>(nb), 0.0);
            int half = P.familySmoothBins / 2;
            for (int i = 0; i < nb; ++i) {
                double s = 0;
                for (int j = -half; j <= half; ++j) s += h[static_cast<size_t>((i + j + nb) % nb)];
                hs[static_cast<size_t>(i)] = s / (2 * half + 1);
            }
            double mx = *std::max_element(hs.begin(), hs.end());
            std::vector<std::pair<double, int>> peaks;
            for (int i = 0; i < nb; ++i) {
                double c = hs[static_cast<size_t>(i)];
                double l = hs[static_cast<size_t>((i - 1 + nb) % nb)], r = hs[static_cast<size_t>((i + 1) % nb)];
                if (c >= P.familyMinRatio * mx && c > l && c >= r) peaks.push_back({c, i});
            }
            std::sort(peaks.begin(), peaks.end(), [](auto& a, auto& b) { return a.first > b.first; });
            std::vector<double> chosen;
            for (auto& pk : peaks) {
                double centre = (pk.second + 0.5) * bw;
                bool farEnough = true;
                for (double c : chosen) if (std::abs(detail::wrapDiff(centre, c, 90.0)) < P.familyMinSeparationDeg) farEnough = false;
                if (!farEnough) continue;
                chosen.push_back(centre);
            }
            for (double centre : chosen) {
                double ss = 0, cs = 0, wsum = 0;
                for (auto& s : samples) {
                    double d = detail::wrapDiff(s.first, centre, 90.0);
                    if (std::abs(d) >= P.familyRefineDeg) continue;
                    ss += s.second * std::sin(detail::degToRad(4 * d));
                    cs += s.second * std::cos(detail::degToRad(4 * d));
                    wsum += s.second;
                }
                double ref = centre + detail::radToDeg(std::atan2(ss, cs)) / 4.0;
                families.push_back({detail::wrapPeriod(ref, 90.0), wsum});
            }
            S.families = families;
        }

        // ------------------------------------------------------------------
        // D5: spatial plane regions (clustered by proximity, not mesh adjacency)
        void buildRegions() {
            std::vector<int8_t> cls(F, -1);
            for (size_t t = 0; t < F; ++t) {
                if (!visible[t] || triA0[t] < 1e-6) continue;
                const V3& n = triN0[t];
                if (std::abs(n.y) < P.wallMaxAbsNy) { cls[t] = 0; ++S.wallCandidates; }
                else if (n.y > P.roofMinNy) { cls[t] = 1; ++S.roofCandidates; }
            }
            // azimuth bin for walls (normal agreement pre-filter)
            const double binDeg = std::max(1.0, P.normalAgreementDeg);
            const int azBins = std::max(1, static_cast<int>(std::floor(360.0 / binDeg)));
            std::vector<int> bin(F, 0);
            std::vector<V3> lo(F), hi(F);
            const double g = P.regionAabbGrow;
            for (size_t t = 0; t < F; ++t) {
                if (cls[t] < 0) continue;
                if (cls[t] == 0) {
                    double az = detail::wrapPeriod(detail::radToDeg(std::atan2(triN0[t].z, triN0[t].x)), 360.0);
                    bin[t] = std::min(azBins - 1, static_cast<int>(az / (360.0 / azBins)));
                }
                const V3 &a = P0[tri[t][0]], &b = P0[tri[t][1]], &c = P0[tri[t][2]];
                lo[t] = V3{std::min({a.x, b.x, c.x}) - g, std::min({a.y, b.y, c.y}) - g, std::min({a.z, b.z, c.z}) - g};
                hi[t] = V3{std::max({a.x, b.x, c.x}) + g, std::max({a.y, b.y, c.y}) + g, std::max({a.z, b.z, c.z}) + g};
            }
            const double cell = P.regionHashCell;
            auto ci = [&](double v) { return static_cast<int64_t>(std::floor(v / cell)); };
            // key: (cell, class, bin)
            auto key4 = [&](int64_t x, int64_t y, int64_t z, int c, int b) {
                return static_cast<int64_t>(detail::mix64(static_cast<uint64_t>(detail::cellKey(x, y, z)) ^ (static_cast<uint64_t>(c * 1024 + b) << 56) ^ static_cast<uint64_t>(c * 1024 + b)));
            };
            // the grid as a flat, key-sorted array of (key, triangle) built by threads over triangle blocks; a stable sort
            // keeps every cell's triangles in ascending order
            std::vector<std::pair<int64_t, uint32_t>> cellTris;
            {
                constexpr size_t kBlock = 4096;
                std::vector<std::vector<std::pair<int64_t, uint32_t>>> blocks((F + kBlock - 1) / kBlock);
                detail::parallelFor(blocks.size(), threads, 1, [&](size_t b0, size_t b1, unsigned) {
                    for (size_t bi = b0; bi < b1; ++bi)
                        for (size_t t = bi * kBlock; t < std::min(F, (bi + 1) * kBlock); ++t) {
                            if (cls[t] < 0) continue;
                            for (int64_t x = ci(lo[t].x); x <= ci(hi[t].x); ++x)
                                for (int64_t y = ci(lo[t].y); y <= ci(hi[t].y); ++y)
                                    for (int64_t z = ci(lo[t].z); z <= ci(hi[t].z); ++z) blocks[bi].push_back({key4(x, y, z, cls[t], bin[t]), static_cast<uint32_t>(t)});
                        }
                });
                size_t total = 0;
                for (const auto& b : blocks) total += b.size();
                cellTris.reserve(total);
                for (auto& b : blocks) { cellTris.insert(cellTris.end(), b.begin(), b.end()); std::vector<std::pair<int64_t, uint32_t>>().swap(b); }
                std::stable_sort(cellTris.begin(), cellTris.end(), [](const auto& x, const auto& y) { return x.first < y.first; });
            }
            struct Span { uint32_t b, e; };
            std::unordered_map<int64_t, Span, detail::CellKeyHash> grid;
            grid.reserve(cellTris.size() / 4 + 16);
            for (size_t k = 0; k < cellTris.size();) {
                size_t e = k;
                while (e < cellTris.size() && cellTris[e].first == cellTris[k].first) ++e;
                grid.emplace(cellTris[k].first, Span{static_cast<uint32_t>(k), static_cast<uint32_t>(e)});
                k = e;
            }
            const double cosAgree = std::cos(detail::degToRad(P.normalAgreementDeg));
            detail::UnionFind uf(F);
            std::vector<std::vector<std::pair<uint32_t, uint32_t>>> pairsPerThread(threads);
            detail::parallelFor(F, threads, 512, [&](size_t b0, size_t e0, unsigned th) {
                auto& out = pairsPerThread[th];
                for (size_t ti = b0; ti < e0; ++ti) {
                    if (cls[ti] < 0) continue;
                    const uint32_t i = static_cast<uint32_t>(ti);
                    int binsToCheck[3] = {bin[i], bin[i], bin[i]};
                    int nbins = 1;
                    if (cls[i] == 0 && azBins > 1) {
                        binsToCheck[1] = (bin[i] + 1) % azBins;
                        binsToCheck[2] = (bin[i] - 1 + azBins) % azBins;
                        nbins = azBins >= 3 ? 3 : 2;
                    }
                    for (int64_t x = ci(lo[i].x); x <= ci(hi[i].x); ++x)
                        for (int64_t y = ci(lo[i].y); y <= ci(hi[i].y); ++y)
                            for (int64_t z = ci(lo[i].z); z <= ci(hi[i].z); ++z) {
                                for (int bi = 0; bi < nbins; ++bi) {
                                    auto it = grid.find(key4(x, y, z, cls[i], binsToCheck[bi]));
                                    if (it == grid.end()) continue;
                                    // a cell's triangles are in ascending order: start past i
                                    const auto first = std::upper_bound(cellTris.begin() + it->second.b, cellTris.begin() + it->second.e, i,
                                                                        [](uint32_t v, const std::pair<int64_t, uint32_t>& e) { return v < e.second; });
                                    for (uint32_t q = static_cast<uint32_t>(first - cellTris.begin()); q < it->second.e; ++q) {
                                        const uint32_t j = cellTris[q].second;
                                        // boxes must overlap; process the pair only in the min cell of the overlap
                                        if (lo[i].x > hi[j].x || lo[j].x > hi[i].x || lo[i].y > hi[j].y || lo[j].y > hi[i].y || lo[i].z > hi[j].z || lo[j].z > hi[i].z) continue;
                                        if (ci(std::max(lo[i].x, lo[j].x)) != x || ci(std::max(lo[i].y, lo[j].y)) != y || ci(std::max(lo[i].z, lo[j].z)) != z) continue;
                                        if (triN0[i].dot(triN0[j]) < cosAgree) continue;
                                        V3 m = (triN0[i] + triN0[j]).normalized();
                                        if (std::abs(m.dot(triC0[i]) - m.dot(triC0[j])) > P.offsetTolerance) continue;
                                        out.push_back({i, j});
                                    }
                                }
                            }
                }
            });
            for (auto& v : pairsPerThread) for (auto& pr : v) uf.unite(pr.first, pr.second);

            std::unordered_map<uint32_t, std::vector<uint32_t>> comps;
            for (size_t t = 0; t < F; ++t) if (cls[t] >= 0) comps[uf.find(static_cast<uint32_t>(t))].push_back(static_cast<uint32_t>(t));
            // Split every proximity component at gaps in its offset distribution along the component's
            // mean normal: transitive chains through large crinkled triangles must not fuse parallel
            // faces that stand metres apart (e.g. a setback face and the tier face below it).
            std::vector<std::vector<uint32_t>> compList;
            compList.reserve(comps.size());
            for (auto& kv : comps) {
                auto& tris = kv.second;
                V3 m;
                for (uint32_t t : tris) m += triN0[t] * triA0[t];
                m = m.normalized();
                std::sort(tris.begin(), tris.end(), [&](uint32_t a, uint32_t b) { return m.dot(triC0[a]) < m.dot(triC0[b]); });
                size_t start = 0;
                for (size_t q = 1; q <= tris.size(); ++q) {
                    if (q == tris.size() || m.dot(triC0[tris[q]]) - m.dot(triC0[tris[q - 1]]) > P.offsetTolerance) {
                        std::vector<uint32_t> part(tris.begin() + static_cast<long>(start), tris.begin() + static_cast<long>(q));
                        std::sort(part.begin(), part.end());
                        compList.push_back(std::move(part));
                        start = q;
                    }
                }
            }
            // Split every component whose offsets form two crisp levels (a step, a recess, a lip).
            {
                std::vector<std::vector<uint32_t>> split;
                split.reserve(compList.size());
                for (auto& tris : compList) splitLevels(std::move(tris), 0, split);
                compList.swap(split);
                for (auto& tris : compList) std::sort(tris.begin(), tris.end());
            }
            // Relief sheets: flat patches standing off the surface around them ride on their parent's plane.
            std::vector<std::pair<uint32_t, SheetSpec>> pendingSheets;  // (parent component key, sheet)
            if (P.extractSheets) {
                // components are independent: extract in parallel, gather in component order (deterministic)
                std::vector<std::vector<SheetSpec>> sheetsOf(compList.size());
                std::vector<size_t> order(compList.size());
                std::iota(order.begin(), order.end(), 0);
                std::stable_sort(order.begin(), order.end(), [&](size_t a, size_t b) { return compList[a].size() > compList[b].size(); });
                detail::parallelFor(order.size(), threads, 1, [&](size_t b0, size_t b1, unsigned) {
                    for (size_t oi = b0; oi < b1; ++oi) {
                        auto& tris = compList[order[oi]];
                        const int c = cls[tris.front()];
                        extractSheets(tris, c == 0 ? P.minWallArea : P.minRoofArea, sheetsOf[order[oi]]);
                    }
                });
                for (size_t ci2 = 0; ci2 < compList.size(); ++ci2) {
                    auto& tris = compList[ci2];
                    auto& sheets = sheetsOf[ci2];
                    if (sheets.empty()) continue;
                    std::sort(tris.begin(), tris.end());
                    for (auto& sh : sheets) { std::sort(sh.tris.begin(), sh.tris.end()); pendingSheets.push_back({tris.front(), std::move(sh)}); }
                }
            }
            std::sort(compList.begin(), compList.end(), [](const auto& a, const auto& b) { return a.front() < b.front(); });

            // phase 1: robust plane fit of every candidate region
            std::vector<RegionFit> fits;
            triRegion.assign(F, -1);
            {
                // robust fits are independent: run them in parallel, then account in component order (deterministic)
                std::vector<RegionFit> cand(compList.size());
                std::vector<int8_t> state(compList.size(), 0);  // 0 small, 1 fitted, 2 rejected by rms
                detail::parallelFor(compList.size(), threads, 8, [&](size_t b0, size_t b1, unsigned) {
                    for (size_t i = b0; i < b1; ++i) {
                        const auto& tris = compList[i];
                        const int c = cls[tris.front()];
                        double area = 0;
                        for (uint32_t t : tris) area += triA0[t];
                        if (area < (c == 0 ? P.minWallArea : P.minRoofArea) || static_cast<int>(tris.size()) < P.minRegionTriangles) { state[i] = 0; continue; }
                        RegionFit& f = cand[i];
                        f.tris = tris;
                        f.cls = c;
                        f.area = area;
                        f.key = tris.front();
                        state[i] = fitPlaneIrls(f) ? 1 : 2;
                    }
                });
                for (size_t i = 0; i < compList.size(); ++i) {
                    const auto& tris = compList[i];
                    if (state[i] == 0) {
                        ++S.rejectedSmall;
                        for (uint32_t t : tris) triRegion[t] = -3;
                        continue;
                    }
                    if (state[i] == 2) {
                        ++S.rejectedRms;
                        for (uint32_t t : tris) triRegion[t] = -2 - static_cast<int32_t>(1000 + S.rejectedRms);
                        continue;
                    }
                    fits.push_back(std::move(cand[i]));
                }
            }
            // phase 2: orientation consensus of nearby walls
            computeLocalOrientations(fits);
            // phase 3: orientation snapping (bounded by the induced displacement), residual check
            std::unordered_map<uint32_t, int32_t> regionOfKey;
            for (auto& f : fits) {
                PlaneRegion R;
                if (!snapRegion(f, R)) {
                    ++S.rejectedRms;
                    for (uint32_t t : f.tris) triRegion[t] = -2 - static_cast<int32_t>(1000 + S.rejectedRms);
                    continue;
                }
                R.area = f.area;
                R.triangleCount = static_cast<int>(f.tris.size());
                int32_t id = static_cast<int32_t>(regions.size());
                for (uint32_t t : f.tris) triRegion[t] = id;
                regions.push_back(R);
                regionOfKey[f.key] = id;
                (f.cls == 0 ? S.wallRegions : S.roofRegions)++;
                S.regionArea += f.area;
            }
            // phase 4: each relief sheet takes its parent's snapped orientation, offset by its relief
            for (auto& ps : pendingSheets) {
                auto it = regionOfKey.find(ps.first);
                const SheetSpec& sh = ps.second;
                if (it == regionOfKey.end()) { for (uint32_t t : sh.tris) triRegion[t] = -3; continue; }
                const PlaneRegion& par = regions[static_cast<size_t>(it->second)];
                PlaneRegion R = par;
                R.sheet = true;
                R.d = par.d + sh.relief;
                double area = 0, sw = 0, sr = 0;
                V3 cen;
                R.lo1 = R.lo2 = 1e300; R.hi1 = R.hi2 = -1e300;
                for (uint32_t t : sh.tris) {
                    area += triA0[t];
                    cen += triC0[t] * triA0[t];
                    for (int k = 0; k < 3; ++k) {
                        const V3& q = P0[tri[t][k]];
                        const double r = R.n.dot(q) - R.d;
                        sw += triA0[t]; sr += triA0[t] * r * r;
                        const double a1 = R.t1.dot(q), a2 = R.t2.dot(q);
                        R.lo1 = std::min(R.lo1, a1); R.hi1 = std::max(R.hi1, a1);
                        R.lo2 = std::min(R.lo2, a2); R.hi2 = std::max(R.hi2, a2);
                    }
                }
                R.area = area;
                R.centroid = cen * (1.0 / std::max(area, 1e-300));
                R.rms = std::sqrt(sr / std::max(sw, 1e-300));
                R.triangleCount = static_cast<int>(sh.tris.size());
                const int32_t id = static_cast<int32_t>(regions.size());
                for (uint32_t t : sh.tris) triRegion[t] = id;
                regions.push_back(R);
                ++S.sheets;
                S.sheetArea += area;
            }
        }

        /**
         * Recursive two-level split of a planar component (Otsu on area-weighted triangle offsets along
         * the component's mean normal). Splits only when the two levels are crisp: well separated
         * relative to the total spread and at least splitMinStep apart.
         */
        void splitLevels(std::vector<uint32_t>&& tris, int depth, std::vector<std::vector<uint32_t>>& out) {
            if (depth >= P.splitMaxDepth || tris.size() < 2) { out.push_back(std::move(tris)); return; }
            V3 m;
            for (uint32_t t : tris) m += triN0[t] * triA0[t];
            m = m.normalized();
            std::sort(tris.begin(), tris.end(), [&](uint32_t a, uint32_t b) {
                const double oa = m.dot(triC0[a]), ob = m.dot(triC0[b]);
                return oa != ob ? oa < ob : a < b;
            });
            const size_t n = tris.size();
            double W = 0, S1 = 0, S2 = 0;
            for (uint32_t t : tris) { const double o = m.dot(triC0[t]); W += triA0[t]; S1 += triA0[t] * o; S2 += triA0[t] * o * o; }
            if (W <= 0) { out.push_back(std::move(tris)); return; }
            const double mu = S1 / W, varT = S2 / W - mu * mu;
            if (!(varT > 1e-8)) { out.push_back(std::move(tris)); return; }
            double w0 = 0, s0 = 0, bestB = -1;
            size_t bestK = 0;
            double bestStep = 0;
            for (size_t k = 0; k + 1 < n; ++k) {
                const double o = m.dot(triC0[tris[k]]);
                w0 += triA0[tris[k]];
                s0 += triA0[tris[k]] * o;
                const double w1 = W - w0;
                if (w0 < P.splitMinPartArea || w1 < P.splitMinPartArea) continue;
                if (m.dot(triC0[tris[k + 1]]) <= o) continue;  // never split between equal offsets
                const double mu0 = s0 / w0, mu1 = (S1 - s0) / w1;
                const double b = w0 * w1 * (mu1 - mu0) * (mu1 - mu0) / (W * W);
                if (b > bestB) { bestB = b; bestK = k; bestStep = mu1 - mu0; }
            }
            if (bestB < 0 || bestB / varT < P.splitMinSeparation || bestStep < P.splitMinStep) { out.push_back(std::move(tris)); return; }
            // crisp sheets: the vertices of each level stay near that level
            for (int part = 0; part < 2; ++part) {
                const size_t b0 = part == 0 ? 0 : bestK + 1, b1 = part == 0 ? bestK + 1 : n;
                double w = 0, s1 = 0, s2 = 0;
                for (size_t k = b0; k < b1; ++k) {
                    const uint32_t t = tris[k];
                    for (int q = 0; q < 3; ++q) {
                        const double o = m.dot(P0[tri[t][q]]);
                        w += triA0[t]; s1 += triA0[t] * o; s2 += triA0[t] * o * o;
                    }
                }
                const double mu1 = s1 / w, rms = std::sqrt(std::max(0.0, s2 / w - mu1 * mu1));
                if (rms > P.splitMaxLevelRms * bestStep) { out.push_back(std::move(tris)); return; }
            }
            ++S.levelSplits;
            std::vector<uint32_t> lo(tris.begin(), tris.begin() + static_cast<long>(bestK + 1));
            std::vector<uint32_t> hi(tris.begin() + static_cast<long>(bestK + 1), tris.end());
            splitLevels(std::move(lo), depth + 1, out);
            splitLevels(std::move(hi), depth + 1, out);
        }

        /** A relief sheet: flat triangles of one component standing `relief` off the surface around them. */
        struct SheetSpec { std::vector<uint32_t> tris; double relief{0}; };

        /**
         * Relief sheets of a wall component (a pier, a pilaster, a strip). Triangles parallel to the component
         * (normal within sheetMaxAngleDeg of its mean normal m) are joined through shared vertices into patches
         * whose centroid levels agree. A patch's relief is its level minus the level of the surface AROUND it:
         * the area-weighted median offset of points sampled on the component's other triangles within
         * sheetRingWidth of the patch (in the plane). A patch is a sheet when |relief| >= sheetMinRelief, its
         * own vertices spread less than the step, it is at most sheetMaxWidth wide and holds sheetMinArea but
         * less than half the component. The sheet later rides on its parent's snapped plane at that relief, so
         * straightening the surroundings carries the step with it instead of pressing it flat. Tilted triangles
         * (crinkle) never form a sheet and are still flattened.
         */
        void extractSheets(std::vector<uint32_t>& tris, double minRemaining, std::vector<SheetSpec>& sheets) {
            if (tris.size() < 2) return;
            V3 m;
            double total = 0;
            for (uint32_t t : tris) { m += triN0[t] * triA0[t]; total += triA0[t]; }
            m = m.normalized();
            if (m.norm() < 0.5 || total < minRemaining + P.sheetMinArea) return;
            const double cosA = std::cos(detail::degToRad(P.sheetMaxAngleDeg));
            const size_t n = tris.size();
            // horizontal in-plane axis: a pier or strip is narrow across it (walls only; roof levels are tiers)
            const V3 hAxis = V3{0, 1, 0}.cross(m).normalized();
            if (hAxis.norm() < 0.5 || std::abs(m.y) > 0.5) return;
            std::vector<double> level(n, std::numeric_limits<double>::quiet_NaN());
            std::vector<uint32_t> flatIdx;
            for (size_t i = 0; i < n; ++i) {
                const uint32_t t = tris[i];
                if (triN0[t].dot(m) < cosA) continue;
                level[i] = m.dot(triC0[t]);
                flatIdx.push_back(static_cast<uint32_t>(i));
            }
            if (flatIdx.empty()) return;
            // patches: flat triangles sharing a weld group and agreeing on their level
            detail::UnionFind uf(flatIdx.size());
            std::unordered_map<uint32_t, std::vector<uint32_t>> byGroup;
            for (uint32_t fi = 0; fi < flatIdx.size(); ++fi) for (int k = 0; k < 3; ++k) byGroup[triG[tris[flatIdx[fi]]][k]].push_back(fi);
            for (auto& kv : byGroup) {
                auto& l = kv.second;
                for (size_t x = 0; x < l.size(); ++x) for (size_t y = x + 1; y < l.size(); ++y) {
                    if (std::abs(level[flatIdx[l[x]]] - level[flatIdx[l[y]]]) <= P.sheetLevelTol) uf.unite(l[x], l[y]);
                }
            }
            std::map<uint32_t, std::vector<uint32_t>> patches;  // ordered: deterministic
            for (uint32_t fi = 0; fi < flatIdx.size(); ++fi) patches[uf.find(fi)].push_back(flatIdx[fi]);
            // in-plane frame and 2D geometry of the component
            V3 e1, e2;
            detail::orthonormalBasis(m, e1, e2);
            struct T2 { double ax, ay, bx, by, cx, cy, lo1, hi1, lo2, hi2; };
            std::vector<T2> t2(n);
            for (size_t i = 0; i < n; ++i) {
                const uint32_t t = tris[i];
                const V3 &a = P0[tri[t][0]], &b = P0[tri[t][1]], &c = P0[tri[t][2]];
                T2 q{e1.dot(a), e2.dot(a), e1.dot(b), e2.dot(b), e1.dot(c), e2.dot(c), 0, 0, 0, 0};
                q.lo1 = std::min({q.ax, q.bx, q.cx}); q.hi1 = std::max({q.ax, q.bx, q.cx});
                q.lo2 = std::min({q.ay, q.by, q.cy}); q.hi2 = std::max({q.ay, q.by, q.cy});
                t2[i] = q;
            }
            auto segDist2 = [](double px, double py, double ax, double ay, double bx, double by) {
                const double dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
                double u = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0.0;
                u = std::clamp(u, 0.0, 1.0);
                const double qx = ax + u * dx - px, qy = ay + u * dy - py;
                return qx * qx + qy * qy;
            };
            auto distToTri = [&](double px, double py, const T2& q) {
                const double d1 = (q.bx - q.ax) * (py - q.ay) - (q.by - q.ay) * (px - q.ax);
                const double d2 = (q.cx - q.bx) * (py - q.by) - (q.cy - q.by) * (px - q.bx);
                const double d3 = (q.ax - q.cx) * (py - q.cy) - (q.ay - q.cy) * (px - q.cx);
                const bool neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
                if (!(neg && pos)) return 0.0;
                return std::sqrt(std::min({segDist2(px, py, q.ax, q.ay, q.bx, q.by), segDist2(px, py, q.bx, q.by, q.cx, q.cy), segDist2(px, py, q.cx, q.cy, q.ax, q.ay)}));
            };
            const double ring = P.sheetRingWidth, step = P.sheetRingSpacing;
            // the component's own level (area-weighted median of its triangles' levels): a sheet stands off this main
            // plane too, not only off a crinkled neighbourhood
            double mainLevel = 0;
            {
                std::vector<std::pair<double, double>> lv;
                lv.reserve(n);
                for (size_t i = 0; i < n; ++i) lv.push_back({m.dot(triC0[tris[i]]), triA0[tris[i]]});
                std::sort(lv.begin(), lv.end());
                double acc = 0;
                mainLevel = lv.back().first;
                for (const auto& x : lv) { acc += x.second; if (acc >= 0.5 * total) { mainLevel = x.first; break; } }
            }
            std::vector<uint8_t> taken(n, 0);
            double takenArea = 0;
            std::vector<SheetSpec> found;
            std::vector<uint8_t> inPatch(n, 0);
            std::vector<std::pair<double, double>> samples;  // (offset, weight)
            std::unordered_map<int64_t, double, detail::CellKeyHash> frontCells;
            for (auto& kv : patches) {
                const auto& pi = kv.second;
                double area = 0, lsum = 0;
                double lo1 = 1e300, hi1 = -1e300, lo2 = 1e300, hi2 = -1e300;
                double wLo = 1e300, wHi = -1e300, oLo = 1e300, oHi = -1e300;
                // the patch's offsets with a plumb lean removed (offset = a + b y, least squares): a pier that leans
                // like the rest of the wall is still one sheet
                double sy = 0, sy2 = 0, so = 0, syo = 0, sn = 0;
                for (uint32_t i : pi) {
                    area += triA0[tris[i]]; lsum += triA0[tris[i]] * level[i];
                    lo1 = std::min(lo1, t2[i].lo1); hi1 = std::max(hi1, t2[i].hi1); lo2 = std::min(lo2, t2[i].lo2); hi2 = std::max(hi2, t2[i].hi2);
                    for (int k = 0; k < 3; ++k) {
                        const V3& q = P0[tri[tris[i]][k]];
                        wLo = std::min(wLo, hAxis.dot(q)); wHi = std::max(wHi, hAxis.dot(q));
                        const double o = m.dot(q);
                        sy += q.y; sy2 += q.y * q.y; so += o; syo += q.y * o; sn += 1;
                    }
                }
                {
                    const double den = sn * sy2 - sy * sy;
                    const double b = std::abs(den) > 1e-9 ? (sn * syo - sy * so) / den : 0.0;
                    const double a0 = (so - b * sy) / sn;
                    for (uint32_t i : pi) for (int k = 0; k < 3; ++k) {
                        const V3& q = P0[tri[tris[i]][k]];
                        const double r = m.dot(q) - (a0 + b * q.y);
                        oLo = std::min(oLo, r); oHi = std::max(oHi, r);
                    }
                }
                double yLo = 1e300, yHi = -1e300;
                for (uint32_t i : pi) for (int k = 0; k < 3; ++k) { const double y = P0[tri[tris[i]][k]].y; yLo = std::min(yLo, y); yHi = std::max(yHi, y); }
                // pier-like: narrow, and standing at least sheetMinAspect times as tall as it is wide
                if (area < P.sheetMinArea || area >= 0.5 * total || wHi - wLo > P.sheetMaxWidth || yHi - yLo < P.sheetMinAspect * (wHi - wLo)) continue;
                const double lv = lsum / area;
                for (uint32_t i : pi) inPatch[i] = 1;
                // the surface around the patch, as seen from in front: points sampled on the other triangles
                // between sheetRingInner and `ring` of it, the front-most (largest offset along m) per cell
                samples.clear();
                frontCells.clear();
                for (size_t j = 0; j < n; ++j) {
                    if (inPatch[j]) continue;
                    const T2& q = t2[j];
                    if (q.hi1 < lo1 - ring || q.lo1 > hi1 + ring || q.hi2 < lo2 - ring || q.lo2 > hi2 + ring) continue;
                    const uint32_t t = tris[j];
                    const V3 &a = P0[tri[t][0]], &b = P0[tri[t][1]], &c = P0[tri[t][2]];
                    const double emax = std::max({(b - a).norm(), (c - b).norm(), (a - c).norm()});
                    const int k = std::clamp(static_cast<int>(std::ceil(emax / step)), 1, 48);
                    for (int u = 0; u <= k; ++u) for (int v = 0; u + v <= k; ++v) {
                        const double wu = static_cast<double>(u) / k, wv = static_cast<double>(v) / k;
                        const V3 p = a * (1.0 - wu - wv) + b * wu + c * wv;
                        const double px = e1.dot(p), py = e2.dot(p);
                        if (px < lo1 - ring || px > hi1 + ring || py < lo2 - ring || py > hi2 + ring) continue;
                        double dmin = 1e300;
                        for (uint32_t i : pi) { dmin = std::min(dmin, distToTri(px, py, t2[i])); if (dmin <= 0) break; }
                        if (!(dmin >= P.sheetRingInner && dmin <= ring)) continue;
                        const int64_t key = detail::cellKey(static_cast<int64_t>(std::floor(px / step)), static_cast<int64_t>(std::floor(py / step)), 0);
                        auto itc = frontCells.find(key);
                        const double off = m.dot(p);
                        if (P.sheetRingFrontMost) {
                            if (itc == frontCells.end()) frontCells.emplace(key, off); else itc->second = std::max(itc->second, off);
                        } else {
                            if (itc == frontCells.end()) frontCells.emplace(key, 0.0);
                            samples.push_back({off, 1.0});
                        }
                    }
                }
                for (uint32_t i : pi) inPatch[i] = 0;
                const double sw = static_cast<double>(frontCells.size()) * step * step;
                if (sw < P.sheetMinRingArea) continue;
                if (P.sheetRingFrontMost) for (const auto& kc : frontCells) samples.push_back({kc.second, 1.0});
                if (samples.empty()) continue;
                std::sort(samples.begin(), samples.end());
                const double ref = samples[samples.size() / 2].first;
                const double relief = lv - ref;
                // a coherent sheet: the step is larger than the spread of the patch's own vertices, and the patch stands
                // off the component's main plane the same way (a flat facet merely above a crinkle valley is not relief)
                if (std::abs(relief) < P.sheetMinRelief || oHi - oLo > std::max(P.sheetFlatSpread, P.sheetMaxSpreadOfRelief * std::abs(relief))) continue;
                if ((lv - mainLevel) * (relief > 0 ? 1.0 : -1.0) < P.sheetMinMainRelief) continue;
                SheetSpec sh;
                for (uint32_t i : pi) { sh.tris.push_back(tris[i]); taken[i] = 1; }
                sh.relief = relief;
                takenArea += area;
                found.push_back(std::move(sh));
            }
            if (found.empty() || total - takenArea < minRemaining) return;
            std::vector<uint32_t> rest;
            rest.reserve(n);
            for (size_t i = 0; i < n; ++i) if (!taken[i]) rest.push_back(tris[i]);
            tris.swap(rest);
            for (auto& sh : found) sheets.push_back(std::move(sh));
        }

        struct RegionFit {
            std::vector<uint32_t> tris;
            int cls{0};
            double area{0};
            V3 n, meanN, centroid;
            double d{0};
            double azDeg{0};        // azimuth of the horizontal part of the fitted wall normal
            double tiltDeg{0};
            double targetAzDeg{0};  // local orientation consensus (walls)
            bool hasTarget{false};
            bool locked{false};     // the consensus was replaced by a global family
            uint32_t key{0};        // the component's smallest triangle id (links relief sheets to it)
            V3 t1;                  // horizontal in-plane axis (walls)
            double lo1{0}, hi1{0};
            int32_t footprint{-1};
        };

        bool fitPlaneIrls(RegionFit& f) {
            std::vector<V3> pts;
            std::vector<double> w;
            pts.reserve(f.tris.size() * 3);
            V3 meanN, centroid;
            double sa = 0;
            for (uint32_t t : f.tris) {
                for (int k = 0; k < 3; ++k) { pts.push_back(P0[tri[t][k]]); w.push_back(triA0[t] / 3.0); }
                meanN += triN0[t] * triA0[t];
                centroid += triC0[t] * triA0[t];
                sa += triA0[t];
            }
            meanN = meanN.normalized();
            centroid = centroid * (1.0 / sa);
            V3 n;
            double d;
            if (!detail::weightedPlane(pts, w, n, d)) return false;
            if (n.dot(meanN) < 0) { n = n * -1.0; d = -d; }
            std::vector<double> iw(w.size());
            for (int it = 0; it < P.planeIrlsIterations; ++it) {
                for (size_t k = 0; k < pts.size(); ++k) {
                    double r = std::abs(n.dot(pts[k]) - d);
                    iw[k] = w[k] * (r <= P.planeHuber ? 1.0 : P.planeHuber / r);
                }
                V3 nn;
                double dd;
                if (!detail::weightedPlane(pts, iw, nn, dd)) break;
                if (nn.dot(meanN) < 0) { nn = nn * -1.0; dd = -dd; }
                n = nn; d = dd;
            }
            f.n = n;
            f.d = d;
            f.meanN = meanN;
            f.centroid = centroid;
            f.tiltDeg = detail::radToDeg(std::asin(std::min(1.0, std::abs(n.y))));
            f.azDeg = detail::radToDeg(std::atan2(n.z, n.x));
            if (f.cls == 0) {
                f.t1 = V3{-n.z, 0, n.x}.normalized();
                f.lo1 = 1e300; f.hi1 = -1e300;
                for (const V3& q : pts) { const double a = f.t1.dot(q); f.lo1 = std::min(f.lo1, a); f.hi1 = std::max(f.hi1, a); }
                // the building this wall bounds: footprint just behind it, else just in front of it
                const V3 h = V3{n.x, 0, n.z}.normalized();
                f.footprint = footprintAt(centroid.x - h.x * 0.75, centroid.z - h.z * 0.75);
                if (f.footprint < 0) f.footprint = footprintAt(centroid.x + h.x * 0.75, centroid.z + h.z * 0.75);
            }
            return true;
        }

        /**
         * Orientation consensus per wall: area- and distance-weighted circular mean (in 4x azimuth
         * space, so the four sides of a rectangle agree) over walls within localOrientationRadius
         * whose own azimuth is within localOrientationWindowDeg (mod 90). Walls of the same footprint
         * dominate; a consensus within familyLockDeg of a global family takes the family exactly.
         */
        void computeLocalOrientations(std::vector<RegionFit>& fits) {
            std::vector<size_t> walls;
            for (size_t i = 0; i < fits.size(); ++i) if (fits[i].cls == 0) walls.push_back(i);
            const double R = P.localOrientationRadius, s2 = 2.0 * P.localOrientationSigma * P.localOrientationSigma;
            auto segDist = [&](const RegionFit& a, const RegionFit& b) {
                // horizontal distance from a's centroid to b's horizontal extent
                const double s = std::clamp(b.t1.dot(a.centroid), b.lo1, b.hi1);
                const V3 q = b.centroid + b.t1 * (s - b.t1.dot(b.centroid));
                const double dx = a.centroid.x - q.x, dz = a.centroid.z - q.z;
                return std::sqrt(dx * dx + dz * dz);
            };
            for (size_t ii = 0; ii < walls.size(); ++ii) {
                RegionFit& a = fits[walls[ii]];
                double cs = 0, sn = 0, wsum = 0;
                for (size_t jj = 0; jj < walls.size(); ++jj) {
                    const RegionFit& b = fits[walls[jj]];
                    if (std::abs(detail::wrapDiff(b.azDeg, a.azDeg, 90.0)) > P.localOrientationWindowDeg) continue;
                    const double dist = jj == ii ? 0.0 : segDist(a, b);
                    if (dist > R) continue;
                    double wgt = b.area * std::exp(-dist * dist / s2);
                    if (a.footprint >= 0 && b.footprint >= 0 && a.footprint != b.footprint) wgt *= P.crossFootprintWeight;
                    const double ang = detail::degToRad(4.0 * b.azDeg);
                    cs += wgt * std::cos(ang);
                    sn += wgt * std::sin(ang);
                    wsum += wgt;
                }
                if (wsum <= 0) continue;
                double cons = detail::radToDeg(std::atan2(sn, cs)) / 4.0;
                cons = a.azDeg + detail::wrapDiff(cons, a.azDeg, 90.0);  // equivalent azimuth nearest the wall's own
                for (const auto& fam : families) {
                    const double dev = detail::wrapDiff(cons, fam.azimuthDeg, 90.0);
                    if (std::abs(dev) <= P.familyLockDeg) { cons -= dev; a.locked = true; break; }
                }
                a.targetAzDeg = cons;
                a.hasTarget = true;
            }
        }

        bool snapRegion(const RegionFit& f, PlaneRegion& R) {
            std::vector<V3> pts;
            std::vector<double> w;
            pts.reserve(f.tris.size() * 3);
            for (uint32_t t : f.tris) for (int k = 0; k < 3; ++k) { pts.push_back(P0[tri[t][k]]); w.push_back(triA0[t] / 3.0); }
            const int c = f.cls;
            const V3 centroid = f.centroid;
            V3 n = f.n;
            double d = f.d;
            // orientation snapping, bounded by the displacement it induces on the region
            auto locate = [&](const V3& nn) {
                std::vector<double> vals(pts.size());
                for (size_t k = 0; k < pts.size(); ++k) vals[k] = nn.dot(pts[k]);
                return detail::huberLocation(vals, w, P.planeHuber);
            };
            auto induced = [&](const V3& na, double da, const V3& nb, double db) {
                double m = 0;
                for (const V3& q : pts) m = std::max(m, std::abs((na.dot(q) - da) - (nb.dot(q) - db)));
                return m;
            };
            d = locate(n);
            V3 nFit = n;
            double dFit = d;
            bool plumb = false, fam = false, level = false;
            if (c == 0) {
                double tilt = f.tiltDeg;
                V3 nPlumb = n;
                if (tilt <= P.plumbSnapDeg) { nPlumb = V3{n.x, 0, n.z}.normalized(); plumb = true; }
                V3 nFam = nPlumb;
                double az = detail::radToDeg(std::atan2(nPlumb.z, nPlumb.x));
                double bestDev = 1e9;
                if (f.hasTarget) bestDev = detail::wrapDiff(az, f.targetAzDeg, 90.0);
                // plan D5: the orientation snaps only when the wall is already within familySnapDeg of a global family
                // (a wall a few degrees off the grid is a real off-grid wall: it keeps its own orientation even when its
                // neighbourhood consensus lies closer to the grid)
                double famDev = 1e9;
                for (const auto& fm : families) famDev = std::min(famDev, std::abs(detail::wrapDiff(az, fm.azimuthDeg, 90.0)));
                if (famDev > P.familySnapDeg) { bestDev = 1e9; if (f.hasTarget) ++S.orientationOffFamily; }
                if (std::abs(bestDev) <= P.familySnapDeg) {
                    double a2 = detail::degToRad(az - bestDev);
                    double hlen = std::sqrt(std::max(0.0, 1.0 - nPlumb.y * nPlumb.y));
                    nFam = V3{std::cos(a2) * hlen, nPlumb.y, std::sin(a2) * hlen}.normalized();
                    fam = true;
                }
                // try full snap, then plumb-only, then keep the fitted plane
                V3 cand[2] = {nFam, nPlumb};
                bool used = false;
                for (int ci2 = 0; ci2 < 2 && !used; ++ci2) {
                    if (ci2 == 0 && !(plumb || fam)) continue;
                    if (ci2 == 1 && !plumb) continue;
                    double dc = locate(cand[ci2]);
                    if (induced(cand[ci2], dc, nFit, dFit) <= P.maxSnapInducedDisplacement) {
                        n = cand[ci2]; d = dc; used = true;
                        if (ci2 == 1) fam = false;
                    }
                }
                if (!used) {
                    if (plumb || fam) ++S.snapRejectedInduced;
                    plumb = fam = false;
                }
                if (plumb) ++S.plumbSnapped;
                if (fam) {
                    ++S.familySnapped;
                    if (f.locked) ++S.familyLocked; else ++S.localOrientationSnapped;
                    S.localOrientationMaxRotationDeg = std::max(S.localOrientationMaxRotationDeg, std::abs(bestDev));
                }
            } else {
                double tiltDeg = detail::radToDeg(std::acos(std::clamp(n.y, -1.0, 1.0)));
                if (tiltDeg <= P.plumbSnapDeg) {
                    V3 up{0, 1, 0};
                    double dc = locate(up);
                    if (induced(up, dc, nFit, dFit) <= P.maxSnapInducedDisplacement) {
                        n = up; d = dc; level = true; ++S.levelSnapped;
                    } else {
                        ++S.snapRejectedInduced;
                        // a nearly level fit that cannot be levelled is several levels fused by proximity: its
                        // tilt is an artefact of fitting one plane through them, never a roof to snap onto
                        if (P.rejectUnlevelableRoofs) { ++S.rejectedUnlevelable; return false; }
                    }
                }
            }
            double sw = 0, sr = 0;
            for (size_t k = 0; k < pts.size(); ++k) { double r = n.dot(pts[k]) - d; sw += w[k]; sr += w[k] * r * r; }
            double rms = std::sqrt(sr / std::max(sw, 1e-300));
            if (rms > P.maxRegionRms) return false;
            R.cls = c;
            R.n = n;
            R.d = d;
            R.rms = rms;
            R.tau = c == 0 ? P.tauWall : P.tauRoof;
            R.level = level;
            R.centroid = centroid;
            if (c == 0) {
                R.t1 = V3{0, 1, 0}.cross(n).normalized();
                if (R.t1.norm() < 0.5) detail::orthonormalBasis(n, R.t1, R.t2);
                R.t2 = n.cross(R.t1);
            } else {
                V3 ref{1, 0, 0};
                if (!families.empty()) {
                    double a = detail::degToRad(families.front().azimuthDeg);
                    ref = V3{std::cos(a), 0, std::sin(a)};
                }
                R.t1 = (ref - n * n.dot(ref)).normalized();
                if (R.t1.norm() < 0.5) detail::orthonormalBasis(n, R.t1, R.t2);
                R.t2 = n.cross(R.t1);
            }
            R.lo1 = R.lo2 = 1e300; R.hi1 = R.hi2 = -1e300;
            for (const V3& q : pts) {
                double a1 = R.t1.dot(q), a2 = R.t2.dot(q);
                R.lo1 = std::min(R.lo1, a1); R.hi1 = std::max(R.hi1, a1);
                R.lo2 = std::min(R.lo2, a2); R.hi2 = std::max(R.hi2, a2);
            }
            return true;
        }

        // ------------------------------------------------------------------
        // D7: per-footprint tier heights from up-facing area histograms
        void buildTierPeaks() {
            if (!P.alignTiers || footprintLabel.empty()) return;
            struct Item { int32_t fp; int64_t bin; double area; double y; };
            std::vector<Item> items;
            const double bw = P.tierBin;
            for (size_t t = 0; t < F; ++t) {
                if (!visible[t] || triN0[t].y < P.tierUpMinNy) continue;
                int32_t fp = footprintAt(triC0[t].x, triC0[t].z);
                if (fp < 0) continue;
                items.push_back({fp, static_cast<int64_t>(std::floor(triC0[t].y / bw)), triA0[t], triC0[t].y});
            }
            std::sort(items.begin(), items.end(), [](const Item& a, const Item& b) {
                if (a.fp != b.fp) return a.fp < b.fp;
                return a.y != b.y ? a.y < b.y : a.area < b.area;
            });
            size_t i = 0;
            const double hbw = std::max(1e-3, P.tierModeBandwidth);
            while (i < items.size()) {
                size_t j = i;
                while (j < items.size() && items[j].fp == items[i].fp) ++j;
                // items[i, j) are sorted by height: windowed sums by binary search
                auto lowerY = [&](double y) {
                    size_t lo = i, hi = j;
                    while (lo < hi) { size_t mid = (lo + hi) / 2; if (items[mid].y < y) lo = mid + 1; else hi = mid; }
                    return lo;
                };
                auto massNear = [&](double y, double half) {
                    double m = 0;
                    for (size_t q = lowerY(y - half); q < j && items[q].y <= y + half; ++q) m += items[q].area;
                    return m;
                };
                // seeds: local maxima of the 3-bin smoothed area histogram (bin = tierBin)
                std::map<int64_t, double> hist;
                for (size_t q = i; q < j; ++q) hist[static_cast<int64_t>(std::floor(items[q].y / bw))] += items[q].area;
                std::vector<double> seeds;
                for (const auto& kv : hist) {
                    auto get = [&](int64_t b) { auto it = hist.find(b); return it == hist.end() ? 0.0 : it->second; };
                    const double c3 = get(kv.first - 1) + kv.second + get(kv.first + 1);
                    const double l3 = get(kv.first - 2) + get(kv.first - 1) + kv.second;
                    const double r3 = kv.second + get(kv.first + 1) + get(kv.first + 2);
                    if (c3 >= l3 && c3 >= r3 && c3 >= 0.5 * P.tierMinPeakArea) seeds.push_back((kv.first + 0.5) * bw);
                }
                // mean shift (Gaussian kernel, truncated at 3 bandwidths) from every seed
                std::vector<std::pair<double, double>> modes;  // (height, mass)
                for (double y : seeds) {
                    for (int it = 0; it < 50; ++it) {
                        double sw = 0, sy = 0;
                        for (size_t q = lowerY(y - 3 * hbw); q < j && items[q].y <= y + 3 * hbw; ++q) {
                            const double r = (items[q].y - y) / hbw;
                            const double wq = items[q].area * std::exp(-0.5 * r * r);
                            sw += wq; sy += wq * items[q].y;
                        }
                        if (sw <= 0) break;
                        const double ny = sy / sw;
                        if (std::abs(ny - y) < 1e-5) { y = ny; break; }
                        y = ny;
                    }
                    modes.push_back({y, massNear(y, P.tierModeHalfWidth)});
                }
                // merge modes closer than tierModeMerge (the heavier one survives), keep the significant ones
                std::sort(modes.begin(), modes.end(), [](auto& a, auto& b) { return a.second != b.second ? a.second > b.second : a.first < b.first; });
                std::vector<TierPeakInfo> peaks;
                for (const auto& md : modes) {
                    if (md.second < P.tierMinPeakArea) continue;
                    bool close = false;
                    for (const auto& pk : peaks) if (std::abs(pk.y - md.first) < P.tierModeMerge) { close = true; break; }
                    if (!close) peaks.push_back({md.first, md.second});
                }
                std::sort(peaks.begin(), peaks.end(), [](auto& a, auto& b) { return a.y < b.y; });
                if (!peaks.empty()) {
                    S.tierPeaksTotal += peaks.size();
                    S.footprintsWithPeaks++;
                    if (items[i].fp == heroFootprint) S.heroTierPeaks = peaks;
                    tierPeaks[items[i].fp] = std::move(peaks);
                }
                i = j;
            }
            // up-facing support index (visible faces) for the local-support test of a tier height
            upIndex.clear();
            for (size_t t = 0; t < F; ++t) {
                if (!visible[t] || triN0[t].y < P.tierUpMinNy) continue;
                upIndex[upKey(triC0[t].x, triC0[t].z)].push_back(static_cast<uint32_t>(t));
            }
            // align level roof planes to their footprint's tier heights; a region is aligned only when
            // most of its area lies inside one footprint (terrain that merely passes under a footprint
            // centroid is never pulled to a building's tier) and the height is supported next to it
            std::vector<std::unordered_map<int32_t, double>> fpArea(regions.size());
            std::vector<double> regArea(regions.size(), 0.0);
            std::vector<std::array<double, 4>> regBox(regions.size(), std::array<double, 4>{1e300, 1e300, -1e300, -1e300});
            for (size_t t = 0; t < F; ++t) {
                int32_t r = triRegion[t];
                if (r < 0 || regions[static_cast<size_t>(r)].cls != 1) continue;
                regArea[static_cast<size_t>(r)] += triA0[t];
                fpArea[static_cast<size_t>(r)][footprintAt(triC0[t].x, triC0[t].z)] += triA0[t];
                auto& b = regBox[static_cast<size_t>(r)];
                for (int k = 0; k < 3; ++k) {
                    const V3& q = P0[tri[t][k]];
                    b[0] = std::min(b[0], q.x); b[1] = std::min(b[1], q.z); b[2] = std::max(b[2], q.x); b[3] = std::max(b[3], q.z);
                }
            }
            for (size_t r = 0; r < regions.size(); ++r) {
                auto& R = regions[r];
                if (R.cls != 1 || !R.level) continue;
                int32_t fp = -1;
                double best = 0;
                for (auto& kv : fpArea[r]) if (kv.first >= 0 && kv.second > best) { best = kv.second; fp = kv.first; }
                if (fp < 0 || best < P.tierRegionMinFootprintShare * regArea[r]) continue;
                auto it = tierPeaks.find(fp);
                if (it == tierPeaks.end()) continue;
                const auto& b = regBox[r];
                const double g = P.tierLocalRadius;
                double bestDy = 1e300, by = R.d;
                bool rejected = false;
                for (auto& pk : it->second) {
                    const double dd = std::abs(pk.y - R.d);
                    if (dd > P.tierRoofTolerance || dd >= bestDy) continue;
                    if (localUpArea(b[0] - g, b[1] - g, b[2] + g, b[3] + g, pk.y, P.tierModeHalfWidth) < P.tierLocalMinArea) { rejected = true; continue; }
                    bestDy = dd; by = pk.y;
                }
                if (bestDy <= P.tierRoofTolerance && bestDy > 0) { R.d = by; ++S.tierAlignedRoofs; }
                else if (rejected) ++S.tierRejectedUnsupported;
            }
        }

        std::unordered_map<int64_t, std::vector<uint32_t>, detail::CellKeyHash> upIndex;
        static constexpr double kUpCell = 4.0;
        static int64_t upKey(double x, double z) {
            return detail::cellKey(static_cast<int64_t>(std::floor(x / kUpCell)), 0, static_cast<int64_t>(std::floor(z / kUpCell)));
        }

        /** Visible up-facing area whose centroid lies in the box [x0,x1] x [z0,z1] within `half` of height y. */
        double localUpArea(double x0, double z0, double x1, double z1, double y, double half) const {
            double a = 0;
            const int64_t i0 = static_cast<int64_t>(std::floor(x0 / kUpCell)), i1 = static_cast<int64_t>(std::floor(x1 / kUpCell));
            const int64_t k0 = static_cast<int64_t>(std::floor(z0 / kUpCell)), k1 = static_cast<int64_t>(std::floor(z1 / kUpCell));
            for (int64_t i = i0; i <= i1; ++i) for (int64_t k = k0; k <= k1; ++k) {
                auto it = upIndex.find(detail::cellKey(i, 0, k));
                if (it == upIndex.end()) continue;
                for (uint32_t t : it->second) {
                    const V3& c = triC0[t];
                    if (c.x < x0 || c.x > x1 || c.z < z0 || c.z > z1 || std::abs(c.y - y) > half) continue;
                    a += triA0[t];
                }
            }
            return a;
        }

        double nearestTierPeak(double x, double y, double z, double tol, bool& found, double* area = nullptr) const {
            found = false;
            int32_t fp = footprintAt(x, z);
            auto it = tierPeaks.find(fp);
            if (it == tierPeaks.end()) return y;
            const double g = P.tierLocalRadius;
            double best = 1e300, by = y, ba = 0;
            for (auto& pk : it->second) {
                const double dd = std::abs(pk.y - y);
                if (dd > tol || dd >= best) continue;
                if (localUpArea(x - g, z - g, x + g, z + g, pk.y, P.tierModeHalfWidth) < P.tierLocalMinArea) continue;
                best = dd; by = pk.y; ba = pk.area;
            }
            if (best <= tol) { found = true; if (area) *area = ba; return by; }
            return y;
        }

        // ------------------------------------------------------------------
        // Narrow relief protection. A crisp panel of a wall standing at least reliefMinStep off the wall's plane and
        // framed at both sides by other surfaces (the panel between two pylons of a frontispiece, a recessed strip
        // between piers) is snapped onto the wall's plane AT ITS OWN LEVEL, so straightening keeps the step instead of
        // pressing the panel into the wall. Found on the input: per wall region the front-most visible surface (kept
        // faces facing the same way within reliefSlab of the plane) is rasterised in the plane's frame; along each row a
        // run of pixels whose face belongs to the region, is crisp (within reliefCrispDeg of the plane) and stands at
        // least reliefMinStep off it on one side is a panel row when the run is at most reliefPanelMaxWidth wide and
        // meets a surface of ANOTHER region at least reliefMinStep away at both ends. A face is a panel when such rows
        // cover at least reliefPanelMinHeight and most of its visible pixels (crinkle crosses the threshold smoothly,
        // and a huge facet merely visible between two frames in a few rows is not a panel).
        std::unordered_map<uint64_t, std::pair<double, int>> reliefVertex;  // (group << 32 | region) -> (sum of levels, count)

        void buildReliefProtection() {
            reliefVertex.clear();
            if (!(P.reliefMinStep > 0) || !(P.reliefPanelMaxWidth > 0)) return;
            // visible faces hashed by their AABB (8 m cells)
            const double hc = 8.0;
            auto hci = [&](double v) { return static_cast<int64_t>(std::floor(v / hc)); };
            std::unordered_map<int64_t, std::vector<uint32_t>, detail::CellKeyHash> hgrid;
            for (size_t t = 0; t < F; ++t) {
                if (!visible[t] || triA0[t] < 1e-6) continue;
                V3 lo{1e300, 1e300, 1e300}, hi{-1e300, -1e300, -1e300};
                for (int k = 0; k < 3; ++k) {
                    const V3& q = P0[tri[t][k]];
                    lo = V3{std::min(lo.x, q.x), std::min(lo.y, q.y), std::min(lo.z, q.z)};
                    hi = V3{std::max(hi.x, q.x), std::max(hi.y, q.y), std::max(hi.z, q.z)};
                }
                for (int64_t x = hci(lo.x); x <= hci(hi.x); ++x)
                    for (int64_t y = hci(lo.y); y <= hci(hi.y); ++y)
                        for (int64_t z = hci(lo.z); z <= hci(hi.z); ++z) hgrid[detail::cellKey(x, y, z)].push_back(static_cast<uint32_t>(t));
            }
            const double res = P.reliefRasterCell, slab = P.reliefSlab, margin = 1.0, step = P.reliefMinStep;
            const double cosCrisp = std::cos(detail::degToRad(P.reliefCrispDeg));
            const int maxRun = static_cast<int>(std::floor(P.reliefPanelMaxWidth / res + 1e-9)) + 1;
            const int minRows = std::max(1, static_cast<int>(std::lround(P.reliefPanelMinHeight / res)));
            // regions are independent: each is rasterised by a worker (own stamps), results are accumulated in region order
            std::vector<std::vector<std::pair<uint32_t, double>>> faceLevels(regions.size());
            struct Scratch { std::vector<uint32_t> cand, stamp; uint32_t stampId{0}; };
            std::vector<Scratch> scratch(threads);
            auto doRegion = [&](uint32_t r, Scratch& sc) {
                std::vector<uint32_t>& cand = sc.cand;
                if (sc.stamp.size() != F) sc.stamp.assign(F, 0);
                std::vector<uint32_t>& stamp = sc.stamp;
                uint32_t& stampId = sc.stampId;
                const PlaneRegion& R = regions[r];
                if (R.cls != 0 || R.sheet || R.area < P.minWallArea) return;
                const double s1lo = R.lo1 - margin, s1hi = R.hi1 + margin, s2lo = R.lo2 - margin, s2hi = R.hi2 + margin;
                const int nx = static_cast<int>(std::ceil((s1hi - s1lo) / res)), ny = static_cast<int>(std::ceil((s2hi - s2lo) / res));
                if (nx <= 0 || ny <= 0 || static_cast<double>(nx) * ny > 4e7) return;
                // candidate faces: the hash cells around the region's slab box
                V3 lo{1e300, 1e300, 1e300}, hi{-1e300, -1e300, -1e300};
                for (int a = 0; a < 2; ++a) for (int b = 0; b < 2; ++b) for (int c = 0; c < 2; ++c) {
                    const V3 q = R.t1 * (a ? s1hi : s1lo) + R.t2 * (b ? s2hi : s2lo) + R.n * (R.d + (c ? slab : -slab));
                    lo = V3{std::min(lo.x, q.x), std::min(lo.y, q.y), std::min(lo.z, q.z)};
                    hi = V3{std::max(hi.x, q.x), std::max(hi.y, q.y), std::max(hi.z, q.z)};
                }
                ++stampId;
                cand.clear();
                for (int64_t x = hci(lo.x); x <= hci(hi.x); ++x)
                    for (int64_t y = hci(lo.y); y <= hci(hi.y); ++y)
                        for (int64_t z = hci(lo.z); z <= hci(hi.z); ++z) {
                            auto it = hgrid.find(detail::cellKey(x, y, z));
                            if (it == hgrid.end()) continue;
                            for (uint32_t t : it->second) if (stamp[t] != stampId) { stamp[t] = stampId; cand.push_back(t); }
                        }
                auto crispOwn = [&](int32_t tt) {
                    return tt >= 0 && triRegion[static_cast<size_t>(tt)] == static_cast<int32_t>(r) && triN0[static_cast<size_t>(tt)].dot(R.n) >= cosCrisp;
                };
                // rasterise only when a crisp face of the region stands off the plane by the step somewhere
                bool anyRelief = false;
                for (uint32_t t : cand) {
                    if (!crispOwn(static_cast<int32_t>(t))) continue;
                    for (int k = 0; k < 3 && !anyRelief; ++k) if (std::abs(R.n.dot(P0[tri[t][k]]) - R.d) >= step) anyRelief = true;
                    if (anyRelief) break;
                }
                if (!anyRelief) return;
                std::vector<float> hmap(static_cast<size_t>(nx) * ny, -1e30f);
                std::vector<int32_t> ids(static_cast<size_t>(nx) * ny, -1);
                for (uint32_t t : cand) {
                    if (triN0[t].dot(R.n) < 0.5) continue;
                    double px[3], py[3], ph[3];
                    bool inSlab = false;
                    for (int k = 0; k < 3; ++k) {
                        const V3& q = P0[tri[t][k]];
                        px[k] = (R.t1.dot(q) - s1lo) / res; py[k] = (R.t2.dot(q) - s2lo) / res; ph[k] = R.n.dot(q) - R.d;
                        if (std::abs(ph[k]) <= slab) inSlab = true;
                    }
                    if (!inSlab) continue;
                    const double det = (px[1] - px[0]) * (py[2] - py[0]) - (py[1] - py[0]) * (px[2] - px[0]);
                    if (std::abs(det) < 1e-12) continue;
                    const int i0 = std::max(0, static_cast<int>(std::floor(std::min({px[0], px[1], px[2]})))), i1 = std::min(nx - 1, static_cast<int>(std::ceil(std::max({px[0], px[1], px[2]}))));
                    const int j0 = std::max(0, static_cast<int>(std::floor(std::min({py[0], py[1], py[2]})))), j1 = std::min(ny - 1, static_cast<int>(std::ceil(std::max({py[0], py[1], py[2]}))));
                    for (int j = j0; j <= j1; ++j) for (int i = i0; i <= i1; ++i) {
                        const double x = i + 0.5, y = j + 0.5;
                        const double l0 = ((px[1] - x) * (py[2] - y) - (py[1] - y) * (px[2] - x)) / det;
                        const double l1 = ((px[2] - x) * (py[0] - y) - (py[2] - y) * (px[0] - x)) / det;
                        const double l2 = 1.0 - l0 - l1;
                        if (l0 < 0 || l1 < 0 || l2 < 0) continue;
                        const double hv = l0 * ph[0] + l1 * ph[1] + l2 * ph[2];
                        const size_t k = static_cast<size_t>(j) * nx + i;
                        if (hv > hmap[k]) { hmap[k] = static_cast<float>(hv); ids[k] = static_cast<int32_t>(t); }
                    }
                }
                auto panelSide = [&](size_t k) -> int {
                    if (!crispOwn(ids[k])) return 0;
                    if (hmap[k] >= step) return 1;
                    if (hmap[k] <= -step) return -1;
                    return 0;
                };
                // the frame: a surface of another region at least `step` away from the panel's edge pixel
                auto framed = [&](size_t inside, int outsideI, int j) {
                    if (outsideI < 0 || outsideI >= nx) return false;
                    const size_t ko = static_cast<size_t>(j) * nx + outsideI;
                    return ids[ko] >= 0 && triRegion[static_cast<size_t>(ids[ko])] != static_cast<int32_t>(r)
                        && std::abs(static_cast<double>(hmap[ko]) - hmap[inside]) >= step;
                };
                std::unordered_map<uint32_t, int> panelRows;          // face -> rows it is a framed panel in
                std::unordered_map<uint32_t, std::vector<float>> panelHeights;  // face -> its heights inside framed panels
                std::vector<uint32_t> seen;
                for (int j = 0; j < ny; ++j) {
                    for (int i = 0; i < nx;) {
                        const size_t k0 = static_cast<size_t>(j) * nx + i;
                        const int sd = panelSide(k0);
                        if (!sd) { ++i; continue; }
                        int e2 = i;
                        while (e2 < nx && panelSide(static_cast<size_t>(j) * nx + e2) == sd) ++e2;
                        const size_t kr = static_cast<size_t>(j) * nx + (e2 - 1);
                        if (e2 - i <= maxRun && (framed(k0, i - 1, j) || framed(k0, i - 2, j)) && (framed(kr, e2, j) || framed(kr, e2 + 1, j))) {
                            seen.clear();
                            for (int q = i; q < e2; ++q) {
                                const size_t k = static_cast<size_t>(j) * nx + q;
                                const uint32_t tt = static_cast<uint32_t>(ids[k]);
                                panelHeights[tt].push_back(hmap[k]);
                                if (std::find(seen.begin(), seen.end(), tt) == seen.end()) { seen.push_back(tt); ++panelRows[tt]; }
                            }
                        }
                        i = e2;
                    }
                }
                if (panelRows.empty()) return;
                std::unordered_map<uint32_t, int> visiblePixels;
                for (size_t k = 0; k < ids.size(); ++k) if (ids[k] >= 0 && panelRows.count(static_cast<uint32_t>(ids[k]))) ++visiblePixels[static_cast<uint32_t>(ids[k])];
                for (auto& kv : panelHeights) {
                    const uint32_t f = kv.first;
                    auto& hs = kv.second;
                    if (panelRows[f] < minRows || 2 * hs.size() < static_cast<size_t>(visiblePixels[f])) continue;
                    std::nth_element(hs.begin(), hs.begin() + static_cast<long>(hs.size() / 2), hs.end());
                    const double level = hs[hs.size() / 2];
                    faceLevels[r].push_back({f, level});
                }
            };
            {
                std::vector<uint32_t> order(regions.size());
                std::iota(order.begin(), order.end(), 0u);
                std::stable_sort(order.begin(), order.end(), [&](uint32_t x, uint32_t y) { return regions[x].area > regions[y].area; });
                detail::parallelFor(order.size(), threads, 1, [&](size_t b0, size_t b1, unsigned th) {
                    for (size_t i = b0; i < b1; ++i) doRegion(order[i], scratch[th]);
                });
            }
            for (uint32_t r = 0; r < regions.size(); ++r) {
                for (const auto& fl : faceLevels[r]) {
                    const uint32_t f = fl.first;
                    ++S.reliefPanelFaces;
                    S.reliefPanelArea += triA0[f];
                    for (int k = 0; k < 3; ++k) {
                        auto& acc = reliefVertex[(static_cast<uint64_t>(triG[f][k]) << 32) | r];
                        acc.first += fl.second;
                        ++acc.second;
                    }
                }
            }
            S.reliefProtectedVertices = reliefVertex.size();
        }

        // ------------------------------------------------------------------
        // Proud blocks (see ScanRectifierParams::proudBlockMinRelief), found on the input positions
        std::vector<uint8_t> proudBlockGroup;  // G: 1 left as scanned, 2 snapped at the block's level

        void buildProudBlocks() {
            proudBlockGroup.assign(G, 0);
            if (!(P.proudBlockMinRelief > 0)) return;
            // edges over weld groups -> visible faces
            std::vector<std::pair<uint64_t, uint32_t>> ek;
            ek.reserve(F * 3);
            for (size_t t = 0; t < F; ++t) {
                if (!visible[t] || !(triA0[t] > 1e-8)) continue;
                for (int k = 0; k < 3; ++k) {
                    const uint32_t a = triG[t][k], b = triG[t][(k + 1) % 3];
                    if (a == b) continue;
                    ek.push_back({(static_cast<uint64_t>(std::min(a, b)) << 32) | std::max(a, b), static_cast<uint32_t>(t)});
                }
            }
            std::sort(ek.begin(), ek.end());
            auto edgeFaces = [&](uint64_t key) {
                auto it = std::lower_bound(ek.begin(), ek.end(), std::pair<uint64_t, uint32_t>{key, 0u});
                std::vector<uint32_t> fs;
                for (; it != ek.end() && it->first == key; ++it) fs.push_back(it->second);
                return fs;
            };
            auto res = [&](const PlaneRegion& R, uint32_t g) { return R.n.dot(groupPos[g]) - R.d; };
            // candidates: faces of a wall region with a vertex at least the relief off its plane; sign = side of the plane
            std::vector<int8_t> side(F, 0);
            for (size_t t = 0; t < F; ++t) {
                const int32_t r = triRegion[t];
                if (r < 0 || !visible[t] || !(triA0[t] > 1e-8)) continue;
                const auto& R = regions[static_cast<size_t>(r)];
                if (R.cls != 0 || R.sheet) continue;
                double lo = 1e300, hi = -1e300;
                for (int k = 0; k < 3; ++k) { const double e = res(R, triG[t][k]); lo = std::min(lo, e); hi = std::max(hi, e); }
                if (hi >= P.proudBlockMinRelief && lo > -P.proudBlockMinRelief) side[t] = 1;
                else if (lo <= -P.proudBlockMinRelief && hi < P.proudBlockMinRelief) side[t] = -1;
            }
            // patches: candidates of one region and side joined across shared edges
            std::vector<uint32_t> up(F);
            std::iota(up.begin(), up.end(), 0u);
            auto root = [&](uint32_t x) { while (up[x] != x) x = up[x] = up[up[x]]; return x; };
            for (size_t i = 0; i < ek.size();) {
                size_t e = i;
                while (e < ek.size() && ek[e].first == ek[i].first) ++e;
                for (size_t a = i; a < e; ++a)
                    for (size_t b = a + 1; b < e; ++b) {
                        const uint32_t ta = ek[a].second, tb = ek[b].second;
                        if (!side[ta] || side[ta] != side[tb] || triRegion[ta] != triRegion[tb]) continue;
                        const uint32_t ra = root(ta), rb = root(tb);
                        if (ra != rb) up[rb] = ra;
                    }
                i = e;
            }
            std::unordered_map<uint32_t, std::vector<uint32_t>> patches;
            for (size_t t = 0; t < F; ++t) if (side[t]) patches[root(static_cast<uint32_t>(t))].push_back(static_cast<uint32_t>(t));
            for (auto& kv : patches) {
                const std::vector<uint32_t>& faces = kv.second;
                const auto& R = regions[static_cast<size_t>(triRegion[faces[0]])];
                const double sgn = side[faces[0]];
                double area = 0;
                for (uint32_t t : faces) area += triA0[t];
                if (area < P.proudBlockMinArea || area > P.proudBlockMaxRegionShare * R.area) continue;
                std::unordered_map<uint32_t, uint8_t> in;
                for (uint32_t t : faces) in[t] = 1;
                // outline: edges with no other patch face; a riser edge has a steep face across that reaches back toward
                // the wall by at least the relief
                double outline = 0, riser = 0;
                for (uint32_t t : faces)
                    for (int k = 0; k < 3; ++k) {
                        const uint32_t a = triG[t][k], b = triG[t][(k + 1) % 3];
                        if (a == b) continue;
                        const auto fs = edgeFaces((static_cast<uint64_t>(std::min(a, b)) << 32) | std::max(a, b));
                        bool inner = false;
                        for (uint32_t f : fs) if (f != t && in.count(f)) inner = true;
                        if (inner) continue;
                        bool across = false, isRiser = false;
                        const double edgeLevel = std::min(sgn * res(R, a), sgn * res(R, b));
                        for (uint32_t f : fs) {
                            if (f == t) continue;
                            across = true;
                            if (std::abs(triN0[f].dot(R.n)) > P.proudBlockRiserMaxDot) continue;
                            double back = 1e300;
                            for (int j = 0; j < 3; ++j) back = std::min(back, sgn * res(R, triG[f][j]));
                            if (back <= edgeLevel - P.proudBlockMinRelief) isRiser = true;
                        }
                        if (!across) continue;  // an open edge says nothing either way
                        const double len = (groupPos[a] - groupPos[b]).norm();
                        outline += len;
                        if (isRiser) riser += len;
                    }
                if (std::getenv("SB_DEBUG_PROUD_BLOCKS")) {
                    V3 c;
                    double mx = 0;
                    for (uint32_t t : faces) {
                        c += triC0[t] * triA0[t];
                        for (int k = 0; k < 3; ++k) mx = std::max(mx, sgn * res(R, triG[t][k]));
                    }
                    c = c * (1.0 / area);
                    std::fprintf(stderr, "proud patch %s side %+d faces %zu area %.2f relief %.3f outline %.2f riser %.2f (%.2f) at (%.2f %.2f %.2f) region area %.0f\n",
                                 riser >= P.proudBlockMinRiserShare * outline ? "BLOCK" : "-", static_cast<int>(sgn), faces.size(), area, mx, outline, riser,
                                 outline > 0 ? riser / outline : 0.0, c.x, c.y, c.z, R.area);
                }
                if (!(outline > 0) || riser < P.proudBlockMinRiserShare * outline) continue;
                ++S.proudBlocks;
                S.proudBlockFaces += faces.size();
                S.proudBlockArea += area;
                // flat at one level: snapped onto the wall's plane at that level (median of its vertices); else as scanned
                std::vector<uint32_t> gs;
                for (uint32_t t : faces) for (int k = 0; k < 3; ++k) gs.push_back(triG[t][k]);
                std::sort(gs.begin(), gs.end());
                gs.erase(std::unique(gs.begin(), gs.end()), gs.end());
                std::vector<double> lv;
                for (uint32_t g : gs) lv.push_back(res(R, g));
                const auto [mnIt, mxIt] = std::minmax_element(lv.begin(), lv.end());
                std::vector<double> sorted = lv;
                std::nth_element(sorted.begin(), sorted.begin() + static_cast<std::ptrdiff_t>(sorted.size() / 2), sorted.end());
                const double level = sorted[sorted.size() / 2];
                const bool flatBlock = *mxIt - *mnIt <= std::max(P.proudBlockFlatSpread, P.proudBlockFlatSpreadOfRelief * std::abs(level));
                const uint32_t r = static_cast<uint32_t>(triRegion[faces[0]]);
                if (flatBlock) ++S.proudBlocksLevelled;
                for (uint32_t g : gs) {
                    if (flatBlock) {
                        auto& acc = reliefVertex[(static_cast<uint64_t>(g) << 32) | r];
                        acc.first += level;
                        ++acc.second;
                        if (proudBlockGroup[g] != 1) proudBlockGroup[g] = 2;  // a vertex another block keeps as scanned stays so
                    } else {
                        proudBlockGroup[g] = 1;
                    }
                }
            }
            for (uint8_t b : proudBlockGroup) { S.proudBlockGroups += b != 0; S.proudBlockFrozenGroups += b == 1; }
        }

        // ------------------------------------------------------------------
        // D6: constrained snapping per weld group
        double strength(double res, double tau) const {
            double a = std::abs(res);
            if (a >= tau) return 0.0;
            double full = P.fullStrengthFraction * tau;
            if (a <= full) return 1.0;
            return (tau - a) / std::max(1e-12, tau - full);
        }

        void snapGroups() {
            // region lookup grid over grown support boxes
            const double cell = 8.0;
            std::unordered_map<int64_t, std::vector<uint32_t>, detail::CellKeyHash> rgrid;
            auto ci = [&](double v) { return static_cast<int64_t>(std::floor(v / cell)); };
            for (uint32_t r = 0; r < regions.size(); ++r) {
                const auto& R = regions[r];
                V3 lo{1e300, 1e300, 1e300}, hi{-1e300, -1e300, -1e300};
                for (int a = 0; a < 2; ++a) for (int b = 0; b < 2; ++b) for (int c = 0; c < 2; ++c) {
                    double s1 = a ? R.hi1 + P.supportGrow : R.lo1 - P.supportGrow;
                    double s2 = b ? R.hi2 + P.supportGrow : R.lo2 - P.supportGrow;
                    const double reach = (P.meltCaptureRange > 0 && R.cls == 0 && !R.sheet) ? std::max(R.tau, P.meltCaptureRange) : R.tau;
                    double sn = R.d + (c ? reach : -reach);
                    V3 q = R.t1 * s1 + R.t2 * s2 + R.n * sn;
                    lo = V3{std::min(lo.x, q.x), std::min(lo.y, q.y), std::min(lo.z, q.z)};
                    hi = V3{std::max(hi.x, q.x), std::max(hi.y, q.y), std::max(hi.z, q.z)};
                }
                for (int64_t x = ci(lo.x); x <= ci(hi.x); ++x)
                    for (int64_t y = ci(lo.y); y <= ci(hi.y); ++y)
                        for (int64_t z = ci(lo.z); z <= ci(hi.z); ++z) rgrid[detail::cellKey(x, y, z)].push_back(r);
            }
            // movable groups: touch a visible (kept) triangle
            std::vector<uint8_t> movable(G, 0);
            for (size_t t = 0; t < F; ++t) if (visible[t]) for (int k = 0; k < 3; ++k) movable[triG[t][k]] = 1;
            for (size_t g = 0; g < G; ++g) S.movableGroups += movable[g];

            // parapet-top groups: top vertices of wall-region triangles that also touch an up-facing cap
            std::vector<double> parapetY(G, std::numeric_limits<double>::quiet_NaN());
            std::vector<double> parapetArea(G, 0.0);
            if (P.alignTiers && !tierPeaks.empty()) {
                for (size_t t = 0; t < F; ++t) {
                    if (!visible[t] || triRegion[t] < 0 || regions[static_cast<size_t>(triRegion[t])].cls != 0) continue;
                    double ymax = std::max({P0[tri[t][0]].y, P0[tri[t][1]].y, P0[tri[t][2]].y});
                    for (int k = 0; k < 3; ++k) {
                        uint32_t g = triG[t][k];
                        if (!std::isnan(parapetY[g]) || groupPos[g].y < ymax - 0.01) continue;
                        bool cap = false;
                        for (uint32_t q = groupTriStart[g]; q < groupTriStart[g + 1] && !cap; ++q) {
                            uint32_t t2 = groupTris[q];
                            if (visible[t2] && triN0[t2].y > P.tierCapMinNy) cap = true;
                        }
                        if (!cap) continue;
                        bool found = false;
                        double pa = 0;
                        double py = nearestTierPeak(groupPos[g].x, groupPos[g].y, groupPos[g].z, P.tierParapetTolerance, found, &pa);
                        if (found) { parapetY[g] = py; parapetArea[g] = pa; ++S.parapetGroups; }
                    }
                }
            }
            const double cosCorner = std::cos(detail::degToRad(P.cornerMinAngleDeg));
            const double sinCorner = std::sin(detail::degToRad(P.cornerMinAngleDeg));
            const double cosMeltParallel = std::cos(detail::degToRad(P.meltParallelDeg));
            const double cosParallel = std::cos(detail::degToRad(P.normalAgreementDeg));
            std::vector<uint8_t> kind(G, 0);
            std::atomic<size_t> facingRejected{0};
            detail::parallelFor(G, threads, 1024, [&](size_t b, size_t e, unsigned) {
                std::vector<Candidate> cands;
                std::vector<V3> ownN;
                for (size_t g = b; g < e; ++g) {
                    if (!movable[g] || (!proudBlockGroup.empty() && proudBlockGroup[g] == 1)) continue;
                    const V3 p = groupPos[g];
                    cands.clear();
                    ownN.clear();
                    for (uint32_t q = groupTriStart[g]; q < groupTriStart[g + 1]; ++q) {
                        const uint32_t t = groupTris[q];
                        if (visible[t] && triA0[t] > 1e-8) ownN.push_back(triN0[t]);
                    }
                    // a plane the vertex does not belong to must not face away from all of its faces
                    auto facesAway = [&](const V3& n) {
                        double mx = -2;
                        for (const V3& m : ownN) mx = std::max(mx, m.dot(n));
                        return mx < P.foreignMinFacingDot;
                    };
                    auto ownsRegion = [&](uint32_t r) {
                        for (uint32_t q = groupTriStart[g]; q < groupTriStart[g + 1]; ++q) {
                            uint32_t t = groupTris[q];
                            if (visible[t] && triRegion[t] == static_cast<int32_t>(r)) return true;
                        }
                        return false;
                    };
                    // the vertex's own faces in wall region r are (almost) all tilted against its plane: a melted facet
                    auto meltOf = [&](uint32_t r) {
                        const V3& n = regions[r].n;
                        double own = 0, par = 0;
                        for (uint32_t q = groupTriStart[g]; q < groupTriStart[g + 1]; ++q) {
                            const uint32_t t = groupTris[q];
                            if (!visible[t] || triRegion[t] != static_cast<int32_t>(r)) continue;
                            own += triA0[t];
                            if (std::abs(triN0[t].dot(n)) >= cosMeltParallel) par += triA0[t];
                        }
                        return own > 0 && par <= P.meltMaxParallelShare * own;
                    };
                    auto it = rgrid.find(detail::cellKey(ci(p.x), ci(p.y), ci(p.z)));
                    if (it != rgrid.end()) {
                        for (uint32_t r : it->second) {
                            const auto& R = regions[r];
                            double res = R.n.dot(p) - R.d;
                            const bool meltRange = P.meltCaptureRange > 0 && R.cls == 0 && !R.sheet;
                            if (std::abs(res) > (meltRange ? std::max(R.tau, P.meltCaptureRange) : R.tau)) continue;
                            double a1 = R.t1.dot(p), a2 = R.t2.dot(p);
                            if (a1 < R.lo1 - P.supportGrow || a1 > R.hi1 + P.supportGrow) continue;
                            if (a2 < R.lo2 - P.supportGrow || a2 > R.hi2 + P.supportGrow) continue;
                            const bool own = ownsRegion(r);
                            const bool melt = meltRange && own && std::abs(res) > P.fullStrengthFraction * R.tau && meltOf(r);
                            if (std::abs(res) > R.tau && !melt) continue;
                            if (!own && facesAway(R.n)) { facingRejected.fetch_add(1, std::memory_order_relaxed); continue; }
                            // a vertex of a relief panel is snapped onto its wall's plane at the panel's own level
                            if (own && !reliefVertex.empty()) {
                                auto rv = reliefVertex.find((static_cast<uint64_t>(g) << 32) | r);
                                if (rv != reliefVertex.end()) res -= rv->second.first / rv->second.second;
                            }
                            cands.push_back({R.n, R.d, res, R.tau, R.area, own, R.sheet, melt});
                        }
                    }
                    if (!std::isnan(parapetY[g])) cands.push_back({V3{0, 1, 0}, parapetY[g], p.y - parapetY[g], P.tierParapetTolerance, parapetArea[g], false, false});
                    if (cands.empty()) continue;
                    // Structural dominance: the vertex sits on the largest plane it belongs to (P1); corner and
                    // cornice lines come from the largest supporting planes at least cornerMinAngle away (P2, P3).
                    // Small facets (chunk cuts, crinkles) therefore never capture a face's vertices.
                    std::sort(cands.begin(), cands.end(), [](const Candidate& a, const Candidate& c) {
                        if (a.area != c.area) return a.area > c.area;
                        return std::abs(a.res) < std::abs(c.res);
                    });
                    const Candidate* p1 = nullptr;
                    for (const auto& c : cands) if (c.own) { p1 = &c; break; }
                    if (!p1 && !(P.foreignPlaneSnap || (P.seamPartnerSnap && !seamVar.empty() && seamVar[g] >= 0))) continue;
                    if (!p1) p1 = &cands[0];
                    // A vertex of a relief sheet stays on its own level: wherever a chosen plane has own planes facing
                    // the same way and one of them is a sheet, the nearest of them is used instead.
                    auto preferSheet = [&](const Candidate* c0) {
                        const Candidate* near = c0;
                        bool anySheet = c0->own && c0->sheet;
                        for (const auto& c : cands) {
                            if (!c.own || &c == c0 || c.n.dot(c0->n) < cosParallel) continue;
                            anySheet = anySheet || c.sheet;
                            if (std::abs(c.res) < std::abs(near->res)) near = &c;
                        }
                        return anySheet ? near : c0;
                    };
                    p1 = preferSheet(p1);
                    std::vector<const Candidate*> sel{p1};
                    for (const auto& c : cands) {
                        if (&c == p1) continue;
                        if (std::abs(c.n.dot(p1->n)) <= cosCorner) { sel.push_back(preferSheet(&c)); break; }
                    }
                    if (sel.size() == 2) {
                        V3 l = sel[0]->n.cross(sel[1]->n).normalized();
                        for (const auto& c : cands) {
                            if (&c == sel[0] || &c == sel[1]) continue;
                            if (std::abs(c.n.dot(sel[0]->n)) > cosCorner || std::abs(c.n.dot(sel[1]->n)) > cosCorner) continue;
                            if (std::abs(c.n.dot(l)) < sinCorner) continue;
                            sel.push_back(preferSheet(&c));
                            break;
                        }
                    }
                    V3 dlt;
                    int used = 0;
                    for (int k = static_cast<int>(sel.size()); k >= 1; --k) {
                        double Gm[3][3], r[3], x[3];
                        for (int a = 0; a < k; ++a) {
                            const Candidate& ca = *sel[static_cast<size_t>(a)];
                            r[a] = -(ca.melt ? 1.0 : strength(ca.res, ca.tau)) * ca.res;
                            for (int c = 0; c < k; ++c) Gm[a][c] = sel[static_cast<size_t>(a)]->n.dot(sel[static_cast<size_t>(c)]->n);
                        }
                        if (!detail::solveSmall(k, Gm, r, x)) continue;
                        V3 cand;
                        for (int a = 0; a < k; ++a) cand += sel[static_cast<size_t>(a)]->n * x[a];
                        if (k >= 2 && cand.norm() > P.tauCorner) continue;
                        dlt = cand;
                        used = k;
                        break;
                    }
                    if (!used) continue;
                    double m = dlt.norm();
                    // dead band: a vertex already this close to its target is left exactly as scanned
                    if (m < P.snapDeadBand) continue;
                    if (m > P.maxDisplacement) { dlt = dlt * (P.maxDisplacement / m); kind[g] |= 8; }
                    delta[g] = dlt;
                    kind[g] |= static_cast<uint8_t>(used);
                    // a vertical corner line (two walls) or a corner point: a building corner being sharpened
                    if (used == 3 || (used == 2 && std::abs(sel[0]->n.cross(sel[1]->n).normalized().y) > 0.9)) kind[g] |= 16;
                }
            });
            for (size_t g = 0; g < G; ++g) {
                int k = kind[g] & 7;
                if (k == 1) ++S.snappedGroups1; else if (k == 2) ++S.snappedGroups2; else if (k == 3) ++S.snappedGroups3;
                if (kind[g] & 8) ++S.cappedGroups;
            }
            S.foreignRejectedFacing = facingRejected.load();
            snapKind = kind;
        }

        // ------------------------------------------------------------------
        // D10 (optional): crease-preserving bilateral normal filtering on surfaces no plane claimed
        void denoiseUnclassified() {
            std::vector<uint8_t> eligible(G, 0);
            for (size_t g = 0; g < G; ++g) {
                if (delta[g].norm() > 0) continue;
                bool anyVisible = false, anyRegion = false, steep = true;
                for (uint32_t q = groupTriStart[g]; q < groupTriStart[g + 1]; ++q) {
                    uint32_t t = groupTris[q];
                    if (visible[t]) {
                        anyVisible = true;
                        if (std::abs(triN0[t].y) >= P.denoiseMaxAbsNy) steep = false;
                    }
                    if (triRegion[t] >= 0) anyRegion = true;
                }
                // near-vertical surfaces only: crinkle is scan noise there, while roofs and terrain undulate for real
                eligible[g] = anyVisible && !anyRegion && steep;
            }
            std::vector<V3> pos(G);
            for (size_t g = 0; g < G; ++g) pos[g] = groupPos[g];
            auto triNormal = [&](size_t t, V3& c, double& a) {
                const V3 &p0 = pos[triG[t][0]], &p1 = pos[triG[t][1]], &p2 = pos[triG[t][2]];
                V3 n = (p1 - p0).cross(p2 - p0);
                a = 0.5 * n.norm();
                c = (p0 + p1 + p2) * (1.0 / 3.0);
                return n.normalized();
            };
            for (int it = 0; it < P.denoiseIterations; ++it) {
                std::vector<V3> fn(F), fc(F);
                std::vector<double> fa(F);
                for (size_t t = 0; t < F; ++t) fn[t] = triNormal(t, fc[t], fa[t]);
                // filtered normals over the one-ring of each triangle's vertices
                std::vector<V3> filtered(F);
                for (size_t t = 0; t < F; ++t) {
                    if (!visible[t] || triRegion[t] >= 0) { filtered[t] = fn[t]; continue; }
                    V3 acc;
                    for (int k = 0; k < 3; ++k) {
                        uint32_t g = triG[t][k];
                        for (uint32_t q = groupTriStart[g]; q < groupTriStart[g + 1]; ++q) {
                            uint32_t t2 = groupTris[q];
                            if (!visible[t2]) continue;
                            double ds = (fc[t2] - fc[t]).norm();
                            double dn = (fn[t2] - fn[t]).norm();
                            double wgt = fa[t2] * std::exp(-ds * ds / (2 * P.denoiseSigmaSpatial * P.denoiseSigmaSpatial)) *
                                         std::exp(-dn * dn / (2 * P.denoiseSigmaNormal * P.denoiseSigmaNormal));
                            acc += fn[t2] * wgt;
                        }
                    }
                    filtered[t] = acc.normalized();
                }
                std::vector<V3> np = pos;
                for (size_t g = 0; g < G; ++g) {
                    if (!eligible[g]) continue;
                    V3 move;
                    double wsum = 0;
                    for (uint32_t q = groupTriStart[g]; q < groupTriStart[g + 1]; ++q) {
                        uint32_t t = groupTris[q];
                        if (!visible[t]) continue;
                        const V3& n = filtered[t];
                        move += n * n.dot(fc[t] - pos[g]);
                        wsum += 1.0;
                    }
                    if (wsum > 0) np[g] = pos[g] + move * (1.0 / wsum);
                    V3 tot = np[g] - groupPos[g];
                    double m = tot.norm();
                    if (m > P.denoiseMaxMove) np[g] = groupPos[g] + tot * (P.denoiseMaxMove / m);
                }
                pos.swap(np);
            }
            for (size_t g = 0; g < G; ++g) {
                if (!eligible[g]) continue;
                V3 d = pos[g] - groupPos[g];
                if (d.norm() >= std::max(1e-6, P.snapDeadBand)) { delta[g] = d; ++S.denoisedGroups; }
            }
        }

        // ------------------------------------------------------------------
        // Triangle geometry at the current displacements
        V3 vpos(uint32_t v) const { return P0[v] + delta[groupOf[v]]; }

        void triAfter(size_t t, V3& n, double& a) const {
            const V3 p0 = vpos(tri[t][0]), p1 = vpos(tri[t][1]), p2 = vpos(tri[t][2]);
            V3 c = (p1 - p0).cross(p2 - p0);
            double l = c.norm();
            a = 0.5 * l;
            n = l > 1e-300 ? c * (1.0 / l) : V3{0, 0, 0};
        }

        /** The edit collapsed this bevel/sliver: next to nothing is left of it, and no visible slit. */
        bool isCollapsed(size_t t, double a1) const {
            if (!(triA0[t] > P.collapseFromArea) || !(a1 < std::max(P.collapseToArea, P.collapseToRatio * triA0[t]))) return false;
            if (a1 < P.collapseToArea) return true;
            double lmax = 0;
            for (int k = 0; k < 3; ++k) lmax = std::max(lmax, (vpos(tri[t][(k + 1) % 3]) - vpos(tri[t][k])).norm());
            return lmax > 0 && 2.0 * a1 / lmax < P.collapseMaxSlit;
        }

        bool touchesMoved(size_t t) const {
            return delta[triG[t][0]].norm() > 0 || delta[triG[t][1]].norm() > 0 || delta[triG[t][2]].norm() > 0;
        }

        /** Largest singular value of the in-plane affine map from the input triangle to the current one. */
        double stretchOf(size_t t) const {
            auto frame = [](const V3& a, const V3& b, const V3& c, double M[2][2]) {
                const V3 e1 = b - a, e2 = c - a;
                const double l1 = e1.norm();
                const V3 nn = e1.cross(e2);
                const double ln = nn.norm();
                if (l1 < 1e-12 || ln < 1e-18) return false;
                const V3 u = e1 * (1.0 / l1);
                const V3 v = (nn * (1.0 / ln)).cross(u);
                M[0][0] = l1; M[0][1] = e2.dot(u);
                M[1][0] = 0;  M[1][1] = e2.dot(v);
                return true;
            };
            double A[2][2], B[2][2];
            if (!frame(P0[tri[t][0]], P0[tri[t][1]], P0[tri[t][2]], A)) return 1.0;
            if (!frame(vpos(tri[t][0]), vpos(tri[t][1]), vpos(tri[t][2]), B)) return 0.0;
            const double det = A[0][0] * A[1][1] - A[0][1] * A[1][0];
            if (std::abs(det) < 1e-18) return 1.0;
            const double inv[2][2] = {{A[1][1] / det, -A[0][1] / det}, {-A[1][0] / det, A[0][0] / det}};
            double Fm[2][2];
            for (int r = 0; r < 2; ++r) for (int c = 0; c < 2; ++c) Fm[r][c] = B[r][0] * inv[0][c] + B[r][1] * inv[1][c];
            const double p = Fm[0][0] * Fm[0][0] + Fm[0][1] * Fm[0][1] + Fm[1][0] * Fm[1][0] + Fm[1][1] * Fm[1][1];
            const double q = Fm[0][0] * Fm[1][1] - Fm[0][1] * Fm[1][0];
            return std::sqrt(0.5 * p + std::sqrt(std::max(0.0, 0.25 * p * p - q * q)));
        }

        enum : uint8_t { kBadFlip = 1, kBadShrink = 2, kBadTurn = 4, kBadStretch = 8 };

        /** D9 per-triangle guard: flips, collapse-free shrinking, large turns of area-keeping faces, texture stretch. */
        /** Diagnostics (SB_DEBUG_FLIPS): kept triangles whose normal turned against the input one. */
        void debugFlips(const char* where) const {
            if (!std::getenv("SB_DEBUG_FLIPS")) return;
            size_t n = 0, bad = 0;
            for (size_t t = 0; t < F; ++t) {
                if (flags[t] != kFlagKeep || triA0[t] < 1e-8) continue;
                V3 n1;
                double a1;
                triAfter(t, n1, a1);
                if (a1 < 1e-8) continue;
                if (n1.dot(triN0[t]) < 0) { if (n < 3) std::fprintf(stderr, "  flip %zu bad=%d at %s\n", t, triBadness(t), where); ++n; }
                if (triBadness(t)) ++bad;
            }
            std::fprintf(stderr, "rectifier flips after %-28s %zu (guard-bad kept triangles %zu)\n", where, n, bad);
            if (const char* dt = std::getenv("SB_DEBUG_TRI")) {
                const size_t t = static_cast<size_t>(std::atoll(dt));
                if (t < F) {
                    V3 n1;
                    double a1;
                    triAfter(t, n1, a1);
                    std::fprintf(stderr, "  tri %zu flag %d a0 %.4g a1 %.4g dot %.3f bad %d collapsed %d seamVars %d %d %d delta %.3f %.3f %.3f\n", t, flags[t], triA0[t], a1,
                                 n1.dot(triN0[t]), triBadness(t), isCollapsed(t, a1) ? 1 : 0,
                                 seamVar.empty() ? -2 : seamVar[triG[t][0]], seamVar.empty() ? -2 : seamVar[triG[t][1]], seamVar.empty() ? -2 : seamVar[triG[t][2]],
                                 delta[triG[t][0]].norm(), delta[triG[t][1]].norm(), delta[triG[t][2]].norm());
                }
            }
        }

        uint8_t triBadness(size_t t) const {
            if (triA0[t] < 1e-8) return 0;
            V3 n1;
            double a1;
            triAfter(t, n1, a1);
            if (isCollapsed(t, a1)) return 0;  // a bevel collapsing to nothing is dropped, not distorted
            const double dot = n1.dot(triN0[t]);
            const double ratio = a1 / triA0[t];
            uint8_t r = 0;
            if (dot < P.guardMinNormalDot) r |= kBadFlip;
            if (ratio < P.guardMinAreaRatio) r |= kBadShrink;
            if (P.guardMaxTurnDeg > 0 && ratio >= P.guardTurnMinAreaRatio && dot < std::cos(detail::degToRad(P.guardMaxTurnDeg))) r |= kBadTurn;
            if (P.guardPlaneMaxTurnDeg > 0 && ratio >= P.guardTurnMinAreaRatio && t < triRegion.size() && triRegion[t] >= 0) {
                V3 nr = regions[static_cast<size_t>(triRegion[t])].n;
                if (nr.dot(triN0[t]) < 0) nr = nr * -1.0;
                if (triN0[t].dot(nr) >= std::cos(detail::degToRad(P.guardPlaneFaceDeg)) && n1.dot(nr) < std::cos(detail::degToRad(P.guardPlaneMaxTurnDeg))) r |= kBadTurn;
            }
            if (P.guardMaxStretch > 0 && stretchOf(t) > P.guardMaxStretch) r |= kBadStretch;
            return r;
        }

        // ------------------------------------------------------------------
        // D9 protected creases: welded edges of two kept triangles whose input dihedral is at least
        // creaseKeepDeg. Snapping may sharpen them but never soften them below that angle.
        void buildProtectedCreases() {
            creases.clear();
            if (P.creaseKeepDeg <= 0) return;
            struct Half { uint64_t key; uint32_t t; uint32_t apex; };
            std::vector<Half> hs;
            hs.reserve(F * 3);
            for (size_t t = 0; t < F; ++t) {
                if (flags[t] != kFlagKeep || triA0[t] <= 1e-9) continue;
                for (int k = 0; k < 3; ++k) {
                    uint32_t a = triG[t][k], b = triG[t][(k + 1) % 3];
                    if (a == b) continue;
                    hs.push_back({(static_cast<uint64_t>(std::min(a, b)) << 32) | std::max(a, b), static_cast<uint32_t>(t), triG[t][(k + 2) % 3]});
                }
            }
            std::sort(hs.begin(), hs.end(), [](const Half& x, const Half& y) { return x.key != y.key ? x.key < y.key : x.t < y.t; });
            const double cosKeep = std::cos(detail::degToRad(P.creaseKeepDeg));
            for (size_t i = 0; i < hs.size();) {
                size_t j = i;
                while (j < hs.size() && hs[j].key == hs[i].key) ++j;
                if (j - i == 2) {
                    const Half &x = hs[i], &y = hs[i + 1];
                    const double dt = triN0[x.t].dot(triN0[y.t]);
                    const bool real = dt <= cosKeep;
                    if (real || P.creaseMaxSharpenDeg >= 0) {
                        CreaseEdge e;
                        e.t1 = x.t; e.t2 = y.t;
                        e.real = real;
                        e.ang0Deg = detail::radToDeg(std::acos(std::clamp(dt, -1.0, 1.0)));
                        e.g[0] = static_cast<uint32_t>(x.key >> 32); e.g[1] = static_cast<uint32_t>(x.key & 0xffffffffu);
                        e.g[2] = x.apex; e.g[3] = y.apex;
                        creases.push_back(e);
                    }
                }
                i = j;
            }
            for (const auto& e : creases) if (e.real) ++S.protectedCreases;
        }

        /** The crease ends below creaseKeepDeg having lost more than creaseMaxSoftenDeg of its input angle. */
        bool creaseSoftened(const CreaseEdge& e) const {
            V3 n1, n2;
            double a1, a2;
            triAfter(e.t1, n1, a1);
            triAfter(e.t2, n2, a2);
            if (isCollapsed(e.t1, a1) || isCollapsed(e.t2, a2) || a1 < 1e-9 || a2 < 1e-9) return false;
            if (e.real && (a1 < P.creaseShrinkExempt * triA0[e.t1] || a2 < P.creaseShrinkExempt * triA0[e.t2])) return false;
            const double ang = detail::radToDeg(std::acos(std::clamp(n1.dot(n2), -1.0, 1.0)));
            if (e.real) return ang < P.creaseKeepDeg && ang < e.ang0Deg - P.creaseMaxSoftenDeg;
            return P.creaseMaxSharpenDeg >= 0 && ang >= P.creaseKeepDeg && ang > e.ang0Deg + P.creaseMaxSharpenDeg;
        }

        /** Two faces of a crease folded back onto each other (back to back, coplanar): never by an edit. */
        bool creaseFolded(const CreaseEdge& e) const {
            if (P.guardFoldDeg <= 0 || P.guardFoldDeg >= 180 || e.ang0Deg >= P.guardFoldDeg) return false;
            V3 n1, n2;
            double a1, a2;
            triAfter(e.t1, n1, a1);
            triAfter(e.t2, n2, a2);
            if (a1 < 1e-9 || a2 < 1e-9) return false;
            const double ang = detail::radToDeg(std::acos(std::clamp(n1.dot(n2), -1.0, 1.0)));
            return ang >= P.guardFoldDeg;
        }

        /** Marks the groups of every kept triangle or protected crease the current displacements damage. */
        size_t collectBad(std::vector<uint8_t>& mark, bool countReasons, bool includeOpposed = true) {
            std::fill(mark.begin(), mark.end(), 0);
            std::vector<uint8_t> badTri(F, 0);
            detail::parallelFor(F, threads, 2048, [&](size_t b, size_t e, unsigned) {
                for (size_t t = b; t < e; ++t) {
                    if (flags[t] != kFlagKeep || !touchesMoved(t)) continue;
                    badTri[t] = triBadness(t);
                }
            });
            std::vector<uint8_t> badCrease(creases.size(), 0);
            detail::parallelFor(creases.size(), threads, 2048, [&](size_t b, size_t e, unsigned) {
                for (size_t i = b; i < e; ++i) {
                    const CreaseEdge& ce = creases[i];
                    bool moved = false;
                    for (int k = 0; k < 4; ++k) if (delta[ce.g[k]].norm() > 0) moved = true;
                    if (!moved) continue;
                    if (ce.real && creaseFolded(ce)) badCrease[i] = 2;
                    else if (creaseSoftened(ce)) badCrease[i] = 1;
                }
            });
            std::vector<uint8_t> badPair(opposed.size(), 0);
            detail::parallelFor(opposed.size(), threads, 4096, [&](size_t b, size_t e, unsigned) {
                for (size_t i = b; i < e; ++i) badPair[i] = opposedViolated(opposed[i]) ? 1 : 0;
            });
            size_t nbad = 0;
            lastReasons.fill(0);
            // the seam solve combines targets; its result must still respect the displacement budget
            if (everMarked.size() != G) everMarked.assign(G, 0);
            for (size_t g = 0; g < G; ++g) {
                if (delta[g].norm() > P.maxDisplacement + 1e-9) { mark[g] = 1; everMarked[g] |= 1; ++nbad; ++lastReasons[0]; if (countReasons) ++S.guardBudget; }
            }
            for (size_t t = 0; t < F; ++t) {
                if (!badTri[t]) continue;
                ++nbad;
                const uint8_t why = static_cast<uint8_t>(((badTri[t] & kBadFlip) ? 2 : 0) | ((badTri[t] & kBadShrink) ? 4 : 0) | ((badTri[t] & kBadStretch) ? 8 : 0) | ((badTri[t] & kBadTurn) ? 64 : 0));
                for (int k = 0; k < 3; ++k) { mark[triG[t][k]] = 1; everMarked[triG[t][k]] |= why; }
                if (badTri[t] & kBadFlip) ++lastReasons[1];
                if (badTri[t] & kBadShrink) ++lastReasons[2];
                if (badTri[t] & kBadStretch) ++lastReasons[3];
                if (badTri[t] & kBadTurn) ++lastReasons[6];
                if (countReasons) {
                    if (badTri[t] & kBadFlip) ++S.guardFlip;
                    if (badTri[t] & kBadShrink) ++S.guardShrink;
                    if (badTri[t] & kBadTurn) ++S.guardTurn;
                    if (badTri[t] & kBadStretch) ++S.guardStretch;
                }
            }
            for (size_t i = 0; i < creases.size(); ++i) {
                if (!badCrease[i]) continue;
                // hold back the face that turned more (the one being flattened), not the plane it meets; a vertex
                // snapped onto a building corner (vertical wall/wall line, or a corner point) defines a structural
                // crease and is not held back for softening another one (a fold is never exempt)
                const CreaseEdge& ce = creases[i];
                const bool fold = badCrease[i] == 2;
                V3 n1, n2;
                double a1, a2;
                triAfter(ce.t1, n1, a1);
                triAfter(ce.t2, n2, a2);
                const size_t tt = n1.dot(triN0[ce.t1]) <= n2.dot(triN0[ce.t2]) ? ce.t1 : ce.t2;
                bool any = false;
                for (int k = 0; k < 3; ++k) {
                    const uint32_t g = triG[tt][k];
                    if (!(delta[g].norm() > 0) || (!fold && P.creaseExemptLineSnaps && !snapKind.empty() && (snapKind[g] & 16))) continue;
                    mark[g] = 1;
                    everMarked[g] |= fold ? 128 : 16;
                    any = true;
                }
                if (!any) continue;
                ++nbad;
                ++lastReasons[fold ? 5 : 4];
                if (countReasons) { if (fold) ++S.guardFold; else ++S.guardCrease; }
            }
            if (countReasons) {
                opposedFirstBad = badPair;
                for (uint8_t b : badPair) S.guardOpposed += b;
            }
            for (size_t i = 0; includeOpposed && i < opposed.size(); ++i) {
                if (!badPair[i]) continue;
                const OpposedPair& q = opposed[i];
                bool any = false;
                for (uint32_t t : {q.t, q.u}) for (int k = 0; k < 3; ++k) {
                    const uint32_t g = triG[t][k];
                    if (!(delta[g].norm() > 0)) continue;
                    mark[g] = 1;
                    everMarked[g] |= 128;
                    any = true;
                }
                if (!any) continue;
                ++nbad;
                ++lastReasons[7];
            }
            return nbad;
        }

        // ------------------------------------------------------------------
        // D9 opposed sheets: two kept faces back to back (the two sides of a thin wall, a parapet or a fin).
        // A ray from a sample point of face t into its own back (-n_t) that first meets a kept face u facing
        // away from t records the pair; the edit must keep t in front of u (signed distance of t's sample
        // behind u's plane) by min(opposedKeepFraction x input gap, opposedKeepMin).
        struct OpposedPair { uint32_t t, u; float wt[3], wu[3]; float gap0; };
        std::vector<OpposedPair> opposed;
        std::vector<uint8_t> opposedFirstBad;  // diagnostics: violated by the unguarded solve
        std::vector<uint8_t> opposedBeforeZero;// diagnostics: still violated when the zeroing passes start
        std::array<size_t, 8> lastReasons{};    // diagnostics: budget, flip, shrink, stretch, crease, fold, turn, opposed

        void buildOpposedPairs() {
            opposed.clear();
            if (!P.guardOpposed) return;
            std::vector<std::vector<OpposedPair>> perThread(threads);
            detail::parallelFor(F, threads, 512, [&](size_t b, size_t e, unsigned th) {
                auto& out = perThread[th];
                for (size_t t = b; t < e; ++t) {
                    if (flags[t] != kFlagKeep || triA0[t] < 1e-4) continue;
                    const V3 n = triN0[t];
                    const V3 &a = P0[tri[t][0]], &bb = P0[tri[t][1]], &c = P0[tri[t][2]];
                    const int ns = std::clamp(static_cast<int>(std::ceil(triA0[t] / std::max(1e-6, P.opposedSampleArea))), 4, 16);
                    // the centroid, three points next to the corners (snapping moves vertices, so a corner crosses
                    // first) and low-discrepancy points over the face
                    for (int k = 0; k < ns + 3; ++k) {
                        double w0, w1, w2;
                        if (k == 0) { w0 = w1 = w2 = 1.0 / 3.0; }
                        else if (k > ns - 1) {
                            const int c = k - ns;  // 0..2
                            const double e = 0.02;
                            w0 = c == 0 ? 1.0 - 2.0 * e : e; w1 = c == 1 ? 1.0 - 2.0 * e : e; w2 = c == 2 ? 1.0 - 2.0 * e : e;
                        } else {
                            const double r1 = detail::radicalInverse(3, static_cast<uint32_t>(k)), r2 = detail::radicalInverse(5, static_cast<uint32_t>(k));
                            const double su = std::sqrt(r1);
                            w0 = 1.0 - su; w1 = su * (1.0 - r2); w2 = su * r2;
                            const double m = 0.1;  // stay off the edges
                            w0 = (1 - m) * w0 + m / 3; w1 = (1 - m) * w1 + m / 3; w2 = (1 - m) * w2 + m / 3;
                        }
                        const V3 p = a * w0 + bb * w1 + c * w2;
                        const V3 d = n * -1.0;
                        double th2;
                        const int64_t u = sbvh.closest(p, d, 1e-5, P.opposedMaxGap, th2, [&](uint32_t q) {
                            return q != t && flags[q] == kFlagKeep && triA0[q] > 1e-6;
                        });
                        if (u < 0) continue;
                        const size_t uu = static_cast<size_t>(u);
                        if (triN0[uu].dot(n) > P.opposedMaxDot) continue;
                        const V3 h = p + d * th2;
                        double wu[3];
                        closestOnTriangle(h, P0[tri[uu][0]], P0[tri[uu][1]], P0[tri[uu][2]], wu);
                        const double s0 = (p - h).dot(triN0[uu]);
                        if (!(s0 < -1e-3)) continue;
                        OpposedPair q;
                        q.t = static_cast<uint32_t>(t); q.u = static_cast<uint32_t>(uu);
                        q.wt[0] = static_cast<float>(w0); q.wt[1] = static_cast<float>(w1); q.wt[2] = static_cast<float>(w2);
                        q.wu[0] = static_cast<float>(wu[0]); q.wu[1] = static_cast<float>(wu[1]); q.wu[2] = static_cast<float>(wu[2]);
                        q.gap0 = static_cast<float>(-s0);
                        out.push_back(q);
                    }
                }
            });
            for (auto& v : perThread) opposed.insert(opposed.end(), v.begin(), v.end());
            std::sort(opposed.begin(), opposed.end(), [](const OpposedPair& x, const OpposedPair& y) {
                if (x.t != y.t) return x.t < y.t;
                if (x.u != y.u) return x.u < y.u;
                return x.wt[0] != y.wt[0] ? x.wt[0] < y.wt[0] : x.wt[1] < y.wt[1];
            });
            S.opposedPairs = opposed.size();
        }

        bool opposedViolated(const OpposedPair& q) const {
            if (flags[q.t] != kFlagKeep || flags[q.u] != kFlagKeep) return false;
            bool moved = false;
            for (uint32_t t : {q.t, q.u}) for (int k = 0; k < 3; ++k) if (delta[triG[t][k]].norm() > 0) moved = true;
            if (!moved) return false;
            V3 nu;
            double au;
            triAfter(q.u, nu, au);
            if (au < 1e-9) return false;
            V3 p, h;
            for (int k = 0; k < 3; ++k) { p += vpos(tri[q.t][k]) * q.wt[k]; h += vpos(tri[q.u][k]) * q.wu[k]; }
            const double s = (p - h).dot(nu);
            const double keep = std::min(P.opposedKeepFraction * static_cast<double>(q.gap0), P.opposedKeepMin);
            // sheets that were already (nearly) coincident may shift by a sub-centimetre amount
            return s > -keep && s + static_cast<double>(q.gap0) > P.opposedMinApproach;
        }

        // ------------------------------------------------------------------
        // D8 chunk seams. Tile chunks are not stitched: a boundary vertex of one chunk lies on a
        // boundary edge of another (a T-junction). Every such contact found at the INPUT positions
        // is a linear constraint  delta[g] = (1 - t) delta[a] + t delta[b] + c  so the vertex keeps its
        // place on the partner edge whatever the snapping does to either side; c closes input gaps up
        // to tJunctionTolerance. The snapped displacements are the soft targets of a least-squares
        // solve with the contacts as stiff penalties, so a seam never opens.
        V3 cur(uint32_t g) const { return groupPos[g] + delta[g]; }

        /** Closest point of triangle abc to p, with its barycentric weights (Ericson, Real-Time Collision Detection 5.1.5). */
        static V3 closestOnTriangle(const V3& p, const V3& a, const V3& b, const V3& c, double w[3]) {
            const V3 ab = b - a, ac = c - a, ap = p - a;
            const double d1 = ab.dot(ap), d2 = ac.dot(ap);
            if (d1 <= 0 && d2 <= 0) { w[0] = 1; w[1] = 0; w[2] = 0; return a; }
            const V3 bp = p - b;
            const double d3 = ab.dot(bp), d4 = ac.dot(bp);
            if (d3 >= 0 && d4 <= d3) { w[0] = 0; w[1] = 1; w[2] = 0; return b; }
            const double vc = d1 * d4 - d3 * d2;
            if (vc <= 0 && d1 >= 0 && d3 <= 0) { const double v = d1 / (d1 - d3); w[0] = 1 - v; w[1] = v; w[2] = 0; return a + ab * v; }
            const V3 cp = p - c;
            const double d5 = ab.dot(cp), d6 = ac.dot(cp);
            if (d6 >= 0 && d5 <= d6) { w[0] = 0; w[1] = 0; w[2] = 1; return c; }
            const double vb = d5 * d2 - d1 * d6;
            if (vb <= 0 && d2 >= 0 && d6 <= 0) { const double v = d2 / (d2 - d6); w[0] = 1 - v; w[1] = 0; w[2] = v; return a + ac * v; }
            const double va = d3 * d6 - d5 * d4;
            if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
                const double v = (d4 - d3) / ((d4 - d3) + (d5 - d6));
                w[0] = 0; w[1] = 1 - v; w[2] = v;
                return b + (c - b) * v;
            }
            const double den = 1.0 / (va + vb + vc);
            const double v = vb * den, ww = vc * den;
            w[0] = 1 - v - ww; w[1] = v; w[2] = ww;
            return a + ab * v + ac * ww;
        }

        static double pointSegment(const V3& p, const V3& a, const V3& b, V3& q, double& t) {
            V3 d = b - a;
            double l2 = d.dot(d);
            t = l2 > 1e-300 ? std::clamp((p - a).dot(d) / l2, 0.0, 1.0) : 0.0;
            q = a + d * t;
            return (p - q).norm();
        }

        using EdgeGrid = std::unordered_map<int64_t, std::vector<uint32_t>, detail::CellKeyHash>;

        EdgeGrid edgeGrid(const std::vector<BEdge>& edges, double pad) const {
            const double cell = 2.0;
            EdgeGrid grid;
            auto ci = [&](double v) { return static_cast<int64_t>(std::floor(v / cell)); };
            for (uint32_t e = 0; e < edges.size(); ++e) {
                V3 a = cur(edges[e].a), b = cur(edges[e].b);
                for (int64_t x = ci(std::min(a.x, b.x) - pad); x <= ci(std::max(a.x, b.x) + pad); ++x)
                    for (int64_t y = ci(std::min(a.y, b.y) - pad); y <= ci(std::max(a.y, b.y) + pad); ++y)
                        for (int64_t z = ci(std::min(a.z, b.z) - pad); z <= ci(std::max(a.z, b.z) + pad); ++z)
                            grid[detail::cellKey(x, y, z)].push_back(e);
            }
            return grid;
        }

        /** The boundary edge belongs to a kept triangle that has g as a vertex (a sliver's own far edge). */
        bool sharesTriangle(uint32_t g, const BEdge& E) const {
            for (uint32_t q = groupTriStart[g]; q < groupTriStart[g + 1]; ++q) {
                const uint32_t t = groupTris[q];
                if (flags[t] != kFlagKeep) continue;
                bool ha = false, hb = false;
                for (int k = 0; k < 3; ++k) { ha |= triG[t][k] == E.a; hb |= triG[t][k] == E.b; }
                if (ha && hb) return true;
            }
            return false;
        }

        /** Nearest boundary edge (not incident to g) within maxD that g is not already joined to; -1 when none. */
        int64_t nearestForeignEdge(const std::vector<BEdge>& edges, const EdgeGrid& grid, uint32_t g, uint32_t comp, double maxD, double& dist, double& tOut, V3& qOut) const {
            const double cell = 2.0;
            V3 p = cur(g);
            dist = 1e300;
            int64_t best = -1;
            auto it = grid.find(detail::cellKey(static_cast<int64_t>(std::floor(p.x / cell)), static_cast<int64_t>(std::floor(p.y / cell)), static_cast<int64_t>(std::floor(p.z / cell))));
            if (it == grid.end()) return -1;
            for (uint32_t e : it->second) {
                const BEdge& E = edges[e];
                if (E.a == g || E.b == g) continue;
                if (P.seamWithinPiece ? sharesTriangle(g, E) : E.comp == comp) continue;
                V3 q;
                double t;
                double d = pointSegment(p, cur(E.a), cur(E.b), q, t);
                if (d <= maxD && (d < dist || (d == dist && e < best))) { dist = d; best = e; tOut = t; qOut = q; }
            }
            return best;
        }

        void gapHistogram(std::array<size_t, 6>& hist) const {
            hist.fill(0);
            const double edgesM[6] = {0.0, 0.001, 0.005, 0.01, 0.03, 0.1};
            EdgeGrid grid = edgeGrid(bEdges, 0.1);
            for (size_t i = 0; i < bVerts.size(); ++i) {
                double d, t;
                V3 q;
                if (nearestForeignEdge(bEdges, grid, bVerts[i], bVertComp[i], 0.1, d, t, q) < 0) continue;
                int b = 0;
                for (int k = 0; k < 6; ++k) if (d >= edgesM[k]) b = k;
                hist[static_cast<size_t>(b)]++;
            }
        }

        void gapHistogramAfter() { gapHistogram(S.gapHistogramAfter); }

        // solver data (built once: the system does not change between solves, only targets and weights do)
        std::vector<V3> cDiag;                        // per solver variable: contact part of the Jacobi diagonal
        std::vector<V3> seamWarm;                     // the last solution (warm start of the next solve)
        std::vector<std::array<double, 6>> vFollow;   // per solver variable: projector (xx, yy, zz, xy, xz, yz) onto the
                                                      // normals of the faces it follows (its target there weighs epsilon)
        std::vector<uint32_t> seamNbrStart, seamNbr;  // contact-graph adjacency per solver variable
        size_t seamComponentCount{0};

        void buildSeamContacts() {
            delta.assign(G, V3{});
            contacts.clear();
            seamWarm.clear();
            solverCompVarStart.clear();
            bEdges.clear(); bVerts.clear(); bVertComp.clear();
            seamVar.assign(G, -1);
            seamGroups.clear();
            seamComponent.assign(G, -1);
            // pieces of the kept surface: triangles connected through shared raw vertices (culling can split
            // one tile chunk into pieces whose borders then meet at T-junctions like two chunks do)
            keptComponent.assign(F, UINT32_MAX);
            {
                detail::UnionFind uf(V);
                for (size_t t = 0; t < F; ++t) {
                    if (flags[t] != kFlagKeep) continue;
                    uf.unite(tri[t][0], tri[t][1]);
                    uf.unite(tri[t][0], tri[t][2]);
                }
                for (size_t t = 0; t < F; ++t) if (flags[t] == kFlagKeep) keptComponent[t] = uf.find(tri[t][0]);
            }
            // welded edges of the kept triangles; boundary = used once
            std::unordered_map<uint64_t, std::pair<uint32_t, uint32_t>> edgeCount;  // key -> (count, component)
            edgeCount.reserve(F * 3);
            for (size_t t = 0; t < F; ++t) {
                if (flags[t] != kFlagKeep) continue;
                for (int k = 0; k < 3; ++k) {
                    uint32_t a = triG[t][k], b = triG[t][(k + 1) % 3];
                    if (a == b) continue;
                    uint64_t key = (static_cast<uint64_t>(std::min(a, b)) << 32) | std::max(a, b);
                    auto& e = edgeCount[key];
                    e.first++;
                    e.second = keptComponent[t];
                }
            }
            std::vector<uint32_t> compOfGroup(G, UINT32_MAX);
            std::vector<uint8_t> isB(G, 0);
            for (auto& kv : edgeCount) {
                if (kv.second.first != 1) continue;
                uint32_t a = static_cast<uint32_t>(kv.first >> 32), b = static_cast<uint32_t>(kv.first & 0xffffffffu);
                bEdges.push_back({a, b, kv.second.second});
            }
            std::sort(bEdges.begin(), bEdges.end(), [](const BEdge& x, const BEdge& y) { return x.a != y.a ? x.a < y.a : x.b < y.b; });
            for (const auto& e : bEdges) {
                isB[e.a] = isB[e.b] = 1;
                compOfGroup[e.a] = std::min(compOfGroup[e.a], e.comp);
                compOfGroup[e.b] = std::min(compOfGroup[e.b], e.comp);
            }
            for (uint32_t g = 0; g < G; ++g) if (isB[g]) { bVerts.push_back(g); bVertComp.push_back(compOfGroup[g]); }
            S.boundaryGroups = bVerts.size();
            gapHistogram(S.gapHistogramBefore);
            if (!P.seamCoherence && !P.closeTJunctions) return;

            // partner edges: the boundary edges, plus (seamInteriorPartners) every other kept edge: a vertex lying on
            // an interior edge of another surface is a T-junction too, and becomes a visible one when a bevel on the
            // far side of that edge collapses
            std::vector<BEdge> partners = bEdges;
            if (P.seamInteriorPartners) {
                for (auto& kv : edgeCount) {
                    if (kv.second.first == 1) continue;
                    partners.push_back({static_cast<uint32_t>(kv.first >> 32), static_cast<uint32_t>(kv.first & 0xffffffffu), kv.second.second});
                }
                std::sort(partners.begin(), partners.end(), [](const BEdge& x, const BEdge& y) { return x.a != y.a ? x.a < y.a : x.b < y.b; });
            }
            EdgeGrid grid = edgeGrid(partners, P.seamContactTolerance + 0.01);
            const double gcell = 2.0;
            auto gci = [&](double v) { return static_cast<int64_t>(std::floor(v / gcell)); };
            // (1) edge contacts: a boundary vertex on a boundary edge of another piece (a T-junction). A weld group can
            // join raw vertices of several kept pieces: it is searched once per piece it bounds.
            std::vector<std::vector<uint32_t>> piecesOf(G);
            for (const auto& e : bEdges) {
                for (uint32_t g : {e.a, e.b}) {
                    auto& l = piecesOf[g];
                    if (std::find(l.begin(), l.end(), e.comp) == l.end()) l.push_back(e.comp);
                }
            }
            for (size_t i = 0; i < bVerts.size(); ++i) {
              const uint32_t g = bVerts[i];
              auto& pieces = piecesOf[g];
              std::sort(pieces.begin(), pieces.end());
              std::vector<int64_t> used;
              for (uint32_t piece : pieces) {
                double d, t;
                V3 q;
                const int64_t e = nearestForeignEdge(partners, grid, g, piece, P.seamContactTolerance, d, t, q);
                if (e < 0 || std::find(used.begin(), used.end(), e) != used.end()) continue;
                used.push_back(e);
                const BEdge& E = partners[static_cast<size_t>(e)];
                Contact c;
                c.nv = 3; c.ns = 1; c.kind = 0; c.mode = 0;
                c.v[0] = g; c.w[0] = 1.0;
                c.v[1] = E.a; c.w[1] = -(1.0 - t);
                c.v[2] = E.b; c.w[2] = -t;
                c.gap0 = d;
                c.c = (P.closeTJunctions && d <= P.tJunctionTolerance && d > 1e-7) ? q - groupPos[g] : V3{};
                contacts.push_back(c);
              }
            }
            // (2) face contacts: a chunk border running across the face of another piece. Points along every boundary
            // edge (the ends and the interior) that lie on another piece's face at the input stay on it (mode 1: along
            // that face's normal; sliding along the face is free). They are followers: the border takes its place
            // from the face, never the other way round (the border's own target barely counts along that normal), so
            // a wall is never dragged toward a chunk skirt lying on it.
            if (P.seamFaceTolerance > 0) {
                EdgeGrid tgrid;
                const double pad = P.seamFaceTolerance + 0.01;
                for (size_t t = 0; t < F; ++t) {
                    if (flags[t] != kFlagKeep || triA0[t] < 1e-8) continue;
                    V3 lo{1e300, 1e300, 1e300}, hi{-1e300, -1e300, -1e300};
                    for (int k = 0; k < 3; ++k) {
                        const V3& q = P0[tri[t][k]];
                        lo = V3{std::min(lo.x, q.x), std::min(lo.y, q.y), std::min(lo.z, q.z)};
                        hi = V3{std::max(hi.x, q.x), std::max(hi.y, q.y), std::max(hi.z, q.z)};
                    }
                    for (int64_t x = gci(lo.x - pad); x <= gci(hi.x + pad); ++x)
                        for (int64_t y = gci(lo.y - pad); y <= gci(hi.y + pad); ++y)
                            for (int64_t z = gci(lo.z - pad); z <= gci(hi.z + pad); ++z) tgrid[detail::cellKey(x, y, z)].push_back(static_cast<uint32_t>(t));
                }
                const double cosMax = std::cos(detail::degToRad(P.seamFaceMaxAngleDeg));
                const int ns = std::max(1, P.seamFaceSamples);
                std::vector<V3> edgeNormal(bEdges.size());
                {
                    // the normal of the kept face each boundary edge belongs to
                    std::unordered_map<uint64_t, uint32_t> faceOf;
                    for (size_t t = 0; t < F; ++t) {
                        if (flags[t] != kFlagKeep) continue;
                        for (int k = 0; k < 3; ++k) {
                            const uint32_t a = triG[t][k], b = triG[t][(k + 1) % 3];
                            if (a != b) faceOf[(static_cast<uint64_t>(std::min(a, b)) << 32) | std::max(a, b)] = static_cast<uint32_t>(t);
                        }
                    }
                    for (size_t e = 0; e < bEdges.size(); ++e) {
                        auto it = faceOf.find((static_cast<uint64_t>(std::min(bEdges[e].a, bEdges[e].b)) << 32) | std::max(bEdges[e].a, bEdges[e].b));
                        edgeNormal[e] = it == faceOf.end() ? V3{} : triN0[it->second];
                    }
                }
                for (size_t e = 0; e < bEdges.size(); ++e) {
                    const BEdge& E = bEdges[e];
                    const V3 A = groupPos[E.a], B = groupPos[E.b];
                    for (int s = 0; s < ns; ++s) {
                        const double tq = (s + 0.5) / ns;  // interior points; the ends are covered by the neighbouring edges' samples
                        const V3 p = A + (B - A) * tq;
                        auto it = tgrid.find(detail::cellKey(gci(p.x), gci(p.y), gci(p.z)));
                        if (it == tgrid.end()) continue;
                        // nearest face of each other piece within tolerance
                        struct Best { uint32_t comp; int64_t t; double d; double w[3]; V3 q; };
                        std::vector<Best> best;
                        for (uint32_t t : it->second) {
                            const uint32_t comp = keptComponent[t];
                            if (comp == E.comp) continue;
                            if (edgeNormal[e].norm() > 0.5 && std::abs(triN0[t].dot(edgeNormal[e])) < cosMax) continue;
                            double w[3];
                            const V3 q = closestOnTriangle(p, P0[tri[t][0]], P0[tri[t][1]], P0[tri[t][2]], w);
                            const double d = (p - q).norm();
                            if (d > P.seamFaceTolerance) continue;
                            auto bt = std::find_if(best.begin(), best.end(), [&](const Best& x) { return x.comp == comp; });
                            Best nb{comp, static_cast<int64_t>(t), d, {w[0], w[1], w[2]}, q};
                            if (bt == best.end()) best.push_back(nb);
                            else if (d < bt->d || (d == bt->d && nb.t < bt->t)) *bt = nb;
                        }
                        std::sort(best.begin(), best.end(), [](const Best& x, const Best& y) { return x.comp < y.comp; });
                        for (const Best& b : best) {
                            const size_t ft = static_cast<size_t>(b.t);
                            // a point at a vertex the face shares with the edge is no contact of its own
                            bool shared = false;
                            for (int k = 0; k < 3; ++k) if ((triG[ft][k] == E.a && b.w[k] > 0.999) || (triG[ft][k] == E.b && b.w[k] > 0.999)) shared = true;
                            if (shared) continue;
                            Contact c;
                            c.ns = 2; c.nv = 5; c.kind = 1;
                            c.v[0] = E.a; c.w[0] = 1.0 - tq;
                            c.v[1] = E.b; c.w[1] = tq;
                            for (int k = 0; k < 3; ++k) { c.v[2 + k] = triG[ft][k]; c.w[2 + k] = -b.w[k]; }
                            c.gap0 = b.d;
                            c.c = (P.closeTJunctions && b.d <= P.tJunctionTolerance && b.d > 1e-7) ? b.q - p : V3{};
                            c.mode = P.seamProjectedContacts ? 1 : 0;
                            c.ax = triN0[ft];
                            c.follow = P.seamFollowFaces;
                            contacts.push_back(c);
                            ++S.seamFaceContacts;
                        }
                    }
                }
            }
            // a contact's own vertex used twice (a degenerate edge-to-face sample) ties nothing: merge duplicate ids
            for (Contact& c : contacts) {
                for (int i = 0; i < c.nv; ++i) for (int j = i + 1; j < c.nv; ++j) {
                    if (c.v[j] != c.v[i]) continue;
                    c.w[i] += c.w[j];
                    for (int k = j; k + 1 < c.nv; ++k) { c.v[k] = c.v[k + 1]; c.w[k] = c.w[k + 1]; }
                    if (j < c.ns) --c.ns;
                    --c.nv; --j;
                }
            }
            // followers never follow each other: a contact follows only when none of its face vertices is a follower and
            // none of its border vertices is a face vertex of a follower (a cycle of followers would have nothing
            // holding it to the scan). The remaining face contacts tie both sides symmetrically.
            {
                std::vector<uint8_t> isFollower(G, 0), isMaster(G, 0);
                for (Contact& c : contacts) {
                    if (!c.follow) continue;
                    bool ok = true;
                    for (int i = 0; i < c.ns && ok; ++i) if (isMaster[c.v[i]]) ok = false;
                    for (int i = c.ns; i < c.nv && ok; ++i) if (isFollower[c.v[i]]) ok = false;
                    if (!ok) { c.follow = false; continue; }
                    for (int i = 0; i < c.ns; ++i) isFollower[c.v[i]] = 1;
                    for (int i = c.ns; i < c.nv; ++i) isMaster[c.v[i]] = 1;
                }
            }
            contactClosed.assign(contacts.size(), 0);
            for (size_t k = 0; k < contacts.size(); ++k) if (projectContact(contacts[k], contacts[k].c).norm() > 0) { contactClosed[k] = 1; ++S.tJunctionsClosed; }
            S.seamContacts = contacts.size();
            if (contacts.empty()) return;

            // solver variables, contact-graph components and adjacency
            auto var = [&](uint32_t g) {
                if (seamVar[g] < 0) { seamVar[g] = static_cast<int32_t>(seamGroups.size()); seamGroups.push_back(g); }
                return static_cast<uint32_t>(seamVar[g]);
            };
            for (const auto& c : contacts) for (int i = 0; i < c.nv; ++i) var(c.v[i]);
            const size_t n = seamGroups.size();
            // the guards' contact graph: a damaged vertex's seam partners are held back with it. Face contacts are not
            // part of it: holding back a whole wall for a chunk skirt lying on it would undo the wall's snapping (the
            // solve keeps the skirt on the wall either way)
            detail::UnionFind uf(n);
            std::vector<std::vector<uint32_t>> nbr(n);
            for (const auto& c : contacts) {
                if (c.kind == 1 && !P.seamGuardThroughFaces) continue;
                for (int i = 0; i < c.nv; ++i) for (int j = i + 1; j < c.nv; ++j) {
                    const uint32_t a = static_cast<uint32_t>(seamVar[c.v[i]]), b = static_cast<uint32_t>(seamVar[c.v[j]]);
                    if (a == b) continue;
                    uf.unite(a, b);
                    nbr[a].push_back(b);
                    nbr[b].push_back(a);
                }
            }
            seamNbrStart.assign(n + 1, 0);
            seamNbr.clear();
            for (size_t v = 0; v < n; ++v) {
                auto& l = nbr[v];
                std::sort(l.begin(), l.end());
                l.erase(std::unique(l.begin(), l.end()), l.end());
                seamNbr.insert(seamNbr.end(), l.begin(), l.end());
                seamNbrStart[v + 1] = static_cast<uint32_t>(seamNbr.size());
            }
            std::unordered_map<uint32_t, int32_t> compId;
            std::vector<size_t> compSize;
            for (size_t v = 0; v < n; ++v) {
                const uint32_t r = uf.find(static_cast<uint32_t>(v));
                auto it = compId.find(r);
                if (it == compId.end()) { it = compId.emplace(r, static_cast<int32_t>(compSize.size())).first; compSize.push_back(0); }
                seamComponent[seamGroups[v]] = it->second;
                compSize[static_cast<size_t>(it->second)]++;
            }
            seamComponentCount = compSize.size();
            S.seamComponents = compSize.size();
            for (size_t s : compSize) S.seamLargestComponent = std::max(S.seamLargestComponent, s);
            // followers: a border vertex takes its position along the followed faces' normals from them (its own target
            // weighs seamFollowEpsilon there)
            vFollow.assign(n, std::array<double, 6>{0, 0, 0, 0, 0, 0});
            {
                std::vector<std::array<double, 6>> acc(n, std::array<double, 6>{0, 0, 0, 0, 0, 0});
                for (const Contact& c : contacts) {
                    if (!c.follow || c.mode != 1) continue;
                    for (int i = 0; i < c.ns; ++i) {
                        if (c.w[i] < 0.25) continue;  // a point near the edge's other end says little about this vertex
                        auto& a = acc[static_cast<size_t>(seamVar[c.v[i]])];
                        a[0] += c.ax.x * c.ax.x; a[1] += c.ax.y * c.ax.y; a[2] += c.ax.z * c.ax.z;
                        a[3] += c.ax.x * c.ax.y; a[4] += c.ax.x * c.ax.z; a[5] += c.ax.y * c.ax.z;
                    }
                }
                for (size_t v = 0; v < n; ++v) {
                    const auto& a = acc[v];
                    if (!(a[0] + a[1] + a[2] > 0)) continue;
                    const double M[3][3] = {{a[0], a[3], a[4]}, {a[3], a[1], a[5]}, {a[4], a[5], a[2]}};
                    double ev[3];
                    V3 vec[3];
                    detail::symmetricEigen3(M, ev, vec);
                    const double top = std::max({ev[0], ev[1], ev[2]});
                    auto& q = vFollow[v];
                    for (int k = 0; k < 3; ++k) {
                        if (!(ev[k] > 0.05 * top)) continue;  // the span of the followed normals
                        const V3& e = vec[k];
                        q[0] += e.x * e.x; q[1] += e.y * e.y; q[2] += e.z * e.z; q[3] += e.x * e.y; q[4] += e.x * e.z; q[5] += e.y * e.z;
                    }
                    ++S.seamFollowers;
                }
            }
            seamWarm.clear();
            // Jacobi preconditioner, contact part: lambda sum w_i^2 diag(Pi)
            cDiag.assign(n, V3{});
            for (const Contact& c : contacts) {
                const V3 pd = c.mode == 1 ? V3{c.ax.x * c.ax.x, c.ax.y * c.ax.y, c.ax.z * c.ax.z}
                            : (c.mode == 2 ? V3{1 - c.ax.x * c.ax.x, 1 - c.ax.y * c.ax.y, 1 - c.ax.z * c.ax.z} : V3{1, 1, 1});
                for (int i = 0; i < c.nv; ++i) cDiag[static_cast<size_t>(seamVar[c.v[i]])] += pd * (P.seamStiffness * c.w[i] * c.w[i]);
            }
        }

        /**
         * delta = target off the seams; on the seams the penalty least-squares solution of
         *   sum_g |delta_g - target_g|^2_{W_g} + lambda sum_contacts |Pi (sum_i w_i delta_{v_i} - c)|^2
         * by Jacobi-preconditioned conjugate gradients over all three axes at once (a projected contact couples them).
         * W_g = targetWeight_g (I - (1 - seamFollowEpsilon) Q_g), Q_g the projector onto the normals a follower follows.
         */
        /**
         * The seam system decouples into the connected components of the contact graph (every contact couples only its
         * own variables). Each component is solved on its own, in parallel: a small component converges in a handful
         * of iterations instead of riding along with the hardest one, and a component whose targets did not change is
         * settled by its warm start in a single residual check.
         */
        std::vector<uint32_t> solverCompVarStart, solverCompVars, solverCompContactStart, solverCompContacts, solverOrder;

        void buildSolverComponents() {
            const size_t n = seamGroups.size();
            solverCompVarStart.clear(); solverCompVars.clear(); solverCompContactStart.clear(); solverCompContacts.clear(); solverOrder.clear();
            if (n == 0) return;
            detail::UnionFind uf(n);
            for (const Contact& c : contacts)
                for (int i = 1; i < c.nv; ++i) uf.unite(static_cast<uint32_t>(seamVar[c.v[0]]), static_cast<uint32_t>(seamVar[c.v[i]]));
            std::vector<int32_t> label(n, -1);
            std::vector<uint32_t> rootLabel(n, UINT32_MAX);
            size_t nc = 0;
            for (size_t v = 0; v < n; ++v) {
                const uint32_t r = uf.find(static_cast<uint32_t>(v));
                if (rootLabel[r] == UINT32_MAX) rootLabel[r] = static_cast<uint32_t>(nc++);
                label[v] = static_cast<int32_t>(rootLabel[r]);
            }
            solverCompVarStart.assign(nc + 1, 0);
            for (size_t v = 0; v < n; ++v) solverCompVarStart[static_cast<size_t>(label[v]) + 1]++;
            for (size_t c = 0; c < nc; ++c) solverCompVarStart[c + 1] += solverCompVarStart[c];
            solverCompVars.assign(n, 0);
            {
                std::vector<uint32_t> fill(solverCompVarStart.begin(), solverCompVarStart.end() - 1);
                for (size_t v = 0; v < n; ++v) solverCompVars[fill[static_cast<size_t>(label[v])]++] = static_cast<uint32_t>(v);
            }
            solverCompContactStart.assign(nc + 1, 0);
            for (const Contact& c : contacts) solverCompContactStart[static_cast<size_t>(label[static_cast<size_t>(seamVar[c.v[0]])]) + 1]++;
            for (size_t c = 0; c < nc; ++c) solverCompContactStart[c + 1] += solverCompContactStart[c];
            solverCompContacts.assign(contacts.size(), 0);
            {
                std::vector<uint32_t> fill(solverCompContactStart.begin(), solverCompContactStart.end() - 1);
                for (size_t k = 0; k < contacts.size(); ++k) solverCompContacts[fill[static_cast<size_t>(label[static_cast<size_t>(seamVar[contacts[k].v[0]])])]++] = static_cast<uint32_t>(k);
            }
            seamCache.clear();
            seamCache.resize(nc);
            solverOrder.resize(nc);
            std::iota(solverOrder.begin(), solverOrder.end(), 0u);
            std::stable_sort(solverOrder.begin(), solverOrder.end(), [&](uint32_t a, uint32_t b) {
                return solverCompVarStart[a + 1] - solverCompVarStart[a] > solverCompVarStart[b + 1] - solverCompVarStart[b];
            });
        }

        /**
         * Per component: the contact part of the normal equations and its symbolic factorization are built once per
         * contact set; the numeric factor is redone only when the targets' weights change (guards changing only the
         * targets just re-solve with the cached factor).
         */
        struct SeamCompCache { detail::BlockSpd A; detail::SparseBlockCholesky chol; bool built{false}, direct{false}, factored{false}; std::vector<double> w; };
        std::vector<SeamCompCache> seamCache;

        bool solveSeamComponentDirect(uint32_t comp, std::vector<uint32_t>& localOf) {
            const uint32_t v0 = solverCompVarStart[comp], v1 = solverCompVarStart[comp + 1];
            const uint32_t k0 = solverCompContactStart[comp], k1 = solverCompContactStart[comp + 1];
            const size_t m = v1 - v0;
            for (uint32_t i = v0; i < v1; ++i) localOf[solverCompVars[i]] = i - v0;
            const double lam = P.seamStiffness;
            const double keepFollow = 1.0 - P.seamFollowEpsilon;
            auto gv = [&](size_t l) { return static_cast<size_t>(solverCompVars[v0 + l]); };
            auto sv = [&](const Contact& c, int i) { return static_cast<uint32_t>(localOf[static_cast<size_t>(seamVar[c.v[i]])]); };
            SeamCompCache& cc = seamCache[comp];
            if (!cc.built) {
                cc.built = true;
                cc.A.init(m);
                for (uint32_t kk = k0; kk < k1; ++kk) {
                    const Contact& c = contacts[solverCompContacts[kk]];
                    detail::BlockSpd::M3 Pi = c.mode == 1 ? detail::BlockSpd::M3::outer(c.ax, c.ax, 1.0) : detail::BlockSpd::M3::identity(1.0);
                    if (c.mode == 2) { const auto o = detail::BlockSpd::M3::outer(c.ax, c.ax, -1.0); Pi += o; }
                    for (int i = 0; i < c.nv; ++i)
                        for (int j = i; j < c.nv; ++j) {
                            detail::BlockSpd::M3 B = Pi;
                            for (double& e : B.a) e *= lam * c.w[i] * c.w[j];
                            const uint32_t li = sv(c, i), lj = sv(c, j);
                            cc.A.add(li, lj, B);
                            if (j != i && lj == li) cc.A.add(li, lj, B);
                        }
                }
                cc.A.finalize();
                cc.direct = cc.chol.analyze(cc.A);
            }
            if (!cc.direct) return false;
            std::vector<double> w(m);
            bool same = cc.factored && cc.w.size() == m;
            for (size_t l = 0; l < m; ++l) { w[l] = targetWeight[seamGroups[gv(l)]]; if (same && w[l] != cc.w[l]) same = false; }
            if (!same) {
                std::vector<detail::BlockSpd::M3> blk(m);
                for (size_t l = 0; l < m; ++l) {
                    const auto& q = vFollow[gv(l)];
                    auto& B = blk[l];
                    B.a[0] = w[l] * (1.0 - keepFollow * q[0]); B.a[4] = w[l] * (1.0 - keepFollow * q[1]); B.a[8] = w[l] * (1.0 - keepFollow * q[2]);
                    B.a[1] = B.a[3] = -w[l] * keepFollow * q[3];
                    B.a[2] = B.a[6] = -w[l] * keepFollow * q[4];
                    B.a[5] = B.a[7] = -w[l] * keepFollow * q[5];
                }
                cc.factored = cc.chol.numeric(cc.A, {}, &blk);
                if (!cc.factored) { cc.direct = false; return false; }
                cc.w = w;
            }
            std::vector<V3> b(m), x;
            for (size_t l = 0; l < m; ++l) {
                const auto& q = vFollow[gv(l)];
                const V3 a = target[seamGroups[gv(l)]];
                const V3 qa{q[0] * a.x + q[3] * a.y + q[4] * a.z, q[3] * a.x + q[1] * a.y + q[5] * a.z, q[4] * a.x + q[5] * a.y + q[2] * a.z};
                b[l] = (a - qa * keepFollow) * w[l];
            }
            for (uint32_t kk = k0; kk < k1; ++kk) {
                const uint32_t k = solverCompContacts[kk];
                if (!contactClosed[k]) continue;
                const Contact& c = contacts[k];
                const V3 s = projectContact(c, c.c) * lam;
                for (int i = 0; i < c.nv; ++i) b[sv(c, i)] += s * c.w[i];
            }
            cc.chol.solve(b, x);
            for (size_t l = 0; l < m; ++l) seamWarm[gv(l)] = x[l];
            return true;
        }

        /** PCG on one contact-graph component (variables are global solver indices; x is read from and written to seamWarm). */
        int solveSeamComponent(uint32_t comp, std::vector<uint32_t>& localOf) {
            if (solveSeamComponentDirect(comp, localOf)) return 0;
            const uint32_t v0 = solverCompVarStart[comp], v1 = solverCompVarStart[comp + 1];
            const uint32_t k0 = solverCompContactStart[comp], k1 = solverCompContactStart[comp + 1];
            const size_t m = v1 - v0;
            for (uint32_t i = v0; i < v1; ++i) localOf[solverCompVars[i]] = i - v0;
            const double lam = P.seamStiffness;
            const double keepFollow = 1.0 - P.seamFollowEpsilon;
            std::vector<V3> x(m), b(m), r(m), z(m), p(m), Ap(m);
            std::vector<double> w(m);
            auto gv = [&](size_t l) { return static_cast<size_t>(solverCompVars[v0 + l]); };
            auto applyW = [&](size_t l, const V3& a) {
                const auto& q = vFollow[gv(l)];
                const V3 qa{q[0] * a.x + q[3] * a.y + q[4] * a.z, q[3] * a.x + q[1] * a.y + q[5] * a.z, q[4] * a.x + q[5] * a.y + q[2] * a.z};
                return (a - qa * keepFollow) * w[l];
            };
            // block-Jacobi preconditioner: the full 3x3 diagonal block of every variable (projected contacts and follower
            // projectors are not axis-aligned)
            std::vector<std::array<double, 6>> blk(m);  // xx yy zz xy xz yz
            for (size_t l = 0; l < m; ++l) {
                const size_t v = gv(l);
                w[l] = targetWeight[seamGroups[v]];
                const auto& q = vFollow[v];
                blk[l] = {w[l] * (1.0 - keepFollow * q[0]), w[l] * (1.0 - keepFollow * q[1]), w[l] * (1.0 - keepFollow * q[2]),
                          -w[l] * keepFollow * q[3], -w[l] * keepFollow * q[4], -w[l] * keepFollow * q[5]};
            }
            auto sv = [&](const Contact& c, int i) { return static_cast<size_t>(localOf[static_cast<size_t>(seamVar[c.v[i]])]); };
            for (uint32_t kk = k0; kk < k1; ++kk) {
                const Contact& c = contacts[solverCompContacts[kk]];
                for (int i = 0; i < c.nv; ++i) {
                    auto& q = blk[sv(c, i)];
                    const double k = lam * c.w[i] * c.w[i];
                    const V3& a = c.ax;
                    if (c.mode == 1) { q[0] += k * a.x * a.x; q[1] += k * a.y * a.y; q[2] += k * a.z * a.z; q[3] += k * a.x * a.y; q[4] += k * a.x * a.z; q[5] += k * a.y * a.z; }
                    else if (c.mode == 2) { q[0] += k * (1 - a.x * a.x); q[1] += k * (1 - a.y * a.y); q[2] += k * (1 - a.z * a.z); q[3] -= k * a.x * a.y; q[4] -= k * a.x * a.z; q[5] -= k * a.y * a.z; }
                    else { q[0] += k; q[1] += k; q[2] += k; }
                }
            }
            std::vector<std::array<double, 6>> binv(m);
            for (size_t l = 0; l < m; ++l) {
                const auto& q = blk[l];
                const double a = q[0], e = q[1], i3 = q[2], bxy = q[3], cxz = q[4], fyz = q[5];
                const double A0 = e * i3 - fyz * fyz, B0 = cxz * fyz - bxy * i3, C0 = bxy * fyz - cxz * e;
                const double det = a * A0 + bxy * B0 + cxz * C0;
                if (!(det > 1e-300)) { binv[l] = {a > 0 ? 1.0 / a : 0.0, e > 0 ? 1.0 / e : 0.0, i3 > 0 ? 1.0 / i3 : 0.0, 0, 0, 0}; continue; }
                const double id = 1.0 / det;
                binv[l] = {A0 * id, (a * i3 - cxz * cxz) * id, (a * e - bxy * bxy) * id, B0 * id, C0 * id, (bxy * cxz - a * fyz) * id};
            }
            auto prec = [&](size_t l, const V3& r0) {
                const auto& q = binv[l];
                return V3{q[0] * r0.x + q[3] * r0.y + q[4] * r0.z, q[3] * r0.x + q[1] * r0.y + q[5] * r0.z, q[4] * r0.x + q[5] * r0.y + q[2] * r0.z};
            };
            auto matvec = [&](const std::vector<V3>& in, std::vector<V3>& out) {
                for (size_t l = 0; l < m; ++l) out[l] = applyW(l, in[l]);
                for (uint32_t kk = k0; kk < k1; ++kk) {
                    const Contact& c = contacts[solverCompContacts[kk]];
                    V3 s;
                    for (int i = 0; i < c.nv; ++i) s += in[sv(c, i)] * c.w[i];
                    s = projectContact(c, s) * lam;
                    for (int i = 0; i < c.nv; ++i) out[sv(c, i)] += s * c.w[i];
                }
            };
            auto dot3 = [&](const std::vector<V3>& a, const std::vector<V3>& c) { double s = 0; for (size_t l = 0; l < m; ++l) s += a[l].dot(c[l]); return s; };
            for (size_t l = 0; l < m; ++l) b[l] = applyW(l, target[seamGroups[gv(l)]]);
            for (uint32_t kk = k0; kk < k1; ++kk) {
                const uint32_t k = solverCompContacts[kk];
                if (!contactClosed[k]) continue;
                const Contact& c = contacts[k];
                const V3 s = projectContact(c, c.c) * lam;
                for (int i = 0; i < c.nv; ++i) b[sv(c, i)] += s * c.w[i];
            }
            for (size_t l = 0; l < m; ++l) x[l] = seamWarm[gv(l)];
            matvec(x, Ap);
            for (size_t l = 0; l < m; ++l) { r[l] = b[l] - Ap[l]; z[l] = prec(l, r[l]); p[l] = z[l]; }
            double rz = dot3(r, z);
            const double tol2 = std::max(1e-28, 1e-22 * dot3(b, b));
            int it = 0;
            for (; it < P.seamSolverIterations; ++it) {
                if (dot3(r, r) <= tol2) break;
                matvec(p, Ap);
                const double pAp = dot3(p, Ap);
                if (!(pAp > 0)) break;
                const double alpha = rz / pAp;
                for (size_t l = 0; l < m; ++l) { x[l] += p[l] * alpha; r[l] = r[l] - Ap[l] * alpha; z[l] = prec(l, r[l]); }
                const double rzNew = dot3(r, z);
                const double beta = rzNew / rz;
                rz = rzNew;
                for (size_t l = 0; l < m; ++l) p[l] = z[l] + p[l] * beta;
            }
            for (size_t l = 0; l < m; ++l) seamWarm[gv(l)] = x[l];
            return it;
        }

        void solveSeams() {
            delta = target;
            ++S.seamSolves;
            if (!P.seamCoherence || contacts.empty()) return;
            const size_t n = seamGroups.size();
            if (solverCompVarStart.empty()) buildSolverComponents();
            // warm start from the previous solution of the same system (guards change only some targets and weights)
            if (seamWarm.size() != n) {
                seamWarm.resize(n);
                for (size_t v = 0; v < n; ++v) seamWarm[v] = target[seamGroups[v]];
            }
            const size_t nc = solverOrder.size();
            std::vector<int> its(nc, 0);
            std::vector<std::vector<uint32_t>> localOf(std::max(1u, threads));
            detail::parallelFor(nc, threads, 1, [&](size_t b0, size_t b1, unsigned th) {
                auto& lo = localOf[th];
                if (lo.size() != n) lo.assign(n, 0);
                for (size_t oi = b0; oi < b1; ++oi) its[oi] = solveSeamComponent(solverOrder[oi], lo);
            });
            int it = 0;
            for (int x : its) it = std::max(it, x);
            S.seamSolverIterationsUsed += static_cast<size_t>(it);
            S.seamSolverIterationsMax = std::max(S.seamSolverIterationsMax, static_cast<size_t>(it));
            const std::vector<V3>& x = seamWarm;
            for (size_t v = 0; v < n; ++v) {
                // a seam vertex that would move less than a micrometre stays exactly as scanned
                V3 d = x[v];
                if (std::abs(d.x) < 1e-6) d.x = 0;
                if (std::abs(d.y) < 1e-6) d.y = 0;
                if (std::abs(d.z) < 1e-6) d.z = 0;
                delta[seamGroups[v]] = d;
            }
            double maxRes = 0;
            for (size_t k = 0; k < contacts.size(); ++k) {
                const auto& c = contacts[k];
                V3 s;
                for (int i = 0; i < c.nv; ++i) s += delta[c.v[i]] * c.w[i];
                const V3 res = projectContact(c, s - (contactClosed[k] ? c.c : V3{}));
                maxRes = std::max(maxRes, res.norm());
            }
            S.seamMaxResidual = maxRes;
        }

        /** Expands a group mark along the contact graph by `rings` steps (whole component when rings < 0). */
        void expandOnSeams(std::vector<uint8_t>& mark, int rings) {
            if (contacts.empty()) return;
            if (rings < 0) {
                std::vector<uint8_t> hit(seamComponentCount, 0);
                for (size_t g = 0; g < G; ++g) if (mark[g] && seamComponent[g] >= 0) hit[static_cast<size_t>(seamComponent[g])] = 1;
                for (size_t g = 0; g < G; ++g) if (seamComponent[g] >= 0 && hit[static_cast<size_t>(seamComponent[g])]) { if (!mark[g] && everMarked.size() == G) everMarked[g] |= 32; mark[g] = 1; }
                return;
            }
            for (int r = 0; r < rings; ++r) {
                std::vector<uint32_t> grow;
                for (size_t v = 0; v < seamGroups.size(); ++v) {
                    if (!mark[seamGroups[v]]) continue;
                    for (uint32_t k = seamNbrStart[v]; k < seamNbrStart[v + 1]; ++k) grow.push_back(seamGroups[seamNbr[k]]);
                }
                for (uint32_t g : grow) { if (!mark[g] && everMarked.size() == G) everMarked[g] |= 32; mark[g] = 1; }
            }
        }

        /**
         * D8 + D9: seam-coherent displacements, then guards. A guard never moves one vertex on its
         * own: it shrinks the TARGETS of the vertices of a damaged triangle or crease (and their seam
         * partners) and the seam system is solved again, so the seams stay closed while the damage is
         * repaired. Escalation: halve (guardIterations times), zero, zero the seam neighbourhood, zero
         * the whole seam component, drop that component's gap closures.
         */
        /**
         * Opposed sheets that the current displacements bring too close (or cross): only the motion that carries
         * either face TOWARD the other is reduced, in the targets of the faces' vertices, by the share needed to
         * restore the required separation (with a margin). Motion along the faces and away from each other is
         * kept, so the snapping of both sheets survives; the pair is re-checked after the next solve.
         */
        size_t relieveOpposed() {
            size_t handled = 0;
            for (const OpposedPair& q : opposed) {
                if (!opposedViolated(q)) continue;
                V3 nu;
                double au;
                triAfter(q.u, nu, au);
                V3 p, h;
                for (int k = 0; k < 3; ++k) { p += vpos(tri[q.t][k]) * q.wt[k]; h += vpos(tri[q.u][k]) * q.wu[k]; }
                const double sNow = (p - h).dot(nu);
                const double keep = std::min(P.opposedKeepFraction * static_cast<double>(q.gap0), P.opposedKeepMin);
                const double need = sNow + keep;  // > 0: separation to restore
                const V3 n = triN0[q.t];
                double towards = 0;
                for (int k = 0; k < 3; ++k) {
                    towards += q.wt[k] * std::max(0.0, -n.dot(delta[triG[q.t][k]]));
                    towards += q.wu[k] * std::max(0.0, n.dot(delta[triG[q.u][k]]));
                }
                if (!(towards > 1e-9)) continue;
                const double f = std::min(1.0, 1.25 * need / towards);
                for (int k = 0; k < 3; ++k) {
                    const uint32_t ga = triG[q.t][k], gb = triG[q.u][k];
                    V3& a = target[ga];
                    const double ca = -n.dot(a);
                    if (ca > 0) { a += n * (f * ca); if (targetWeight[ga] < 1.0) targetWeight[ga] = 1.0; }
                    V3& b = target[gb];
                    const double cb = n.dot(b);
                    if (cb > 0) { b = b - n * (f * cb); if (targetWeight[gb] < 1.0) targetWeight[gb] = 1.0; }
                }
                ++handled;
            }
            S.opposedRelieved += handled;
            return handled;
        }

        static constexpr double kPinWeight = 1e6;  // a pinned vertex's target weight in the seam solve

        void solveWithGuards() {
            std::vector<uint8_t> mark(G, 0);
            solveSeams();
            int iter = 0;
            for (; iter < P.guardIterations; ++iter) {
                const size_t relieved = P.guardOpposed ? relieveOpposed() : 0;
                if (!collectBad(mark, iter == 0, false)) {
                    if (!relieved) break;
                    solveSeams();
                    continue;
                }
                expandOnSeams(mark, 1);
                bool changed = relieved > 0;
                for (size_t g = 0; g < G; ++g) {
                    if (!mark[g]) continue;
                    if (targetWeight[g] < 1.0) { targetWeight[g] = 1.0; changed = true; }  // a guarded vertex holds its target
                    if (!(target[g].norm() > 0)) continue;
                    target[g] = target[g] * 0.5;
                    ++S.guardHalvings;
                    changed = true;
                }
                if (!changed) break;
                solveSeams();
            }
            S.guardIterationsUsed = iter;
            // opposed sheets get a few more targeted reliefs before anything is zeroed
            for (int pass = 0; pass < 3 && P.guardOpposed; ++pass) {
                if (!relieveOpposed()) break;
                solveSeams();
            }
            opposedBeforeZero.assign(opposed.size(), 0);
            for (size_t i = 0; i < opposed.size(); ++i) opposedBeforeZero[i] = opposedViolated(opposed[i]) ? 1 : 0;
            for (int pass = 0; pass < 6; ++pass) {
                if (P.guardOpposed && relieveOpposed()) solveSeams();
                // opposed pairs the relief could not fix are zeroed with their near seam neighbourhood only (never a
                // whole seam component): that would cost far more snapping than the pair is worth
                if (!collectBad(mark, false, P.guardOpposed && (P.opposedEscalate || pass < P.opposedZeroPasses))) break;
                const int rings = pass == 0 ? 1 : (pass == 1 ? 3 : -1);
                expandOnSeams(mark, rings);
                bool changed = false;
                for (size_t g = 0; g < G; ++g) {
                    if (!mark[g]) continue;
                    if (targetWeight[g] < 1.0) { targetWeight[g] = 1.0; changed = true; }
                    if (!(target[g].norm() > 0)) continue;
                    target[g] = V3{};
                    ++S.guardReverted;
                    if (rings < 0) ++S.guardComponentReverts;
                    changed = true;
                }
                if (pass >= 3) {
                    for (size_t k = 0; k < contacts.size(); ++k) {
                        if (contactClosed[k] && mark[contacts[k].v[0]]) { contactClosed[k] = 0; ++S.guardClosureDropped; changed = true; }
                    }
                }
                // damage carried only by seam coupling changes nothing at this ring width: widen before giving up
                if (!changed) { if (pass >= 3) break; continue; }
                solveSeams();
            }
            S.opposedResidual = 0;
            for (const OpposedPair& q : opposed) if (opposedViolated(q)) ++S.opposedResidual;
            // last resort (should not trigger): pin whatever is still damaged to the scan, together with its whole
            // seam component so no chunk seam opens
            // (pinned through the solve: followers on a pinned surface follow it back to the scan)
            for (int pass = 0; pass < 32; ++pass) {
                if (!collectBad(mark, false, P.opposedEscalate)) break;
                if (pass == 0) S.residualReasons = lastReasons;
                expandOnSeams(mark, -1);
                bool changed = false;
                for (size_t g = 0; g < G; ++g) {
                    if (!mark[g] || (!(delta[g].norm() > 0) && !(target[g].norm() > 0))) continue;
                    target[g] = V3{};
                    targetWeight[g] = std::max(targetWeight[g], kPinWeight);
                    ++S.guardResidualReverted;
                    changed = true;
                }
                if (!changed) break;
                solveSeams();
            }
        }

        /**
         * Guard restore: halving acts on every vertex of a damaged face (and its seam ring), so it usually holds back
         * more than the damage needed. A vertex that is on no chunk seam and whose move was reduced is moved back
         * toward its snap target (all of the way, three quarters, or half of the remaining way) whenever that leaves
         * every face, protected crease and opposed pair around it undamaged and the move within the budget.
         */
        // incidence for local damage checks: group -> protected creases, triangle -> opposed pairs
        std::vector<uint32_t> incCreaseStart, incCrease, incPairStart, incPair;

        void buildLocalIncidence() {
            std::vector<uint32_t>& cStart = incCreaseStart;
            std::vector<uint32_t>& cIdx = incCrease;
            std::vector<uint32_t>& pStart = incPairStart;
            std::vector<uint32_t>& pIdx = incPair;
            cStart.assign(G + 1, 0);
            for (const auto& e : creases) for (int k = 0; k < 4; ++k) cStart[e.g[k] + 1]++;
            for (size_t g = 0; g < G; ++g) cStart[g + 1] += cStart[g];
            cIdx.assign(cStart[G], 0);
            {
                std::vector<uint32_t> fill(cStart.begin(), cStart.end() - 1);
                for (uint32_t i = 0; i < creases.size(); ++i) for (int k = 0; k < 4; ++k) cIdx[fill[creases[i].g[k]]++] = i;
            }
            pStart.assign(F + 1, 0);
            for (const auto& q : opposed) { pStart[q.t + 1]++; pStart[q.u + 1]++; }
            for (size_t t = 0; t < F; ++t) pStart[t + 1] += pStart[t];
            pIdx.assign(pStart[F], 0);
            {
                std::vector<uint32_t> fill(pStart.begin(), pStart.end() - 1);
                for (uint32_t i = 0; i < opposed.size(); ++i) { pIdx[fill[opposed[i].t]++] = i; pIdx[fill[opposed[i].u]++] = i; }
            }
        }

        /** Every kept face, protected crease and opposed pair around group g is undamaged and its move is within budget. */
        bool localOk(uint32_t g) const {
            if (delta[g].norm() > P.maxDisplacement + 1e-9) return false;
            for (uint32_t q = groupTriStart[g]; q < groupTriStart[g + 1]; ++q) {
                const uint32_t t = groupTris[q];
                if (flags[t] != kFlagKeep) continue;
                if (triBadness(t)) return false;
                if (P.guardOpposed) for (uint32_t k = incPairStart[t]; k < incPairStart[t + 1]; ++k) if (opposedViolated(opposed[incPair[k]])) return false;
            }
            for (uint32_t k = incCreaseStart[g]; k < incCreaseStart[g + 1]; ++k) {
                const CreaseEdge& e = creases[incCrease[k]];
                if ((e.real && creaseFolded(e)) || creaseSoftened(e)) return false;
            }
            return true;
        }

        /**
         * Guard restore on the chunk seams. The guards hold back a damaged vertex together with its seam partners and halve
         * in coarse steps, so seam vertices usually end farther from their snap targets than the damage needs. Their
         * targets are moved back toward the snap targets in batches (all of the way, then half of it); after each re-solve
         * every seam vertex whose position changed is checked, and the ones whose faces, creases or opposed pairs are
         * damaged (with their seam partners) keep their previous target. Seams stay closed throughout: everything goes
         * through the seam solve.
         */
        void restoreSeamPass() {
            if (!P.guardRestore || contacts.empty() || seamGroups.empty()) return;
            std::vector<uint8_t> frozen(G, 0), damagedBefore(G, 0), badBefore(G, 0);
            // damage the guards left (if any) is not this pass's to judge: those vertices keep their targets. Their
            // positions can still change through seam partners, so their faces may not gain a new kind of damage.
            auto faceDamage = [&](uint32_t g) {
                uint8_t m = 0;
                for (uint32_t q = groupTriStart[g]; q < groupTriStart[g + 1]; ++q) {
                    const uint32_t t = groupTris[q];
                    if (flags[t] == kFlagKeep) m |= triBadness(t);
                }
                return m;
            };
            for (uint32_t g : seamGroups) if (!localOk(g)) { damagedBefore[g] = 1; frozen[g] = 1; badBefore[g] = faceDamage(g); }
            size_t restored = 0;
            const double fracs[3] = {1.0, 0.5, 0.25};
            for (int round = 0; round < P.guardRestoreRounds; ++round) {
                for (double f : fracs) {
                    // a vertex that failed a larger step may still take a smaller one
                    for (uint32_t g : seamGroups) frozen[g] = damagedBefore[g];
                    std::vector<uint32_t> cand;
                    for (uint32_t g : seamGroups) {
                        if (frozen[g] || targetWeight[g] >= kPinWeight) continue;
                        if ((snapTarget0[g] - target[g]).norm() > 1e-4) cand.push_back(g);
                    }
                    if (cand.empty()) break;
                    const std::vector<V3> keepTarget = target, keepDelta = delta;
                    for (uint32_t g : cand) target[g] = target[g] + (snapTarget0[g] - target[g]) * f;
                    std::vector<uint8_t> tried(G, 0);
                    for (uint32_t g : cand) tried[g] = 1;
                    bool clean = false;
                    for (int fix = 0; fix < 8; ++fix) {
                        solveSeams();
                        std::vector<uint8_t> mark(G, 0);
                        size_t bad = 0;
                        double worst = 0;
                        for (uint32_t g : seamGroups) {
                            if ((delta[g] - keepDelta[g]).norm() <= 1e-5) continue;
                            const bool damaged = damagedBefore[g] ? (faceDamage(g) & static_cast<uint8_t>(~badBefore[g])) != 0 : !localOk(g);
                            if (damaged) { mark[g] = 1; ++bad; worst = std::max(worst, (delta[g] - keepDelta[g]).norm()); }
                        }
                        if (std::getenv("SB_DEBUG_RESTORE")) std::fprintf(stderr, "seam restore round %d f %.2f fix %d: %zu candidates, %zu bad (largest change %.6f)\n", round, f, fix, cand.size(), bad, worst);
                        if (!bad) { clean = true; break; }
                        ++S.guardSeamRestoreFixes;
                        // a vertex still damaged after its own target went back is moved by partners farther along the
                        // seam: its whole seam component goes back
                        expandOnSeams(mark, fix < 2 ? 1 : -1);
                        for (uint32_t g = 0; g < G; ++g) {
                            if (!mark[g]) continue;
                            target[g] = keepTarget[g];
                            if (tried[g]) frozen[g] = 1;
                        }
                    }
                    if (!clean) {
                        // could not settle: back to the guarded state for this batch
                        target = keepTarget;
                        delta = keepDelta;
                        for (uint32_t g : cand) frozen[g] = 1;
                        continue;
                    }
                    for (uint32_t g : cand) if ((target[g] - keepTarget[g]).norm() > 1e-9) ++restored;
                }
            }
            S.guardSeamRestored += restored;
        }

        void restorePass() {
            if (!P.guardRestore) return;
            if (incCreaseStart.size() != G + 1) buildLocalIncidence();
            restoreSeamPass();
            const double fracs[4] = {1.0, 0.75, 0.5, 0.25};
            for (int round = 0; round < P.guardRestoreRounds; ++round) {
                size_t restored = 0;
                for (uint32_t g = 0; g < G; ++g) {
                    if (!seamVar.empty() && seamVar[g] >= 0) continue;
                    const V3 full = snapTarget0[g];
                    const V3 cur = delta[g];
                    if ((full - cur).norm() < 1e-4) continue;
                    if (!localOk(g)) continue;  // only from an undamaged state
                    for (double f : fracs) {
                        const V3 cand = cur + (full - cur) * f;
                        delta[g] = cand;
                        if (localOk(g)) { target[g] = cand; ++restored; break; }
                        delta[g] = cur;
                    }
                }
                S.guardRestored += restored;
                if (!restored) break;
            }
        }

        /**
         * Chunk-seam stitch, after the guarded solve. The scan's tile chunks overlap and are not stitched: a chunk border
         * often runs across a face of another piece. Points along every kept boundary edge (seamStitchSamples per edge)
         * that lay within seamStitchTolerance of a face of another piece keep their input distance to that face along the
         * face's normal, so the edit opens no slit there. Both sides may move, by least squares: a vertex the snapping
         * placed on a plane (or holds on a chunk-seam T-junction) weighs 1, one left as scanned weighs seamStitchEpsilon,
         * so an unsnapped side follows a snapped one and two snapped sides meet halfway. A vertex whose move damages a
         * face, protected crease or opposed pair around it, collapses a face or leaves the displacement budget is put
         * back and held, and the rest is solved again.
         */
        /** True when p (x/z) is not well inside any building footprint: outside all, or within the margin of an edge. */
        bool outsideFootprints(const V3& p) const {
            for (const auto& ring : P.buildingFootprintsXZ) {
                const size_t m = ring.size();
                if (m < 3) continue;
                bool inside = false;
                double edgeDist = 1e300;
                for (size_t i = 0, j = m - 1; i < m; j = i++) {
                    const auto [xi, zi] = ring[i];
                    const auto [xj, zj] = ring[j];
                    if ((zi > p.z) != (zj > p.z) && p.x < (xj - xi) * (p.z - zi) / (zj - zi) + xi) inside = !inside;
                    const double dx = xi - xj, dz = zi - zj, len2 = dx * dx + dz * dz;
                    const double t = len2 > 0 ? std::clamp(((p.x - xj) * dx + (p.z - zj) * dz) / len2, 0.0, 1.0) : 0.0;
                    edgeDist = std::min(edgeDist, std::hypot(p.x - (xj + t * dx), p.z - (zj + t * dz)));
                }
                if (inside && edgeDist > P.footprintGroundMargin) return false;
            }
            return true;
        }

        void stitchPass() {
            if (!(P.seamStitchTolerance > 0) || P.seamStitchSamples <= 0) return;
            if (incCreaseStart.size() != G + 1) buildLocalIncidence();
            // pieces of the final kept surface and its welded boundary edges
            std::vector<uint32_t> piece(F, UINT32_MAX);
            {
                detail::UnionFind uf(V);
                for (size_t t = 0; t < F; ++t) if (flags[t] == kFlagKeep) { uf.unite(tri[t][0], tri[t][1]); uf.unite(tri[t][0], tri[t][2]); }
                for (size_t t = 0; t < F; ++t) if (flags[t] == kFlagKeep) piece[t] = uf.find(tri[t][0]);
            }
            struct BE { uint32_t a, b, t; };
            std::vector<BE> edges;
            {
                std::unordered_map<uint64_t, std::pair<uint32_t, uint32_t>> use;  // key -> (count, triangle)
                for (size_t t = 0; t < F; ++t) {
                    if (flags[t] != kFlagKeep) continue;
                    for (int k = 0; k < 3; ++k) {
                        const uint32_t a = triG[t][k], b = triG[t][(k + 1) % 3];
                        if (a == b) continue;
                        auto& u = use[(static_cast<uint64_t>(std::min(a, b)) << 32) | std::max(a, b)];
                        if (u.first++ == 0) u.second = static_cast<uint32_t>(t);
                    }
                }
                for (auto& kv : use) if (kv.second.first == 1) edges.push_back({static_cast<uint32_t>(kv.first >> 32), static_cast<uint32_t>(kv.first & 0xffffffffu), kv.second.second});
                std::sort(edges.begin(), edges.end(), [](const BE& x, const BE& y) { return x.a != y.a ? x.a < y.a : x.b < y.b; });
            }
            const auto stT0 = Clock::now();
            auto stLog = [&](const char* what) { if (std::getenv("SB_DEBUG_STITCH")) std::fprintf(stderr, "stitch %-12s %9.1f ms\n", what, msSince(stT0)); };
            // kept faces hashed by their input AABB
            const double cell = 2.0, tol = P.seamStitchTolerance, pad = tol + 0.01;
            auto ci = [&](double v) { return static_cast<int64_t>(std::floor(v / cell)); };
            // only cells that hold a sample point are ever looked up: faces are registered in those cells only, by
            // threads over face blocks; the (cell, face) pairs are then grouped per cell in face order (deterministic)
            std::unordered_map<int64_t, std::vector<uint32_t>, detail::CellKeyHash> tgrid;
            {
                const int nsamp = std::max(1, P.seamStitchSamples);
                for (const BE& E : edges) {
                    const V3 A = groupPos[E.a], B = groupPos[E.b];
                    for (int k = 0; k < nsamp; ++k) {
                        const V3 q = A + (B - A) * ((k + 0.5) / nsamp);
                        tgrid.try_emplace(detail::cellKey(ci(q.x), ci(q.y), ci(q.z)));
                    }
                }
                constexpr size_t kFaceBlock = 4096;
                std::vector<std::vector<std::pair<int64_t, uint32_t>>> blocks((F + kFaceBlock - 1) / kFaceBlock);
                detail::parallelFor(blocks.size(), threads, 1, [&](size_t b0, size_t b1, unsigned) {
                    for (size_t bi = b0; bi < b1; ++bi) {
                        auto& out = blocks[bi];
                        for (size_t t = bi * kFaceBlock; t < std::min(F, (bi + 1) * kFaceBlock); ++t) {
                            if (flags[t] != kFlagKeep || triA0[t] < 1e-8) continue;
                            V3 lo{1e300, 1e300, 1e300}, hi{-1e300, -1e300, -1e300};
                            for (int k = 0; k < 3; ++k) {
                                const V3& q = P0[tri[t][k]];
                                lo = V3{std::min(lo.x, q.x), std::min(lo.y, q.y), std::min(lo.z, q.z)};
                                hi = V3{std::max(hi.x, q.x), std::max(hi.y, q.y), std::max(hi.z, q.z)};
                            }
                            for (int64_t x = ci(lo.x - pad); x <= ci(hi.x + pad); ++x)
                                for (int64_t y = ci(lo.y - pad); y <= ci(hi.y + pad); ++y)
                                    for (int64_t z = ci(lo.z - pad); z <= ci(hi.z + pad); ++z) {
                                        const int64_t key = detail::cellKey(x, y, z);
                                        if (tgrid.find(key) != tgrid.end()) out.push_back({key, static_cast<uint32_t>(t)});
                                    }
                        }
                    }
                });
                for (const auto& b : blocks)
                    for (const auto& kv : b) tgrid[kv.first].push_back(kv.second);
            }
            // samples: n . (sum_i w_i delta_{v_i}) = 0 over the edge's two ends (+) and the face's three corners (-)
            struct Sample { uint32_t v[5]; double w[5]; int nv; V3 n; };
            std::vector<Sample> samples;
            const int ns = P.seamStitchSamples;
            // edges in blocks, in parallel; blocks are concatenated in order (deterministic)
            constexpr size_t kEdgeBlock = 512;
            std::vector<std::vector<Sample>> blockSamples((edges.size() + kEdgeBlock - 1) / kEdgeBlock);
            stLog("grid");
            detail::parallelFor(blockSamples.size(), threads, 1, [&](size_t b0, size_t b1, unsigned) {
              for (size_t bi = b0; bi < b1; ++bi) {
                std::vector<Sample>& out = blockSamples[bi];
                std::vector<std::pair<uint32_t, uint32_t>> best;  // (piece, face)
                std::vector<double> bestD;
                std::vector<std::array<double, 3>> bestW;
                for (size_t ei = bi * kEdgeBlock; ei < std::min(edges.size(), (bi + 1) * kEdgeBlock); ++ei) {
                const BE& E = edges[ei];
                const V3 A = groupPos[E.a], B = groupPos[E.b];
                const uint32_t own = piece[E.t];
                for (int k = 0; k < ns; ++k) {
                    const double s = (k + 0.5) / ns;
                    const V3 p = A + (B - A) * s;
                    auto it = tgrid.find(detail::cellKey(ci(p.x), ci(p.y), ci(p.z)));
                    if (it == tgrid.end()) continue;
                    // the nearest face of every other piece within tolerance
                    best.clear(); bestD.clear(); bestW.clear();
                    for (uint32_t f : it->second) {
                        if (piece[f] == own) continue;
                        double w[3];
                        const V3 q = closestOnTriangle(p, P0[tri[f][0]], P0[tri[f][1]], P0[tri[f][2]], w);
                        const double d = (p - q).norm();
                        if (d > tol) continue;
                        size_t j = 0;
                        while (j < best.size() && best[j].first != piece[f]) ++j;
                        if (j == best.size()) { best.push_back({piece[f], f}); bestD.push_back(d); bestW.push_back({w[0], w[1], w[2]}); }
                        else if (d < bestD[j] || (d == bestD[j] && f < best[j].second)) { best[j].second = f; bestD[j] = d; bestW[j] = {w[0], w[1], w[2]}; }
                    }
                    for (size_t j = 0; j < best.size(); ++j) {
                        const uint32_t f = best[j].second;
                        Sample sm{};
                        sm.n = triN0[f];
                        sm.nv = 0;
                        auto add = [&](uint32_t g, double wt) {
                            for (int i = 0; i < sm.nv; ++i) if (sm.v[i] == g) { sm.w[i] += wt; return; }
                            sm.v[sm.nv] = g; sm.w[sm.nv] = wt; ++sm.nv;
                        };
                        add(E.a, 1.0 - s);
                        add(E.b, s);
                        for (int q = 0; q < 3; ++q) add(triG[f][q], -bestW[j][q]);
                        double wsum = 0;
                        for (int i = 0; i < sm.nv; ++i) wsum += std::abs(sm.w[i]);
                        if (wsum > 1e-6) out.push_back(sm);
                    }
                }
                }
              }
            });
            for (auto& b : blockSamples) samples.insert(samples.end(), b.begin(), b.end());
            stLog("samples");
            S.stitchSamples = samples.size();
            if (samples.empty()) return;
            // variables: every vertex of a sample, and every vertex tied to a variable by a chunk-seam T-junction (the
            // seam contacts stay part of the system, so T-junctions stay closed while their vertices move); a variable's
            // own position weighs 1 when the snapping moved it, epsilon when it is as scanned
            std::vector<int32_t> var(G, -1);
            std::vector<uint32_t> vars;
            auto addVar = [&](uint32_t g) { if (var[g] < 0) { var[g] = static_cast<int32_t>(vars.size()); vars.push_back(g); return true; } return false; };
            for (const Sample& sm : samples) for (int i = 0; i < sm.nv; ++i) addVar(sm.v[i]);
            std::vector<uint32_t> seamTies;  // contacts among the variables
            const bool stitchTies = std::getenv("SB_STITCH_NO_TIES") ? false : P.seamStitchTies;
            if (P.seamCoherence && stitchTies && !contacts.empty()) {
                // closure over the contact graph by breadth-first search (group -> contacts index)
                std::vector<uint32_t> cStart(G + 1, 0), cIdx;
                for (const Contact& c : contacts) for (int i = 0; i < c.nv; ++i) cStart[c.v[i] + 1]++;
                for (size_t g = 0; g < G; ++g) cStart[g + 1] += cStart[g];
                cIdx.assign(cStart[G], 0);
                {
                    std::vector<uint32_t> fill(cStart.begin(), cStart.end() - 1);
                    for (uint32_t k = 0; k < contacts.size(); ++k) for (int i = 0; i < contacts[k].nv; ++i) cIdx[fill[contacts[k].v[i]]++] = k;
                }
                std::vector<uint8_t> seenContact(contacts.size(), 0);
                for (size_t qi = 0; qi < vars.size(); ++qi) {
                    const uint32_t g = vars[qi];
                    for (uint32_t j = cStart[g]; j < cStart[g + 1]; ++j) {
                        const uint32_t k = cIdx[j];
                        if (seenContact[k]) continue;
                        seenContact[k] = 1;
                        for (int i = 0; i < contacts[k].nv; ++i) addVar(contacts[k].v[i]);
                    }
                }
                for (uint32_t k = 0; k < contacts.size(); ++k) if (var[contacts[k].v[0]] >= 0) seamTies.push_back(k);
            }
            if (vars.empty()) return;
            const size_t n = vars.size();
            std::vector<V3> base(n);
            std::vector<double> prior(n);
            for (size_t v = 0; v < n; ++v) {
                base[v] = delta[vars[v]];
                prior[v] = delta[vars[v]].norm() > 0 ? P.seamStitchSnappedWeight : P.seamStitchEpsilon;
            }
            std::vector<uint8_t> held(n, 0);
            if (!P.buildingFootprintsXZ.empty()) {
                for (size_t v = 0; v < n; ++v) {
                    if (delta[vars[v]].norm() > 0) continue;  // snapped by the solve: not ground, may be stitched
                    if (outsideFootprints(groupPos[vars[v]])) { held[v] = 4; ++S.stitchGroundHeld; }
                }
            }
            // the folds through each variable (pairs of its kept faces sharing an edge) and their angle before the stitch:
            // a stitch may not turn a smooth fold into a new crease (sharper than stitchMaxFoldDeg and sharper than before)
            auto foldDeg = [&](uint32_t t1, uint32_t t2) {
                V3 n1, n2;
                double a1, a2;
                triAfter(t1, n1, a1);
                triAfter(t2, n2, a2);
                return detail::radToDeg(std::acos(std::clamp(n1.dot(n2), -1.0, 1.0)));
            };
            stLog("variables");
            std::vector<std::vector<std::array<float, 3>>> folds(n);  // (t1, t2, angle before)
            for (size_t v = 0; v < n; ++v) {
                const uint32_t g = vars[v];
                for (uint32_t q = groupTriStart[g]; q < groupTriStart[g + 1]; ++q) {
                    const uint32_t t1 = groupTris[q];
                    if (flags[t1] != kFlagKeep) continue;
                    for (uint32_t q2 = q + 1; q2 < groupTriStart[g + 1]; ++q2) {
                        const uint32_t t2 = groupTris[q2];
                        if (flags[t2] != kFlagKeep) continue;
                        int shared = 0;
                        for (int a = 0; a < 3; ++a) for (int b = 0; b < 3; ++b) if (triG[t1][a] == triG[t2][b]) ++shared;
                        if (shared == 2) folds[v].push_back({static_cast<float>(t1), static_cast<float>(t2), static_cast<float>(foldDeg(t1, t2))});
                    }
                }
            }
            // undamaged around the vertex, and no kept face collapses (the collapse flags are final by now)
            auto stitchOk = [&](uint32_t g) {
                if (!localOk(g)) return false;
                for (const auto& fd : folds[static_cast<size_t>(var[g])]) {
                    const double now = foldDeg(static_cast<uint32_t>(fd[0]), static_cast<uint32_t>(fd[1]));
                    if (now >= P.seamStitchMaxFoldDeg && now > fd[2] + 1.0 && now < P.creaseKeepDeg) return false;
                }
                for (uint32_t q = groupTriStart[g]; q < groupTriStart[g + 1]; ++q) {
                    const uint32_t t = groupTris[q];
                    if (flags[t] != kFlagKeep) continue;
                    V3 n1;
                    double a1;
                    triAfter(t, n1, a1);
                    if (isCollapsed(t, a1) || a1 < P.collapseKeepArea * 0.999) return false;
                }
                return true;
            };
            size_t moved = 0;
            constexpr int kStitchRounds = 16;
            // The stitch system decouples into connected components (samples and seam ties couple only their own
            // variables): each component is solved on its own, in parallel, and after the first round only the
            // components holding a newly held vertex are solved again.
            std::vector<uint32_t> compOf(n, 0), compVarStart, compVars, compSampleStart, compSamples, compTieStart, compTies;
            size_t ncomp = 0;
            {
                detail::UnionFind uf(n);
                for (const Sample& sm : samples) {
                    int32_t first = -1;
                    for (int j = 0; j < sm.nv; ++j) {
                        const int32_t vv = var[sm.v[j]];
                        if (vv < 0) continue;
                        if (first < 0) first = vv; else uf.unite(static_cast<uint32_t>(first), static_cast<uint32_t>(vv));
                    }
                }
                for (uint32_t k : seamTies) {
                    const Contact& c = contacts[k];
                    for (int i = 1; i < c.nv; ++i) uf.unite(static_cast<uint32_t>(var[c.v[0]]), static_cast<uint32_t>(var[c.v[i]]));
                }
                std::vector<uint32_t> rootLabel(n, UINT32_MAX);
                for (size_t v = 0; v < n; ++v) {
                    const uint32_t r = uf.find(static_cast<uint32_t>(v));
                    if (rootLabel[r] == UINT32_MAX) rootLabel[r] = static_cast<uint32_t>(ncomp++);
                    compOf[v] = rootLabel[r];
                }
                auto csr = [&](size_t count, const std::function<int64_t(size_t)>& compOfItem, std::vector<uint32_t>& start, std::vector<uint32_t>& items) {
                    start.assign(ncomp + 1, 0);
                    for (size_t i = 0; i < count; ++i) { const int64_t c = compOfItem(i); if (c >= 0) start[static_cast<size_t>(c) + 1]++; }
                    for (size_t c = 0; c < ncomp; ++c) start[c + 1] += start[c];
                    items.assign(start[ncomp], 0);
                    std::vector<uint32_t> fill(start.begin(), start.end() - 1);
                    for (size_t i = 0; i < count; ++i) { const int64_t c = compOfItem(i); if (c >= 0) items[fill[static_cast<size_t>(c)]++] = static_cast<uint32_t>(i); }
                };
                csr(n, [&](size_t v) { return static_cast<int64_t>(compOf[v]); }, compVarStart, compVars);
                csr(samples.size(), [&](size_t i) {
                    for (int j = 0; j < samples[i].nv; ++j) if (var[samples[i].v[j]] >= 0) return static_cast<int64_t>(compOf[static_cast<size_t>(var[samples[i].v[j]])]);
                    return static_cast<int64_t>(-1);
                }, compSampleStart, compSamples);
                csr(seamTies.size(), [&](size_t i) { return static_cast<int64_t>(compOf[static_cast<size_t>(var[contacts[seamTies[i]].v[0]])]); }, compTieStart, compTies);
            }
            // constant part of every sample (its fixed vertices; they do not move during the stitch)
            std::vector<double> kc(samples.size(), 0.0);
            for (size_t i = 0; i < samples.size(); ++i) {
                const Sample& sm = samples[i];
                for (int j = 0; j < sm.nv; ++j) if (var[sm.v[j]] < 0) kc[i] += sm.w[j] * sm.n.dot(delta[sm.v[j]]);
            }
            // a vertex whose move damaged something weighs 10x more for every time it did (its move shrinks), and is
            // pinned at its fourth strike
            static constexpr double kPow10[4] = {1.0, 10.0, 100.0, 1000.0};
            auto wOf = [&](size_t v) { return held[v] >= 4 ? 1e6 : prior[v] * kPow10[held[v]]; };
            std::vector<V3> xs(base);  // the current solution of every component
            std::vector<uint8_t> dirty(ncomp, 1);
            std::vector<int> compIters(ncomp, 0);
            std::vector<uint8_t> recheck;
            std::vector<uint32_t> localOf(n, 0);
            for (size_t i = 0; i < n; ++i) localOf[compVars[i]] = static_cast<uint32_t>(i - compVarStart[compOf[compVars[i]]]);
            // per component: the weight-independent part of the normal equations (samples and ties) and its symbolic
            // factorization are built once; every round only refactors with the current prior weights and solves
            struct CompSystem { detail::BlockSpd A; detail::SparseBlockCholesky chol; bool built{false}, direct{false}; std::vector<V3> bStatic; };
            std::vector<CompSystem> systems(ncomp);
            auto solveComp = [&](size_t c) {
                const uint32_t v0 = compVarStart[c], v1 = compVarStart[c + 1];
                const size_t m = v1 - v0;
                auto gv = [&](size_t l) { return static_cast<size_t>(compVars[v0 + l]); };
                auto lv = [&](uint32_t g) { return static_cast<uint32_t>(localOf[static_cast<size_t>(var[g])]); };
                CompSystem& sys = systems[c];
                if (!sys.built) {
                    sys.built = true;
                    detail::BlockSpd& A = sys.A;
                    A.init(m);
                    sys.bStatic.assign(m, V3{});
                    uint32_t lid[5];
                    double lw[5];
                    for (uint32_t ii = compSampleStart[c]; ii < compSampleStart[c + 1]; ++ii) {
                        const uint32_t i = compSamples[ii];
                        const Sample& sm = samples[i];
                        int k = 0;
                        for (int j = 0; j < sm.nv; ++j) {
                            if (var[sm.v[j]] < 0) continue;
                            lid[k] = lv(sm.v[j]); lw[k] = sm.w[j]; ++k;
                            sys.bStatic[lid[k - 1]] = sys.bStatic[lid[k - 1]] - sm.n * (sm.w[j] * kc[i]);
                        }
                        for (int a = 0; a < k; ++a)
                            for (int bb = a; bb < k; ++bb) A.add(lid[a], lid[bb], detail::BlockSpd::M3::outer(sm.n, sm.n, lw[a] * lw[bb]));
                    }
                    const double lamSeam = P.seamStiffness;
                    for (uint32_t ti = compTieStart[c]; ti < compTieStart[c + 1]; ++ti) {
                        const uint32_t k = seamTies[compTies[ti]];
                        const Contact& ct = contacts[k];
                        const V3 sv = contactClosed[k] ? projectContact(ct, ct.c) * lamSeam : V3{};
                        detail::BlockSpd::M3 Pi = ct.mode == 1 ? detail::BlockSpd::M3::outer(ct.ax, ct.ax, 1.0) : detail::BlockSpd::M3::identity(1.0);
                        if (ct.mode == 2) { const auto o = detail::BlockSpd::M3::outer(ct.ax, ct.ax, -1.0); Pi += o; }
                        for (int i = 0; i < ct.nv; ++i) {
                            const uint32_t li = lv(ct.v[i]);
                            sys.bStatic[li] += sv * ct.w[i];
                            for (int j = i; j < ct.nv; ++j) {
                                detail::BlockSpd::M3 B = Pi;
                                for (double& e : B.a) e *= lamSeam * ct.w[i] * ct.w[j];
                                const uint32_t lj = lv(ct.v[j]);
                                A.add(li, lj, B);
                                if (j != i && lj == li) A.add(li, lj, B);  // the same variable twice: both cross terms
                            }
                        }
                    }
                    A.finalize();
                    sys.direct = sys.chol.analyze(A);
                }
                std::vector<double> wl(m);
                std::vector<V3> x(m), b(m);
                for (size_t l = 0; l < m; ++l) {
                    const size_t v = gv(l);
                    wl[l] = wOf(v);
                    x[l] = xs[v];  // warm start for the iterative fallback
                    b[l] = base[v] * wl[l] + sys.bStatic[l];
                }
                if (sys.direct && sys.chol.numeric(sys.A, wl)) {
                    sys.chol.solve(b, x);
                    for (size_t l = 0; l < m; ++l) xs[gv(l)] = x[l];
                    compIters[c] = 0;
                    return;
                }
                // fallback: IC(0)-preconditioned conjugate gradients on the same system
                detail::BlockSpd A = sys.A;
                for (size_t l = 0; l < m; ++l) { A.D[l].a[0] += wl[l]; A.D[l].a[4] += wl[l]; A.D[l].a[8] += wl[l]; }
                A.factor();
                std::vector<V3> r(m), z(m), p(m), Ap(m);
                auto dot3 = [&](const std::vector<V3>& a, const std::vector<V3>& d) { double s = 0; for (size_t l = 0; l < m; ++l) s += a[l].dot(d[l]); return s; };
                A.mul(x, Ap);
                for (size_t l = 0; l < m; ++l) r[l] = b[l] - Ap[l];
                A.apply(r, z);
                double zmax = 0;
                for (size_t l = 0; l < m; ++l) { p[l] = z[l]; zmax = std::max(zmax, z[l].norm()); }
                double rz = dot3(r, z);
                const double tol2 = std::max(1e-30, 1e-20 * dot3(b, b));
                int it = 0;
                for (; it < P.seamStitchMaxIterations; ++it) {
                    if (dot3(r, r) <= tol2 || zmax < 1e-7) break;
                    A.mul(p, Ap);
                    const double pAp = dot3(p, Ap);
                    if (!(pAp > 0)) break;
                    const double alpha = rz / pAp;
                    for (size_t l = 0; l < m; ++l) { x[l] += p[l] * alpha; r[l] = r[l] - Ap[l] * alpha; }
                    A.apply(r, z);
                    zmax = 0;
                    for (size_t l = 0; l < m; ++l) zmax = std::max(zmax, z[l].norm());
                    const double rzNew = dot3(r, z);
                    const double beta = rzNew / rz;
                    rz = rzNew;
                    for (size_t l = 0; l < m; ++l) p[l] = z[l] + p[l] * beta;
                }
                for (size_t l = 0; l < m; ++l) xs[gv(l)] = x[l];
                compIters[c] = it;
            };
            stLog("setup");
            for (int round = 0; round < kStitchRounds; ++round) {
                std::vector<uint32_t> todo;
                for (size_t c = 0; c < ncomp; ++c) if (dirty[c]) todo.push_back(static_cast<uint32_t>(c));
                if (todo.empty()) break;
                std::stable_sort(todo.begin(), todo.end(), [&](uint32_t a, uint32_t b) { return compVarStart[a + 1] - compVarStart[a] > compVarStart[b + 1] - compVarStart[b]; });
                detail::parallelFor(todo.size(), threads, 1, [&](size_t b0, size_t b1, unsigned) { for (size_t i = b0; i < b1; ++i) solveComp(todo[i]); });
                // apply (moves under a micrometre are not applied), then hold back every vertex whose move damages anything
                // around it
                // groups whose position changed this round; only vertices around them can change their verdict
                std::vector<uint32_t> changedGroups;
                for (uint32_t c : todo) {
                    for (uint32_t i = compVarStart[c]; i < compVarStart[c + 1]; ++i) {
                        const size_t v = compVars[i];
                        const V3 next = (held[v] < 4 && (xs[v] - base[v]).norm() > 1e-6) ? xs[v] : base[v];
                        if (round == 0 || (next - delta[vars[v]]).norm() > 0) changedGroups.push_back(vars[v]);
                        delta[vars[v]] = next;
                    }
                }
                std::fill(dirty.begin(), dirty.end(), 0);
                if (recheck.size() != G) recheck.assign(G, 0);
                std::vector<uint32_t> marked;
                for (uint32_t g : changedGroups)
                    for (uint32_t q = groupTriStart[g]; q < groupTriStart[g + 1]; ++q) {
                        const uint32_t t = groupTris[q];
                        // the faces around g, and every face paired with them (opposed pairs) or folding with them (creases)
                        for (int k = 0; k < 3; ++k) if (!recheck[triG[t][k]]) { recheck[triG[t][k]] = 1; marked.push_back(triG[t][k]); }
                        for (uint32_t k = incPairStart[t]; k < incPairStart[t + 1]; ++k) {
                            const OpposedPair& op = opposed[incPair[k]];
                            for (uint32_t tt : {op.t, op.u}) for (int j = 0; j < 3; ++j) if (!recheck[triG[tt][j]]) { recheck[triG[tt][j]] = 1; marked.push_back(triG[tt][j]); }
                        }
                    }
                for (uint32_t g : changedGroups)
                    for (uint32_t k = incCreaseStart[g]; k < incCreaseStart[g + 1]; ++k)
                        for (uint32_t gg : creases[incCrease[k]].g) if (!recheck[gg]) { recheck[gg] = 1; marked.push_back(gg); }
                // verdicts in parallel (read-only), strikes applied after (deterministic)
                std::vector<uint32_t> toCheck;
                for (uint32_t g : marked) {
                    recheck[g] = 0;
                    const int32_t vv = var[g];
                    if (vv < 0) continue;
                    const size_t v = static_cast<size_t>(vv);
                    if (held[v] >= 4 || (delta[g] - base[v]).norm() <= 0) continue;
                    toCheck.push_back(static_cast<uint32_t>(v));
                }
                std::sort(toCheck.begin(), toCheck.end());
                std::vector<uint8_t> verdict(toCheck.size(), 1);
                detail::parallelFor(toCheck.size(), threads, 256, [&](size_t b0, size_t b1, unsigned) {
                    for (size_t i = b0; i < b1; ++i) verdict[i] = stitchOk(vars[toCheck[i]]) ? 1 : 0;
                });
                size_t bad = 0;
                for (size_t i = 0; i < toCheck.size(); ++i) {
                    if (verdict[i]) continue;
                    const size_t v = toCheck[i];
                    ++held[v]; ++bad; dirty[compOf[v]] = 1;
                }
                if (std::getenv("SB_DEBUG_STITCH")) std::fprintf(stderr, "stitch round %2d: %zu components solved (largest %u vars, %d iterations), %zu held %9.1f ms\n", round, todo.size(),
                                                                  todo.empty() ? 0u : compVarStart[todo[0] + 1] - compVarStart[todo[0]], todo.empty() ? 0 : compIters[todo[0]], bad, msSince(stT0));
                if (!bad) break;
                if (round == kStitchRounds - 1) {
                    // components that could not settle go back to the guarded state
                    for (size_t v = 0; v < n; ++v) if (dirty[compOf[v]]) delta[vars[v]] = base[v];
                }
            }
            for (size_t v = 0; v < n; ++v) if ((delta[vars[v]] - base[v]).norm() > 0) ++moved;
            stLog("solve");
            S.stitchedGroups = moved;
            S.stitchHeld = 0;
            for (size_t v = 0; v < n; ++v) S.stitchHeld += held[v] >= 4 ? 1 : 0;
        }

        /**
         * Triangles the final positions collapse to (near) zero area. With keepCollapsedSlivers each one is kept as
         * a sliver: its apex (the vertex opposite its longest edge) is pushed off that edge, along the input
         * face's direction, to collapseKeepWidth / collapseKeepArea. A push that would exceed collapseMaxNudge,
         * or that damages another kept face, is undone and the triangle is flagged 2 (dropped).
         */
        void finalizeCollapseFlags() {
            std::vector<uint32_t> coll;
            for (size_t t = 0; t < F; ++t) {
                if (flags[t] != kFlagKeep) continue;
                V3 n1;
                double a1;
                triAfter(t, n1, a1);
                if (isCollapsed(t, a1)) coll.push_back(static_cast<uint32_t>(t));
            }
            S.collapseCandidates += coll.size();
            std::vector<uint8_t> ok(coll.size(), 0);
            if (P.keepCollapsedSlivers && !coll.empty()) {
                std::unordered_map<uint32_t, V3> push;  // group -> accumulated push
                std::vector<uint8_t> inCollSet(F, 0);
                for (uint32_t t : coll) inCollSet[t] = 1;
                // the kept face across the edge (ga, gb) other than t, -1 when none
                auto across = [&](size_t t, uint32_t ga, uint32_t gb) -> int64_t {
                    for (uint32_t q = groupTriStart[ga]; q < groupTriStart[ga + 1]; ++q) {
                        const uint32_t o = groupTris[q];
                        if (o == t || flags[o] != kFlagKeep) continue;
                        if (triG[o][0] == gb || triG[o][1] == gb || triG[o][2] == gb) return o;
                    }
                    return -1;
                };
                auto widthOk = [&](size_t t, int& apexOut, V3& dirOut, double& needOut) {
                    V3 p[3];
                    for (int k = 0; k < 3; ++k) p[k] = vpos(tri[t][k]);
                    int i = 0;
                    double lmax = -1;
                    for (int k = 0; k < 3; ++k) { const double l = (p[(k + 1) % 3] - p[k]).norm(); if (l > lmax) { lmax = l; i = k; } }
                    apexOut = (i + 2) % 3;
                    if (lmax < 1e-6) { needOut = 1e300; return false; }
                    const V3 e = (p[(i + 1) % 3] - p[i]) * (1.0 / lmax);
                    // the sliver continues the face across its longest edge when that face agrees with its input
                    // orientation (its creases are then that face's own, not new 15-45 degree folds), else it
                    // keeps the input face's own direction
                    V3 nh = triN0[t] - e * triN0[t].dot(e);
                    const int64_t nb = across(t, triG[t][i], triG[t][(i + 1) % 3]);
                    if (nb >= 0 && !inCollSet[static_cast<size_t>(nb)]) {
                        V3 nA;
                        double aA;
                        triAfter(static_cast<size_t>(nb), nA, aA);
                        if (aA > 1e-6 && nA.dot(triN0[t]) >= 0.3) nh = nA - e * nA.dot(e);
                    }
                    if (nh.norm() < 0.5) { needOut = 1e300; return false; }
                    nh = nh.normalized();
                    const V3 u = nh.cross(e);
                    const double beta = (p[apexOut] - p[i]).dot(u);
                    const double h = std::max(P.collapseKeepWidth, 2.0 * P.collapseKeepArea / lmax);
                    dirOut = u;
                    needOut = h * 1.02 - beta;
                    return beta >= h;
                };
                for (int pass = 0; pass < 6; ++pass) {
                    bool any = false;
                    for (size_t i = 0; i < coll.size(); ++i) {
                        int apex;
                        V3 dir;
                        double need;
                        if (widthOk(coll[i], apex, dir, need)) continue;
                        if (!(need < 1e299)) continue;
                        const uint32_t g = triG[coll[i]][apex];
                        V3& acc = push[g];
                        if ((acc + dir * need).norm() > P.collapseMaxNudge) continue;
                        acc += dir * need;
                        delta[g] += dir * need;
                        any = true;
                    }
                    if (!any) break;
                }
                // verify: no other kept face damaged by a push; undo pushes that damage one
                std::vector<uint8_t> inColl(F, 0);
                for (uint32_t t : coll) inColl[t] = 1;
                for (int pass = 0; pass < 4; ++pass) {
                    std::vector<uint32_t> undo;
                    for (auto& kv : push) {
                        const uint32_t g = kv.first;
                        if (!(kv.second.norm() > 0)) continue;
                        bool bad = false;
                        for (uint32_t q = groupTriStart[g]; q < groupTriStart[g + 1] && !bad; ++q) {
                            const uint32_t t = groupTris[q];
                            if (flags[t] != kFlagKeep || triA0[t] < 1e-8) continue;
                            V3 n1;
                            double a1;
                            triAfter(t, n1, a1);
                            if (inColl[t]) { if (n1.dot(triN0[t]) < P.guardMinNormalDot && a1 > 1e-12) bad = true; continue; }
                            if (isCollapsed(t, a1) || triBadness(t) & (kBadFlip | kBadShrink)) bad = true;
                        }
                        if (bad) undo.push_back(g);
                    }
                    if (undo.empty()) break;
                    for (uint32_t g : undo) { delta[g] = delta[g] - push[g]; push[g] = V3{}; }
                }
                for (size_t i = 0; i < coll.size(); ++i) {
                    int apex;
                    V3 dir;
                    double need;
                    const uint32_t t = coll[i];
                    V3 n1;
                    double a1;
                    triAfter(t, n1, a1);
                    ok[i] = widthOk(t, apex, dir, need) && a1 >= P.collapseKeepArea * 0.999 && n1.dot(triN0[t]) >= P.guardMinNormalDot ? 1 : 0;
                }
            }
            for (size_t i = 0; i < coll.size(); ++i) {
                if (ok[i]) { ++S.collapseKeptAsSlivers; continue; }
                flags[coll[i]] = kFlagDegenerate;
                ++S.collapsedTriangles;
            }
        }
    };
};

} // namespace scan_rectifier
} // namespace scratchbox

#endif // SCRATCHBOX_SCAN_RECTIFIER_HPP
