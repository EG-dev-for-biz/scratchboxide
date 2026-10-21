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
 * adjacent Google 3D Tiles chunks in a just-loaded scan, before anything reads wall planes or wall
 * directions out of the mesh.
 *
 * Measured (docs/processes/tile_seam_weld.md, Haughwout Building, 488 Broadway, leaf-LOD extraction,
 * 85 tile-chunk primitives, 198,710 triangles):
 *   - adjacent chunks are never stitched by the tile source: a boundary vertex of one chunk sits
 *     close to, but not on, a boundary edge of its neighbour. Of ~63k such cross-chunk contacts
 *     within 10 cm, 31% land at or under 3 cm (the true-seam band: median ~1.5 cm, nothing above
 *     3 cm); the rest (gap > 3 cm) are incidental proximity between unrelated surfaces, not seams.
 *   - this pre-weld mesh has NO elevated rate of thin/elongated triangles specifically next to those
 *     contacts (aspect-ratio > 8 rate: 12.1% on a seam vertex against 14.1% elsewhere -- slightly
 *     LOWER, not higher). An unconditional "drop anything thin near a seam" rule would therefore
 *     mostly cut ordinary facade geometry. What the kernel drops instead is triangles that the WELD
 *     ITSELF turns degenerate: a triangle already bridging the gap (one short edge on the order of
 *     the gap) necessarily collapses toward zero area once that gap closes. Ordinary geometry, whose
 *     edges are tens of centimetres or more, is moved by at most weldToleranceM and keeps its shape.
 *
 * Why this runs where it runs: scratchbox_scan_rectifier.hpp's own D1 weld (weldEpsilon, default
 * 1 mm) is far tighter than a 1-3 cm tile seam, and its D4 orientation-family vote and D5 planar
 * regions run four stages before its own D8 seam close (tJunctionTolerance, default 3 cm) -- so even
 * inside scan_rectifier's pipeline the wall-direction vote sees the seam. Worse, scan_fit.hpp's own
 * wall-plane fit (the "fit" stage) never sees scan_rectifier at all: it reads tile_refine's
 * `rawClayGlb`, written by `passThroughMesh()` straight from the loaded scan -- before
 * scan_rectifier::rectifyMesh() is even called. A single pre-pass, run on the scan the moment it is
 * loaded and before isolation, relief or rectification touch it, reaches every later consumer.
 *
 * Detection reuses the same approach as scan_rectifier's own D8 (scratchbox_scan_rectifier.hpp
 * buildSeamContacts(), "chunk seams"): union-find over raw triangle adjacency finds each chunk's
 * connected piece without any chunk-id metadata (none exists this early); the boundary of a piece is
 * the set of edges used by exactly one of its triangles; a uniform grid over boundary-edge bounding
 * boxes answers "nearest boundary edge of a DIFFERENT piece" with point-segment distance. The
 * difference is where it runs (immediately after the scan is read, not after four other rectifier
 * stages) and what it does with a contact (move the vertex directly onto the matched point -- "a
 * simple position weld, not a solver", per the measured tolerance -- and drop whatever triangle that
 * move collapses), not the geometry used to find one.
 *
 * Every tolerance here is a continuous metric derived from the measurement above, not a scene
 * constant: there is no notion of "this is a building" or "this is a tile" anywhere in this file.
 */

#include "scratchbox_geometry.hpp"
#include "scratchbox_scan_rectifier.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <functional>
#include <string>
#include <unordered_map>
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
     * A boundary vertex of one tile chunk snaps onto the nearest boundary edge of another chunk when
     * their gap is at most this far apart. Default 0.03 m: the measured real-seam band tops out at
     * 3 cm (docs/processes/tile_seam_weld.md); it also matches the tolerance scan_rectifier's own D8
     * already uses to call a contact closeable (tJunctionTolerance), so a tile that later also runs
     * scan_rectifier sees a consistent idea of "closed".
     */
    double weldToleranceM{0.03};
    /** Grid padding beyond weldToleranceM when searching for a partner edge (same convention as
     *  scan_rectifier's edgeGrid padding). */
    double searchPadM{0.01};
    /**
     * A triangle touched by a weld is dropped only when its post-weld narrow dimension (altitude) is
     * at most this fraction of weldToleranceM. A triangle that was genuinely bridging the gap has a
     * short edge on the order of the gap itself, so once the gap closes that edge -- and the
     * triangle's altitude -- collapses toward zero; ordinary geometry (edges of tens of centimetres
     * or more, moved by at most weldToleranceM) stays far above this floor. Default 0.5.
     */
    double sliverAltitudeFraction{0.5};
    /**
     * A dropped triangle must also be at least this elongated (longest edge / altitude). Default 4.0,
     * chosen above the measured whole-mesh median aspect ratio (2.75, Haughwout sample) so a merely
     * small-but-regular triangle near a seam is not also caught.
     */
    double sliverAspectMin{4.0};
    /** Worker threads for the grid search (0 = hardware concurrency). */
    int threads{0};
};

