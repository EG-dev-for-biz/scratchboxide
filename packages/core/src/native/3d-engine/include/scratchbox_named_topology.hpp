/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Named faces and edges on a triangle mesh: a script says `edges="top"` or `face="top"` instead of a direction cone
 * and a box in fractions of the bounds.
 *
 * - Faces: a maker writes, per triangle, which FaceGroup it belongs to (ScratchboxMesh::faceGroup); each group is one
 *   smooth surface and carries its names ("top", "side", "plate.top"). Edits that keep triangles keep the names; the
 *   bevel (scratchbox_mesh_ops.hpp) carries them through and names its own faces "chamfer" or "fillet".
 * - Edges are never stored: an edge is a real edge where its two triangles belong to different groups, and it is
 *   named from them, as sand3d names its edges (Apache-2.0; the idea, none of its code): the cap names of the two
 *   faces ("top", "bottom", "start", "end"; plain or qualified, "plate.top"), plus a bevel face's own kind; an edge
 *   between two walls takes the walls' edge kind ("side").
 * - A name is an open label. It selects geometry for an edit and never chooses how geometry is made.
 *
 * Every lookup fails loudly: a name no face or edge carries is refused with the names the mesh has, and a mesh whose
 * names an earlier operation lost says so, rather than an edit quietly doing nothing.
 */

