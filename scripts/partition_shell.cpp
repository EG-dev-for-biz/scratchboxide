/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Partition shell (experiment, 2026-11-09): pipeline K's splice-and-repair polish replaced by one closed solid.
 *
 *   1. shell     the cleaned scan explained by planes (scratchbox_shell_fit.hpp): K's facade planes (facades.json) taken as
 *                priors exactly, the roof, terrace and slope planes grown from the scan (the region growing plane-orthos.ts
 *                uses), space cut into convex cells by them, each cell inside or outside by the skin's generalised winding
 *                number, then a minimum cut over the cell graph. The boundary is closed by construction; where three
 *                planes meet the corner is their exact intersection.
 *   2. facades   on every shell face lying on a rebuilt facade's plane, K's lattice is inset: its on-plane triangles are
 *                replaced by the shell face itself, and each relief piece the lattice draws off the plane (a recessed
 *                window, a reveal, a proud pier) whose rim lies wholly inside the face is kept, the face triangulated
 *                around that rim (constrained Delaunay, scratchbox_cdt.hpp) so the pocket and the face share its rim.
 *                A face triangle inside the facade's orthophoto takes the photo through the ortho's own mapping
 *                (facades.json: u = (s - orthoSMin) / (pixel width), v = (orthoTMax - t) / (pixel height)), which is the
 *                lattice's own; the rest is left for the bake.
 *   3. residual  scan farther than residualTolM from the shell and outside it (a crown, a mast, fins, ornament) is kept as
 *                measured, and each of its open edges within seamReachM of the shell is joined to the shell by a skirt
 *                to the edge's closest points on it (generated). The joined edge length is the seam.
 *
 *   partition_shell --input <in.bin> --output <out.bin> --report <report.json> [--set <param> <value>]...
 *
 * in.bin  (little-endian): "PSH1"; u32 nScan, f32[nScan*9]; u32 nLat, f32[nLat*9], i32[nLat] facade id; u32 nFac, per
 *         facade i32 id, f64[3] normal, f64[3] centroid, f64[3] axisS, f64[3] axisT, f64[3] A, f64[3] B (its photo:
 *         u = A . (s, t, 1), v = B . (s, t, 1), s and t about the centroid), f64 area, u8 rebuilt (has a lattice node).
 * out.bin "PSO1"; u32 nV, f32[nV*3]; u32 nT, u32[nT*3]; per triangle u8 kind, i32 ref, i32 facade, u8 measured.
 *         kind 0 shell face (to bake), 1 shell face in a rebuilt facade's ortho (ref -1, facade its id), 2 lattice relief
 *         (ref: lattice triangle), 3 residual scan (ref: scan triangle), 4 seam skirt (ref: the residual scan triangle).
 *
 * Build: clang++ -std=c++20 -O3 -I packages/core/src/native/3d-engine/include scripts/partition_shell.cpp -lz -o build/3d-native/partition_shell
 */

#include "scratchbox_cdt.hpp"
#include "scratchbox_shell_fit.hpp"

#include <chrono>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iostream>
#include <map>
#include <set>
#include <sstream>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace sf = scratchbox::shell_fit;
using sf::V3;

namespace {

struct Facade {
    int id{-1};
    V3 n, c, s, t;
    double A[3]{0, 0, 0}, B[3]{0, 0, 0}, area{0};
    bool rebuilt{false};
};

struct Reader {
    std::vector<char> b; size_t o{0};
    template <class T> T get() { T v; std::memcpy(&v, b.data() + o, sizeof(T)); o += sizeof(T); return v; }
    V3 v3d() { const double x = get<double>(), y = get<double>(), z = get<double>(); return {x, y, z}; }
};

struct OutTri { uint32_t a, b, c; uint8_t kind; int32_t ref, facade; uint8_t measured; };

/** Vertices welded by their exact float bits: a position written twice is one vertex. */
struct OutWeld {
    std::vector<float> pos;
    std::unordered_map<std::string, uint32_t> map;
    uint32_t add(const V3& p) {
        const float f[3] = {static_cast<float>(p.x), static_cast<float>(p.y), static_cast<float>(p.z)};
        std::string k(reinterpret_cast<const char*>(f), sizeof(f));
        auto it = map.find(k);
        if (it != map.end()) return it->second;
        const uint32_t id = static_cast<uint32_t>(pos.size() / 3);
        pos.insert(pos.end(), f, f + 3);
        map.emplace(std::move(k), id);
        return id;
    }
    V3 at(uint32_t i) const { return {pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]}; }
};

inline uint64_t ekey(uint32_t a, uint32_t b) { return (static_cast<uint64_t>(a) << 32) | b; }
inline uint64_t ukey(uint32_t a, uint32_t b) { return a < b ? ekey(a, b) : ekey(b, a); }

double segDist2D(const scratchbox::cdt::P2& p, const scratchbox::cdt::P2& a, const scratchbox::cdt::P2& b) {
    const double dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    double t = l2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
    t = std::clamp(t, 0.0, 1.0);
    return std::hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Directed edges used once (their reverse absent) chained into loops; false when a vertex has more than one way on. */
bool chainLoops(const std::vector<std::pair<uint32_t, uint32_t>>& edges, std::vector<std::vector<uint32_t>>& loops) {
    std::unordered_map<uint32_t, uint32_t> next;
    for (const auto& [a, b] : edges) { if (next.count(a)) return false; next[a] = b; }
    std::unordered_set<uint32_t> used;
    for (const auto& [a, b] : edges) {
        (void)b;
        if (used.count(a)) continue;
        std::vector<uint32_t> loop;
        uint32_t cur = a;
        for (size_t g = 0; g <= edges.size(); ++g) {
            if (used.count(cur)) break;
            used.insert(cur); loop.push_back(cur);
            auto it = next.find(cur);
            if (it == next.end()) return false;
            cur = it->second;
        }
        if (cur != a || loop.size() < 3) return false;
        loops.push_back(std::move(loop));
    }
    return true;
}

bool insideLoops2D(const std::vector<std::vector<scratchbox::cdt::P2>>& loops, const scratchbox::cdt::P2& p) {
    bool in = false;
    for (const auto& l : loops) for (size_t i = 0, j = l.size() - 1; i < l.size(); j = i++) {
        if (((l[i][1] > p[1]) != (l[j][1] > p[1])) && (p[0] < (l[j][0] - l[i][0]) * (p[1] - l[i][1]) / (l[j][1] - l[i][1]) + l[i][0])) in = !in;
    }
    return in;
}

}  // namespace

