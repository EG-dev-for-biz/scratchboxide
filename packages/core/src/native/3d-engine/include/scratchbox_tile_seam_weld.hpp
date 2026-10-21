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

// ============================================================================
// Kernel
// ============================================================================
class TileSeamWeld {
public:
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