#pragma once

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <map>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace scratchbox {
namespace named {

using math::Vec3;
using geometry::FaceGroup;
using geometry::ScratchboxMesh;

/** The part of a name after its qualifier: "plate.top" -> "top". */
inline std::string plainName(const std::string& n) {
    const size_t dot = n.rfind('.');
    return dot == std::string::npos ? n : n.substr(dot + 1);
}

/** Cap names: an edge bounding a face with one of these takes its name. The makers' own words for their ends. */
inline bool isCapName(const std::string& n) {
    const std::string p = plainName(n);
    return p == "top" || p == "bottom" || p == "start" || p == "end";
}

/** Throws unless the mesh names its triangles; `verb` is the call that needed them. */
inline void requireNames(const ScratchboxMesh& m, const std::string& verb) {
    if (m.hasFaceNames()) return;
    if (!m.faceGroups.empty()) {
        throw std::invalid_argument(verb + ": '" + m.name + "' had face names, but an operation after its maker rebuilt its "
            "triangles without them (subdivide, decimate, a boolean, inset_extrude...). Name edges and faces before such an "
            "operation, or rebuild it from a maker that names them");
    }
    throw std::invalid_argument(verb + ": '" + m.name + "' carries no face or edge names. Makers that name them: "
        "sb.geometry.extrude_polygon (top, bottom, side) and sb.create_box (top, bottom, side); sb.meshops.bevel keeps them");
}

/** Names `name` qualified by `prefix`: "top" -> "plate.top". Already-qualified names are kept as they are. */
inline void qualifyNames(ScratchboxMesh& m, const std::string& prefix) {
    if (prefix.empty()) return;
    for (auto& g : m.faceGroups) {
        std::vector<std::string> add;
        for (const auto& n : g.names) if (n.find('.') == std::string::npos) add.push_back(prefix + "." + n);
        for (auto& a : add) if (std::find(g.names.begin(), g.names.end(), a) == g.names.end()) g.names.push_back(a);
    }
}

/** The names of the edge between face groups a and b (a != b); empty when either side is unnamed. */
inline std::set<std::string> edgeNamesBetween(const std::vector<FaceGroup>& groups, int32_t a, int32_t b) {
    std::set<std::string> out;
    if (a < 0 || b < 0 || a == b) return out;
    const FaceGroup& A = groups[a];
    const FaceGroup& B = groups[b];
    for (const FaceGroup* g : {&A, &B}) for (const auto& n : g->names) if (isCapName(n)) out.insert(n);
    // a group's edge kind, plain and with each qualifier its own names carry ("plate.top" -> "plate.side")
    auto addKind = [&out](const FaceGroup& g) {
        if (g.edgeKind.empty()) return;
        out.insert(g.edgeKind);
        for (const auto& n : g.names) {
            const size_t dot = n.rfind('.');
            if (dot != std::string::npos) out.insert(n.substr(0, dot) + "." + g.edgeKind);
        }
    };
    for (const FaceGroup* g : {&A, &B}) if (g->edgeKindAlways) addKind(*g);
    if (out.empty()) for (const FaceGroup* g : {&A, &B}) addKind(*g);
    return out;
}

/**
 * The face group a bevel adds: named `kind` ("chamfer", "fillet") and, for every owner the bevelled edges' faces are
 * qualified by ("plate.top" -> plate), owner.kind, so a part's bevels stay its own after a merge.
 */
inline FaceGroup bevelGroup(const std::string& kind, const std::vector<FaceGroup>& groups, const std::set<int32_t>& adjacent) {
    FaceGroup g{{kind}, kind, true};
    std::set<std::string> owners;
    for (int32_t a : adjacent) {
        if (a < 0 || a >= static_cast<int32_t>(groups.size())) continue;
        for (const auto& n : groups[a].names) { const size_t dot = n.rfind('.'); if (dot != std::string::npos) owners.insert(n.substr(0, dot)); }
    }
    for (const auto& o : owners) g.names.push_back(o + "." + kind);
    return g;
}

/**
 * Which smooth surface each segment of a polyline belongs to, for a maker naming the faces it sweeps from it: segment i
 * runs pts[i] -> pts[i + 1] (wrapping when closed), and a new surface starts at a joint that turns by at least turnDeg,
 * or where cls (one value per segment, optional) changes. A closed outline starts at such a break, so no surface wraps
 * across the first segment. Zero-length segments continue the surface before them. Returns a surface index per segment.
 */
inline std::vector<int32_t> surfaceRuns(const std::vector<Vec3>& pts, bool closed, float turnDeg, const std::vector<int>& cls = {}) {
    const size_t n = pts.size();
    const size_t segs = closed ? n : (n > 0 ? n - 1 : 0);
    std::vector<int32_t> run(segs, -1);
    if (segs == 0) return run;
    auto dir = [&](size_t i) { return pts[(i + 1) % n] - pts[i]; };
    const float cosTurn = std::cos(turnDeg * 3.14159265358979f / 180.0f);
    auto prevOf = [&](size_t i) -> long {      // the nearest earlier segment with length
        for (size_t k = 1; k <= segs; ++k) {
            if (!closed && k > i) return -1;
            const size_t j = (i + segs - k) % segs;
            if (dir(j).length() > 0) return static_cast<long>(j);
        }
        return -1;
    };
    auto breakAt = [&](size_t i) {             // whether segment i starts a new surface
        const Vec3 b = dir(i);
        if (!(b.length() > 0)) return false;
        const long j = prevOf(i);
        if (j < 0) return true;
        if (!cls.empty() && cls[i] != cls[static_cast<size_t>(j)]) return true;
        const Vec3 a = dir(static_cast<size_t>(j));
        return a.dot(b) / (a.length() * b.length()) < cosTurn;
    };
    size_t first = 0;
    if (closed) { first = segs; for (size_t i = 0; i < segs && first == segs; ++i) if (breakAt(i)) first = i; if (first == segs) first = 0; }
    int32_t surface = -1;
    for (size_t k = 0; k < segs; ++k) {
        const size_t i = (first + k) % segs;
        if (surface < 0 || breakAt(i)) ++surface;
        run[i] = surface;
    }
    return run;
}

/** Ids of positions shared bit for bit (a maker's corners repeat exactly; a weld by tolerance could merge features). */
inline std::vector<uint32_t> exactPointIds(const ScratchboxMesh& m) {
    std::map<std::array<float, 3>, uint32_t> byPos;
    std::vector<uint32_t> id(m.vertices.size());
    for (size_t i = 0; i < m.vertices.size(); ++i) {
        const Vec3& p = m.vertices[i].position;
        id[i] = byPos.emplace(std::array<float, 3>{p.x, p.y, p.z}, static_cast<uint32_t>(byPos.size())).first->second;
    }
    return id;
}

/** Every real edge of a named mesh: its two point ids (by exactPointIds), the triangles on each side, and its names. */
struct NamedEdge {
    uint32_t a = 0, b = 0;
    uint32_t f0 = 0, f1 = 0;
    std::set<std::string> names;
};

inline std::vector<NamedEdge> namedEdges(const ScratchboxMesh& m) {
    std::vector<NamedEdge> out;
    if (!m.hasFaceNames()) return out;
    const std::vector<uint32_t> id = exactPointIds(m);
    std::map<std::pair<uint32_t, uint32_t>, std::vector<uint32_t>> edgeFaces;
    const size_t F = m.indices.size() / 3;
    for (size_t f = 0; f < F; ++f) for (int k = 0; k < 3; ++k) {
        uint32_t a = id[m.indices[3 * f + k]], b = id[m.indices[3 * f + (k + 1) % 3]];
        if (a == b) continue;
        edgeFaces[{std::min(a, b), std::max(a, b)}].push_back(static_cast<uint32_t>(f));
    }
    for (const auto& [key, fs] : edgeFaces) {
        if (fs.size() != 2) continue;
        const int32_t ga = m.faceGroup[fs[0]], gb = m.faceGroup[fs[1]];
        if (ga == gb) continue;
        NamedEdge e{key.first, key.second, fs[0], fs[1], edgeNamesBetween(m.faceGroups, ga, gb)};
        if (!e.names.empty()) out.push_back(std::move(e));
    }
    return out;
}

inline std::vector<std::string> faceNames(const ScratchboxMesh& m) {
    std::set<std::string> s;
    if (m.hasFaceNames()) {
        std::set<int32_t> used(m.faceGroup.begin(), m.faceGroup.end());
        for (int32_t g : used) if (g >= 0) for (const auto& n : m.faceGroups[g].names) s.insert(n);
    }
    return {s.begin(), s.end()};
}

inline std::vector<std::string> edgeNames(const ScratchboxMesh& m) {
    std::set<std::string> s;
    for (const auto& e : namedEdges(m)) s.insert(e.names.begin(), e.names.end());
    return {s.begin(), s.end()};
}

inline size_t editDistance(const std::string& a, const std::string& b) {
    std::vector<size_t> row(b.size() + 1);
    for (size_t j = 0; j <= b.size(); ++j) row[j] = j;
    for (size_t i = 1; i <= a.size(); ++i) {
        size_t diag = row[0];
        row[0] = i;
        for (size_t j = 1; j <= b.size(); ++j) {
            const size_t up = row[j];
            row[j] = std::min({row[j] + 1, row[j - 1] + 1, diag + (a[i - 1] == b[j - 1] ? 0 : 1)});
            diag = up;
        }
    }
    return row[b.size()];
}

/** The refusal for names `missing` of kind ("edge", "face") that `owner` does not carry, with what was most likely meant. */
inline std::string unknownNameMessage(const std::string& verb, const std::string& owner, const std::string& kind,
                                      const std::vector<std::string>& missing, const std::vector<std::string>& known) {
    std::ostringstream msg;
    msg << verb << ": '" << owner << "' has no " << kind << " named";
    for (const auto& n : missing) msg << " '" << n << "'";
    msg << "; its " << kind << " names: ";
    for (size_t i = 0; i < known.size(); ++i) msg << (i ? ", " : "") << known[i];
    if (known.empty()) msg << "(none)";
    std::set<std::string> plain;
    for (const auto& k : known) plain.insert(plainName(k));
    const std::string first = plainName(missing.front());
    if ((first == "start" || first == "end") && plain.count("top") && plain.count("bottom")) {
        msg << ". An extrusion names its caps top and bottom; start and end are a sweep's ends";
    } else if (kind == "edge" && first == "side" && plain.count("top") && !plain.count("side")) {
        msg << ". Its outline turns smoothly all round (a circle): no corner makes a side edge";
    } else {
        std::string best;
        size_t bestD = 3;
        for (const auto& k : known) { const size_t d = editDistance(missing.front(), k); if (d < bestD) { bestD = d; best = k; } }
        if (!best.empty()) msg << ". Did you mean '" << best << "'?";
        else msg << ". Faces and edges go by the names their maker gave them, not by direction";
    }
    return msg.str();
}

/** Splits "top side" or a single name into names. */
inline std::vector<std::string> splitNames(const std::string& s) {
    std::vector<std::string> out;
    std::istringstream in(s);
    for (std::string w; in >> w;) out.push_back(w);
    return out;
}

/**
 * The real edges (as point-id pairs) carrying any of `names`; throws for a name no edge carries, and for names that
 * select nothing an edit could act on (every selected edge flat across).
 */
inline std::set<std::pair<uint32_t, uint32_t>> selectEdges(const ScratchboxMesh& m, const std::vector<std::string>& names, const std::string& verb) {
    requireNames(m, verb);
    if (names.empty()) throw std::invalid_argument(verb + ": edges= names no edge; give one or more edge names, e.g. \"top\"");
    const std::vector<NamedEdge> edges = namedEdges(m);
    std::set<std::string> known;
    for (const auto& e : edges) known.insert(e.names.begin(), e.names.end());
    std::vector<std::string> missing;
    for (const auto& n : names) if (!known.count(n)) missing.push_back(n);
    if (!missing.empty()) throw std::invalid_argument(unknownNameMessage(verb, m.name, "edge", missing, {known.begin(), known.end()}));
    std::set<std::pair<uint32_t, uint32_t>> out;
    for (const auto& e : edges) for (const auto& n : names) if (e.names.count(n)) { out.insert({e.a, e.b}); break; }
    return out;
}

/** A frame on a named face: origin at the face's centre, `normal` out of the solid, `xAxis` and `zAxis` in its plane. */
struct FaceFrame {
    Vec3 origin, normal, xAxis, zAxis;
    float area = 0;
};

/**
 * The frame of the face named `name`: the largest flat set of triangles carrying it (triangles grouped by plane),
 * centred at its area-weighted centroid. Axes, Y up: on a face looking +-Y, x is +X; on any other, x is +Y x normal
 * (horizontal, so a wall's frame reads left to right as seen from outside), and z = x x normal.
 */
inline FaceFrame faceFrame(const ScratchboxMesh& m, const std::string& name, const std::string& verb = "face_frame") {
    requireNames(m, verb);
    const size_t F = m.indices.size() / 3;
    std::vector<char> carries(m.faceGroups.size(), 0);
    for (size_t g = 0; g < m.faceGroups.size(); ++g)
        for (const auto& n : m.faceGroups[g].names) if (n == name) carries[g] = 1;
    float extent = (m.bounds.max - m.bounds.min).length();
    if (!(extent > 0)) extent = 1.0f;
    struct Plane { Vec3 nSum{0, 0, 0}, cSum{0, 0, 0}; float area = 0; };
    std::map<std::array<long, 4>, Plane> planes;
    for (size_t f = 0; f < F; ++f) {
        const int32_t g = m.faceGroup[f];
        if (g < 0 || !carries[g]) continue;
        const Vec3& p0 = m.vertices[m.indices[3 * f]].position;
        const Vec3& p1 = m.vertices[m.indices[3 * f + 1]].position;
        const Vec3& p2 = m.vertices[m.indices[3 * f + 2]].position;
        const Vec3 c = (p1 - p0).cross(p2 - p0);
        const float a2 = c.length();
        if (!(a2 > 0)) continue;
        const Vec3 n = c / a2;
        const float d = n.dot(p0) / extent;
        const std::array<long, 4> key{std::lround(n.x * 1e3), std::lround(n.y * 1e3), std::lround(n.z * 1e3), std::lround(d * 1e4)};
        Plane& P = planes[key];
        P.nSum += c;
        P.cSum += (p0 + p1 + p2) * (a2 / 3.0f);
        P.area += a2;
    }
    if (planes.empty()) {
        const std::vector<std::string> known = faceNames(m);
        if (std::find(known.begin(), known.end(), name) == known.end())
            throw std::invalid_argument(unknownNameMessage(verb, m.name, "face", {name}, known));
        throw std::invalid_argument(verb + ": the face '" + name + "' of '" + m.name + "' has no area");
    }
    const Plane* best = nullptr;
    float total = 0;
    for (const auto& [_, P] : planes) { total += P.area; if (!best || P.area > best->area) best = &P; }
    if (planes.size() > 6 && best->area < 0.5f * total)
        throw std::invalid_argument(verb + ": the faces named '" + name + "' of '" + m.name + "' are not flat; a frame needs a flat face");
    FaceFrame fr;
    fr.normal = best->nSum.normalized();
    fr.origin = best->cSum / best->area;
    fr.area = best->area * 0.5f;
    if (std::abs(fr.normal.y) > 0.9999f) fr.xAxis = Vec3(1, 0, 0);
    else fr.xAxis = Vec3(0, 1, 0).cross(fr.normal).normalized();
    fr.xAxis = (fr.xAxis - fr.normal * fr.xAxis.dot(fr.normal)).normalized();
    fr.zAxis = fr.xAxis.cross(fr.normal).normalized();
    return fr;
}

/**
 * `part` set on the face named `face` of `target`: the part's +Y turned onto the face's normal, its X onto the frame's
 * x (then turned spinDeg about the normal), and the centre of its bounding box's -Y side put at the face's centre,
 * moved u along the frame's x, v along its z and gap out along the normal. Rotates normals and tangents with the
 * positions. The part keeps its own names.
 */
inline void placeOnFace(ScratchboxMesh& part, const ScratchboxMesh& target, const std::string& face, float u, float v,
                        float gap, float spinDeg) {
    const FaceFrame fr = faceFrame(target, face, "place_on");
    part.recomputeBounds();
    const Vec3 lo = part.bounds.min, hi = part.bounds.max;
    const Vec3 foot((lo.x + hi.x) * 0.5f, lo.y, (lo.z + hi.z) * 0.5f);
    const float s = std::sin(spinDeg * math::DEG_TO_RAD), c = std::cos(spinDeg * math::DEG_TO_RAD);
    const Vec3 X = fr.xAxis * c + fr.zAxis * s;
    const Vec3 Z = fr.zAxis * c - fr.xAxis * s;
    const Vec3 Y = fr.normal;
    const Vec3 at = fr.origin + fr.xAxis * u + fr.zAxis * v + Y * gap;
    auto turn = [&](const Vec3& q) { return X * q.x + Y * q.y + Z * q.z; };
    for (auto& vx : part.vertices) {
        vx.position = at + turn(vx.position - foot);
        vx.normal = turn(vx.normal);
        const Vec3 t = turn(Vec3(vx.tangent.x, vx.tangent.y, vx.tangent.z));
        vx.tangent = math::Vec4(t.x, t.y, t.z, vx.tangent.w);
    }
    part.recomputeBounds();
}

} // namespace named
} // namespace scratchbox