int main(int argc, char** argv) {
    using clock = std::chrono::steady_clock;
    const auto t0 = clock::now();
    std::string inPath, outPath, reportPath;
    sf::Params P;
    P.windingLabels = true;
    P.residualTolM = 0.3;
    double onPlaneM = 0.03, rimMarginM = 0.03, seamReachM = 1.0, gridMergeM = 0.02, maxReliefM = 1.5, facadeAlignDeg = 3.0, facadeReachM = 0.6;
    for (int i = 1; i < argc; ++i) {
        const std::string a = argv[i];
        if (a == "--input" && i + 1 < argc) inPath = argv[++i];
        else if (a == "--output" && i + 1 < argc) outPath = argv[++i];
        else if (a == "--report" && i + 1 < argc) reportPath = argv[++i];
        else if (a == "--set" && i + 2 < argc) {
            const std::string k = argv[++i]; const double v = std::stod(argv[++i]);
            if (k == "windingLabels") P.windingLabels = v != 0;
            else if (k == "residualTolM") P.residualTolM = v;
            else if (k == "threads") P.threads = static_cast<int>(v);
            else if (k == "priorAlignDeg") P.priorAlignDeg = v;
            else if (k == "minPlaneAreaM2") P.minPlaneAreaM2 = v;
            else if (k == "maxPlanes") P.maxPlanes = static_cast<int>(v);
            else if (k == "revolutionParts") P.revolutionParts = v != 0;
            else if (k == "topIsAir") P.topIsAir = v != 0;
            else if (k == "groundY") P.groundY = v;
            else if (k == "mergeDistM") P.mergeDistM = v;
            else if (k == "supportTolM") P.supportTolM = v;
            else if (k == "onPlaneM") onPlaneM = v;
            else if (k == "rimMarginM") rimMarginM = v;
            else if (k == "seamReachM") seamReachM = v;
            else if (k == "gridMergeM") gridMergeM = v;
            else if (k == "maxReliefM") maxReliefM = v;
            else if (k == "facadeAlignDeg") facadeAlignDeg = v;
            else if (k == "facadeReachM") facadeReachM = v;
            else { std::cout << "{\"ok\":false,\"error\":\"unknown parameter " << k << "\"}\n"; return 2; }
        }
    }
    if (inPath.empty() || outPath.empty() || reportPath.empty()) { std::cout << "{\"ok\":false,\"error\":\"--input, --output and --report are required\"}\n"; return 2; }
    try {
        Reader r;
        {
            std::ifstream f(inPath, std::ios::binary);
            if (!f) throw std::runtime_error("cannot read " + inPath);
            r.b.assign(std::istreambuf_iterator<char>(f), {});
        }
        if (r.b.size() < 4 || std::memcmp(r.b.data(), "PSH1", 4) != 0) throw std::runtime_error("not a PSH1 file");
        r.o = 4;
        const uint32_t nScan = r.get<uint32_t>();
        std::vector<float> scan(static_cast<size_t>(nScan) * 9);
        std::memcpy(scan.data(), r.b.data() + r.o, scan.size() * 4); r.o += scan.size() * 4;
        const uint32_t nLat = r.get<uint32_t>();
        std::vector<float> lat(static_cast<size_t>(nLat) * 9);
        std::memcpy(lat.data(), r.b.data() + r.o, lat.size() * 4); r.o += lat.size() * 4;
        std::vector<int32_t> latFac(nLat);
        std::memcpy(latFac.data(), r.b.data() + r.o, latFac.size() * 4); r.o += latFac.size() * 4;
        const uint32_t nFac = r.get<uint32_t>();
        std::vector<Facade> facades(nFac);
        for (auto& fa : facades) {
            fa.id = r.get<int32_t>(); fa.n = r.v3d(); fa.c = r.v3d(); fa.s = r.v3d(); fa.t = r.v3d();
            for (double& x : fa.A) x = r.get<double>();
            for (double& x : fa.B) x = r.get<double>();
            fa.area = r.get<double>();
            fa.rebuilt = r.get<uint8_t>() != 0;
        }
        std::map<int, size_t> facIdx;
        for (size_t i = 0; i < facades.size(); ++i) facIdx[facades[i].id] = i;

        // ------------------------------------------------------------------ 1. shell
        sf::Input in;
        in.positions.reserve(static_cast<size_t>(nScan) * 3);
        for (size_t i = 0; i < static_cast<size_t>(nScan) * 3; ++i) { in.positions.emplace_back(scan[i * 3], scan[i * 3 + 1], scan[i * 3 + 2]); in.indices.push_back(static_cast<uint32_t>(i)); }
        {
            std::vector<size_t> order(facades.size());
            for (size_t i = 0; i < order.size(); ++i) order[i] = i;
            // rebuilt facades first, then by area: a facade on a rebuilt one's plane is taken as that plane
            std::sort(order.begin(), order.end(), [&](size_t a, size_t b) { if (facades[a].rebuilt != facades[b].rebuilt) return facades[a].rebuilt; return facades[a].area > facades[b].area; });
            for (size_t i : order) { sf::Plane pl; pl.n = facades[i].n.normalized(); pl.d = -pl.n.dot(facades[i].c); pl.prior = facades[i].id; in.priors.push_back(pl); }
        }
        const sf::Result R = sf::ShellFit::solve(in, P);
        const auto tShell = clock::now();
        std::map<int, int> repOf;                 // facade id -> the prior id whose plane it was taken as
        for (const auto& [f, rep] : R.priorPlaneOf) repOf[f] = rep;
        std::map<int, int> planeOfPrior;          // prior id -> plane index
        for (size_t i = 0; i < R.planes.size(); ++i) if (R.planes[i].prior >= 0) planeOfPrior[R.planes[i].prior] = static_cast<int>(i);
        // a shell plane's facades: rebuilt facades parallel to it within facadeAlignDeg (facing either way along it) and within
        // facadeReachM of it, nearest first; a key is (plane, +1/-1: the facade faces along the plane's normal or against it)
        std::map<std::pair<int, int>, std::vector<int>> facadesOnPlane;
        {
            const double cosA = std::cos(facadeAlignDeg * M_PI / 180.0);
            for (size_t pi = 6; pi < R.planes.size(); ++pi) {
                const sf::Plane& pl = R.planes[pi];
                std::vector<std::pair<double, int>> near[2];
                for (const auto& fa : facades) {
                    if (!fa.rebuilt) continue;
                    const double c = pl.n.dot(fa.n.normalized());
                    if (std::abs(c) < cosA) continue;
                    const double off = std::abs(pl.dist(fa.c));
                    if (off > facadeReachM) continue;
                    near[c > 0 ? 0 : 1].emplace_back(off, fa.id);
                }
                for (int k = 0; k < 2; ++k) {
                    if (near[k].empty()) continue;
                    std::sort(near[k].begin(), near[k].end());
                    auto& l = facadesOnPlane[{static_cast<int>(pi), k == 0 ? 1 : -1}];
                    for (const auto& [o, id] : near[k]) { (void)o; l.push_back(id); }
                }
            }
        }
        size_t priorPlanesKept = 0;
        for (const auto& pl : R.planes) if (pl.prior >= 0) ++priorPlanesKept;

        // ------------------------------------------------------------------ 2. facades inset
        OutWeld W;
        std::vector<OutTri> out;
        std::vector<uint8_t> latUsed(nLat, 0);
        std::map<int, std::vector<uint32_t>> latByFacade;
        for (uint32_t t = 0; t < nLat; ++t) latByFacade[latFac[t]].push_back(t);
        size_t gridCells = 0, reliefCells = 0; double stepWallM2 = 0;
        size_t floatersKept = 0, facesInset = 0, facesFallback = 0, rimsKept = 0, rimsCrossing = 0, rimsComplex = 0, rimsNone = 0, cdtNoHoles = 0;
        double reliefKeptM2 = 0, reliefDroppedM2 = 0, orthoAreaM2 = 0, bakeAreaM2 = 0, latticeOnPlaneM2 = 0, latticeOffPlaneLostM2 = 0;
        auto latV = [&](uint32_t t, int k) { return V3(lat[t * 9 + k * 3], lat[t * 9 + k * 3 + 1], lat[t * 9 + k * 3 + 2]); };
        auto triArea = [](const V3& a, const V3& b, const V3& c) { return 0.5 * (b - a).cross(c - a).length(); };
        // the photo of a rebuilt facade at a point on its plane: u = A . (s, t, 1), v = B . (s, t, 1) (s, t about its centroid)
        auto uvOf = [&](const Facade& fa, const V3& q) { const double s = (q - fa.c).dot(fa.s), t = (q - fa.c).dot(fa.t); return std::array<double, 2>{fa.A[0] * s + fa.A[1] * t + fa.A[2], fa.B[0] * s + fa.B[1] * t + fa.B[2]}; };
        auto orthoFacade = [&](std::pair<int, int> planeKey, const std::vector<V3>& pts) -> int {
            auto it = facadesOnPlane.find(planeKey);
            if (it == facadesOnPlane.end()) return -1;
            for (int fid : it->second) {
                const Facade& fa = facades[facIdx[fid]];
                if (!fa.rebuilt) continue;
                bool ok = true;
                for (const auto& q : pts) {
                    const auto uv = uvOf(fa, q);
                    if (uv[0] < -0.002 || uv[0] > 1.002 || uv[1] < -0.002 || uv[1] > 1.002) { ok = false; break; }
                }
                if (ok) return fid;
            }
            return -1;
        };
        auto emitPlain = [&](const std::vector<uint32_t>& tris, std::pair<int, int> plane, const std::vector<uint8_t>& measured) {
            for (size_t i = 0; i + 2 < tris.size(); i += 3) {
                const V3 a = W.at(tris[i]), b = W.at(tris[i + 1]), c = W.at(tris[i + 2]);
                const int fid = orthoFacade(plane, {a, b, c});
                const double ar = triArea(a, b, c);
                if (fid >= 0) orthoAreaM2 += ar; else bakeAreaM2 += ar;
                out.push_back({tris[i], tris[i + 1], tris[i + 2], static_cast<uint8_t>(fid >= 0 ? 1 : 0), -1, fid, measured[i / 3]});
            }
        };
        // faces grouped: every face on one rebuilt facade's plane facing out along it is one unit (measured and generated alike)
        std::map<std::pair<int, int>, std::vector<size_t>> groups;
        for (size_t fi = 0; fi < R.faces.size(); ++fi) {
            const auto& face = R.faces[fi];
            const sf::Plane& pl = R.planes[static_cast<size_t>(face.plane)];
            const std::pair<int, int> key{face.plane, face.normal.dot(pl.n) > 0 ? 1 : -1};
            if (facadesOnPlane.count(key)) { groups[key].push_back(fi); continue; }
            std::vector<uint32_t> ft; std::vector<uint8_t> me;
            for (uint32_t k = 0; k < face.triangleCount; ++k) { for (int j = 0; j < 3; ++j) ft.push_back(W.add(R.shellPositions[R.shellIndices[(face.firstTriangle + k) * 3 + static_cast<uint32_t>(j)]])); me.push_back(face.measured ? 1 : 0); }
            emitPlain(ft, key, me);
        }
        using P2 = scratchbox::cdt::P2;
        for (const auto& [plane, fis] : groups) {
            // the group's plane, its normal facing out
            sf::Plane pl = R.planes[static_cast<size_t>(plane.first)];
            if (plane.second < 0) { pl.n = pl.n * -1.0; pl.d = -pl.d; }
            std::vector<uint32_t> ft; std::vector<uint8_t> me;
            for (size_t fi : fis) { const auto& face = R.faces[fi]; for (uint32_t k = 0; k < face.triangleCount; ++k) { for (int j = 0; j < 3; ++j) ft.push_back(W.add(R.shellPositions[R.shellIndices[(face.firstTriangle + k) * 3 + static_cast<uint32_t>(j)]])); me.push_back(face.measured ? 1 : 0); } }
            const V3 n = pl.n;
            // the frame: the plane's first rebuilt facade's (s, t), s x t = n, so counter-clockwise in (s, t) faces along n
            V3 u = (std::abs(n.y) < 0.9 ? V3(0, 1, 0) : V3(1, 0, 0)).cross(n).normalized(), v = n.cross(u);
            for (int fid : facadesOnPlane[plane]) { const Facade& fa = facades[facIdx[fid]]; u = (fa.s - n * fa.s.dot(n)).normalized(); v = n.cross(u); break; }
            std::vector<uint32_t> groupLat;
            for (int fid : facadesOnPlane[plane]) { auto it = latByFacade.find(fid); if (it != latByFacade.end()) groupLat.insert(groupLat.end(), it->second.begin(), it->second.end()); }
            auto to2 = [&](const V3& q) { return P2{q.dot(u), q.dot(v)}; };
            std::unordered_set<uint64_t> dir;
            for (size_t i = 0; i + 2 < ft.size(); i += 3) for (int k = 0; k < 3; ++k) dir.insert(ekey(ft[i + static_cast<size_t>(k)], ft[i + static_cast<size_t>((k + 1) % 3)]));
            std::vector<std::array<P2, 2>> bseg;      // the group's boundary, 2D
            std::vector<std::pair<uint32_t, uint32_t>> bnd;
            for (size_t i = 0; i + 2 < ft.size(); i += 3) for (int k = 0; k < 3; ++k) {
                const uint32_t a = ft[i + static_cast<size_t>(k)], b = ft[i + static_cast<size_t>((k + 1) % 3)];
                if (!dir.count(ekey(b, a))) { bnd.emplace_back(a, b); bseg.push_back({to2(W.at(a)), to2(W.at(b))}); }
            }
            auto inside = [&](const std::vector<std::array<P2, 2>>& segs, const P2& p) {
                bool in = false;
                for (const auto& s : segs) { const P2& a = s[0]; const P2& b = s[1]; if (((a[1] > p[1]) != (b[1] > p[1])) && (p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0])) in = !in; }
                return in;
            };
            auto nearBoundary = [&](const P2& p) { for (const auto& s : bseg) if (segDist2D(p, s[0], s[1]) < rimMarginM) return true; return false; };
            // the lattice on this plane, in the facade's own (s, t): its cells are rectilinear there
            scratchbox::geometry::ScratchboxMesh lm("lattice");
            std::vector<double> sv, tv;
            double s0 = 1e300, s1 = -1e300, t0 = 1e300, t1 = -1e300;
            std::vector<int> lmFac;
            for (uint32_t t : groupLat) {
                const V3 a = latV(t, 0), b = latV(t, 1), c = latV(t, 2);
                if (!inside(bseg, to2((a + b + c) * (1.0 / 3.0)))) continue;
                latUsed[t] = 1;
                const V3 tn = (b - a).cross(c - a).normalized();
                if (std::abs(pl.dist(a)) < onPlaneM && std::abs(pl.dist(b)) < onPlaneM && std::abs(pl.dist(c)) < onPlaneM && std::abs(tn.dot(n)) > 0.95) latticeOnPlaneM2 += triArea(a, b, c);
                else reliefKeptM2 += triArea(a, b, c);
                for (const V3& q : {a, b, c}) {
                    lm.vertices.emplace_back(sf::detail::f3(q));
                    const P2 p = to2(q);
                    sv.push_back(std::round(p[0] * 1000.0) / 1000.0); tv.push_back(std::round(p[1] * 1000.0) / 1000.0);
                    s0 = std::min(s0, p[0]); s1 = std::max(s1, p[0]); t0 = std::min(t0, p[1]); t1 = std::max(t1, p[1]);
                }
                const uint32_t k = static_cast<uint32_t>(lm.vertices.size());
                lm.indices.push_back(k - 3); lm.indices.push_back(k - 2); lm.indices.push_back(k - 1);
                lmFac.push_back(latFac[t]);
            }
            // grid lines: coordinates at least 4 lattice corners share, merged within gridMergeM
            auto lines = [&](std::vector<double>& xs) {
                std::sort(xs.begin(), xs.end());
                std::vector<double> outL;
                for (size_t i = 0; i < xs.size();) {
                    size_t j = i; while (j < xs.size() && xs[j] == xs[i]) ++j;
                    if (j - i >= 4 && (outL.empty() || xs[i] - outL.back() >= gridMergeM)) outL.push_back(xs[i]);
                    i = j;
                }
                return outL;
            };
            const std::vector<double> sl = lines(sv), tl = lines(tv);
            std::vector<P2> pts;
            std::vector<std::array<int, 2>> segs;
            std::vector<uint32_t> ptW;           // a boundary point's welded shell vertex, else ~0
            std::unordered_map<uint32_t, int> idx;
            auto ptOf = [&](uint32_t w) { auto it = idx.find(w); if (it != idx.end()) return it->second; const int i = static_cast<int>(pts.size()); idx[w] = i; pts.push_back(to2(W.at(w))); ptW.push_back(w); return i; };
            for (const auto& [a, b] : bnd) segs.push_back({ptOf(a), ptOf(b)});
            const size_t nBnd = segs.size();
            const std::vector<std::array<int, 2>> bndSegs = segs;
            bool haveLattice = !lm.indices.empty() && sl.size() >= 2 && tl.size() >= 2;
            if (haveLattice) {
                // a line along (within 3 cm of) one of the face's own edges is that edge
                auto alongEdge = [&](int axis, double x) {
                    for (const auto& sg : bseg) if (std::abs(sg[0][1 - axis] - sg[1][1 - axis]) > 1e-6 && std::abs(sg[0][axis] - x) < 0.03 && std::abs(sg[1][axis] - x) < 0.03) return true;
                    return false;
                };
                std::vector<double> xs, ys;
                for (double x : sl) if (!alongEdge(0, x)) xs.push_back(x);
                for (double y : tl) if (!alongEdge(1, y)) ys.push_back(y);
                // every crossing computed here, both segments split there, so the triangulation meets no crossing: grid lines
                // cross at (x, y) exactly; a boundary edge and a line at the point on the edge
                std::vector<std::vector<std::pair<double, int>>> bsplit(nBnd);
                std::vector<std::vector<std::pair<double, int>>> xsplit(xs.size()), ysplit(ys.size());
                auto newPt = [&](const P2& q) { const int i = static_cast<int>(pts.size()); pts.push_back(q); ptW.push_back(~0u); return i; };
                for (size_t i = 0; i < xs.size(); ++i) for (size_t j = 0; j < ys.size(); ++j) { const int k = newPt({xs[i], ys[j]}); xsplit[i].emplace_back(ys[j], k); ysplit[j].emplace_back(xs[i], k); }
                for (size_t i = 0; i < xs.size(); ++i) { xsplit[i].emplace_back(t0, newPt({xs[i], t0})); xsplit[i].emplace_back(t1, newPt({xs[i], t1})); }
                for (size_t j = 0; j < ys.size(); ++j) { ysplit[j].emplace_back(s0, newPt({s0, ys[j]})); ysplit[j].emplace_back(s1, newPt({s1, ys[j]})); }
                for (size_t b = 0; b < nBnd; ++b) {
                    const P2 A = pts[static_cast<size_t>(segs[b][0])], B = pts[static_cast<size_t>(segs[b][1])];
                    auto cross = [&](int axis, double c, std::vector<std::pair<double, int>>& lineSplit, double lo, double hi) {
                        const double da = A[axis] - c, db = B[axis] - c;
                        if ((da > 1e-9 && db > 1e-9) || (da < -1e-9 && db < -1e-9)) return;
                        if (std::abs(A[axis] - B[axis]) < 1e-9) return;   // parallel
                        const double tt = da / (da - db);
                        if (tt <= 1e-7 || tt >= 1 - 1e-7) {
                            // the line passes through an end of the edge: split the line there
                            const int end = tt <= 1e-7 ? segs[b][0] : segs[b][1];
                            const double o2 = pts[static_cast<size_t>(end)][1 - axis];
                            if (o2 > lo && o2 < hi) lineSplit.emplace_back(o2, end);
                            return;
                        }
                        P2 q{A[0] + (B[0] - A[0]) * tt, A[1] + (B[1] - A[1]) * tt};
                        q[static_cast<size_t>(axis)] = c;
                        if (q[static_cast<size_t>(1 - axis)] <= lo || q[static_cast<size_t>(1 - axis)] >= hi) return;
                        const int k = newPt(q);
                        bsplit[b].emplace_back(tt, k);
                        lineSplit.emplace_back(q[static_cast<size_t>(1 - axis)], k);
                    };
                    for (size_t i = 0; i < xs.size(); ++i) cross(0, xs[i], xsplit[i], t0, t1);
                    for (size_t j = 0; j < ys.size(); ++j) cross(1, ys[j], ysplit[j], s0, s1);
                }
                std::vector<std::array<int, 2>> ns;
                for (size_t b = 0; b < nBnd; ++b) {
                    auto& sp = bsplit[b];
                    std::sort(sp.begin(), sp.end());
                    int prev = segs[b][0];
                    for (const auto& [tt, k] : sp) { (void)tt; if (k != prev) ns.push_back({prev, k}); prev = k; }
                    if (prev != segs[b][1]) ns.push_back({prev, segs[b][1]});
                }
                const size_t nB2 = ns.size();
                auto emitLine = [&](std::vector<std::pair<double, int>>& sp) {
                    std::sort(sp.begin(), sp.end());
                    for (size_t i = 0; i + 1 < sp.size(); ++i) {
                        if (sp[i + 1].first - sp[i].first < 1e-9) continue;
                        ns.push_back({sp[i].second, sp[i + 1].second}); ns.push_back({sp[i + 1].second, sp[i].second});
                    }
                };
                for (auto& sp : xsplit) emitLine(sp);
                for (auto& sp : ysplit) emitLine(sp);
                (void)nB2;
                segs.swap(ns);
            }
            scratchbox::cdt::Options co; co.fill = scratchbox::cdt::Fill::Positive;
            auto o = scratchbox::cdt::triangulate(pts, segs, co);
            if (o.lostSegments && std::getenv("PS_DUMP")) {
                std::ofstream d(std::string(std::getenv("PS_DUMP")) + "/cdt_" + std::to_string(plane.first) + ".txt");
                d.precision(17);
                d << pts.size() << " " << segs.size() << " " << nBnd << " lost " << o.lostSegments << "\n";
                for (const auto& q : pts) d << q[0] << " " << q[1] << "\n";
                for (const auto& sg : segs) d << sg[0] << " " << sg[1] << "\n";
            }
            if (o.lostSegments) { ++cdtNoHoles; haveLattice = false; pts.resize(idx.size()); ptW.resize(idx.size()); segs = bndSegs; o = scratchbox::cdt::triangulate(pts, segs, co); }
            if (o.lostSegments || o.tris.empty()) { ++facesFallback; emitPlain(ft, plane, me); continue; }
            ++facesInset;
            scratchbox::bvh::BvhTree lb;
            if (haveLattice) lb.build(lm);
            // a cell's depth: the lattice met along the normal at its centre (0 where no lattice lies over it)
            auto cellOf = [&](const P2& p) {
                const auto i = std::upper_bound(sl.begin(), sl.end(), p[0]) - sl.begin(), j = std::upper_bound(tl.begin(), tl.end(), p[1]) - tl.begin();
                return std::pair<long, long>(i, j);
            };
            std::map<std::pair<long, long>, double> depthOf;
            auto depthAt = [&](const P2& p) -> double {
                if (!haveLattice) return 0.0;
                const auto c = cellOf(p);
                if (c.first <= 0 || c.second <= 0 || c.first >= static_cast<long>(sl.size()) || c.second >= static_cast<long>(tl.size())) return 0.0;
                auto it = depthOf.find(c);
                if (it != depthOf.end()) return it->second;
                const P2 m{0.5 * (sl[static_cast<size_t>(c.first - 1)] + sl[static_cast<size_t>(c.first)]), 0.5 * (tl[static_cast<size_t>(c.second - 1)] + tl[static_cast<size_t>(c.second)])};
                const V3 q = u * m[0] + v * m[1] + n * (-pl.d) + n * 3.0;
                scratchbox::bvh::RayHit h; h.t = 6.0f;
                double d = 0;
                if (lb.raycast(scratchbox::math::Ray(sf::detail::f3(q), sf::detail::f3(n * -1.0)), h) && h.t <= 6.0f) {
                    // the depth is the lattice's own, measured from its facade's plane (the shell's plane can stand a little off it)
                    const Facade& fa = facades[facIdx[lmFac[h.triangleIndex]]];
                    const V3 hp = q - n * static_cast<double>(h.t);
                    d = std::clamp((hp - fa.c).dot(fa.n.normalized()), -maxReliefM, maxReliefM);
                }
                if (std::abs(d) < onPlaneM) d = 0;
                depthOf[c] = d;
                return d;
            };
            // vertices: a CDT point at a depth; at depth 0 a boundary point is its shell vertex exactly
            std::vector<uint32_t> pointW(o.points.size(), ~0u);
            for (size_t i = 0; i < pts.size(); ++i) if (ptW[i] != ~0u) pointW[static_cast<size_t>(o.inputVertex[i])] = ptW[i];
            std::map<std::pair<int, int64_t>, uint32_t> vAt;
            auto vert = [&](int pi, double d) {
                const int64_t dk = std::llround(d * 1e4);
                auto it = vAt.find({pi, dk});
                if (it != vAt.end()) return it->second;
                uint32_t w;
                if (dk == 0 && pointW[static_cast<size_t>(pi)] != ~0u) w = pointW[static_cast<size_t>(pi)];
                else { const P2& p = o.points[static_cast<size_t>(pi)]; w = W.add(u * p[0] + v * p[1] + n * (-pl.d + d)); }
                vAt[{pi, dk}] = w;
                return w;
            };
            std::vector<double> triD(o.tris.size());
            std::unordered_map<uint64_t, size_t> edgeTri;   // directed CDT edge -> its triangle
            std::vector<uint32_t> faceTris; std::vector<uint8_t> faceMe;
            std::vector<std::array<P2, 3>> measuredTris;
            for (size_t i = 0; i < me.size(); ++i) if (me[i]) measuredTris.push_back({to2(W.at(ft[i * 3])), to2(W.at(ft[i * 3 + 1])), to2(W.at(ft[i * 3 + 2]))});
            auto inTri = [](const std::array<P2, 3>& t, const P2& p) {
                auto cr = [](const P2& a, const P2& b, const P2& c) { return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); };
                const double d1 = cr(t[0], t[1], p), d2 = cr(t[1], t[2], p), d3 = cr(t[2], t[0], p);
                return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
            };
            for (size_t k = 0; k < o.tris.size(); ++k) {
                const auto& t = o.tris[k];
                const P2 cen{(o.points[static_cast<size_t>(t[0])][0] + o.points[static_cast<size_t>(t[1])][0] + o.points[static_cast<size_t>(t[2])][0]) / 3.0, (o.points[static_cast<size_t>(t[0])][1] + o.points[static_cast<size_t>(t[1])][1] + o.points[static_cast<size_t>(t[2])][1]) / 3.0};
                const double d = depthAt(cen);
                triD[k] = d;
                for (int e = 0; e < 3; ++e) edgeTri[ekey(static_cast<uint32_t>(t[static_cast<size_t>(e)]), static_cast<uint32_t>(t[static_cast<size_t>((e + 1) % 3)]))] = k;
                faceTris.push_back(vert(t[0], d)); faceTris.push_back(vert(t[1], d)); faceTris.push_back(vert(t[2], d));
                uint8_t m = 0;
                for (const auto& mt : measuredTris) if (inTri(mt, cen)) { m = 1; break; }
                faceMe.push_back(m);
            }
            emitPlain(faceTris, plane, faceMe);
            // walls where the depth steps: between two cells, and from a cell back to the plane at the group's boundary
            std::vector<uint32_t> wallTris; std::vector<uint8_t> wallMe;
            for (size_t k = 0; k < o.tris.size(); ++k) {
                const auto& t = o.tris[k];
                for (int e = 0; e < 3; ++e) {
                    const int a = t[static_cast<size_t>(e)], b = t[static_cast<size_t>((e + 1) % 3)];
                    auto it = edgeTri.find(ekey(static_cast<uint32_t>(b), static_cast<uint32_t>(a)));
                    const double dOther = it == edgeTri.end() ? 0.0 : triD[it->second];
                    if (it != edgeTri.end() && it->second < k) continue;   // each shared edge once
                    if (std::abs(dOther - triD[k]) < 1e-4) continue;
                    // the wall runs from this triangle's edge (a, b) at its depth to the same edge at the other depth: (b, a) at
                    // our depth starts it, so it faces as the step does (out of the deeper side)
                    const uint32_t a0 = vert(a, triD[k]), b0 = vert(b, triD[k]), a1 = vert(a, dOther), b1 = vert(b, dOther);
                    if (it == edgeTri.end() || true) {
                        // orientation: the quad (b0, a0, a1, b1) continues triangle k across its edge (a, b)
                        wallTris.insert(wallTris.end(), {b0, a0, a1, b0, a1, b1});
                        wallMe.push_back(1); wallMe.push_back(1);
                    }
                }
            }
            for (size_t i = 0; i + 2 < wallTris.size(); i += 3) {
                if (wallTris[i] == wallTris[i + 1] || wallTris[i + 1] == wallTris[i + 2] || wallTris[i] == wallTris[i + 2]) continue;
                const V3 A = W.at(wallTris[i]), B = W.at(wallTris[i + 1]), C = W.at(wallTris[i + 2]);
                const int fid = orthoFacade(plane, {A, B, C});
                const double ar = triArea(A, B, C);
                if (fid >= 0) orthoAreaM2 += ar; else bakeAreaM2 += ar;
                stepWallM2 += ar;
                out.push_back({wallTris[i], wallTris[i + 1], wallTris[i + 2], static_cast<uint8_t>(fid >= 0 ? 1 : 0), -1, fid, 1});
            }
            gridCells += depthOf.size();
            for (const auto& [c, d] : depthOf) { (void)c; if (d != 0) ++reliefCells; }
        }
        // T-junctions: a shell or facade vertex lying inside another triangle's open edge splits that triangle there
        size_t tJunctionSplits = 0;
        for (int round = 0; round < 6; ++round) {
            std::unordered_map<uint64_t, int> ec;
            for (const auto& t : out) { ec[ukey(t.a, t.b)]++; ec[ukey(t.b, t.c)]++; ec[ukey(t.c, t.a)]++; }
            std::unordered_set<uint32_t> openV;
            for (const auto& [k, c] : ec) if (c == 1) { openV.insert(static_cast<uint32_t>(k >> 32)); openV.insert(static_cast<uint32_t>(k & 0xFFFFFFFFull)); }
            if (openV.empty()) break;
            const double cellM = 0.5;
            std::unordered_map<uint64_t, std::vector<uint32_t>> grid;
            auto gk = [&](const V3& q) { return (static_cast<uint64_t>(static_cast<uint32_t>(static_cast<int32_t>(std::floor(q.x / cellM)) & 0x1FFFFF)) << 42) | (static_cast<uint64_t>(static_cast<uint32_t>(static_cast<int32_t>(std::floor(q.y / cellM)) & 0x1FFFFF)) << 21) | static_cast<uint64_t>(static_cast<uint32_t>(static_cast<int32_t>(std::floor(q.z / cellM)) & 0x1FFFFF)); };
            for (uint32_t id : openV) grid[gk(W.at(id))].push_back(id);
            std::vector<OutTri> next;
            size_t splits = 0;
            for (const auto& t : out) {
                const uint32_t vv[3] = {t.a, t.b, t.c};
                std::vector<uint32_t> poly;
                bool split = false;
                for (int e = 0; e < 3; ++e) {
                    const uint32_t a = vv[e], b = vv[(e + 1) % 3];
                    poly.push_back(a);
                    if (ec[ukey(a, b)] != 1) continue;
                    const V3 A = W.at(a), B = W.at(b), d = B - A;
                    const double l2 = d.dot(d);
                    if (l2 < 1e-12) continue;
                    std::vector<std::pair<double, uint32_t>> on;
                    const V3 lo(std::min(A.x, B.x), std::min(A.y, B.y), std::min(A.z, B.z)), hi(std::max(A.x, B.x), std::max(A.y, B.y), std::max(A.z, B.z));
                    for (int64_t x = static_cast<int64_t>(std::floor(lo.x / cellM)); x <= static_cast<int64_t>(std::floor(hi.x / cellM)); ++x)
                        for (int64_t y = static_cast<int64_t>(std::floor(lo.y / cellM)); y <= static_cast<int64_t>(std::floor(hi.y / cellM)); ++y)
                            for (int64_t z = static_cast<int64_t>(std::floor(lo.z / cellM)); z <= static_cast<int64_t>(std::floor(hi.z / cellM)); ++z) {
                                auto it = grid.find(gk(V3((static_cast<double>(x) + 0.5) * cellM, (static_cast<double>(y) + 0.5) * cellM, (static_cast<double>(z) + 0.5) * cellM)));
                                if (it == grid.end()) continue;
                                for (uint32_t c : it->second) {
                                    if (c == a || c == b) continue;
                                    const V3 r = W.at(c) - A;
                                    const double s = r.dot(d) / l2;
                                    if (s <= 1e-6 || s >= 1 - 1e-6) continue;
                                    if ((r - d * s).length() > 2e-4) continue;
                                    on.emplace_back(s, c);
                                }
                            }
                    std::sort(on.begin(), on.end());
                    on.erase(std::unique(on.begin(), on.end(), [](const auto& x, const auto& y) { return x.second == y.second; }), on.end());
                    for (const auto& [s, c] : on) { (void)s; poly.push_back(c); split = true; }
                }
                if (!split) { next.push_back(t); continue; }
                // fan from the corner opposite the longest run of inserted points: the polygon is convex (points on the edges)
                ++splits;
                for (size_t i = 1; i + 1 < poly.size(); ++i) { OutTri n2 = t; n2.a = poly[0]; n2.b = poly[i]; n2.c = poly[i + 1]; if (n2.a != n2.b && n2.b != n2.c && n2.a != n2.c) next.push_back(n2); }
            }
            out.swap(next);
            tJunctionSplits += splits;
            if (!splits) break;
        }
        for (uint32_t t = 0; t < nLat; ++t) if (!latUsed[t]) latticeOffPlaneLostM2 += triArea(latV(t, 0), latV(t, 1), latV(t, 2));
        std::ostringstream perFac;
        {
            std::map<int, std::array<double, 2>> la;   // facade -> lattice area, placed area
            for (uint32_t t = 0; t < nLat; ++t) { auto& x = la[latFac[t]]; const double a = triArea(latV(t, 0), latV(t, 1), latV(t, 2)); x[0] += a; if (latUsed[t]) x[1] += a; }
            bool first = true;
            for (const auto& [fid, x] : la) {
                int plane = -1; auto it = repOf.find(fid); if (it != repOf.end()) { auto jt = planeOfPrior.find(it->second); if (jt != planeOfPrior.end()) plane = jt->second; }
                double outA = 0, inA = 0;
                for (const auto& face : R.faces) if (face.plane == plane) { if (face.normal.dot(R.planes[static_cast<size_t>(plane)].n) > 0.9) outA += face.areaM2; else inA += face.areaM2; }
                perFac << (first ? "" : ",") << "{\"id\":" << fid << ",\"rep\":" << (it != repOf.end() ? it->second : -1) << ",\"plane\":" << plane << ",\"latticeM2\":" << x[0] << ",\"placedM2\":" << x[1] << ",\"faceOutM2\":" << outA << ",\"faceInM2\":" << inA << "}";
                first = false;
            }
        }
        const auto tInset = clock::now();

        // ------------------------------------------------------------------ 3. residual scan and its seam to the shell
        scratchbox::geometry::ScratchboxMesh shellMesh("shell");
        for (const auto& q : R.shellPositions) shellMesh.vertices.emplace_back(sf::detail::f3(q));
        shellMesh.indices = R.shellIndices;
        scratchbox::bvh::BvhTree shellBvh;
        shellBvh.build(shellMesh);
        double residualM2 = 0, seamJoinedM = 0, seamFreeM = 0, skirtM2 = 0;
        {
            std::vector<std::array<uint32_t, 3>> resTri;
            for (size_t k = 0; k < R.residualTriangles.size(); ++k) {
                const uint32_t t = R.residualTriangles[k];
                V3 a(scan[t * 9], scan[t * 9 + 1], scan[t * 9 + 2]), b(scan[t * 9 + 3], scan[t * 9 + 4], scan[t * 9 + 5]), c(scan[t * 9 + 6], scan[t * 9 + 7], scan[t * 9 + 8]);
                if (R.residualFlipped[k]) std::swap(b, c);
                const std::array<uint32_t, 3> ids{W.add(a), W.add(b), W.add(c)};
                resTri.push_back(ids);
                out.push_back({ids[0], ids[1], ids[2], 3, static_cast<int32_t>(t), -1, 1});
                residualM2 += triArea(a, b, c);
            }
            std::unordered_map<uint64_t, int> ec;
            for (const auto& t : resTri) for (int k = 0; k < 3; ++k) ec[ukey(t[static_cast<size_t>(k)], t[static_cast<size_t>((k + 1) % 3)])]++;
            for (size_t k = 0; k < resTri.size(); ++k) {
                const auto& t = resTri[k];
                for (int j = 0; j < 3; ++j) {
                    const uint32_t a = t[static_cast<size_t>(j)], b = t[static_cast<size_t>((j + 1) % 3)];
                    if (ec[ukey(a, b)] != 1) continue;
                    const V3 A = W.at(a), B = W.at(b);
                    float da2 = 0, db2 = 0;
                    const auto ca = shellBvh.closestPoint(sf::detail::f3(A), da2), cb = shellBvh.closestPoint(sf::detail::f3(B), db2);
                    const double da = std::sqrt(static_cast<double>(da2)), db = std::sqrt(static_cast<double>(db2));
                    const double len = (B - A).length();
                    if (da > seamReachM || db > seamReachM) { seamFreeM += len; continue; }
                    seamJoinedM += len;
                    if (da < 0.005 && db < 0.005) continue;
                    const V3 Ca = sf::detail::d3(ca), Cb = sf::detail::d3(cb);
                    // the skirt runs on from the triangle across the edge (a, b): (b, a) is its first edge, so it faces as the triangle does
                    const uint32_t ia = W.add(Ca), ib = W.add(Cb);
                    auto push = [&](uint32_t x, uint32_t y, uint32_t z) {
                        const V3 sn = (W.at(y) - W.at(x)).cross(W.at(z) - W.at(x));
                        if (sn.length() < 1e-9) return;
                        out.push_back({x, y, z, 4, static_cast<int32_t>(R.residualTriangles[k]), -1, 0});
                        skirtM2 += 0.5 * sn.length();
                    };
                    push(b, a, ia);
                    push(b, ia, ib);
                }
            }
        }
        const auto tEnd = clock::now();

        // ------------------------------------------------------------------ closure of the whole, by welded position
        size_t openEdges = 0, nonManifold = 0;
        {
            std::unordered_map<uint64_t, int> ec;
            for (const auto& t : out) { if (t.a == t.b || t.b == t.c || t.a == t.c) continue; ec[ukey(t.a, t.b)]++; ec[ukey(t.b, t.c)]++; ec[ukey(t.c, t.a)]++; }
            for (const auto& [k, c] : ec) { (void)k; if (c == 1) ++openEdges; else if (c > 2) ++nonManifold; }
        }
        size_t shellOnlyOpen = 0;
        {
            std::unordered_map<uint64_t, int> ec;
            for (const auto& t : out) { if (t.kind > 2) continue; if (t.a == t.b || t.b == t.c || t.a == t.c) continue; ec[ukey(t.a, t.b)]++; ec[ukey(t.b, t.c)]++; ec[ukey(t.c, t.a)]++; }
            for (const auto& [k, c] : ec) { (void)k; if (c == 1) ++shellOnlyOpen; }
        }

        {
            std::ofstream o(outPath, std::ios::binary);
            o.write("PSO1", 4);
            const uint32_t nV = static_cast<uint32_t>(W.pos.size() / 3), nT = static_cast<uint32_t>(out.size());
            o.write(reinterpret_cast<const char*>(&nV), 4);
            o.write(reinterpret_cast<const char*>(W.pos.data()), static_cast<std::streamsize>(W.pos.size() * 4));
            o.write(reinterpret_cast<const char*>(&nT), 4);
            for (const auto& t : out) { o.write(reinterpret_cast<const char*>(&t.a), 4); o.write(reinterpret_cast<const char*>(&t.b), 4); o.write(reinterpret_cast<const char*>(&t.c), 4); }
            for (const auto& t : out) { o.write(reinterpret_cast<const char*>(&t.kind), 1); o.write(reinterpret_cast<const char*>(&t.ref), 4); o.write(reinterpret_cast<const char*>(&t.facade), 4); o.write(reinterpret_cast<const char*>(&t.measured), 1); }
            if (!o) throw std::runtime_error("cannot write " + outPath);
        }
        const auto& M = R.metrics;
        auto ms = [](auto a, auto b) { return std::chrono::duration<double, std::milli>(b - a).count(); };
        std::ostringstream js;
        js.precision(6);
        size_t kinds[5] = {0, 0, 0, 0, 0};
        for (const auto& t : out) kinds[t.kind]++;
        js << "{\"version\":\"partition-shell/1\",\"scanTriangles\":" << nScan << ",\"latticeTriangles\":" << nLat << ",\"facades\":" << nFac
           << ",\"planes\":{\"priorsGiven\":" << in.priors.size() << ",\"priorPlanesKept\":" << priorPlanesKept << ",\"fittedKept\":" << (M.planesKept - priorPlanesKept)
           << ",\"total\":" << M.planesKept << "},\"cells\":" << M.cells << ",\"insideCells\":" << M.insideCells << ",\"labels\":\"" << (P.windingLabels ? "winding" : "votes") << "\""
           << ",\"roof\":{\"topIsAir\":" << (P.topIsAir ? "true" : "false") << ",\"levels\":" << M.roofLevels << ",\"caps\":" << M.roofCaps << "}"
           << ",\"shell\":{\"triangles\":" << M.shellTriangles << ",\"faces\":" << M.shellFaces << ",\"boundaryEdges\":" << M.boundaryEdges << ",\"nonManifoldEdges\":" << M.nonManifoldEdges
           << ",\"areaM2\":" << M.shellAreaM2 << ",\"volumeM3\":" << M.shellVolumeM3 << ",\"generatedAreaShare\":" << M.generatedAreaShare << ",\"groundClosureAreaM2\":" << M.groundClosureAreaM2
           << ",\"scanWithin05Share\":" << M.scanWithin05Share << ",\"scanWithin15Share\":" << M.scanWithin15Share << ",\"scanRmsM\":" << M.scanRmsM << ",\"explainedRmsM\":" << M.explainedRmsM
           << ",\"buriedAreaShare\":" << M.buriedAreaShare << "}"
           << ",\"inset\":{\"facesInset\":" << facesInset << ",\"facesFallback\":" << facesFallback << ",\"cdtWithoutHoles\":" << cdtNoHoles << ",\"rimsKept\":" << rimsKept
           << ",\"rimsCrossingFaceEdge\":" << rimsCrossing << ",\"rimsComplex\":" << rimsComplex << ",\"rimsNone\":" << rimsNone << ",\"gridCells\":" << gridCells << ",\"reliefCells\":" << reliefCells << ",\"stepWallM2\":" << stepWallM2 << ",\"reliefKeptM2\":" << reliefKeptM2 << ",\"reliefDroppedM2\":" << reliefDroppedM2
           << ",\"latticeOnPlaneReplacedM2\":" << latticeOnPlaneM2 << ",\"latticeOffShellM2\":" << latticeOffPlaneLostM2 << ",\"orthoTexturedM2\":" << orthoAreaM2 << ",\"toBakeM2\":" << bakeAreaM2 << ",\"perFacade\":[" << perFac.str() << "]}"
           << ",\"residual\":{\"triangles\":" << R.residualTriangles.size() << ",\"areaM2\":" << residualM2 << ",\"areaShare\":" << M.residualAreaShare << ",\"tolM\":" << P.residualTolM
           << ",\"seamJoinedM\":" << seamJoinedM << ",\"seamFreeM\":" << seamFreeM << ",\"skirtM2\":" << skirtM2 << ",\"seamReachM\":" << seamReachM << "}"
           << ",\"output\":{\"vertices\":" << W.pos.size() / 3 << ",\"triangles\":" << out.size() << ",\"byKind\":[" << kinds[0] << "," << kinds[1] << "," << kinds[2] << "," << kinds[3] << "," << kinds[4] << "]"
           << ",\"tJunctionSplits\":" << tJunctionSplits << ",\"openEdges\":" << openEdges << ",\"nonManifoldEdges\":" << nonManifold << ",\"shellAndInsetOpenEdges\":" << shellOnlyOpen << "}"
           << ",\"ms\":{\"shell\":" << ms(t0, tShell) << ",\"skin\":" << M.msSkin << ",\"planes\":" << M.msPlanes << ",\"cells\":" << M.msCells << ",\"labels\":" << M.msLabels
           << ",\"inset\":" << ms(tShell, tInset) << ",\"residual\":" << ms(tInset, tEnd) << ",\"total\":" << ms(t0, tEnd) << "}}";
        {
            std::ofstream o(reportPath);
            o << js.str();
        }
        std::cout << "{\"ok\":true,\"report\":\"" << reportPath << "\"}\n";
        return 0;
    } catch (const std::exception& e) {
        std::string m = e.what();
        for (auto& ch : m) if (ch == '"' || ch == '\\') ch = '\'';
        std::cout << "{\"ok\":false,\"error\":\"" << m << "\"}\n";
        return 1;
    }
}
