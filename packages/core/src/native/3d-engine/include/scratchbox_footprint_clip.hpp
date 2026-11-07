/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's footprint clip by the robust boolean (scratchbox_boolean.hpp): every primitive of the building trimmed to
 * the inside of one closed prism, the footprint's loops pushed out by the margin (mitred) and extruded past the
 * building's height both ways. Unlike the line-by-line clip (scratchbox_lattice_cut.hpp clip), a triangle is cut only
 * where the prism's walls really cross it, never along an outline line's far extension, and every cut point is shared
 * by the triangles that meet there, so the clip leaves exactly one open curve along the prism wall for the infill to close.
 * Short edges at the new points are collapsed (collapseM) where that keeps the surface valid, so no sliver is left
 * along the cut.
 *
 * Output is the line clip's contract (lattice_cut::PrimOut): per primitive the triangles cut or dropped (made degenerate
 * by the caller) and the kept pieces welded, every attribute carried by barycentric weights in the source triangle
 * (flag-like attributes from the nearest corner, normals renormalised).
 */

#pragma once

#include "scratchbox_boolean.hpp"
#include "scratchbox_lattice_cut.hpp"

#include <cmath>
#include <cstring>
#include <string>
#include <unordered_map>
#include <vector>

namespace scratchbox {
namespace footprint_clip {

struct Report {
    double cutTriangles = 0, removedTriangles = 0, removedAreaM2 = 0;
    /** The prism: its plan loops and triangles. */
    double prismLoops = 0, prismTriangles = 0;
    /** The boolean's own checks (all zero on sound input) and how many short edges were collapsed. */
    double crossings = 0, unpairedSegments = 0, chainFailures = 0, windingConflicts = 0, ties = 0, fallbackFaces = 0, collapsed = 0;
    /** New triangles along the cut: how many, and how many are slivers (smallest angle under 1 degree, or under 1 mm2). */
    double newTriangles = 0, slivers = 0;
    /** Edges of one triangle after the clip, among the clipped primitives (the cut curve plus holes the scan had). */
    double openEdgesAfter = 0, nonManifoldAfter = 0;
};

inline std::string reportJson(const Report& r) {
    const auto f = [](double v) { char b[64]; std::snprintf(b, sizeof b, "%.10g", v); return std::string(b); };
    return std::string("{") + "\"cutTriangles\":" + f(r.cutTriangles) + ",\"removedTriangles\":" + f(r.removedTriangles) + ",\"removedAreaM2\":" + f(r.removedAreaM2) +
           ",\"prismLoops\":" + f(r.prismLoops) + ",\"prismTriangles\":" + f(r.prismTriangles) + ",\"crossings\":" + f(r.crossings) + ",\"unpairedSegments\":" + f(r.unpairedSegments) +
           ",\"chainFailures\":" + f(r.chainFailures) + ",\"windingConflicts\":" + f(r.windingConflicts) + ",\"ties\":" + f(r.ties) + ",\"fallbackFaces\":" + f(r.fallbackFaces) +
           ",\"collapsed\":" + f(r.collapsed) + ",\"newTriangles\":" + f(r.newTriangles) + ",\"slivers\":" + f(r.slivers) + ",\"openEdgesAfter\":" + f(r.openEdgesAfter) +
           ",\"nonManifoldAfter\":" + f(r.nonManifoldAfter) + "}";
}

inline double triArea(const boolean::V3& a, const boolean::V3& b, const boolean::V3& c) {
    using namespace boolean::detail;
    return norm(cross(sub(b, a), sub(c, a))) / 2;
}

inline double minAngleDeg3(const boolean::V3& a, const boolean::V3& b, const boolean::V3& c) {
    using namespace boolean::detail;
    const auto ang = [](const boolean::V3& p, const boolean::V3& q, const boolean::V3& r) { const auto u = sub(q, p), v = sub(r, p); return std::atan2(norm(cross(u, v)), dot(u, v)) * 180 / M_PI; };
    return std::min({ang(a, b, c), ang(b, c, a), ang(c, a, b)});
}

/** The clip: `prims` trimmed to the footprint (`loops`, plan x z) pushed out by marginM. */
inline std::vector<lattice_cut::PrimOut> clip(const std::vector<lattice_cut::Prim>& prims, const std::vector<lattice_cut::Loop>& loops, double marginM, double collapseM, Report& report) {
    using boolean::V3;
    // every primitive's triangles as one mesh (shared positions weld across primitives, so the cut agrees at their seams)
    boolean::Mesh A;
    std::vector<std::pair<uint32_t, uint32_t>> owner;  // per mesh triangle: primitive, first index slot
    std::vector<uint32_t> vbase(prims.size());
    double ylo = std::numeric_limits<double>::infinity(), yhi = -ylo;
    for (size_t p = 0; p < prims.size(); ++p) {
        vbase[p] = static_cast<uint32_t>(A.pos.size());
        const auto& pr = prims[p];
        for (size_t v = 0; v * 3 + 2 < pr.pos.size(); ++v) {
            A.pos.push_back({pr.pos[v * 3], pr.pos[v * 3 + 1], pr.pos[v * 3 + 2]});
            ylo = std::min(ylo, pr.pos[v * 3 + 1]);
            yhi = std::max(yhi, pr.pos[v * 3 + 1]);
        }
        for (size_t t = 0; t + 2 < pr.I.size(); t += 3) {
            A.tris.push_back({static_cast<int>(vbase[p] + pr.I[t]), static_cast<int>(vbase[p] + pr.I[t + 1]), static_cast<int>(vbase[p] + pr.I[t + 2])});
            owner.push_back({static_cast<uint32_t>(p), static_cast<uint32_t>(t)});
        }
    }
    std::vector<lattice_cut::PrimOut> outs(prims.size());
    for (size_t p = 0; p < prims.size(); ++p) {
        outs[p].attr.resize(prims[p].comps.size());
        outs[p].mn = {std::numeric_limits<double>::infinity(), std::numeric_limits<double>::infinity(), std::numeric_limits<double>::infinity()};
        outs[p].mx = {-outs[p].mn[0], -outs[p].mn[1], -outs[p].mn[2]};
    }
    if (A.tris.empty()) return outs;
    std::vector<boolean::Loop2> plan;
    for (const auto& l : loops) { boolean::Loop2 q; for (const auto& p : l) q.push_back({p[0], p[1]}); plan.push_back(q); }
    const auto region = boolean::offsetRegion(plan, marginM);
    const boolean::Mesh B = boolean::prism(region, ylo - 10, yhi + 10);
    report.prismLoops = static_cast<double>(region.size());
    report.prismTriangles = static_cast<double>(B.tris.size());
    boolean::Options opt;
    opt.weldByPosition = true;
    opt.collapseShort = collapseM;
    const boolean::Result R = boolean::compute(A, B, boolean::Op::TrimInside, opt);
    const auto& rp = R.report;
    report.crossings = static_cast<double>(rp.crossingsA + rp.crossingsB);
    report.unpairedSegments = static_cast<double>(rp.unpairedSegments);
    report.chainFailures = static_cast<double>(rp.chainFailures);
    report.windingConflicts = static_cast<double>(rp.windingConflicts);
    report.ties = static_cast<double>(rp.ties);
    report.fallbackFaces = static_cast<double>(rp.fallbackFaces);
    report.collapsed = static_cast<double>(rp.collapsed);
    report.openEdgesAfter = static_cast<double>(rp.openEdgesOut);
    report.nonManifoldAfter = static_cast<double>(rp.nonManifoldOut);

    // which source triangles came through whole: an output triangle on the source's own three vertices, weights the identity
    const size_t nSrc = A.tris.size();
    std::vector<std::vector<size_t>> pieces(nSrc);
    for (size_t t = 0; t < R.mesh.tris.size(); ++t) pieces[static_cast<size_t>(R.source[t])].push_back(t);
    const auto whole = [&](size_t s) {
        if (pieces[s].size() != 1) return false;
        const auto& b = R.bary[pieces[s][0]];
        for (int k = 0; k < 3; ++k) for (int c = 0; c < 3; ++c) if (b[k][c] != (k == c ? 1.0 : 0.0)) return false;
        return true;
    };
    // per primitive, its kept pieces welded by (output vertex, attribute values)
    std::vector<std::unordered_map<std::string, uint32_t>> weld(prims.size());
    std::vector<double> buf;
    for (size_t s = 0; s < nSrc; ++s) {
        const auto [p, slot] = owner[s];
        const auto& pr = prims[p];
        const auto& I = pr.I;
        if (I[slot] == I[slot + 1] || I[slot + 1] == I[slot + 2] || I[slot] == I[slot + 2]) continue;
        if (whole(s)) continue;
        // a triangle with no area (welded away by the boolean) is left as it was
        if (pieces[s].empty() && triArea(A.pos[A.tris[s][0]], A.pos[A.tris[s][1]], A.pos[A.tris[s][2]]) == 0) continue;
        lattice_cut::PrimOut& o = outs[p];
        o.cut.push_back(slot);
        const V3& a = A.pos[A.tris[s][0]];
        const V3& b = A.pos[A.tris[s][1]];
        const V3& c = A.pos[A.tris[s][2]];
        double keptArea = 0;
        for (size_t t : pieces[s]) {
            uint32_t ids[3];
            for (int k = 0; k < 3; ++k) {
                const int vid = R.mesh.tris[t][k];
                const V3& q = R.mesh.pos[vid];
                const auto& w = R.bary[t][k];
                // attributes from the source corners by weight
                buf.assign(1, static_cast<double>(vid));
                int nearest = 0;
                for (int j = 1; j < 3; ++j) if (w[j] > w[nearest]) nearest = j;
                for (size_t ak = 0; ak < pr.attr.size(); ++ak) {
                    const int comps = pr.comps[ak];
                    double acc[4] = {0, 0, 0, 0};
                    for (int cc = 0; cc < comps && cc < 4; ++cc) {
                        if (pr.flag[ak]) acc[cc] = pr.attr[ak][static_cast<size_t>(I[slot + nearest]) * comps + cc];
                        else for (int j = 0; j < 3; ++j) acc[cc] += w[j] * pr.attr[ak][static_cast<size_t>(I[slot + j]) * comps + cc];
                    }
                    if (pr.normal[ak]) { const double l = std::sqrt(acc[0] * acc[0] + acc[1] * acc[1] + acc[2] * acc[2]); if (l > 0) for (int cc = 0; cc < 3; ++cc) acc[cc] /= l; }
                    for (int cc = 0; cc < comps; ++cc) buf.push_back(static_cast<double>(static_cast<float>(cc < 4 ? acc[cc] : 0)));
                }
                std::string key(reinterpret_cast<const char*>(buf.data()), buf.size() * sizeof(double));
                auto it = weld[p].find(key);
                if (it == weld[p].end()) {
                    it = weld[p].emplace(std::move(key), static_cast<uint32_t>(o.verts++)).first;
                    for (int cc = 0; cc < 3; ++cc) { o.pos.push_back(static_cast<float>(q[cc])); o.mn[cc] = std::min(o.mn[cc], q[cc]); o.mx[cc] = std::max(o.mx[cc], q[cc]); }
                    size_t off = 1;
                    for (size_t ak = 0; ak < pr.attr.size(); ++ak) for (int cc = 0; cc < pr.comps[ak]; ++cc) o.attr[ak].push_back(static_cast<float>(buf[off++]));
                }
                ids[k] = it->second;
            }
            o.tris.insert(o.tris.end(), {ids[0], ids[1], ids[2]});
            const auto& tr = R.mesh.tris[t];
            const double ar = triArea(R.mesh.pos[tr[0]], R.mesh.pos[tr[1]], R.mesh.pos[tr[2]]);
            keptArea += ar;
            report.newTriangles++;
            if (ar < 1e-6 || minAngleDeg3(R.mesh.pos[tr[0]], R.mesh.pos[tr[1]], R.mesh.pos[tr[2]]) < 1.0) report.slivers++;
        }
        if (pieces[s].empty()) report.removedTriangles++; else report.cutTriangles++;
        report.removedAreaM2 += std::max(0.0, triArea(a, b, c) - keptArea);
    }
    return outs;
}

}  // namespace footprint_clip
}  // namespace scratchbox
