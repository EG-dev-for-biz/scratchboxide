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
#include "scratchbox_scan_rectifier.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
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
    static TileSeamWeldResult weldAndMarkSlivers(geometry::ScratchboxMesh& mesh, const TileSeamWeldParams& p = {}) {
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
        {
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