// ============================================================================
// Result
// ============================================================================
struct TileSeamWeldStats {
    size_t vertexCount{0};
    size_t triangleCount{0};
    size_t pieceCount{0};
    size_t boundaryVerts{0};
    size_t boundaryEdges{0};
    /** Cross-piece contacts within weldToleranceM + searchPadM, before any gating. */
    size_t contactsFound{0};
    /** Boundary vertices actually moved (contact gap > 0 and <= weldToleranceM). */
    size_t vertsWelded{0};
    size_t trianglesDropped{0};
    double meanWeldDisplacementM{0};
    double maxWeldDisplacementM{0};
    /** Gap histogram of every contact found, bucketed like scan_rectifier's own gapHistogram:
     *  [0, 1mm, 5mm, 1cm, 3cm, 10cm). Lets a caller compare this pre-pass's input directly against
     *  scan_rectifier's "before" histogram on the same tile. */
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

// ============================================================================
// Kernel
// ============================================================================
class TileSeamWeld {
public:
    /**
     * Welds matching tile-chunk boundary vertex pairs within params.weldToleranceM directly onto
     * each other (mutates mesh.vertices[*].position in place) and marks the triangles that weld
     * collapses into slivers for removal. Does not touch UVs, normals, colour or material; does not
     * remove vertices (only triangles); does not run a solver -- each matched vertex moves once, to
     * the closest point on its matched partner edge, computed from the ORIGINAL (pre-weld)
     * positions, so welds never cascade into each other.
     */
    static TileSeamWeldResult weldAndMarkSlivers(geometry::ScratchboxMesh& mesh, const TileSeamWeldParams& p = {}) {
        TileSeamWeldResult res;
        const size_t V = mesh.vertices.size();
        const size_t F = mesh.indices.size() / 3;
        res.stats.vertexCount = V;
        res.stats.triangleCount = F;
        if (V == 0 || F == 0) { res.error = "mesh has no triangles"; return res; }

        // ---- piece = connected component of raw vertex ids through triangle edges. This is exactly
        // how scan_rectifier tells chunks apart too (keptComponent in buildSeamContacts): no chunk-id
        // metadata exists this early (GlbSceneReader flattens every glTF primitive into one vertex /
        // index buffer), but different tile-chunk primitives never share a raw vertex id before any
        // weld runs, so plain triangle-edge adjacency already separates them correctly.
        scan_rectifier::detail::UnionFind uf(V);
        for (size_t t = 0; t < F; ++t) {
            const uint32_t a = mesh.indices[3 * t], b = mesh.indices[3 * t + 1], c = mesh.indices[3 * t + 2];
            uf.unite(a, b);
            uf.unite(a, c);
        }
        std::vector<uint32_t> piece(V);
        for (size_t v = 0; v < V; ++v) piece[v] = uf.find(static_cast<uint32_t>(v));
        {
            std::vector<uint32_t> ren(V, UINT32_MAX);
            uint32_t next = 0;
            for (size_t v = 0; v < V; ++v) { uint32_t& r = ren[piece[v]]; if (r == UINT32_MAX) r = next++; piece[v] = r; }
            res.stats.pieceCount = next;
        }

        // ---- boundary edges: used by exactly one triangle (globally -- a shared edge always unites
        // its two triangles' pieces, so "used once" already implies "on this piece's own boundary").
        struct BEdge { uint32_t a, b; uint32_t piece; };
        std::unordered_map<uint64_t, std::pair<uint32_t, uint32_t>> edgeCount;  // key -> (count, piece)
        edgeCount.reserve(F * 3);
        for (size_t t = 0; t < F; ++t) {
            for (int k = 0; k < 3; ++k) {
                const uint32_t a = mesh.indices[3 * t + k], b = mesh.indices[3 * t + (k + 1) % 3];
                if (a == b) continue;
                const uint64_t key = (static_cast<uint64_t>(std::min(a, b)) << 32) | std::max(a, b);
                auto& e = edgeCount[key];
                e.first++;
                e.second = piece[a];
            }
        }
        std::vector<BEdge> bEdges;
        bEdges.reserve(edgeCount.size() / 4);
        for (const auto& kv : edgeCount) {
            if (kv.second.first != 1) continue;
            bEdges.push_back({static_cast<uint32_t>(kv.first >> 32), static_cast<uint32_t>(kv.first & 0xffffffffu), kv.second.second});
        }
        res.stats.boundaryEdges = bEdges.size();
        std::vector<uint8_t> isBoundary(V, 0);
        for (const auto& e : bEdges) { isBoundary[e.a] = 1; isBoundary[e.b] = 1; }
        std::vector<uint32_t> boundaryVerts;
        for (size_t v = 0; v < V; ++v) if (isBoundary[v]) boundaryVerts.push_back(static_cast<uint32_t>(v));
        res.stats.boundaryVerts = boundaryVerts.size();

        auto pos = [&](uint32_t v) { const auto& p3 = mesh.vertices[v].position; return V3{p3.x, p3.y, p3.z}; };

        // ---- spatial grid over boundary VERTICES (not edges): a vertex-to-vertex weld snaps a moved
        // vertex exactly onto an existing vertex's position, which is what downstream exact/near-exact
        // position welds (scan_rectifier's own D1, scan_fit's own load step) key on. An earlier version
        // of this pass snapped onto the closest point of a foreign boundary EDGE (matching D8's own
        // T-junction contacts) -- measured on Haughwout isolate: it left scan_fit.hpp's own wall-plane
        // fit far MORE fragmented than doing nothing (182 primitives / 2398 surfaces against 4 / 54,
        // same input otherwise), because a point on an edge interior is, in general, nobody's vertex:
        // it does not coincide with any neighbour's position, so every later position-keyed step treats
        // it as yet another distinct point instead of the shared seam point it visually sits on.
        const double pad = p.weldToleranceM + p.searchPadM;
        const double cell = std::max(2.0, pad * 4.0);  // a vertex's 3x3x3 cell block always covers the search radius
        auto ci = [&](double v) { return static_cast<int64_t>(std::floor(v / cell)); };
        std::unordered_map<int64_t, std::vector<uint32_t>, scan_rectifier::detail::CellKeyHash> grid;
        for (uint32_t i = 0; i < boundaryVerts.size(); ++i) {
            const V3 a = pos(boundaryVerts[i]);
            grid[scan_rectifier::detail::cellKey(ci(a.x), ci(a.y), ci(a.z))].push_back(i);
        }
        // a vertex's own 3x3x3 neighbourhood of cells (pad <= cell, so this always covers the search radius)
        auto forNeighborCells = [&](const V3& p3, const std::function<void(const std::vector<uint32_t>&)>& fn) {
            const int64_t cx = ci(p3.x), cy = ci(p3.y), cz = ci(p3.z);
            for (int64_t dx = -1; dx <= 1; ++dx) for (int64_t dy = -1; dy <= 1; ++dy) for (int64_t dz = -1; dz <= 1; ++dz) {
                auto it = grid.find(scan_rectifier::detail::cellKey(cx + dx, cy + dy, cz + dz));
                if (it != grid.end()) fn(it->second);
            }
        };

        // ---- per boundary vertex: nearest boundary VERTEX of a DIFFERENT piece within the search pad.
        // One target per vertex, computed from ORIGINAL positions only (no cascading): the gating
        // (<= weldToleranceM) happens after every target is known, so later vertices never see an
        // already-moved earlier one. A matched PAIR only ever moves the higher-piece-id side onto the
        // lower-piece-id side's (unmoved) position -- a fixed, arbitrary but consistent tie-break -- so
        // two boundary vertices that are each other's nearest match can never swap places or chase each
        // other: exactly one of the two actually moves.
        struct Target { uint32_t v; V3 to; double gap; };
        std::vector<Target> targets(boundaryVerts.size());
        std::vector<uint8_t> hasTarget(boundaryVerts.size(), 0);
        const unsigned threads = scan_rectifier::detail::resolveThreads(p.threads);
        std::vector<size_t> histPerThread(threads * 6, 0);
        std::atomic<size_t> contactCounter{0};
        const double edgesM[6] = {0.0, 0.001, 0.005, 0.01, 0.03, 0.1};
        scan_rectifier::detail::parallelFor(boundaryVerts.size(), threads, 256, [&](size_t i0, size_t i1, unsigned th) {
            for (size_t i = i0; i < i1; ++i) {
                const uint32_t v = boundaryVerts[i];
                const V3 p3 = pos(v);
                double bestD = 1e300;
                uint32_t bestH = UINT32_MAX;
                forNeighborCells(p3, [&](const std::vector<uint32_t>& cellVerts) {
                    for (uint32_t j : cellVerts) {
                        const uint32_t h = boundaryVerts[j];
                        if (piece[h] == piece[v]) continue;
                        const double d = (p3 - pos(h)).norm();
                        if (d <= pad && (d < bestD || (d == bestD && h < bestH))) { bestD = d; bestH = h; }
                    }
                });
                if (bestH == UINT32_MAX) continue;
                ++contactCounter;
                int b = 0;
                for (int k = 0; k < 6; ++k) if (bestD >= edgesM[k]) b = k;
                histPerThread[th * 6 + static_cast<size_t>(b)]++;
                // tie-break: only the higher-piece-id vertex moves (ties on piece id broken by raw vertex
                // id), so of a mutually-nearest pair exactly one target is ever recorded.
                const bool thisMoves = piece[v] > piece[bestH] || (piece[v] == piece[bestH] && v > bestH);
                if (thisMoves && bestD > 1e-9 && bestD <= p.weldToleranceM) {
                    targets[i] = Target{v, pos(bestH), bestD};
                    hasTarget[i] = 1;
                }
            }
        });
        res.stats.contactsFound = contactCounter.load();
        for (unsigned th = 0; th < threads; ++th) for (int k = 0; k < 6; ++k) res.stats.gapHistogram[static_cast<size_t>(k)] += histPerThread[th * 6 + static_cast<size_t>(k)];

        // ---- apply the welds (direct position assignment; "a simple position weld, not a solver")
        // and remember every vertex this pass actually moved, so the sliver check only looks at
        // triangles the weld itself touched.
        std::vector<uint8_t> moved(V, 0);
        double sumD = 0.0, maxD = 0.0;
        size_t weldedCount = 0;
        for (size_t i = 0; i < boundaryVerts.size(); ++i) {
            if (!hasTarget[i]) continue;
            const Target& tg = targets[i];
            mesh.vertices[tg.v].position = geometry::Vec3(static_cast<float>(tg.to.x), static_cast<float>(tg.to.y), static_cast<float>(tg.to.z));
            moved[tg.v] = 1;
            sumD += tg.gap;
            maxD = std::max(maxD, tg.gap);
            ++weldedCount;
        }
        res.stats.vertsWelded = weldedCount;
        res.stats.meanWeldDisplacementM = weldedCount ? sumD / static_cast<double>(weldedCount) : 0.0;
        res.stats.maxWeldDisplacementM = maxD;

        // ---- drop triangles the weld collapsed into slivers (post-weld shape, see file header for
        // why this is the right discriminator: an ordinary triangle is barely perturbed by a move of
        // at most weldToleranceM; a triangle that was bridging the gap collapses toward zero area).
        res.keepTriangle.assign(F, kFlagKeep);
        size_t dropped = 0;
        for (size_t t = 0; t < F; ++t) {
            const uint32_t i0 = mesh.indices[3 * t], i1 = mesh.indices[3 * t + 1], i2 = mesh.indices[3 * t + 2];
            if (!moved[i0] && !moved[i1] && !moved[i2]) continue;
            const V3 a = pos(i0), b = pos(i1), c = pos(i2);
            const double ab = (b - a).norm(), bc = (c - b).norm(), ca = (a - c).norm();
            const double s = (ab + bc + ca) * 0.5;
            const double areaSq = std::max(0.0, s * (s - ab) * (s - bc) * (s - ca));
            const double area = std::sqrt(areaSq);
            const double longest = std::max({ab, bc, ca});
            const double altitude = longest > 1e-9 ? 2.0 * area / longest : 0.0;
            const double aspect = altitude > 1e-9 ? longest / altitude : 1e300;
            if (altitude <= p.sliverAltitudeFraction * p.weldToleranceM && aspect >= p.sliverAspectMin) {
                res.keepTriangle[t] = kFlagHidden;
                ++dropped;
            }
        }
        res.stats.trianglesDropped = dropped;

        res.ok = true;
        return res;
    }

    /**
     * Physically removes the triangles `keepTriangle` marks dropped (kFlagHidden) from mesh.indices,
     * keeping every per-triangle side array the caller passes (e.g. GltfScene::triangleMaterial) in
     * lockstep. Vertices are left untouched (only `vertices.size()` consumers reindex; dropping a
     * vertex here would renumber every remaining triangle's indices for no benefit, since an unused
     * weld-group vertex costs nothing downstream). Safe to call with an empty `sideArrays`.
     */
    static void compactDropped(geometry::ScratchboxMesh& mesh, const std::vector<uint8_t>& keepTriangle, std::vector<std::vector<uint32_t>*> sideArrays = {}) {
        const size_t F = mesh.indices.size() / 3;
        if (keepTriangle.size() != F) return;
        size_t kept = 0;
        for (size_t t = 0; t < F; ++t) if (keepTriangle[t] == kFlagKeep) ++kept;
        if (kept == F) return;  // nothing dropped
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
};

} // namespace tile_seam_weld
} // namespace scratchbox

#endif // SCRATCHBOX_TILE_SEAM_WELD_HPP
