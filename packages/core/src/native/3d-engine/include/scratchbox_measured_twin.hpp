/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_MEASURED_TWIN_HPP
#define SCRATCHBOX_MEASURED_TWIN_HPP

/**
 * The measured procedural twin: a building generated from what a finished pipeline K build measured of it, with none of
 * the scan's surface in the result. Every surface is a new procedural element; what it is made from is measured:
 *
 *   - Massing (measured). The tree-free scan's height map split into tiers (scratchbox_shape_program.hpp analyseScan);
 *     each tier a prism of its squared outline between its base and top, its roof a flat cap (constrained Delaunay).
 *   - Slender top (measured). Where the scan above a tier top is slender (every 1 m slice's 95th-percentile radius under
 *     `slenderShare` of the building's plan diagonal) and tall (at least `minSlenderShare` of the height), it is not a
 *     prism: one vertical axis is fitted (the median of per-slice circle fits), each slice's radius read in `sectors`
 *     sectors about it and smoothed to `harmonics` Fourier terms, averaged over the top's measured order of rotational
 *     symmetry, and the mean radius up the axis split into tapered steps by penalised least-squares segmentation (a
 *     harmonic solid of revolution in stepped, tapered bands).
 *   - Opening heads (photo-inferred). Each window type of six or more on a plane photo median-stacked into one exemplar;
 *     the opening's top boundary traced across it; a head varying `headMinM` or more cut into the wall as that curve.
 *   - Fins (measured). Each step of the slender top: its angular profile stacked over the step's height in 0.5 degree bins
 *     (the excess of dense scan samples beyond the ring), folded by its period when it repeats around the axis, the bins
 *     standing `finMinM` or more beyond the ring drawn as radial blocks.
 *   - Self-read (opt-in `selfRead`, the K-free mode): no plane photos or window boxes from another stage. Each wall's photo
 *     rendered from the scan's texture; its windows found in it (storey and column pitch from its autocorrelation, the
 *     median unit cell's dark opening, every cell that matches); its detail texture read from it; the street level, when
 *     not given ("ground auto"), the commonest up-facing height near the scan's foot.
 *   - Openings (photo-inferred). Every window box pipeline K kept (window_fit.json: the facade reader's openings, the
 *     window fit's elsewhere, in each plane photo's pixels) is mapped through its plane's frame onto the prism wall facing
 *     the same way within `planeTolM`, punched through it, recessed by the reveal depth (photo-inferred when read from
 *     Street View, else a generated estimate, as the spec says), closed by its panes' glass and the frame between them.
 *     A box the window fit continued over an occluded or uncovered span is counted generated.
 *   - Colour (photo-inferred). Each element (a wall cell of at most `cellM`, a reveal, a pane, a frame, a roof cell, a
 *     band face) takes the per-channel median of the scan's own photo texture sampled over it (nearest scan surface
 *     facing the same way within `sampleRadiusM`; a fill a stage laid over unphotographed surfaces is not sampled).
 *     An element no photo reaches takes its tier's median wall colour, counted.
 *   - Detail (photo-inferred). A wall with windows from a photographed plane and a storey pitch gets a detail texture:
 *     every texel the per-channel median of the plane's straightened photo (the scan's own photo; never-photographed
 *     texels left out) at that point and `detailRepeats` storeys up and down, so the storey's own sash, mullion,
 *     spandrel and stone pattern stays and a one-off reflection, lit window or smear is outvoted. Each element's measured
 *     colour is baked over its rect as a gain on that median (to the power `detailGainPower`); the walls share one atlas
 *     (texel enlarged from `detailTexelM` until they fit in half the atlas). The geometry stays the operators'; roofs,
 *     the slender top and walls without detail keep their flat element colours.
 *   - Ledge profiles (measured). Each tier wall's scan sections stacked along it into one profile (the outermost surface
 *     per 0.1 m of height, 4 m below to 3 m above the tier top): continuous steps standing out of the wall (lips,
 *     cornices) and a parapet rising out of the roof are swept along the wall, mitred at convex corners. A step or
 *     parapet must run along at least `profileCoverage` of the wall, or it is not drawn.
 *   - Roof detail (measured). Connected cells of the scan's height map standing at least `roofDetailMinM` above the
 *     twin's tiers (away from the parapets' band and the slender top's foot), rebuilt as blocks at the scan's heights.
 *   - Scan detail (measured, opt-in: `scanDetailM` above 0). The scan's own triangles standing at least that far outside
 *     the procedural shell, in connected pieces, are kept as they are (the ledge profiles and roof detail are then left out).
 *   - Relief maps (measured, procedural, opt-in: `reliefM` above 0). Dense scan samples mapped on each wall (along, up), the
 *     roofs (the height map, down to reliefM, parapets included) and the slender top (height, sector) in `reliefCellM`
 *     cells; what stands at least reliefM off the shell, in pieces of reliefMinArea to reliefMaxArea, rebuilt as blocks.
 *   - Surface fit (measured, opt-in `surfaceFit`, with the relief maps). Irregular pieces off the shell (0.5 to 40 m^2, 1.5 m tall, not flat)
 *     rebuilt as a closed surface: the signed distance to their points on a 0.15 m grid, meshed by surface nets.
 *   - Atlas. Every element takes its colour from one atlas texture through its TEXCOORD_0 (COLOR_0 white), since some
 *     renderers read material textures and ignore vertex colours: a detailed wall's elements sample its texture, every
 *     other element a 16-texel block of its own colour (the palette, below the walls' textures; each colour once).
 *   - Material (photo-inferred). Each element's colour picks the nearest of K's measured appearance classes (CIELAB):
 *     its roughness and metalness (the library set's tiled maps would need a second UV set and are left out with an
 *     atlas). Glass is a smooth dielectric.
 *
 * No element is named or classified: walls, openings and bands are the operators' geometry (prisms, punched relief,
 * revolution), the class picks a measured appearance. Output: one binary glTF in the tile frame (x east, y up, z
 * south), nodes `massing`, `openings` and `slender_top`, each with extras.sb.provenance, and a JSON report.
 */

#include "scratchbox_cdt.hpp"
#include "scratchbox_gltf_scene.hpp"
#include "scratchbox_png.hpp"
#include "scratchbox_shape_program.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <map>
#include <optional>
#include <random>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

namespace scratchbox {
namespace measured_twin {

constexpr double kPi = 3.14159265358979323846;
using shape_program::P2;
using shape_program::P3;
namespace sp = shape_program;

// =============================================================================================
// Spec
// =============================================================================================

struct PlaneFrame { int id{0}; P3 c, s, t, n; double sMin{0}, tMax{0}, pixel{0}; int w{0}, h{0}; };
struct PixRect { double x0{0}, y0{0}, x1{0}, y1{0}; bool generated{false}; };
struct ClassMat {
    std::string name;                  // the library set (or the class) name, a label only
    double lab[3]{50, 0, 0};
    double roughness{0.8}, metallic{0}, tileM{2};
    std::string normalPng, ormPng;     // the set's prepared maps (empty: none)
    bool openings{false};              // the class lies inside window openings (not a wall pick)
};

struct Params {
    double cellM{1.5};                 // a wall or roof element is at most this across (its own colour)
    double planeTolM{2.5};             // a plane photo's windows go on a prism wall within this of its plane
    double normalDot{0.97};            // ... facing within acos(this)
    double minWindowM{0.3};            // a window box smaller than this either way is not punched
    double keepShare{0.7};             // a box clipped to its wall keeps at least this share of its area, else dropped
    double sampleRadiusM{2.5};         // colour: the nearest scan surface within this
    double slenderShare{0.15};         // slender top: slice radius under this share of the plan diagonal
    double minSlenderShare{0.1};       // ... over at least this share of the building's height
    int sectors{32};
    int harmonics{12};
    double symmetryTol{0.04};          // a slender top's rotational symmetry holds when its m-fold average departs by at most this share of the radius (RMS)
    double circleBelowM{1.0};
    int selfRead{0};                   // no plane photos or window boxes given: each wall's own photo rendered from the scan's texture, its windows found in it
    double selfTexelM{0.15};           // ... its texel
    int openingHeads{1};               // window heads traced from each window type's median-stacked photo
    double headMinM{0.15};             // ... drawn when the traced top varies at least this much across the window
    double headEdgeM{0.12};            // ... and stays within this of the box top at its outer columns (the wall closes in at the corners)          // a slice of a slender top narrower than this (mean radius) is a circle
    int slenderFins{1};                // the angular profile of each step, stacked over its height at 0.5 degrees, folded by its period: fins, flutes, ribs
    double finMinM{0.2};               // ... standing at least this far beyond the ring
    double finMinCorr{0.15};           // ... folded when one harmonic above the ring's carries at least this share of the excess's power
    double sliceM{1.0};
    double fillGapM{1.0};              // another photo's window fills a wall only this far from the windows already placed (along the wall)
    double fillReachM{8.0};            // ... looked for within this height above and below
    double snapAlongM{0.25};           // window edges within this along the wall share one column line
    double snapUpM{0.2};               // ... and within this up the wall one row line
    int continueMinWindows{6};         // a wall's rows are continued into unread spans when it holds at least this many windows
    double continueMaxDeltaE{20};      // a continued window's photo lies within this (CIELAB) of the wall's windows, and nearer them than the wall
    int detail{1};                     // wall detail textures from the walls' own storey repeats (0: flat colours only)
    double detailTexelM{0.12};         // their texel, enlarged until every wall fits one atlas
    int detailRepeats{6};              // storeys up and down a texel's median is taken over
    int detailAtlas{4096};             // the atlas's side (texels)
    double detailGainPower{0.5};
    int edgeProfiles{1};               // ledge profiles (lips, cornices, parapets) fitted from the scan's stacked sections
    double profileBinM{0.1};           // a profile's height bins
    double profileMinOutM{0.12};       // a step stands at least this far out of the wall (scan noise below it)
    double profileMaxOutM{1.5};        // ... and at most this far (beyond it, something else)
    double profileCoverage{0.5};       // a step runs along at least this share of the wall (a continuous lip, not a blob)
    double profileDensity{25};         // scan samples per square metre for the profiles
    int roofDetail{1};                 // what the scan has above the twin's roofs, rebuilt as stacked measured blocks
    double roofDetailMinM{0.8};        // ... standing at least this far above the twin's surface
    double roofDetailMinArea{1.5};     // ... over at least this much plan area (m^2)
    double roofDetailStepM{0.5};       // ... its heights in steps of this
    double scanDetailM{0};             // when above 0: scan surface standing at least this far outside the shell is kept as it is (measured), and the ledge profiles and roof detail are left out
    double scanDetailMinArea{0.5};     // ... in connected pieces of at least this much area (m^2)
    double reliefM{0};                 // when above 0: relief maps on the walls, roofs and slender top rebuild, as blocks, what stands at least this far off the shell (all procedural; the ledge profiles are left out)
    double reliefCellM{0.3};           // ... their cell
    double reliefDensity{40};          // ... scan samples per square metre
    double reliefMinArea{0.5};         // ... in connected pieces of at least this much area (m^2)
    double reliefMaxArea{20};
    int surfaceFit{0};                 // ... irregular leftovers rebuilt as a fitted closed surface (with the relief maps; opt-in: on the ESB its thin open pieces fit worse than blocks)          // ... and at most this (a larger piece on a wall is the wall standing off the squared outline, not a detail)
    double roofDetailEdgeM{1.2};       // ... within this of a tier's outline (the parapets' band, drawn by the ledge profiles) only above 2.5 m       // how much of an element's own colour is baked over the median (1: all of it, 0: none)
};

struct Spec {
    std::string isolate, textured, out, report;
    double groundY{0};
    std::vector<std::vector<P2>> footprintXZ;
    sp::ScanParams scan;
    Params P;
    double revealM{0.12};
    std::string revealLabel{"generated"}, revealSource{"no reading: a plausible reveal"};
    std::vector<ClassMat> classes;
    double glassRoughness{0.06};
    std::vector<PlaneFrame> planes;
    std::map<int, std::vector<PixRect>> windows, panes;
    std::map<int, std::string> planeImage, planeMask;  // a plane photo (its frame's pixels) and its uncovered mask
};

inline std::string restOfLine(std::istringstream& ls) {
    std::string r; std::getline(ls, r);
    size_t a = r.find_first_not_of(" \t");
    return a == std::string::npos ? std::string() : r.substr(a);
}

/** The line spec (scripts/measured_twin.cpp's comment lists the directives). */
inline Spec parseSpec(std::istream& in) {
    Spec S;
    std::map<int, std::string> classNormal, classOrm;
    std::string line;
    while (std::getline(in, line)) {
        if (line.empty() || line[0] == '#') continue;
        std::istringstream ls(line);
        std::string k; ls >> k;
        if (k == "isolate") S.isolate = restOfLine(ls);
        else if (k == "textured") S.textured = restOfLine(ls);
        else if (k == "out") S.out = restOfLine(ls);
        else if (k == "report") S.report = restOfLine(ls);
        else if (k == "ground") { std::string g; ls >> g; S.groundY = g == "auto" ? NAN : std::stod(g); }
        else if (k == "footprint") { size_t n; ls >> n; std::vector<P2> l(n); for (auto& p : l) ls >> p.u >> p.v; if (n >= 3) S.footprintXZ.push_back(l); }
        else if (k == "scan") {
            std::string name; double v; ls >> name >> v;
            auto& P = S.scan;
            if (name == "cell") P.cell = v; else if (name == "modeMerge") P.modeMerge = v; else if (name == "minTierArea") P.minTierArea = v;
            else if (name == "minTierShare") P.minTierShare = v; else if (name == "maxTiers") P.maxTiers = static_cast<int>(v);
            else if (name == "simplifyTol") P.simplifyTol = v; else if (name == "cleanRadius") P.cleanRadius = v; else if (name == "squareDeg") P.squareDeg = v;
            else throw std::runtime_error("unknown scan param " + name);
        }
        else if (k == "param") {
            std::string name; double v; ls >> name >> v;
            auto& P = S.P;
            if (name == "cellM") P.cellM = v; else if (name == "planeTolM") P.planeTolM = v; else if (name == "normalDot") P.normalDot = v;
            else if (name == "minWindowM") P.minWindowM = v; else if (name == "keepShare") P.keepShare = v; else if (name == "sampleRadiusM") P.sampleRadiusM = v;
            else if (name == "slenderShare") P.slenderShare = v; else if (name == "minSlenderShare") P.minSlenderShare = v;
            else if (name == "sectors") P.sectors = static_cast<int>(v); else if (name == "harmonics") P.harmonics = static_cast<int>(v);
            else if (name == "selfRead") P.selfRead = static_cast<int>(v); else if (name == "selfTexelM") P.selfTexelM = v;
            else if (name == "openingHeads") P.openingHeads = static_cast<int>(v); else if (name == "headMinM") P.headMinM = v; else if (name == "headEdgeM") P.headEdgeM = v;
            else if (name == "slenderFins") P.slenderFins = static_cast<int>(v); else if (name == "finMinM") P.finMinM = v; else if (name == "finMinCorr") P.finMinCorr = v;
            else if (name == "symmetryTol") P.symmetryTol = v; else if (name == "circleBelowM") P.circleBelowM = v; else if (name == "sliceM") P.sliceM = v;
            else if (name == "detail") P.detail = static_cast<int>(v); else if (name == "detailTexelM") P.detailTexelM = v;
            else if (name == "detailRepeats") P.detailRepeats = static_cast<int>(v); else if (name == "detailAtlas") P.detailAtlas = static_cast<int>(v); else if (name == "detailGainPower") P.detailGainPower = v;
            else if (name == "edgeProfiles") P.edgeProfiles = static_cast<int>(v); else if (name == "profileBinM") P.profileBinM = v;
            else if (name == "profileMinOutM") P.profileMinOutM = v; else if (name == "profileMaxOutM") P.profileMaxOutM = v;
            else if (name == "reliefM") P.reliefM = v; else if (name == "reliefCellM") P.reliefCellM = v; else if (name == "reliefDensity") P.reliefDensity = v; else if (name == "reliefMinArea") P.reliefMinArea = v; else if (name == "reliefMaxArea") P.reliefMaxArea = v; else if (name == "surfaceFit") P.surfaceFit = static_cast<int>(v);
            else if (name == "scanDetailM") P.scanDetailM = v; else if (name == "scanDetailMinArea") P.scanDetailMinArea = v;
            else if (name == "roofDetail") P.roofDetail = static_cast<int>(v); else if (name == "roofDetailMinM") P.roofDetailMinM = v;
            else if (name == "roofDetailMinArea") P.roofDetailMinArea = v; else if (name == "roofDetailStepM") P.roofDetailStepM = v; else if (name == "roofDetailEdgeM") P.roofDetailEdgeM = v;
            else if (name == "profileCoverage") P.profileCoverage = v; else if (name == "profileDensity") P.profileDensity = v;
            else if (name == "continueMinWindows") P.continueMinWindows = static_cast<int>(v); else if (name == "continueMaxDeltaE") P.continueMaxDeltaE = v;
            else if (name == "fillGapM") P.fillGapM = v; else if (name == "fillReachM") P.fillReachM = v; else if (name == "snapAlongM") P.snapAlongM = v; else if (name == "snapUpM") P.snapUpM = v;
            else throw std::runtime_error("unknown param " + name);
        }
        else if (k == "reveal") { ls >> S.revealM >> S.revealLabel; S.revealSource = restOfLine(ls); }
        else if (k == "glass") ls >> S.glassRoughness;
        else if (k == "class") {
            ClassMat c; int open = 0;
            ls >> c.name >> c.lab[0] >> c.lab[1] >> c.lab[2] >> c.roughness >> c.metallic >> c.tileM >> open;
            c.openings = open != 0;
            S.classes.push_back(c);
        }
        else if (k == "classnormal") { int i; ls >> i; classNormal[i] = restOfLine(ls); }
        else if (k == "classorm") { int i; ls >> i; classOrm[i] = restOfLine(ls); }
        else if (k == "plane") {
            PlaneFrame f;
            ls >> f.id >> f.c.x >> f.c.y >> f.c.z >> f.s.x >> f.s.y >> f.s.z >> f.t.x >> f.t.y >> f.t.z >> f.n.x >> f.n.y >> f.n.z >> f.sMin >> f.tMax >> f.pixel >> f.w >> f.h;
            S.planes.push_back(f);
        }
        else if (k == "planeimage") { int id; ls >> id; S.planeImage[id] = restOfLine(ls); }
        else if (k == "planemask") { int id; ls >> id; S.planeMask[id] = restOfLine(ls); }
        else if (k == "win" || k == "pane") {
            int id; PixRect r; int gen = 0;
            ls >> id >> r.x0 >> r.y0 >> r.x1 >> r.y1 >> gen;
            r.generated = gen != 0;
            (k == "win" ? S.windows : S.panes)[id].push_back(r);
        }
        else throw std::runtime_error("unknown directive " + k);
    }
    for (auto& [i, p] : classNormal) if (i >= 0 && i < static_cast<int>(S.classes.size())) S.classes[i].normalPng = p;
    for (auto& [i, p] : classOrm) if (i >= 0 && i < static_cast<int>(S.classes.size())) S.classes[i].ormPng = p;
    if (S.isolate.empty() || S.out.empty()) throw std::runtime_error("measured twin: isolate and out are required");
    return S;
}

// =============================================================================================
// Colour: the scan's own photo, sampled
// =============================================================================================

struct Rgb { double r{0}, g{0}, b{0}; };

inline double srgbToLinear(double c) { return c <= 0.04045 ? c / 12.92 : std::pow((c + 0.055) / 1.055, 2.4); }

/** CIELAB (D65) of a linear RGB colour. */
inline std::array<double, 3> labOf(const Rgb& c) {
    const double X = (0.4124 * c.r + 0.3576 * c.g + 0.1805 * c.b) / 0.95047;
    const double Y = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    const double Z = (0.0193 * c.r + 0.1192 * c.g + 0.9505 * c.b) / 1.08883;
    auto f = [](double t) { return t > 0.008856 ? std::cbrt(t) : 7.787 * t + 16.0 / 116.0; };
    const double fx = f(X), fy = f(Y), fz = f(Z);
    return {116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)};
}

class PhotoSampler {
public:
    bool ok{false};
    std::string why;
    size_t hits{0}, misses{0};

    explicit PhotoSampler(const std::string& glb, double cell = 2.0) : cell_(cell) {
        if (glb.empty()) { why = "no textured scan given"; return; }
        sc_ = gltf::GlbSceneReader::readFile(glb);
        if (!sc_.ok) { why = "textured scan: " + sc_.error; return; }
        const auto& ix = sc_.mesh.indices;
        const auto& vs = sc_.mesh.vertices;
        for (size_t t = 0; t + 2 < ix.size(); t += 3) {
            const uint32_t m = t / 3 < sc_.triangleMaterial.size() ? sc_.triangleMaterial[t / 3] : 0;
            if (m >= sc_.materials.size()) continue;
            const auto& mat = sc_.materials[m];
            if (mat.photoInferredFill || mat.baseColorImage < 0 || mat.baseColorImage >= static_cast<int>(sc_.images.size()) || !sc_.images[mat.baseColorImage].decoded) continue;
            Tri T;
            for (int k = 0; k < 3; ++k) { const auto& v = vs[ix[t + k]]; T.p[k] = {v.position.x, v.position.y, v.position.z}; T.uv[k] = {v.uv.x, v.uv.y}; }
            P3 n = sp::cross(T.p[1] - T.p[0], T.p[2] - T.p[0]);
            const double L = sp::len(n);
            if (L < 1e-9) continue;
            T.n = n * (1 / L);
            T.img = mat.baseColorImage;
            T.factor = {mat.baseColorFactor.x, mat.baseColorFactor.y, mat.baseColorFactor.z};
            const uint32_t id = static_cast<uint32_t>(tris_.size());
            tris_.push_back(T);
            P3 lo = T.p[0], hi = T.p[0];
            for (int k = 1; k < 3; ++k) { lo = {std::min(lo.x, T.p[k].x), std::min(lo.y, T.p[k].y), std::min(lo.z, T.p[k].z)}; hi = {std::max(hi.x, T.p[k].x), std::max(hi.y, T.p[k].y), std::max(hi.z, T.p[k].z)}; }
            for (int64_t a = key(lo.x); a <= key(hi.x); ++a) for (int64_t b = key(lo.y); b <= key(hi.y); ++b) for (int64_t c = key(lo.z); c <= key(hi.z); ++c) grid_[pack(a, b, c)].push_back(id);
        }
        ok = !tris_.empty();
        if (!ok) why = "the textured scan holds no photographed triangle";
    }

    /** The photo's linear colour at the nearest scan surface to p facing within ~70 degrees of n, within radius. */
    bool sample(P3 p, P3 n, double radius, Rgb& out) {
        if (!ok) return false;
        double best = radius * radius; int bi = -1; std::array<double, 3> bw{};
        const int64_t r = static_cast<int64_t>(std::ceil(radius / cell_));
        const int64_t ka = key(p.x), kb = key(p.y), kc = key(p.z);
        for (int64_t a = ka - r; a <= ka + r; ++a) for (int64_t b = kb - r; b <= kb + r; ++b) for (int64_t c = kc - r; c <= kc + r; ++c) {
            auto it = grid_.find(pack(a, b, c));
            if (it == grid_.end()) continue;
            for (uint32_t id : it->second) {
                const Tri& T = tris_[id];
                if (sp::dot(T.n, n) < 0.34) continue;
                std::array<double, 3> w;
                const P3 q = closest(p, T, w);
                const P3 d = q - p;
                const double d2 = sp::dot(d, d);
                if (d2 < best) { best = d2; bi = static_cast<int>(id); bw = w; }
            }
        }
        if (bi < 0) { ++misses; return false; }
        const Tri& T = tris_[bi];
        const double u = bw[0] * T.uv[0].u + bw[1] * T.uv[1].u + bw[2] * T.uv[2].u;
        const double v = bw[0] * T.uv[0].v + bw[1] * T.uv[1].v + bw[2] * T.uv[2].v;
        out = texel(T, u, v);
        ++hits;
        return true;
    }

private:
    struct Tri { std::array<P3, 3> p; std::array<P2, 3> uv; P3 n; int img{-1}; P3 factor{1, 1, 1}; };
    gltf::GltfScene sc_;
    std::vector<Tri> tris_;
    std::unordered_map<uint64_t, std::vector<uint32_t>> grid_;
    double cell_;
    int64_t key(double x) const { return static_cast<int64_t>(std::floor(x / cell_)); }
    static uint64_t pack(int64_t a, int64_t b, int64_t c) { return (static_cast<uint64_t>(a & 0x1FFFFF) << 42) | (static_cast<uint64_t>(b & 0x1FFFFF) << 21) | static_cast<uint64_t>(c & 0x1FFFFF); }

    Rgb texel(const Tri& T, double u, double v) const {
        const auto& im = sc_.images[T.img].pixels;
        u -= std::floor(u); v -= std::floor(v);
        const double fx = u * im.width - 0.5, fy = v * im.height - 0.5;
        const int x0 = static_cast<int>(std::floor(fx)), y0 = static_cast<int>(std::floor(fy));
        const double ax = fx - x0, ay = fy - y0;
        Rgb c;
        for (int j = 0; j < 2; ++j) for (int i = 0; i < 2; ++i) {
            const int x = std::clamp(x0 + i, 0, im.width - 1), y = std::clamp(y0 + j, 0, im.height - 1);
            const double w = (i ? ax : 1 - ax) * (j ? ay : 1 - ay);
            const size_t o = im.getIndex(x, y);
            c.r += w * srgbToLinear(im.data[o] / 255.0);
            c.g += w * srgbToLinear(im.data[o + (im.channels > 1 ? 1 : 0)] / 255.0);
            c.b += w * srgbToLinear(im.data[o + (im.channels > 2 ? 2 : 0)] / 255.0);
        }
        c.r *= T.factor.x; c.g *= T.factor.y; c.b *= T.factor.z;
        return c;
    }

    /** The closest point of T to p and its barycentric weights (Ericson, Real-Time Collision Detection 5.1.5). */
    static P3 closest(P3 p, const Tri& T, std::array<double, 3>& w) {
        const P3 a = T.p[0], b = T.p[1], c = T.p[2];
        const P3 ab = b - a, ac = c - a, ap = p - a;
        const double d1 = sp::dot(ab, ap), d2 = sp::dot(ac, ap);
        if (d1 <= 0 && d2 <= 0) { w = {1, 0, 0}; return a; }
        const P3 bp = p - b; const double d3 = sp::dot(ab, bp), d4 = sp::dot(ac, bp);
        if (d3 >= 0 && d4 <= d3) { w = {0, 1, 0}; return b; }
        const double vc = d1 * d4 - d3 * d2;
        if (vc <= 0 && d1 >= 0 && d3 <= 0) { const double t = d1 / (d1 - d3); w = {1 - t, t, 0}; return a + ab * t; }
        const P3 cp = p - c; const double d5 = sp::dot(ab, cp), d6 = sp::dot(ac, cp);
        if (d6 >= 0 && d5 <= d6) { w = {0, 0, 1}; return c; }
        const double vb = d5 * d2 - d1 * d6;
        if (vb <= 0 && d2 >= 0 && d6 <= 0) { const double t = d2 / (d2 - d6); w = {1 - t, 0, t}; return a + ac * t; }
        const double va = d3 * d6 - d5 * d4;
        if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) { const double t = (d4 - d3) / ((d4 - d3) + (d5 - d6)); w = {0, 1 - t, t}; return b + (c - b) * t; }
        const double den = 1 / (va + vb + vc), v = vb * den, ww = vc * den;
        w = {1 - v - ww, v, ww};
        return a + ab * v + ac * ww;
    }
};

/** The per-channel median of the photo over a planar patch: a grid of up to n x n points over origin + a*A + b*B (a, b in [0, 1]). */
inline bool patchColour(PhotoSampler& ph, P3 origin, P3 A, P3 B, P3 n, double radius, Rgb& out, int maxN = 4) {
    const double la = sp::len(A), lb = sp::len(B);
    const int na = std::clamp(static_cast<int>(std::ceil(la / 0.5)), 1, maxN), nb = std::clamp(static_cast<int>(std::ceil(lb / 0.5)), 1, maxN);
    std::vector<double> r, g, b;
    for (int j = 0; j < nb; ++j) for (int i = 0; i < na; ++i) {
        Rgb c;
        if (ph.sample(origin + A * ((i + 0.5) / na) + B * ((j + 0.5) / nb), n, radius, c)) { r.push_back(c.r); g.push_back(c.g); b.push_back(c.b); }
    }
    if (r.empty()) return false;
    auto med = [](std::vector<double>& v) { std::nth_element(v.begin(), v.begin() + v.size() / 2, v.end()); return v[v.size() / 2]; };
    out = {med(r), med(g), med(b)};
    return true;
}

/** Mean and standard deviation of the photo's luminance over a patch (an n x n grid), or false when under half is photographed. */
inline bool patchLumStats(PhotoSampler& ph, P3 origin, P3 A, P3 B, P3 n, double radius, double& mean, double& sd, int N = 6) {
    std::vector<double> v;
    for (int j = 0; j < N; ++j) for (int i = 0; i < N; ++i) {
        Rgb c;
        if (ph.sample(origin + A * ((i + 0.5) / N) + B * ((j + 0.5) / N), n, radius, c)) v.push_back(0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b);
    }
    if (v.size() * 2 < static_cast<size_t>(N * N)) return false;
    double m = 0; for (double x : v) m += x; m /= v.size();
    double q = 0; for (double x : v) q += (x - m) * (x - m);
    mean = m; sd = std::sqrt(q / v.size());
    return true;
}

// =============================================================================================
// Output mesh
// =============================================================================================

struct Prim { std::vector<float> pos, nrm, uv, col; std::vector<uint32_t> idx; };

/**
 * A wall's detail texture: every texel the per-channel median of the wall's photo at that point and the same point
 * `detailRepeats` storeys up and down (the facade's own repeats: a reflection, a lit window, a blind or a smear in one
 * storey is outvoted by the others, the storey's own pattern of sash, mullion, spandrel and pier stays), placed in the
 * atlas at (ax, ay). Each element's measured colour is then baked over its rect as a gain on the median (bakeTints).
 */
struct FaceTex {
    bool ok{false};
    int ax{0}, ay{0}, w{0}, h{0};
    double texel{0.12}, h0{0}, h1{0};
    std::vector<float> M;              // linear RGB, -1 where no repeat was photographed
    struct Tint { double a0, a1, h0, h1; Rgb c; };
    std::vector<Tint> tints;
};
struct OutNode { std::string name, extras; std::map<int, Prim> prims; };  // material index -> primitive

struct Emitter {
    std::vector<ClassMat>* classes{nullptr};
    int glassMat{0};
    size_t triangles{0};
    // Every element is drawn from the atlas (its colour in a texture, COLOR_0 white), since some renderers read material
    // textures but not vertex colours. While a detail-textured wall is emitted, `tex` is its texture and an element samples
    // it; any other element samples a block of its own colour (the palette, below the walls' textures). UVs are written in
    // atlas texels and divided by the atlas's final size when it is known (normaliseUvs).
    FaceTex* tex{nullptr};
    P3 texP0, texD;
    double groundY{0};
    int texOffset{0}, atlasW{4096}, paletteY0{0};
    static constexpr int kBlock = 16;                // a palette block's side (texels): its colour survives four mip levels (distant views)
    std::map<uint32_t, int> paletteIndex;            // 8-bit sRGB colour -> block
    std::vector<uint32_t> palette;
    static uint8_t toSrgb8(double c) { c = std::clamp(c, 0.0, 1.0); return static_cast<uint8_t>(std::lround(255.0 * (c <= 0.0031308 ? 12.92 * c : 1.055 * std::pow(c, 1 / 2.4) - 0.055))); }
    void paletteUv(float& u, float& v, const Rgb& c) {
        // 5 bits a channel (steps of 8 in sRGB): the palette stays within the atlas however many elements there are
        auto q5 = [&](double v) { return static_cast<uint32_t>(std::min(255, (toSrgb8(v) & 0xF8) + 4)); };
        const uint32_t key = (q5(c.r) << 16) | (q5(c.g) << 8) | q5(c.b);
        auto it = paletteIndex.find(key);
        int k;
        if (it == paletteIndex.end()) { k = static_cast<int>(palette.size()); palette.push_back(key); paletteIndex[key] = k; } else k = it->second;
        const int perRow = atlasW / kBlock;
        u = static_cast<float>((k % perRow) * kBlock + kBlock * 0.5);
        v = static_cast<float>(paletteY0 + (k / perRow) * kBlock + kBlock * 0.5);
    }
    int paletteRowsTexels() const { const int perRow = atlasW / kBlock; return static_cast<int>((palette.size() + perRow - 1) / perRow) * kBlock; }
    void atlasUv(Prim& p, const P3& q) const {
        const double a = sp::dot(q - texP0, texD), h = q.y - groundY;
        p.uv.push_back(static_cast<float>(tex->ax + a / tex->texel));
        p.uv.push_back(static_cast<float>(tex->ay + (tex->h1 - h) / tex->texel));
    }
    void push(Prim& p, std::initializer_list<P3> pts, P3 n, const Rgb& col) {
        float pu = 0, pv = 0;
        if (!tex) paletteUv(pu, pv, col);
        for (const P3& q : pts) {
            if (tex) atlasUv(p, q); else { p.uv.push_back(pu); p.uv.push_back(pv); }
            p.pos.insert(p.pos.end(), {static_cast<float>(q.x), static_cast<float>(q.y), static_cast<float>(q.z)});
            p.nrm.insert(p.nrm.end(), {static_cast<float>(n.x), static_cast<float>(n.y), static_cast<float>(n.z)});
            p.col.insert(p.col.end(), {1.0f, 1.0f, 1.0f});
        }
    }
    /** Divides every element's UVs (atlas texels) by the atlas's final size. */
    void normaliseUvs(std::vector<OutNode*> nodes, int H) const {
        for (auto* nd : nodes) for (auto& [m, p] : nd->prims) for (size_t i = 0; i + 1 < p.uv.size(); i += 2) { p.uv[i] /= static_cast<float>(atlasW); p.uv[i + 1] /= static_cast<float>(H); }
    }

    /** The nearest class (CIELAB) to a colour; openings classes only when nothing else is given. */
    int classOf(const Rgb& c) const {
        const auto L = labOf(c);
        int best = 0; double bd = 1e300; bool any = false;
        for (int pass = 0; pass < 2 && !any; ++pass)
            for (size_t i = 0; i < classes->size(); ++i) {
                const auto& k = (*classes)[i];
                if (pass == 0 && k.openings) continue;
                const double d = (L[0] - k.lab[0]) * (L[0] - k.lab[0]) + (L[1] - k.lab[1]) * (L[1] - k.lab[1]) + (L[2] - k.lab[2]) * (L[2] - k.lab[2]);
                if (d < bd) { bd = d; best = static_cast<int>(i); any = true; }
            }
        return best;
    }

    /** A planar quad a, b, c, d (counter-clockwise seen from n, reordered when not), drawn from the atlas. */
    void quad(OutNode& nd, int mat, P3 a, P3 b, P3 c, P3 d, P3 n, const Rgb& col, P3, P3) {
        if (sp::dot(sp::cross(b - a, c - a), n) < 0) std::swap(b, d);
        Prim& p = nd.prims[mat + texOffset];
        const uint32_t base = static_cast<uint32_t>(p.pos.size() / 3);
        push(p, {a, b, c, d}, n, col);
        p.idx.insert(p.idx.end(), {base, base + 1, base + 2, base, base + 2, base + 3});
        triangles += 2;
    }
    void tri(OutNode& nd, int mat, P3 a, P3 b, P3 c, P3 n, const Rgb& col, P3, P3) {
        if (sp::dot(sp::cross(b - a, c - a), n) < 0) std::swap(b, c);
        Prim& p = nd.prims[mat + texOffset];
        const uint32_t base = static_cast<uint32_t>(p.pos.size() / 3);
        push(p, {a, b, c}, n, col);
        p.idx.insert(p.idx.end(), {base, base + 1, base + 2});
        triangles += 1;
    }
};

// =============================================================================================
// Report
// =============================================================================================

struct Report {
    size_t tiers{0}, wallFaces{0}, facesWithWindows{0}, wallCells{0}, roofCells{0};
    size_t windowsGiven{0}, windowsPlaced{0}, windowsGenerated{0}, windowsContinued{0}, continueTested{0}, windowsRephased{0}, wallsRephased{0}, panesPlaced{0};
    size_t droppedNoWall{0}, droppedClipped{0}, droppedOverlap{0}, droppedSmall{0}, droppedNoFrame{0};
    size_t uncolouredElements{0}, colouredElements{0}, capsCut{0};
    size_t facesTextured{0}, texelsDetail{0}, paletteColours{0};
    size_t profileWalls{0}, profileLips{0}, profileParapets{0}, profileSteps{0};
    size_t roofDetailPieces{0}, roofDetailBoxes{0};
    size_t scanDetailPieces{0}, scanDetailTriangles{0};
    size_t reliefWallPieces{0}, reliefWallBoxes{0}, reliefMastPieces{0}, reliefMastCells{0};
    double reliefWallAreaM2{0};
    double scanDetailAreaM2{0};
    double roofDetailAreaM2{0}, roofDetailMedianM{0};
    double profileMedianOutM{0}, profileMedianParapetM{0};
    int atlasW{0}, atlasH{0};
    double detailTexelM{0};
    double slenderFromM{-1}, topM{0};
    size_t slenderBands{0}, slenderSlices{0}, slenderAxisFits{0}, finBands{0}, finCount{0}, finSegments{0};
    size_t headTypes{0}, headWindows{0}, headsDrawn{0}, surfacePieces{0}, surfaceQuads{0};
    size_t selfWalls{0}, selfWindowWalls{0}, selfWindows{0};
    std::vector<double> headRises;
    int slenderSymmetry{1};
    std::map<int, size_t> classUse;
    std::vector<std::string> notes;
};

namespace detail {

inline std::string num(double v) {
    if (!std::isfinite(v)) return "null";
    char b[40]; std::snprintf(b, sizeof b, "%.6g", v); return b;
}
inline std::string esc(const std::string& s) {
    std::string o;
    for (char c : s) { if (c == '"' || c == '\\') { o += '\\'; o += c; } else if (static_cast<unsigned char>(c) < 0x20) o += ' '; else o += c; }
    return o;
}
inline bool inRingXZ(double x, double z, const std::vector<P2>& r) {
    bool in = false;
    for (size_t i = 0, j = r.size() - 1; i < r.size(); j = i++)
        if (((r[i].v > z) != (r[j].v > z)) && (x < (r[j].u - r[i].u) * (z - r[i].v) / (r[j].v - r[i].v) + r[i].u)) in = !in;
    return in;
}
inline std::vector<uint8_t> readFile(const std::string& p) {
    std::ifstream f(p, std::ios::binary);
    if (!f) return {};
    return std::vector<uint8_t>((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
}

/** Rectangle [a0, a1] x [h0, h1] minus non-overlapping holes, as rectangles (slabs between every hole's top and bottom). */
struct R2 { double a0, a1, h0, h1; };
inline std::vector<R2> subtractHoles(const R2& box, const std::vector<R2>& holes) {
    std::vector<double> hs{box.h0, box.h1};
    for (const auto& w : holes) { hs.push_back(std::clamp(w.h0, box.h0, box.h1)); hs.push_back(std::clamp(w.h1, box.h0, box.h1)); }
    std::sort(hs.begin(), hs.end());
    std::vector<double> u;
    for (double h : hs) if (u.empty() || h - u.back() > 0.005) u.push_back(h);
    std::vector<R2> out;
    for (size_t i = 0; i + 1 < u.size(); ++i) {
        const double y0 = u[i], y1 = u[i + 1], ym = (y0 + y1) / 2;
        std::vector<std::pair<double, double>> cut;
        for (const auto& w : holes) if (w.h0 < ym && w.h1 > ym) cut.push_back({std::max(w.a0, box.a0), std::min(w.a1, box.a1)});
        std::sort(cut.begin(), cut.end());
        double a = box.a0;
        for (const auto& [c0, c1] : cut) { if (c0 - a > 0.005) out.push_back({a, c0, y0, y1}); a = std::max(a, c1); }
        if (box.a1 - a > 0.005) out.push_back({a, box.a1, y0, y1});
    }
    return out;
}

}  // namespace detail

// =============================================================================================
// The build
// =============================================================================================

struct Result { std::vector<OutNode> nodes; Report report; sp::Frame frame; texture::ImageBuffer atlas; };

/** A wall face: from p0 along d (unit, horizontal) for L metres, between heights h0 and h1 above the street, facing n. */
struct WallFace { P3 p0, d, n; double L, h0, h1; int tier; bool cvx0{true}, cvx1{true}; };  // cvx: the corner at the start / end is convex

inline Result build(Spec S) {
    Result out;
    Report& rep = out.report;
    std::vector<ClassMat> classes = S.classes;
    if (classes.empty()) classes.push_back(ClassMat{"neutral", {60, 0, 0}, 0.8, 0, 2, "", "", false});
    Emitter E;
    E.classes = &classes;
    E.glassMat = static_cast<int>(classes.size());  // one past the classes

    // --- massing: the scan's tiers
    // the street level, when not given: the commonest height of the scan's up-facing surface (area-weighted, 0.1 m bins)
    // within 15 m of its lowest point
    if (std::isnan(S.groundY)) {
        gltf::GltfScene sc = gltf::GlbSceneReader::readFile(S.isolate);
        if (!sc.ok) throw std::runtime_error("isolate: " + sc.error);
        double lo = 1e30;
        for (const auto& v : sc.mesh.vertices) lo = std::min(lo, static_cast<double>(v.position.y));
        std::map<long, double> hist;
        const auto& vs = sc.mesh.vertices; const auto& ix = sc.mesh.indices;
        for (size_t t = 0; t + 2 < ix.size(); t += 3) {
            const P3 a{vs[ix[t]].position.x, vs[ix[t]].position.y, vs[ix[t]].position.z}, b{vs[ix[t + 1]].position.x, vs[ix[t + 1]].position.y, vs[ix[t + 1]].position.z}, c{vs[ix[t + 2]].position.x, vs[ix[t + 2]].position.y, vs[ix[t + 2]].position.z};
            const P3 n = sp::cross(b - a, c - a); const double A2 = sp::len(n);
            if (A2 < 1e-9 || n.y / A2 < 0.9) continue;
            const double y = (a.y + b.y + c.y) / 3;
            if (y > lo + 15) continue;
            hist[std::lround(y * 10)] += A2 / 2;
        }
        long best = 0; double bw = -1;
        for (const auto& [k, w] : hist) if (w > bw) { bw = w; best = k; }
        S.groundY = bw > 0 ? best / 10.0 : lo;
        rep.notes.push_back("street level not given: " + detail::num(S.groundY) + " (the commonest up-facing height near the scan's foot)");
    }
    sp::ScanResult R = sp::analyseScan(S.isolate, S.groundY, S.footprintXZ, {}, S.scan);
    out.frame = R.frame;
    const sp::Frame& F = R.frame;
    for (const auto& n : R.notes) rep.notes.push_back(n);

    // --- slender top: per-slice radii of the building soup (frame: x = u, y = h, z = v)
    const double topH = R.boxHi.y;
    rep.topM = topH;
    const double diag = std::hypot(R.boxHi.x - R.boxLo.x, R.boxHi.z - R.boxLo.z);
    std::vector<P3> pts;
    {
        std::mt19937 rng(7);
        std::uniform_real_distribution<double> U(0, 1);
        for (size_t t = 0; t < R.building.size(); ++t) {
            const P3 a = R.building.p[3 * t], b = R.building.p[3 * t + 1], c = R.building.p[3 * t + 2];
            const double area = sp::len(sp::cross(b - a, c - a)) / 2;
            const int n = std::max(1, static_cast<int>(std::ceil(area / 0.25)));
            for (int k = 0; k < n; ++k) { double r1 = U(rng), r2 = U(rng); if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; } pts.push_back(a + (b - a) * r1 + (c - a) * r2); }
        }
    }
    const int nSlices = std::max(1, static_cast<int>(std::ceil(topH / S.P.sliceM)));
    std::vector<std::vector<P3>> slice(nSlices);
    for (const auto& p : pts) { const int k = std::clamp(static_cast<int>(std::floor(p.y / S.P.sliceM)), 0, nSlices - 1); slice[k].push_back(p); }
    std::vector<double> r95(nSlices, -1);
    std::vector<P2> cen(nSlices);
    for (int k = 0; k < nSlices; ++k) {
        if (slice[k].size() < 12) continue;
        double cu = 0, cv = 0;
        for (const auto& p : slice[k]) { cu += p.x; cv += p.z; }
        cu /= slice[k].size(); cv /= slice[k].size();
        cen[k] = {cu, cv};
        std::vector<double> r;
        for (const auto& p : slice[k]) r.push_back(std::hypot(p.x - cu, p.z - cv));
        std::nth_element(r.begin(), r.begin() + static_cast<long>(0.95 * (r.size() - 1)), r.end());
        r95[k] = r[static_cast<size_t>(0.95 * (r.size() - 1))];
    }
    auto slenderFrom = [&](double h) {
        if (topH - h < S.P.minSlenderShare * topH) return false;
        for (int k = std::max(0, static_cast<int>(std::ceil(h / S.P.sliceM))); k < nSlices; ++k) if (r95[k] >= 0 && r95[k] >= S.P.slenderShare * diag) return false;
        return true;
    };
    double slenderH = -1;
    for (const auto& t : R.tiers) if (slenderFrom(t.topY)) { slenderH = t.topY; break; }
    rep.slenderFromM = slenderH;

    std::vector<const sp::TierOut*> tiers;
    for (const auto& t : R.tiers) if (slenderH < 0 || t.baseY < slenderH - 0.01) tiers.push_back(&t);
    rep.tiers = tiers.size();

    // --- photo sampler
    PhotoSampler ph(S.textured);
    if (!ph.ok) rep.notes.push_back("colour: " + ph.why + "; every element takes the class colour");

    // --- plane frames by id
    std::map<int, const PlaneFrame*> frames;
    for (const auto& f : S.planes) frames[f.id] = &f;
    auto planePoint = [](const PlaneFrame& f, double x, double y) {
        const double s = f.sMin + x * f.pixel, t = f.tMax - y * f.pixel;
        return f.c + f.s * s + f.t * t;
    };

    OutNode massing{"massing", "", {}}, openings{"openings", "", {}}, slender{"slender_top", "", {}}, ledges{"ledge_profiles", "", {}}, roofDet{"roof_detail", "", {}}, scanDet{"scan_detail", "", {}};
    const P3 up{0, 1, 0};

    auto classColour = [&](int k) {
        const auto& L = classes[k].lab;
        const double fy = (L[0] + 16) / 116, fx = fy + L[1] / 500, fz = fy - L[2] / 200;
        auto inv = [](double t) { return t * t * t > 0.008856 ? t * t * t : (t - 16.0 / 116.0) / 7.787; };
        const double X = 0.95047 * inv(fx), Y = inv(fy), Z = 1.08883 * inv(fz);
        return Rgb{std::clamp(3.2406 * X - 1.5372 * Y - 0.4986 * Z, 0.0, 1.0), std::clamp(-0.9689 * X + 1.8758 * Y + 0.0415 * Z, 0.0, 1.0), std::clamp(0.0557 * X - 0.2040 * Y + 1.0570 * Z, 0.0, 1.0)};
    };
    // the elements' colour: the photo over the patch, else the fallback (counted)
    auto colourOf = [&](P3 origin, P3 A, P3 B, P3 n, const Rgb& fallback, bool& got) {
        Rgb c;
        got = patchColour(ph, origin, A, B, n, S.P.sampleRadiusM, c);
        if (got) ++rep.colouredElements; else ++rep.uncolouredElements;
        return got ? c : fallback;
    };

    // --- wall faces of every tier
    std::vector<WallFace> faces;
    for (size_t ti = 0; ti < tiers.size(); ++ti) {
        const auto& t = *tiers[ti];
        for (const auto& loopUV : t.loopsUV) {
            std::vector<P2> xz;
            for (const auto& q : loopUV) { double x, z; F.toXZ(q.u, q.v, x, z); xz.push_back({x, z}); }
            for (size_t i = 0; i < xz.size(); ++i) {
                const P2 a = xz[i], b = xz[(i + 1) % xz.size()];
                const double L = std::hypot(b.u - a.u, b.v - a.v);
                if (L < 0.05) continue;
                P3 d{(b.u - a.u) / L, 0, (b.v - a.v) / L};
                P3 n{d.z, 0, -d.x};
                const double mx = (a.u + b.u) / 2 + n.x * 0.3, mz = (a.v + b.v) / 2 + n.z * 0.3;
                bool inside = false;
                for (const auto& l2 : t.loopsUV) { std::vector<P2> lx; for (const auto& q : l2) { double x, z; F.toXZ(q.u, q.v, x, z); lx.push_back({x, z}); } if (detail::inRingXZ(mx, mz, lx)) inside = !inside; }
                if (inside) n = n * -1.0;
                faces.push_back({P3{a.u, S.groundY, a.v}, d, n, L, t.baseY, t.topY, static_cast<int>(ti)});
            }
            // each corner of this loop: convex when the next edge turns away from the previous edge's outward side
            const size_t first = faces.size() - std::min(faces.size(), xz.size());
            const size_t nf = faces.size() - first;
            for (size_t k = 0; k < nf; ++k) {
                auto& A = faces[first + k];
                auto& B = faces[first + (k + 1) % nf];
                const bool convex = sp::dot(B.d, A.n) < 1e-6;
                A.cvx1 = convex; B.cvx0 = convex;
            }
        }
    }
    rep.wallFaces = faces.size();

    struct Photo { bool ok{false}; texture::ImageBuffer rgb, mask; };
    std::map<int, Photo> photos;
    auto photoOf = [&](int id) -> const Photo& {
        auto it = photos.find(id);
        if (it != photos.end()) return it->second;
        Photo P;
        auto im = S.planeImage.find(id);
        if (im != S.planeImage.end()) {
            const auto bytes = detail::readFile(im->second);
            auto d = png::decode(bytes.data(), bytes.size(), png::OutputFormat::Rgb);
            if (d.ok) { P.rgb = std::move(d.image); P.ok = true; }
            auto mk = S.planeMask.find(id);
            if (P.ok && mk != S.planeMask.end()) {
                const auto mb = detail::readFile(mk->second);
                auto md = png::decode(mb.data(), mb.size(), png::OutputFormat::Luma);
                if (md.ok && md.image.width == P.rgb.width && md.image.height == P.rgb.height) P.mask = std::move(md.image);
            }
        }
        return photos.emplace(id, std::move(P)).first->second;
    };

    // --- opening heads. Per plane photo, its window boxes grouped into types by size (3 px); a type of six or more is
    // median-stacked into one exemplar (each crop with a margin of 0.6 of its width above the box and 0.2 to the sides,
    // resampled to 32 x 48), sharper than any one window. Where the exemplar's opening reads apart from the wall beside it
    // (12 grey levels or more), the opening's top boundary is traced in 16 columns across the box (from inside the
    // opening up, the first two rows that read as the wall), and when that boundary varies by headMinM or more across
    // the window the type's head is that curve (metres above the box top, smoothed): an arch, a point, a stepped head or
    // anything else, no shape named. Photo-inferred.
    std::map<int, std::vector<std::vector<double>>> heads;  // plane -> per window box, its head (16 samples) or empty
    if (S.P.openingHeads) {
        for (const auto& [id, rects] : S.windows) {
            auto fit = frames.find(id);
            if (fit == frames.end() || rects.size() < 6) continue;
            const Photo& P = photoOf(id);
            if (!P.ok) continue;
            const double pix = fit->second->pixel;
            auto lum = [&](double x, double y) -> double {
                if (x < 0 || y < 0 || x >= P.rgb.width - 1 || y >= P.rgb.height - 1) return NAN;
                const int xi = static_cast<int>(x), yi = static_cast<int>(y);
                if (!P.mask.empty() && P.mask.data[P.mask.getIndex(xi, yi)] > 127) return NAN;
                const size_t o = P.rgb.getIndex(xi, yi);
                return 0.299 * P.rgb.data[o] + 0.587 * P.rgb.data[o + 1] + 0.114 * P.rgb.data[o + 2];
            };
            std::map<std::pair<long, long>, std::vector<size_t>> types;
            for (size_t i = 0; i < rects.size(); ++i) types[{std::lround((rects[i].x1 - rects[i].x0) / 3), std::lround((rects[i].y1 - rects[i].y0) / 3)}].push_back(i);
            auto& out = heads[id];
            out.assign(rects.size(), {});
            constexpr int NX = 32, NY = 48, NS = 16;
            for (const auto& [key, members] : types) {
                if (members.size() < 6) continue;
                const double w = rects[members[0]].x1 - rects[members[0]].x0, h = rects[members[0]].y1 - rects[members[0]].y0;
                if (w * pix < 0.4 || h * pix < 0.6) continue;
                const double mTop = 0.6 * w, gx0 = -0.2 * w, gx1 = w * 1.2, gy0 = -mTop, gy1 = 0.5 * h;
                std::vector<std::vector<double>> stack(NX * NY);
                for (size_t m : members) {
                    const auto& r = rects[m];
                    for (int j = 0; j < NY; ++j) for (int i = 0; i < NX; ++i) {
                        const double v = lum(r.x0 + gx0 + (gx1 - gx0) * (i + 0.5) / NX, r.y0 + gy0 + (gy1 - gy0) * (j + 0.5) / NY);
                        if (!std::isnan(v)) stack[j * NX + i].push_back(v);
                    }
                }
                std::vector<double> ex(NX * NY, NAN);
                for (size_t k = 0; k < ex.size(); ++k) if (stack[k].size() >= 3) { auto& v = stack[k]; std::nth_element(v.begin(), v.begin() + v.size() / 2, v.end()); ex[k] = v[v.size() / 2]; }
                auto colOf = [&](double fx) { return std::clamp(static_cast<int>((fx * w - gx0) / (gx1 - gx0) * NX), 0, NX - 1); };
                auto rowOf = [&](double py) { return std::clamp(static_cast<int>((py - gy0) / (gy1 - gy0) * NY), 0, NY - 1); };
                std::vector<double> inV, outV;
                for (int j = rowOf(0.1 * h); j <= rowOf(0.45 * h); ++j) {
                    for (int i = colOf(0.3); i <= colOf(0.7); ++i) if (!std::isnan(ex[j * NX + i])) inV.push_back(ex[j * NX + i]);
                    for (int i = 0; i < colOf(-0.05); ++i) if (!std::isnan(ex[j * NX + i])) outV.push_back(ex[j * NX + i]);
                    for (int i = colOf(1.05) + 1; i < NX; ++i) if (!std::isnan(ex[j * NX + i])) outV.push_back(ex[j * NX + i]);
                }
                if (inV.size() < 8 || outV.size() < 8) continue;
                auto med = [](std::vector<double> v) { std::nth_element(v.begin(), v.begin() + v.size() / 2, v.end()); return v[v.size() / 2]; };
                const double li = med(inV), lo = med(outV);
                if (std::abs(li - lo) < 12) continue;
                std::vector<double> prof(NS, NAN);
                int found = 0;
                for (int k = 0; k < NS; ++k) {
                    const int col = colOf((k + 0.5) / NS);
                    int run = 0, yb = -1;
                    for (int j = rowOf(0.3 * h); j >= 0; --j) {
                        const double v = ex[j * NX + col];
                        if (std::isnan(v)) { run = 0; continue; }
                        if (std::abs(v - lo) < std::abs(v - li)) { if (++run == 2) { yb = j + 1; break; } } else run = 0;
                    }
                    if (yb < 0) { prof[k] = 1e9; continue; }  // never closed within the band above the box: an open strip, not a head
                    const double py = gy0 + (gy1 - gy0) * (yb + 0.5) / NY;  // pixels below the box top (negative above)
                    prof[k] = -py * pix;
                    ++found;
                }
                if (found < 12) continue;
                // a head closes: every column's boundary found below the band's top, and the wall right above the box's outer
                // columns (two each side within headEdgeM of the box top); a dark strip running on up does neither
                bool open = false; for (double x : prof) if (x >= 1e8) open = true;
                if (open) continue;
                if (std::max(std::abs(prof[0]), std::abs(prof[1])) > S.P.headEdgeM || std::max(std::abs(prof[NS - 1]), std::abs(prof[NS - 2])) > S.P.headEdgeM) continue;
                // fill gaps from neighbours, smooth (median of three)
                for (int k = 0; k < NS; ++k) if (std::isnan(prof[k])) { double a2 = NAN, b2 = NAN; for (int d = 1; d < NS && (std::isnan(a2) && std::isnan(b2)); ++d) { if (k - d >= 0) a2 = prof[k - d]; if (k + d < NS) b2 = prof[k + d]; } prof[k] = std::isnan(a2) ? b2 : std::isnan(b2) ? a2 : (a2 + b2) / 2; }
                std::vector<double> sm(NS);
                for (int k = 0; k < NS; ++k) { double a2 = prof[std::max(0, k - 1)], b2 = prof[k], c2 = prof[std::min(NS - 1, k + 1)]; sm[k] = std::max(std::min(a2, b2), std::min(std::max(a2, b2), c2)); }
                const double lo2 = *std::min_element(sm.begin(), sm.end()), hi2 = *std::max_element(sm.begin(), sm.end());
                if (hi2 - lo2 < S.P.headMinM || hi2 > 0.8 * w * pix) continue;
                for (size_t m : members) out[m] = sm;
                ++rep.headTypes; rep.headWindows += members.size();
                rep.headRises.push_back(hi2 - lo2);
            }
        }
    }

    // --- windows onto faces: each plane's boxes onto the face it stands on
    struct Win { detail::R2 r; bool generated; std::vector<detail::R2> panes; int plane; std::vector<double> head; };
    std::vector<std::vector<Win>> faceWins(faces.size());
    for (const auto& [id, rects] : S.windows) rep.windowsGiven += rects.size();
    std::vector<int> ids;
    for (const auto& [id, rects] : S.windows) ids.push_back(id);
    std::sort(ids.begin(), ids.end(), [&](int a, int b) { const size_t na = S.windows.at(a).size(), nb = S.windows.at(b).size(); return na != nb ? na > nb : a < b; });
    for (int id : ids) {
        const auto& rects = S.windows.at(id);
        auto fit = frames.find(id);
        if (fit == frames.end()) { rep.droppedNoFrame += rects.size(); continue; }
        const PlaneFrame& f = *fit->second;
        if (std::abs(f.n.y) > 0.3) { rep.droppedNoWall += rects.size(); continue; }  // roofs and slopes: no punched openings
        const P3 fn = f.n * (1.0 / std::max(1e-9, sp::len(f.n)));
        std::vector<size_t> cand;
        for (size_t fi = 0; fi < faces.size(); ++fi) {
            const auto& w = faces[fi];
            if (sp::dot(fn, w.n) < S.P.normalDot) continue;
            if (std::abs(sp::dot(f.c - w.p0, w.n)) > S.P.planeTolM) continue;
            cand.push_back(fi);
        }
        const auto& panes = S.panes.count(id) ? S.panes.at(id) : std::vector<PixRect>{};
        for (const auto& r : rects) {
            const P3 p00 = planePoint(f, r.x0, r.y1), p11 = planePoint(f, r.x1, r.y0);
            bool placed = false, sawFace = false, clipped = false, overlapped = false, small = false;
            for (size_t fi : cand) {
                const auto& w = faces[fi];
                double a0 = sp::dot(p00 - w.p0, w.d), a1 = sp::dot(p11 - w.p0, w.d);
                double h0 = p00.y - S.groundY, h1 = p11.y - S.groundY;
                if (a0 > a1) std::swap(a0, a1);
                if (h0 > h1) std::swap(h0, h1);
                const double area = (a1 - a0) * (h1 - h0);
                const double c0 = std::max(a0, 0.05), c1 = std::min(a1, w.L - 0.05), g0 = std::max(h0, w.h0 + 0.05), g1 = std::min(h1, w.h1 - 0.05);
                if (c1 <= c0 || g1 <= g0) continue;
                sawFace = true;
                if ((c1 - c0) * (g1 - g0) < S.P.keepShare * area) { clipped = true; continue; }
                if (c1 - c0 < S.P.minWindowM || g1 - g0 < S.P.minWindowM) { small = true; continue; }
                detail::R2 box{c0, c1, g0, g1};
                // a wall's windows come from its best photo (the plane with the most windows comes first); another photo's
                // box fills only a span with no window of an earlier photo near it, so two photos' grids never interleave
                bool hit = false;
                for (const auto& o : faceWins[fi]) {
                    const bool overlap = std::min(o.r.a1, box.a1) - std::max(o.r.a0, box.a0) > 0.01 && std::min(o.r.h1, box.h1) - std::max(o.r.h0, box.h0) > 0.01;
                    const bool near = o.plane != id && box.a0 < o.r.a1 + S.P.fillGapM && box.a1 > o.r.a0 - S.P.fillGapM && box.h0 < o.r.h1 + S.P.fillReachM && box.h1 > o.r.h0 - S.P.fillReachM;
                    if (overlap || near) { hit = true; break; }
                }
                if (hit) { overlapped = true; continue; }
                std::vector<double> head;
                { auto hi = heads.find(id); const size_t ri = static_cast<size_t>(&r - &rects[0]); if (hi != heads.end() && ri < hi->second.size()) head = hi->second[ri]; }
                Win W{box, r.generated, {}, id, head};
                for (const auto& pr : panes) {
                    const double cx = (pr.x0 + pr.x1) / 2, cy = (pr.y0 + pr.y1) / 2;
                    if (cx < r.x0 || cx > r.x1 || cy < r.y0 || cy > r.y1) continue;
                    const P3 q00 = planePoint(f, pr.x0, pr.y1), q11 = planePoint(f, pr.x1, pr.y0);
                    double b0 = sp::dot(q00 - w.p0, w.d), b1 = sp::dot(q11 - w.p0, w.d), k0 = q00.y - S.groundY, k1 = q11.y - S.groundY;
                    if (b0 > b1) std::swap(b0, b1);
                    if (k0 > k1) std::swap(k0, k1);
                    b0 = std::max(b0, box.a0); b1 = std::min(b1, box.a1); k0 = std::max(k0, box.h0); k1 = std::min(k1, box.h1);
                    if (b1 - b0 < 0.05 || k1 - k0 < 0.05) continue;
                    bool ov = false;
                    for (const auto& q : W.panes) if (std::min(q.a1, b1) - std::max(q.a0, b0) > 0.005 && std::min(q.h1, k1) - std::max(q.h0, k0) > 0.005) { ov = true; break; }
                    if (!ov) W.panes.push_back({b0, b1, k0, k1});
                }
                faceWins[fi].push_back(W);
                placed = true;
                break;
            }
            if (placed) { ++rep.windowsPlaced; if (r.generated) ++rep.windowsGenerated; }
            else if (!sawFace) ++rep.droppedNoWall;
            else if (overlapped) ++rep.droppedOverlap;
            else if (clipped) ++rep.droppedClipped;
            else if (small) ++rep.droppedSmall;
            else ++rep.droppedNoWall;
        }
    }

    // --- one wall's window edges on shared lines: edges within snapAlongM (along) / snapUpM (up) take their cluster's median,
    // panes moved with their window; a window the snap made overlap another, or too small, is dropped (counted)
    auto snapValues = [](std::vector<double*>& vals, double tol) {
        std::sort(vals.begin(), vals.end(), [](const double* a, const double* b) { return *a < *b; });
        for (size_t i = 0; i < vals.size();) {
            size_t j = i + 1;
            while (j < vals.size() && *vals[j] - *vals[j - 1] <= tol) ++j;
            std::vector<double> c;
            for (size_t k = i; k < j; ++k) c.push_back(*vals[k]);
            std::nth_element(c.begin(), c.begin() + c.size() / 2, c.end());
            const double m = c[c.size() / 2];
            for (size_t k = i; k < j; ++k) *vals[k] = m;
            i = j;
        }
    };
    for (auto& wins : faceWins) {
        if (wins.size() < 2) continue;
        std::vector<detail::R2> before;
        for (const auto& W : wins) before.push_back(W.r);
        std::vector<double*> along, upv;
        for (auto& W : wins) { along.push_back(&W.r.a0); along.push_back(&W.r.a1); upv.push_back(&W.r.h0); upv.push_back(&W.r.h1); }
        snapValues(along, S.P.snapAlongM);
        snapValues(upv, S.P.snapUpM);
        std::vector<Win> kept;
        for (size_t i = 0; i < wins.size(); ++i) {
            auto W = wins[i];
            if (W.r.a1 - W.r.a0 < S.P.minWindowM || W.r.h1 - W.r.h0 < S.P.minWindowM) { ++rep.droppedSmall; --rep.windowsPlaced; continue; }
            bool ov = false;
            for (const auto& o : kept) if (std::min(o.r.a1, W.r.a1) - std::max(o.r.a0, W.r.a0) > 0.005 && std::min(o.r.h1, W.r.h1) - std::max(o.r.h0, W.r.h0) > 0.005) { ov = true; break; }
            if (ov) { ++rep.droppedOverlap; --rep.windowsPlaced; continue; }
            // panes: scaled with the window's snapped box, kept inside it
            const auto& b = before[i];
            const double sa = (W.r.a1 - W.r.a0) / std::max(1e-6, b.a1 - b.a0), sh = (W.r.h1 - W.r.h0) / std::max(1e-6, b.h1 - b.h0);
            for (auto& q : W.panes) {
                q = {W.r.a0 + (q.a0 - b.a0) * sa, W.r.a0 + (q.a1 - b.a0) * sa, W.r.h0 + (q.h0 - b.h0) * sh, W.r.h0 + (q.h1 - b.h0) * sh};
                q.a0 = std::max(q.a0, W.r.a0); q.a1 = std::min(q.a1, W.r.a1); q.h0 = std::max(q.h0, W.r.h0); q.h1 = std::min(q.h1, W.r.h1);
            }
            kept.push_back(W);
        }
        wins = kept;
    }

    // --- self-read (selfRead: no plane photos or window boxes from another stage). Each wall's own photo is rendered from
    // the scan's photo texture (selfTexelM texels: the nearest scan surface facing the same way within 1.5 m). Its windows
    // are found in it: the storey pitch (the best vertical autocorrelation of its luminance at 2.5 to 6 m, at least 0.3)
    // and the column pitch (the best horizontal one at 0.8 to 8 m, at least 0.2) fold the photo into one unit cell (the
    // median over its repeats); the cell's opening is its largest region darker than the midpoint of its 20th and 80th
    // percentiles (10 to 70% of the cell, at least 0.04 darker than the rest); every cell of the wall whose opening region
    // reads darker than the midpoint of opening and wall is a window. Photo-inferred; the storey pitch also serves the
    // wall's detail texture, read from this photo.
    struct SelfImg { int w{0}, h{0}; double pitch{0}; std::vector<float> rgb; };
    std::vector<SelfImg> selfImg(faces.size());
    if (S.P.selfRead && ph.ok) {
        const double t = S.P.selfTexelM;
        for (size_t fi = 0; fi < faces.size(); ++fi) {
            const auto& w = faces[fi];
            if (w.L < 4 || w.h1 - w.h0 < 4) continue;
            SelfImg I; I.w = static_cast<int>(std::ceil(w.L / t)); I.h = static_cast<int>(std::ceil((w.h1 - w.h0) / t));
            I.rgb.assign(static_cast<size_t>(I.w) * I.h * 3, -1.0f);
            std::vector<float> L(static_cast<size_t>(I.w) * I.h, NAN);
            size_t got = 0;
            for (int j = 0; j < I.h; ++j) for (int i = 0; i < I.w; ++i) {
                const double a = (i + 0.5) * t, hh = w.h1 - (j + 0.5) * t;
                Rgb c;
                if (!ph.sample(P3{w.p0.x + w.d.x * a, S.groundY + hh, w.p0.z + w.d.z * a}, w.n, 1.5, c)) continue;
                const size_t o = (static_cast<size_t>(j) * I.w + i);
                I.rgb[o * 3] = static_cast<float>(c.r); I.rgb[o * 3 + 1] = static_cast<float>(c.g); I.rgb[o * 3 + 2] = static_cast<float>(c.b);
                L[o] = static_cast<float>(0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b);
                ++got;
            }
            if (got * 2 < L.size()) continue;
            ++rep.selfWalls;
            auto corr = [&](int dx, int dy) {
                double sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0; size_t n = 0;
                for (int j = 0; j + dy < I.h; j += 2) for (int i = 0; i + dx < I.w; i += 2) {
                    const float x = L[static_cast<size_t>(j) * I.w + i], y = L[static_cast<size_t>(j + dy) * I.w + i + dx];
                    if (std::isnan(x) || std::isnan(y)) continue;
                    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; ++n;
                }
                if (n < 200) return -1.0;
                const double cov = sxy / n - sx / n * sy / n, vx = sxx / n - sx / n * sx / n, vy = syy / n - sy / n * sy / n;
                return vx > 1e-12 && vy > 1e-12 ? cov / std::sqrt(vx * vy) : -1.0;
            };
            int P = 0; double cP = 0.3;
            for (int k = static_cast<int>(std::round(2.5 / t)); k <= static_cast<int>(std::round(6.0 / t)) && k < I.h / 2; ++k) { const double c = corr(0, k); if (c > cP) { cP = c; P = k; } }
            int Q = 0; double cQ = 0.2;
            for (int k = static_cast<int>(std::round(0.8 / t)); k <= static_cast<int>(std::round(8.0 / t)) && k < I.w / 2; ++k) { const double c = corr(k, 0); if (c > cQ) { cQ = c; Q = k; } }
            I.pitch = P ? P * t : 0;
            if (!P || !Q) { selfImg[fi] = std::move(I); continue; }
            // the unit cell: the median over the wall's repeats
            std::vector<float> U(static_cast<size_t>(Q) * P, NAN);
            for (int cy = 0; cy < P; ++cy) for (int cx = 0; cx < Q; ++cx) {
                std::vector<float> v;
                for (int y = cy; y < I.h; y += P) for (int x = cx; x < I.w; x += Q) { const float l = L[static_cast<size_t>(y) * I.w + x]; if (!std::isnan(l)) v.push_back(l); }
                if (v.size() >= 3) { std::nth_element(v.begin(), v.begin() + v.size() / 2, v.end()); U[static_cast<size_t>(cy) * Q + cx] = v[v.size() / 2]; }
            }
            std::vector<float> uv; for (float x : U) if (!std::isnan(x)) uv.push_back(x);
            if (uv.size() < U.size() / 2) { selfImg[fi] = std::move(I); continue; }
            std::sort(uv.begin(), uv.end());
            const double thr = (uv[uv.size() / 5] + uv[uv.size() * 4 / 5]) / 2;
            // the largest dark region of the cell (4-connected)
            std::vector<int> lab(U.size(), -1); int bestLab = -1; size_t bestN = 0; int bx0 = 0, by0 = 0, bx1 = 0, by1 = 0;
            for (size_t k0 = 0; k0 < U.size(); ++k0) {
                if (lab[k0] >= 0 || !(U[k0] < thr)) continue;
                std::vector<size_t> q{k0}; lab[k0] = static_cast<int>(k0);
                int x0 = Q, y0 = P, x1 = -1, y1 = -1;
                for (size_t z = 0; z < q.size(); ++z) {
                    const int cx = static_cast<int>(q[z] % Q), cy = static_cast<int>(q[z] / Q);
                    x0 = std::min(x0, cx); x1 = std::max(x1, cx); y0 = std::min(y0, cy); y1 = std::max(y1, cy);
                    const int nb[4][2] = {{1, 0}, {-1, 0}, {0, 1}, {0, -1}};
                    for (const auto& d : nb) { const int nx = cx + d[0], ny = cy + d[1]; if (nx < 0 || ny < 0 || nx >= Q || ny >= P) continue; const size_t nk = static_cast<size_t>(ny) * Q + nx; if (lab[nk] < 0 && U[nk] < thr) { lab[nk] = static_cast<int>(k0); q.push_back(nk); } }
                }
                if (q.size() > bestN) { bestN = q.size(); bestLab = static_cast<int>(k0); bx0 = x0; by0 = y0; bx1 = x1 + 1; by1 = y1 + 1; }
            }
            const double share = static_cast<double>((bx1 - bx0) * (by1 - by0)) / U.size();
            if (bestLab < 0 || share < 0.1 || share > 0.7 || (bx1 - bx0) * t < 0.4 || (by1 - by0) * t < 0.6) { selfImg[fi] = std::move(I); continue; }
            double inS = 0, outS = 0; size_t inN = 0, outN = 0;
            for (int cy = 0; cy < P; ++cy) for (int cx = 0; cx < Q; ++cx) { const float u = U[static_cast<size_t>(cy) * Q + cx]; if (std::isnan(u)) continue; if (cx >= bx0 && cx < bx1 && cy >= by0 && cy < by1) { inS += u; ++inN; } else { outS += u; ++outN; } }
            if (!inN || !outN || outS / outN - inS / inN < 0.04) { selfImg[fi] = std::move(I); continue; }
            const double mid = (inS / inN + outS / outN) / 2;
            size_t placed = 0;
            for (int ry = 0; ry * P + by1 <= I.h; ++ry) for (int rx = 0; rx * Q + bx1 <= I.w; ++rx) {
                const int x0 = rx * Q + bx0, x1 = rx * Q + bx1, y0 = ry * P + by0, y1 = ry * P + by1;
                double sum = 0; size_t n = 0, all = 0;
                for (int y = y0; y < y1; ++y) for (int x = x0; x < x1; ++x) { ++all; const float l = L[static_cast<size_t>(y) * I.w + x]; if (!std::isnan(l)) { sum += l; ++n; } }
                if (n * 2 < all || sum / n >= mid) continue;
                detail::R2 box{x0 * t, x1 * t, w.h1 - y1 * t, w.h1 - y0 * t};
                box.a0 = std::max(box.a0, 0.05); box.a1 = std::min(box.a1, w.L - 0.05); box.h0 = std::max(box.h0, w.h0 + 0.05); box.h1 = std::min(box.h1, w.h1 - 0.05);
                if (box.a1 - box.a0 < S.P.minWindowM || box.h1 - box.h0 < S.P.minWindowM) continue;
                faceWins[fi].push_back(Win{box, false, {}, -2, {}});
                ++placed;
            }
            if (placed) { ++rep.selfWindowWalls; rep.selfWindows += placed; rep.windowsPlaced += placed; rep.windowsGiven += placed; }
            selfImg[fi] = std::move(I);
        }
    }

    // --- one storey phase per wall: the windows' bottoms taken modulo the wall's storey pitch fall in phase groups; when
    // two groups each hold at least a fifth of the wall's windows (a reading that put neighbouring columns half a storey
    // apart), the group whose boxes hold the more fine detail in the photo (glazing: sashes, blinds, reflections; a
    // spandrel panel is smooth) keeps its phase and the other's windows move to the nearest row of it. Counted; their
    // positions are then the wall's rhythm, not their own reading.
    for (size_t fi = 0; fi < faces.size() && ph.ok; ++fi) {
        auto& wins = faceWins[fi];
        if (wins.size() < 8) continue;
        const auto& w = faces[fi];
        auto at = [&](double a, double h) { return P3{w.p0.x + w.d.x * a, S.groundY + h, w.p0.z + w.d.z * a}; };
        // the pitch: the commonest step between windows stacked in one column
        std::map<long, std::vector<double>> cols;
        for (const auto& W : wins) cols[std::lround(W.r.a0 * 20)].push_back(W.r.h0);
        std::vector<double> steps;
        for (auto& [k, v] : cols) { std::sort(v.begin(), v.end()); for (size_t i = 1; i < v.size(); ++i) { const double st = v[i] - v[i - 1]; if (st > 1.5 && st < 6.0) steps.push_back(st); } }
        if (steps.size() < 6) continue;
        std::nth_element(steps.begin(), steps.begin() + steps.size() / 2, steps.end());
        const double P = steps[steps.size() / 2];
        // phase groups (circular, within a quarter of a metre)
        auto phaseOf = [&](double h) { double f = std::fmod(h, P); return f < 0 ? f + P : f; };
        std::vector<double> ph0;
        for (const auto& W : wins) ph0.push_back(phaseOf(W.r.h0));
        std::vector<double> sorted = ph0;
        std::sort(sorted.begin(), sorted.end());
        struct Group { double centre; size_t n; };
        std::vector<Group> groups;
        for (size_t i = 0; i < sorted.size();) {
            size_t j = i + 1;
            while (j < sorted.size() && sorted[j] - sorted[j - 1] <= 0.25) ++j;
            groups.push_back({sorted[i + (j - i) / 2], j - i});
            i = j;
        }
        if (groups.size() >= 2 && groups.front().centre + P - groups.back().centre <= 0.25) { groups.front().n += groups.back().n; groups.pop_back(); }
        std::sort(groups.begin(), groups.end(), [](const Group& a, const Group& b) { return a.n > b.n; });
        if (groups.size() < 2 || groups[1].n * 5 < wins.size()) continue;
        auto wrapDiff = [&](double a, double b) { double d = std::fmod(a - b, P); if (d > P / 2) d -= P; if (d < -P / 2) d += P; return d; };
        auto member = [&](double phase, const Group& g) { return std::abs(wrapDiff(phase, g.centre)) <= 0.3; };
        // the photo's fine detail inside each group's boxes
        double detail[2] = {0, 0}; int cnt[2] = {0, 0};
        for (size_t i = 0; i < wins.size(); ++i) for (int g = 0; g < 2; ++g) if (member(ph0[i], groups[g]) && cnt[g] < 80) {
            double m, sd;
            const auto& r = wins[i].r;
            if (patchLumStats(ph, at(r.a0, r.h0), w.d * (r.a1 - r.a0), P3{0, r.h1 - r.h0, 0}, w.n, S.P.sampleRadiusM, m, sd)) { detail[g] += sd / std::max(0.02, m); ++cnt[g]; }
        }
        if (!cnt[0] || !cnt[1]) continue;
        const int keep = detail[0] / cnt[0] >= detail[1] / cnt[1] ? 0 : 1;
        const Group& K = groups[keep];
        std::vector<Win> out2;
        size_t moved = 0;
        for (size_t i = 0; i < wins.size(); ++i) {
            Win W = wins[i];
            if (!member(ph0[i], K)) {
                const double d = -wrapDiff(ph0[i], K.centre);
                W.r.h0 += d; W.r.h1 += d;
                for (auto& q : W.panes) { q.h0 += d; q.h1 += d; }
                if (W.r.h0 < w.h0 + 0.05 || W.r.h1 > w.h1 - 0.05) { --rep.windowsPlaced; ++rep.droppedClipped; continue; }
                W.generated = true;
                ++moved;
            }
            bool ov = false;
            for (const auto& o : out2) if (std::min(o.r.a1, W.r.a1) - std::max(o.r.a0, W.r.a0) > 0.005 && std::min(o.r.h1, W.r.h1) - std::max(o.r.h0, W.r.h0) > 0.005) { ov = true; break; }
            if (ov) { --rep.windowsPlaced; ++rep.droppedOverlap; continue; }
            out2.push_back(W);
        }
        rep.windowsRephased += moved;
        rep.windowsGenerated += moved;
        if (moved) ++rep.wallsRephased;
        wins = out2;
    }

    // --- rows continued into the spans no photo reading covered: on a wall with enough windows, each row (windows sharing
    // a snapped bottom and top) steps on at the wall's own window pitch from its nearest window; a candidate box is kept
    // when the photo inside it lies within continueMaxDeltaE of the wall's windows and nearer them than the wall's own
    // median colour (it looks like a window, not like the stone beside it). Generated, counted.
    for (size_t fi = 0; fi < faces.size(); ++fi) {
        auto& wins = faceWins[fi];
        if (static_cast<int>(wins.size()) < S.P.continueMinWindows || !ph.ok) continue;
        const auto& w = faces[fi];
        auto at = [&](double a, double h) { return P3{w.p0.x + w.d.x * a, S.groundY + h, w.p0.z + w.d.z * a}; };
        auto inside = [&](const detail::R2& r, Rgb& c) { return patchColour(ph, at(r.a0, r.h0), w.d * (r.a1 - r.a0), P3{0, r.h1 - r.h0, 0}, w.n, S.P.sampleRadiusM, c, 3); };
        // the wall's windows' photo, and the wall's own median colour
        std::vector<double> ir, ig, ib;
        for (size_t i = 0; i < wins.size(); i += std::max<size_t>(1, wins.size() / 60)) { Rgb c; if (inside(wins[i].r, c)) { ir.push_back(c.r); ig.push_back(c.g); ib.push_back(c.b); } }
        Rgb wallC;
        if (ir.size() < 3 || !patchColour(ph, at(0, w.h0), w.d * w.L, P3{0, w.h1 - w.h0, 0}, w.n, S.P.sampleRadiusM, wallC, 8)) continue;
        auto med = [](std::vector<double>& v) { std::nth_element(v.begin(), v.begin() + v.size() / 2, v.end()); return v[v.size() / 2]; };
        const auto refIn = labOf(Rgb{med(ir), med(ig), med(ib)}), refWall = labOf(wallC);
        auto dE = [](const std::array<double, 3>& a, const std::array<double, 3>& b) { return std::sqrt((a[0] - b[0]) * (a[0] - b[0]) + (a[1] - b[1]) * (a[1] - b[1]) + (a[2] - b[2]) * (a[2] - b[2])); };
        if (dE(refIn, refWall) < 6) continue;  // the windows read no different from the wall: nothing to tell them apart by
        // rows, and the pitch: the commonest step between neighbouring windows of a row
        std::map<std::pair<long, long>, std::vector<detail::R2>> rows;
        for (const auto& W : wins) rows[{std::lround(W.r.h0 * 100), std::lround(W.r.h1 * 100)}].push_back(W.r);
        std::vector<double> steps, widths;
        for (auto& [k, v] : rows) {
            std::sort(v.begin(), v.end(), [](const detail::R2& a, const detail::R2& b) { return a.a0 < b.a0; });
            for (size_t i = 0; i < v.size(); ++i) { widths.push_back(v[i].a1 - v[i].a0); if (i) steps.push_back(v[i].a0 - v[i - 1].a0); }
        }
        if (steps.size() < 3) continue;
        const double width = med(widths);
        std::vector<double> small;
        for (double st : steps) if (st > width * 1.05 && st < width * 2.5) small.push_back(st);
        if (small.size() < 3) continue;
        const double pitch = med(small);
        std::vector<Win> added;
        for (auto& [k, v] : rows) {
            if (v.size() < 2) continue;
            const double h0 = v.front().h0, h1 = v.front().h1;
            // candidates both ways from every window of the row, at the pitch, until a window or the wall's end
            for (const auto& anchor : v) for (int dir : {-1, 1}) {
                for (int step = 1; step < 400; ++step) {
                    const double a0 = anchor.a0 + dir * step * pitch, a1 = a0 + (anchor.a1 - anchor.a0);
                    if (a0 < 0.05 || a1 > w.L - 0.05) break;
                    const detail::R2 box{a0, a1, h0, h1};
                    auto clash = [&](const detail::R2& o) { return std::min(o.a1, box.a1) - std::max(o.a0, box.a0) > -0.05 && std::min(o.h1, box.h1) - std::max(o.h0, box.h0) > 0.005; };
                    bool hit = false;
                    for (const auto& o : wins) if (clash(o.r)) { hit = true; break; }
                    if (hit) break;  // reached a read window: this direction is done
                    bool dup = false;
                    for (const auto& o : added) if (clash(o.r)) { dup = true; break; }
                    if (dup) continue;
                    ++rep.continueTested;
                    Rgb c;
                    if (!inside(box, c)) continue;
                    const auto L = labOf(c);
                    const double toWin = dE(L, refIn), toWall = dE(L, refWall);
                    if (toWin <= S.P.continueMaxDeltaE && toWin < toWall) added.push_back(Win{box, true, {}, -1, {}});
                }
            }
        }
        for (auto& W : added) { wins.push_back(W); ++rep.windowsContinued; ++rep.windowsPlaced; ++rep.windowsGenerated; }
    }

    // --- detail textures: a wall with windows from a photographed plane and a storey pitch gets one (FaceTex)
    std::vector<FaceTex> faceTex(faces.size());
    std::vector<double> facePitch(faces.size(), 0);
    int facesUsedH = 0;
    std::vector<int> facePlane(faces.size(), -1);
    if (S.P.detail) {
        for (size_t fi = 0; fi < faces.size(); ++fi) {
            const auto& wins = faceWins[fi];
            // a self-read wall: its own photo and the storey pitch read from it
            if (S.P.selfRead) { if (selfImg[fi].w && selfImg[fi].pitch > 0) { facePitch[fi] = selfImg[fi].pitch; facePlane[fi] = -2; } continue; }
            if (wins.size() < 4) continue;
            std::map<int, int> votes;
            for (const auto& W : wins) if (W.plane >= 0) ++votes[W.plane];
            int best = -1, bn = 0;
            for (const auto& [id, n] : votes) if (n > bn && frames.count(id) && photoOf(id).ok) { best = id; bn = n; }
            if (best < 0) continue;
            std::map<long, std::vector<double>> cols;
            for (const auto& W : wins) cols[std::lround(W.r.a0 * 20)].push_back(W.r.h0);
            std::vector<double> steps;
            for (auto& [k, v] : cols) { std::sort(v.begin(), v.end()); for (size_t i = 1; i < v.size(); ++i) { const double st = v[i] - v[i - 1]; if (st > 1.5 && st < 6.0) steps.push_back(st); } }
            if (steps.size() < 3) continue;
            std::nth_element(steps.begin(), steps.begin() + steps.size() / 2, steps.end());
            facePitch[fi] = steps[steps.size() / 2];
            facePlane[fi] = best;
        }
        // the texel: enlarged until every textured wall fits the atlas (shelves, tallest first), half of it at most: the
        // other half holds the palette of every other element's colour
        double texel = S.P.detailTexelM;
        const int A = S.P.detailAtlas;
        for (int attempt = 0; attempt < 12; ++attempt, texel *= 1.15) {
            std::vector<size_t> order;
            for (size_t fi = 0; fi < faces.size(); ++fi) if (facePlane[fi] != -1) {
                faceTex[fi].w = std::max(1, static_cast<int>(std::ceil(faces[fi].L / texel)));
                faceTex[fi].h = std::max(1, static_cast<int>(std::ceil((faces[fi].h1 - faces[fi].h0) / texel)));
                order.push_back(fi);
            }
            std::sort(order.begin(), order.end(), [&](size_t a, size_t b) { return faceTex[a].h > faceTex[b].h; });
            int x = 0, y = 0, shelf = 0; bool fits = true;
            for (size_t fi : order) {
                auto& t = faceTex[fi];
                if (t.w + 2 > A || t.h + 2 > A) { fits = false; break; }
                if (x + t.w + 2 > A) { x = 0; y += shelf; shelf = 0; }
                if (y + t.h + 2 > A / 2) { fits = false; break; }
                t.ax = x + 1; t.ay = y + 1; x += t.w + 2; shelf = std::max(shelf, t.h + 2);
            }
            if (fits) { rep.detailTexelM = texel; rep.atlasW = A; facesUsedH = ((y + shelf + 3) / 4) * 4; break; }
        }
        if (rep.atlasW) {
            for (size_t fi = 0; fi < faces.size(); ++fi) {
                if (facePlane[fi] == -1) continue;
                auto& t = faceTex[fi];
                const auto& w = faces[fi];
                const bool self = facePlane[fi] == -2;
                static const PlaneFrame noFrame{};
                static const Photo noPhoto{};
                const PlaneFrame& f = self ? noFrame : *frames.at(facePlane[fi]);
                const Photo& P = self ? noPhoto : photoOf(facePlane[fi]);
                const SelfImg& SI = selfImg[fi];
                t.texel = rep.detailTexelM; t.h0 = w.h0; t.h1 = w.h0 + t.h * t.texel;
                t.M.assign(static_cast<size_t>(t.w) * t.h * 3, -1.0f);
                const double Pp = facePitch[fi];
                const P3 fs = f.s, ft = f.t;
                auto texelAt = [&](double a, double h, Rgb& c) {
                    if (self) {
                        const int i = static_cast<int>(a / S.P.selfTexelM), j = static_cast<int>((w.h1 - h) / S.P.selfTexelM);
                        if (i < 0 || j < 0 || i >= SI.w || j >= SI.h) return false;
                        const size_t o = (static_cast<size_t>(j) * SI.w + i) * 3;
                        if (SI.rgb[o] < 0) return false;
                        c = {SI.rgb[o], SI.rgb[o + 1], SI.rgb[o + 2]};
                        return true;
                    }
                    const P3 q{w.p0.x + w.d.x * a, S.groundY + h, w.p0.z + w.d.z * a};
                    const double ss = sp::dot(q - f.c, fs), tt = sp::dot(q - f.c, ft);
                    const int px = static_cast<int>(std::floor((ss - f.sMin) / f.pixel)), py = static_cast<int>(std::floor((f.tMax - tt) / f.pixel));
                    if (px < 0 || py < 0 || px >= P.rgb.width || py >= P.rgb.height) return false;
                    if (!P.mask.empty() && P.mask.data[P.mask.getIndex(px, py)] > 127) return false;
                    const size_t o = P.rgb.getIndex(px, py);
                    c = {srgbToLinear(P.rgb.data[o] / 255.0), srgbToLinear(P.rgb.data[o + 1] / 255.0), srgbToLinear(P.rgb.data[o + 2] / 255.0)};
                    return true;
                };
                std::vector<double> vr, vg, vb;
                for (int j = 0; j < t.h; ++j) for (int i = 0; i < t.w; ++i) {
                    const double a = (i + 0.5) * t.texel, h = t.h1 - (j + 0.5) * t.texel;
                    vr.clear(); vg.clear(); vb.clear();
                    for (int k = -S.P.detailRepeats; k <= S.P.detailRepeats; ++k) {
                        const double hk = h + k * Pp;
                        if (hk < w.h0 || hk > w.h1) continue;
                        Rgb c;
                        if (texelAt(a, hk, c)) { vr.push_back(c.r); vg.push_back(c.g); vb.push_back(c.b); }
                    }
                    if (vr.size() < 3) continue;
                    auto med = [](std::vector<double>& v) { std::nth_element(v.begin(), v.begin() + v.size() / 2, v.end()); return v[v.size() / 2]; };
                    const size_t o = (static_cast<size_t>(j) * t.w + i) * 3;
                    t.M[o] = static_cast<float>(med(vr)); t.M[o + 1] = static_cast<float>(med(vg)); t.M[o + 2] = static_cast<float>(med(vb));
                    ++rep.texelsDetail;
                }
                t.ok = true;
                ++rep.facesTextured;
            }
        }
    }
    E.groundY = S.groundY;
    E.texOffset = static_cast<int>(classes.size()) + 1;
    E.atlasW = S.P.detailAtlas;
    E.paletteY0 = facesUsedH;

    // --- emit walls (cells), windows (reveals, panes, frames)
    const double D = S.revealM;
    for (size_t fi = 0; fi < faces.size(); ++fi) {
        const auto& w = faces[fi];
        auto at = [&](double a, double h, double off) { return P3{w.p0.x + w.d.x * a - w.n.x * off, S.groundY + h, w.p0.z + w.d.z * a - w.n.z * off}; };
        FaceTex* T = faceTex[fi].ok ? &faceTex[fi] : nullptr;
        E.tex = T; E.texP0 = w.p0; E.texD = w.d;
        auto tint = [&](double a0, double a1, double h0, double h1, const Rgb& c) { if (T) T->tints.push_back({a0, a1, h0, h1, c}); };
        // a window with a traced head: its opening runs up to the head's curve (the box top moved to the curve's lowest
        // point, the curve's patch above it cut out of the wall and drawn below), when the patch stays clear of the wall's
        // top and of every other window
        std::vector<double> headTop(faceWins[fi].size(), NAN), headBase(faceWins[fi].size(), NAN);
        for (size_t wi = 0; wi < faceWins[fi].size(); ++wi) {
            const auto& W = faceWins[fi][wi];
            if (W.head.size() < 2) continue;
            const double lo = *std::min_element(W.head.begin(), W.head.end()), hi = *std::max_element(W.head.begin(), W.head.end());
            const double base = W.r.h1 + lo, top = W.r.h1 + hi;
            if (top > w.h1 - 0.05 || base < W.r.h0 + 0.3) continue;
            bool clash = false;
            for (size_t wj = 0; wj < faceWins[fi].size() && !clash; ++wj) if (wj != wi) { const auto& o = faceWins[fi][wj].r; clash = std::min(o.a1, W.r.a1) - std::max(o.a0, W.r.a0) > 0.01 && std::min(o.h1, top) - std::max(o.h0, W.r.h1) > 0.01; }
            if (clash) continue;
            headTop[wi] = top; headBase[wi] = base;
        }
        std::vector<detail::R2> holes;
        for (size_t wi = 0; wi < faceWins[fi].size(); ++wi) { auto r = faceWins[fi][wi].r; if (!std::isnan(headTop[wi])) r.h1 = headTop[wi]; holes.push_back(r); }
        if (!holes.empty()) ++rep.facesWithWindows;
        // the face's median colour, the fallback for any cell the photo misses
        Rgb faceFallback = classColour(0);
        {
            bool got;
            const Rgb c = colourOf(at(0, w.h0, 0), w.d * w.L, P3{0, w.h1 - w.h0, 0}, w.n, classColour(0), got);
            if (got) faceFallback = c;
        }
        // cells split at the windows' column lines too, so a pier and the band between a column's windows are cells of their own
        std::vector<double> colLines;
        for (const auto& hl : holes) { colLines.push_back(hl.a0); colLines.push_back(hl.a1); }
        std::sort(colLines.begin(), colLines.end());
        auto spans = [&](double lo, double hi, bool useLines) {
            std::vector<double> cut{lo};
            if (useLines) for (double x : colLines) if (x > cut.back() + 0.05 && x < hi - 0.05) cut.push_back(x);
            cut.push_back(hi);
            std::vector<std::pair<double, double>> out2;
            for (size_t k = 0; k + 1 < cut.size(); ++k) {
                const int n = std::max(1, static_cast<int>(std::ceil((cut[k + 1] - cut[k]) / S.P.cellM)));
                for (int i = 0; i < n; ++i) out2.push_back({cut[k] + (cut[k + 1] - cut[k]) * i / n, cut[k] + (cut[k + 1] - cut[k]) * (i + 1) / n});
            }
            return out2;
        };
        for (const auto& piece : detail::subtractHoles({0, w.L, w.h0, w.h1}, holes)) {
            const auto as = spans(piece.a0, piece.a1, true), hs = spans(piece.h0, piece.h1, false);
            for (const auto& [h0, h1] : hs) for (const auto& [a0, a1] : as) {
                bool got;
                const Rgb c = colourOf(at(a0, h0, 0), w.d * (a1 - a0), P3{0, h1 - h0, 0}, w.n, faceFallback, got);
                const int m = E.classOf(c);
                ++rep.classUse[m];
                E.quad(massing, m, at(a0, h0, 0), at(a1, h0, 0), at(a1, h1, 0), at(a0, h1, 0), w.n, c, w.d, P3{0, -1, 0});
                tint(a0, a1, h0, h1, c);
                ++rep.wallCells;
            }
        }
        for (size_t wi = 0; wi < faceWins[fi].size(); ++wi) {
            const auto& W = faceWins[fi][wi];
            const bool headed = !std::isnan(headTop[wi]);
            detail::R2 r = W.r;
            if (headed) r.h1 = headBase[wi];
            // reveals: the wall's colour just around the opening
            bool got;
            const Rgb ring = colourOf(at(r.a0 - 0.15, r.h0 - 0.15, 0), w.d * (r.a1 - r.a0 + 0.3), P3{0, r.h1 - r.h0 + 0.3, 0}, w.n, faceFallback, got);
            const int rm = E.classOf(ring);
            tint(r.a0, r.a1, r.h0, r.h1, ring);  // the opening's frame colour below, then each pane's, are laid over this
            const P3 inL = w.d, inR = w.d * -1.0, inB = up, inT = up * -1.0;
            E.quad(openings, rm, at(r.a0, r.h0, 0), at(r.a0, r.h1, 0), at(r.a0, r.h1, D), at(r.a0, r.h0, D), inL, ring, w.n, up);
            E.quad(openings, rm, at(r.a1, r.h1, 0), at(r.a1, r.h0, 0), at(r.a1, r.h0, D), at(r.a1, r.h1, D), inR, ring, w.n, up);
            E.quad(openings, rm, at(r.a1, r.h0, 0), at(r.a0, r.h0, 0), at(r.a0, r.h0, D), at(r.a1, r.h0, D), inB, ring, w.d, w.n);
            if (!headed) E.quad(openings, rm, at(r.a0, r.h1, 0), at(r.a1, r.h1, 0), at(r.a1, r.h1, D), at(r.a0, r.h1, D), inT, ring, w.d, w.n);
            if (headed) {
                // the head: strips across the window between its traced points, glass below the curve at the reveal's depth,
                // wall above it, a reveal along it and down its two ends
                const auto& hd = W.head;
                const int NS = static_cast<int>(hd.size());
                std::vector<std::pair<double, double>> curve{{r.a0, W.r.h1 + hd.front()}};
                for (int k = 0; k < NS; ++k) curve.push_back({r.a0 + (r.a1 - r.a0) * (k + 0.5) / NS, W.r.h1 + hd[k]});
                curve.push_back({r.a1, W.r.h1 + hd.back()});
                const double base = headBase[wi], top = headTop[wi];
                bool g2;
                const Rgb glassC = colourOf(at(r.a0, base, D), w.d * (r.a1 - r.a0), P3{0, top - base, 0}, w.n, Rgb{0.05, 0.06, 0.07}, g2);
                for (size_t k = 0; k + 1 < curve.size(); ++k) {
                    const double xa = curve[k].first, xb = curve[k + 1].first, ya = std::max(base, curve[k].second), yb = std::max(base, curve[k + 1].second);
                    if (xb - xa < 1e-4) continue;
                    if (std::max(ya, yb) > base + 1e-3) E.quad(openings, E.glassMat, at(xa, base, D), at(xb, base, D), at(xb, yb, D), at(xa, ya, D), w.n, glassC, w.d, P3{0, -1, 0});
                    if (top - std::min(ya, yb) > 1e-3) E.quad(openings, rm, at(xa, ya, 0), at(xb, yb, 0), at(xb, top, 0), at(xa, top, 0), w.n, ring, w.d, P3{0, -1, 0});
                    P3 nr = sp::cross(at(xb, yb, 0) - at(xa, ya, 0), w.n); const double L = sp::len(nr);
                    if (L > 1e-9) { nr = nr * (1 / L); if (nr.y > 0) nr = nr * -1.0; E.quad(openings, rm, at(xa, ya, 0), at(xb, yb, 0), at(xb, yb, D), at(xa, ya, D), nr, ring, w.d, w.n); }
                }
                const double yA = std::max(base, curve.front().second), yB = std::max(base, curve.back().second);
                if (yA > base + 1e-3) E.quad(openings, rm, at(r.a0, base, 0), at(r.a0, yA, 0), at(r.a0, yA, D), at(r.a0, base, D), inL, ring, w.n, up);
                if (yB > base + 1e-3) E.quad(openings, rm, at(r.a1, yB, 0), at(r.a1, base, 0), at(r.a1, base, D), at(r.a1, yB, D), inR, ring, w.n, up);
                ++rep.headsDrawn;
            }
            // panes (glass) and the frame between them, at the reveal's depth (inside the box below the head)
            std::vector<detail::R2> panesClipped;
            for (auto q : W.panes) { q.h1 = std::min(q.h1, r.h1); if (q.h1 - q.h0 > 0.05) panesClipped.push_back(q); }
            const std::vector<detail::R2> panes = panesClipped.empty() ? std::vector<detail::R2>{r} : panesClipped;
            std::vector<FaceTex::Tint> panesTint;
            for (const auto& p : panes) {
                const Rgb g = colourOf(at(p.a0, p.h0, D), w.d * (p.a1 - p.a0), P3{0, p.h1 - p.h0, 0}, w.n, Rgb{0.05, 0.06, 0.07}, got);
                panesTint.push_back({p.a0, p.a1, p.h0, p.h1, g});
                E.quad(openings, E.glassMat, at(p.a0, p.h0, D), at(p.a1, p.h0, D), at(p.a1, p.h1, D), at(p.a0, p.h1, D), w.n, g, w.d, P3{0, -1, 0});
                ++rep.panesPlaced;
            }
            if (!panesClipped.empty()) {
                const auto frame = detail::subtractHoles(r, panesClipped);
                if (!frame.empty()) {
                    // one colour for the frame: the photo over the whole opening's frame strips
                    std::vector<double> cr, cg, cb;
                    for (const auto& q : frame) { Rgb c; if (patchColour(ph, at(q.a0, q.h0, D), w.d * (q.a1 - q.a0), P3{0, q.h1 - q.h0, 0}, w.n, S.P.sampleRadiusM, c, 2)) { cr.push_back(c.r); cg.push_back(c.g); cb.push_back(c.b); } }
                    Rgb fc = ring;
                    if (!cr.empty()) { auto med = [](std::vector<double>& v) { std::nth_element(v.begin(), v.begin() + v.size() / 2, v.end()); return v[v.size() / 2]; }; fc = {med(cr), med(cg), med(cb)}; ++rep.colouredElements; } else ++rep.uncolouredElements;
                    const int fm = E.classOf(fc);
                    for (const auto& q : frame) E.quad(openings, fm, at(q.a0, q.h0, D), at(q.a1, q.h0, D), at(q.a1, q.h1, D), at(q.a0, q.h1, D), w.n, fc, w.d, P3{0, -1, 0});
                    tint(r.a0, r.a1, r.h0, r.h1, fc);
                }
            }
            for (const auto& pt : panesTint) tint(pt.a0, pt.a1, pt.h0, pt.h1, pt.c);
        }
    }
    E.tex = nullptr;


    // --- ledge profiles. A lip, cornice or parapet is far below the scan's resolution in any one place, but it is the same
    // profile all along its wall: every scan sample within a band around the tier top (4 m below to 3 m above, 1.5 m in and
    // out of the wall) is projected onto the wall's section plane, and per 0.1 m of height the outermost surface (the 90th
    // percentile of the samples' offset) is the stacked profile. Consecutive bins within 6 cm are one step; a step counts
    // when it stands profileMinOutM to profileMaxOutM out of the wall and its samples run along at least profileCoverage
    // of the wall (0.5 m bins). Above the tier top, a parapet: samples rising out of the roof within a metre of the wall,
    // whose density stops below 3 m (an upper tier's wall standing flush would not stop). Each is swept along the wall, its
    // ends mitred at convex corners and drawn back at concave ones. Measured (stacked scan); the colour is the photo's.
    if (S.P.edgeProfiles && S.P.scanDetailM <= 0 && S.P.reliefM <= 0 && R.building.size()) {
        // dense samples of the building's surface, in the tile frame, on a 2 m grid
        std::vector<P3> dense;
        {
            std::mt19937 rng(11);
            std::uniform_real_distribution<double> U(0, 1);
            for (size_t ti = 0; ti < R.building.size(); ++ti) {
                const P3 a = R.building.p[3 * ti], b = R.building.p[3 * ti + 1], c = R.building.p[3 * ti + 2];
                const double area = sp::len(sp::cross(b - a, c - a)) / 2;
                const int n = std::max(1, static_cast<int>(std::ceil(area * S.P.profileDensity)));
                for (int k = 0; k < n; ++k) {
                    double r1 = U(rng), r2 = U(rng); if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; }
                    const P3 q = a + (b - a) * r1 + (c - a) * r2;
                    double x, z; F.toXZ(q.x, q.z, x, z);
                    dense.push_back({x, q.y, z});  // y: height above the street
                }
            }
        }
        const double cell = 2.0;
        std::unordered_map<uint64_t, std::vector<uint32_t>> grid;
        auto gkey = [&](double x, double z) { return (static_cast<uint64_t>(static_cast<uint32_t>(static_cast<int32_t>(std::floor(x / cell)))) << 32) | static_cast<uint32_t>(static_cast<int32_t>(std::floor(z / cell))); };
        for (uint32_t i = 0; i < dense.size(); ++i) grid[gkey(dense[i].x, dense[i].z)].push_back(i);
        const double bin = S.P.profileBinM, below = 4.0, above = 3.0, inM = 1.5;
        std::vector<double> outs, paras;
        for (size_t fi = 0; fi < faces.size(); ++fi) {
            const auto& w = faces[fi];
            if (w.L < 3.0) continue;
            const double a0 = 0.5, a1 = w.L - 0.5;
            const int nb = static_cast<int>(std::ceil((below + above) / bin));
            const double hb0 = w.h1 - below;
            const int na = std::max(1, static_cast<int>(std::ceil((a1 - a0) / 0.5)));
            std::vector<std::vector<double>> offs(nb);
            std::vector<std::vector<int>> alongOf(nb);
            // the samples near the wall's band
            const double minx = std::min(w.p0.x, w.p0.x + w.d.x * w.L) - 2, maxx = std::max(w.p0.x, w.p0.x + w.d.x * w.L) + 2;
            const double minz = std::min(w.p0.z, w.p0.z + w.d.z * w.L) - 2, maxz = std::max(w.p0.z, w.p0.z + w.d.z * w.L) + 2;
            for (double gx = std::floor(minx / cell) * cell; gx <= maxx; gx += cell) for (double gz = std::floor(minz / cell) * cell; gz <= maxz; gz += cell) {
                auto it = grid.find(gkey(gx + 0.5 * cell, gz + 0.5 * cell));
                if (it == grid.end()) continue;
                for (uint32_t i : it->second) {
                    const P3& q = dense[i];
                    const double rx = q.x - w.p0.x, rz = q.z - w.p0.z;
                    const double a = rx * w.d.x + rz * w.d.z, o = rx * w.n.x + rz * w.n.z;
                    if (a < a0 || a > a1 || o < -inM || o > S.P.profileMaxOutM + 0.2) continue;
                    const int k = static_cast<int>(std::floor((q.y - hb0) / bin));
                    if (k < 0 || k >= nb) continue;
                    offs[k].push_back(o);
                    alongOf[k].push_back(static_cast<int>(std::floor((a - a0) / 0.5)));
                }
            }
            ++rep.profileWalls;
            // per bin: the outermost surface, and how much of the wall's length it covers
            std::vector<double> out90(nb, NAN), cover(nb, 0);
            for (int k = 0; k < nb; ++k) {
                if (offs[k].size() < 8) continue;
                std::vector<double> v = offs[k];
                std::nth_element(v.begin(), v.begin() + static_cast<long>(0.9 * (v.size() - 1)), v.end());
                const double o90 = v[static_cast<size_t>(0.9 * (v.size() - 1))];
                out90[k] = o90;
                std::vector<uint8_t> hit(na, 0);
                for (size_t j = 0; j < offs[k].size(); ++j) if (offs[k][j] > o90 - 0.1 && alongOf[k][j] >= 0 && alongOf[k][j] < na) hit[alongOf[k][j]] = 1;
                cover[k] = std::accumulate(hit.begin(), hit.end(), 0.0) / na;
            }
            // lips: the bins up to the tier top standing out of the wall, merged into steps
            struct Step { double h0, h1, out; };
            std::vector<Step> steps;
            const int kTop = static_cast<int>(std::floor(below / bin));
            for (int k = 0; k < kTop; ++k) {
                const double o = out90[k];
                const bool ok = std::isfinite(o) && o >= S.P.profileMinOutM && o <= S.P.profileMaxOutM && cover[k] >= S.P.profileCoverage;
                if (!ok) continue;
                const double h0 = hb0 + k * bin, h1 = h0 + bin;
                if (!steps.empty() && std::abs(steps.back().h1 - h0) < 1e-6 && std::abs(steps.back().out - o) < 0.06) { steps.back().h1 = h1; steps.back().out = (steps.back().out + o) / 2; }
                else steps.push_back({h0, h1, o});
            }
            // a step must be at least two bins tall (one bin is noise)
            steps.erase(std::remove_if(steps.begin(), steps.end(), [&](const Step& st) { return st.h1 - st.h0 < 2 * bin - 1e-6; }), steps.end());
            // the parapet: above the top, samples within a metre of the wall plane, stopping below 3 m
            double paraTop = -1, paraIn = 0, paraOut = 0;
            {
                std::vector<double> hs, os;
                int dense0 = 0, dense1 = 0;
                for (int k = kTop; k < nb; ++k) for (double o : offs[k]) if (o > -1.0 && o < 0.6) {
                    const double h = hb0 + (k + 0.5) * bin;
                    if (h < w.h1 + 2.5) { hs.push_back(h); os.push_back(o); ++dense0; } else ++dense1;
                }
                // coverage along the wall in the parapet band
                std::vector<uint8_t> hit(na, 0);
                for (int k = kTop; k < nb && hb0 + k * bin < w.h1 + 2.5; ++k) for (size_t j = 0; j < offs[k].size(); ++j) if (offs[k][j] > -1.0 && offs[k][j] < 0.6 && hb0 + (k + 0.5) * bin > w.h1 + 0.3) { const int ai = alongOf[k][j]; if (ai >= 0 && ai < na) hit[ai] = 1; }
                const double cov = std::accumulate(hit.begin(), hit.end(), 0.0) / na;
                if (hs.size() > 40 && dense1 * 5 < dense0 && cov >= S.P.profileCoverage) {
                    std::vector<double> h2 = hs;
                    std::nth_element(h2.begin(), h2.begin() + static_cast<long>(0.95 * (h2.size() - 1)), h2.end());
                    const double top = h2[static_cast<size_t>(0.95 * (h2.size() - 1))];
                    std::vector<double> o2 = os;
                    std::sort(o2.begin(), o2.end());
                    paraIn = o2[static_cast<size_t>(0.05 * (o2.size() - 1))];
                    paraOut = std::max(0.0, o2[static_cast<size_t>(0.95 * (o2.size() - 1))]);
                    if (top - w.h1 >= 0.4) { paraTop = top; paraIn = std::min(paraIn, paraOut - 0.2); }
                }
            }
            if (steps.empty() && paraTop < 0) continue;
            // the sweep: a box per step (front at its offset, top and bottom back to the wall), the parapet a box above
            // the top from its inner to its outer face; ends mitred by the offset at convex corners, drawn back at concave
            auto at = [&](double a, double h, double o) { return P3{w.p0.x + w.d.x * a + w.n.x * o, S.groundY + h, w.p0.z + w.d.z * a + w.n.z * o}; };
            auto endA = [&](double o, bool start) { const bool cv = start ? w.cvx0 : w.cvx1; const double e = cv ? o : -o; return start ? -e : w.L + e; };
            auto box = [&](double h0, double h1, double oIn, double oOut) {
                const double sIn = endA(oIn, true), eIn = endA(oIn, false), sOut = endA(oOut, true), eOut = endA(oOut, false);
                bool got;
                const Rgb c = colourOf(at(0, h0, oOut + 0.05), w.d * w.L, P3{0, h1 - h0, 0}, w.n, classColour(0), got);
                const int m = E.classOf(c);
                const P3 up{0, 1, 0};
                E.quad(ledges, m, at(sOut, h0, oOut), at(eOut, h0, oOut), at(eOut, h1, oOut), at(sOut, h1, oOut), w.n, c, w.d, up);           // front
                E.quad(ledges, m, at(sIn, h1, oIn), at(eIn, h1, oIn), at(eOut, h1, oOut), at(sOut, h1, oOut), up, c, w.d, w.n);               // top
                E.quad(ledges, m, at(sIn, h0, oIn), at(sOut, h0, oOut), at(eOut, h0, oOut), at(eIn, h0, oIn), up * -1.0, c, w.d, w.n);         // underside
                if (oIn < -0.01) E.quad(ledges, m, at(sIn, h0, oIn), at(sIn, h1, oIn), at(eIn, h1, oIn), at(eIn, h0, oIn), w.n * -1.0, c, w.d, up);  // inner face
            };
            for (const auto& st : steps) { box(st.h0, st.h1, 0.0, st.out); outs.push_back(st.out); ++rep.profileSteps; }
            if (!steps.empty()) ++rep.profileLips;
            if (paraTop > 0) { box(w.h1, paraTop, paraIn, std::max(paraOut, 0.0)); paras.push_back(paraTop - w.h1); ++rep.profileParapets; }
        }
        auto med = [](std::vector<double> v) { if (v.empty()) return 0.0; std::nth_element(v.begin(), v.begin() + v.size() / 2, v.end()); return v[v.size() / 2]; };
        rep.profileMedianOutM = med(outs); rep.profileMedianParapetM = med(paras);
    }

    // --- roofs: each tier's cap, split until every edge is at most ~2 cell sizes, each piece its own colour
    for (size_t ti = 0; ti < tiers.size(); ++ti) {
        const auto& t = *tiers[ti];
        std::vector<cdt::P2> pts2;
        std::vector<std::vector<int>> loops;
        auto addLoops = [&](const std::vector<std::vector<P2>>& ls) {
            for (const auto& l : ls) {
                std::vector<int> ix;
                for (const auto& q : l) { double x, z; F.toXZ(q.u, q.v, x, z); ix.push_back(static_cast<int>(pts2.size())); pts2.push_back({x, z}); }
                loops.push_back(ix);
            }
        };
        addLoops(t.loopsUV);
        // the tier above stands on this cap: its outline as holes (even-odd) when it lies clear inside, else the whole cap
        std::optional<std::vector<cdt::Tri3>> tris;
        bool upperInside = ti + 1 < tiers.size();
        if (upperInside)
            for (const auto& l : tiers[ti + 1]->loopsUV) for (const auto& q : l) {
                bool in = false;
                for (const auto& own : t.loopsUV) if (detail::inRingXZ(q.u, q.v, own)) in = !in;  // both in (u, v): containment needs no frame
                if (!in) upperInside = false;
            }
        if (upperInside) {
            const auto keepPts = pts2; const auto keepLoops = loops;
            addLoops(tiers[ti + 1]->loopsUV);
            tris = cdt::triangulatePolygon(pts2, loops);
            if (!tris) { pts2 = keepPts; loops = keepLoops; }
        }
        if (tris) ++rep.capsCut;
        if (!tris) tris = cdt::triangulatePolygon(pts2, loops);
        if (!tris) { rep.notes.push_back("tier " + std::to_string(ti) + ": its roof outline crosses itself; no cap"); continue; }
        const double y = S.groundY + t.topY;
        std::vector<std::array<P3, 3>> todo;
        for (const auto& tr : *tris) {
            std::array<P3, 3> T;
            for (int k = 0; k < 3; ++k) T[k] = {pts2[tr[k]][0], y, pts2[tr[k]][1]};
            // counter-clockwise seen from above (+y)
            if (sp::cross(T[1] - T[0], T[2] - T[0]).y < 0) std::swap(T[1], T[2]);
            todo.push_back(T);
        }
        const double maxE = 2 * S.P.cellM;
        while (!todo.empty()) {
            auto T = todo.back(); todo.pop_back();
            const double e = std::max({sp::len(T[1] - T[0]), sp::len(T[2] - T[1]), sp::len(T[0] - T[2])});
            if (e > maxE) {
                // split the longest edge (two halves): slivers stay few
                int k = 0;
                const double l0 = sp::len(T[1] - T[0]), l1 = sp::len(T[2] - T[1]), l2 = sp::len(T[0] - T[2]);
                if (l1 >= l0 && l1 >= l2) k = 1; else if (l2 >= l0 && l2 >= l1) k = 2;
                const P3 a = T[k], b = T[(k + 1) % 3], c = T[(k + 2) % 3], m = (a + b) * 0.5;
                todo.push_back({a, m, c}); todo.push_back({m, b, c});
                continue;
            }
            // the colour: the photo at the piece's centre and toward its corners
            std::vector<double> cr, cg, cb;
            const P3 cc = (T[0] + T[1] + T[2]) * (1.0 / 3);
            for (const P3& q : {cc, (cc + T[0]) * 0.5, (cc + T[1]) * 0.5, (cc + T[2]) * 0.5}) { Rgb c; if (ph.sample(q, up, S.P.sampleRadiusM, c)) { cr.push_back(c.r); cg.push_back(c.g); cb.push_back(c.b); } }
            Rgb c = classColour(0);
            if (!cr.empty()) { auto med = [](std::vector<double>& v) { std::nth_element(v.begin(), v.begin() + v.size() / 2, v.end()); return v[v.size() / 2]; }; c = {med(cr), med(cg), med(cb)}; ++rep.colouredElements; } else ++rep.uncolouredElements;
            const int m = E.classOf(c);
            ++rep.classUse[m];
            E.tri(massing, m, T[0], T[1], T[2], up, c, P3{1, 0, 0}, P3{0, 0, 1});
            ++rep.roofCells;
        }
    }

    std::vector<double> slenderFoot;  // the slender top's widest first ring (m), its axis (u, v): the roof detail keeps clear of it
    struct ShellRing { double z0, z1; std::vector<double> r, r1; };
    std::vector<ShellRing> shellRings;  // the slender top's steps, for the scan detail's distance to the shell
    int shellK = 0; double shellAu = 0, shellAv = 0;
    std::vector<std::pair<double, double>> finSpans;  // the height spans whose fins the angular profile drew
    // --- the slender top, axis-locked. One vertical axis for the whole top: the median of the per-slice circle fits (Kasa,
    // slices whose fitted radius is at least 1.5 m: a thin antenna's fit wanders). Each 1 m slice's radius is read in
    // `sectors` sectors about it (95th percentile), smoothed to `harmonics` Fourier terms. The top's order of rotational
    // symmetry is measured: the largest m in {8, 4, 2} whose m-fold average of the mean normalised profile departs from it
    // by at most `symmetryTol` (an RMS share of the radius); every slice is averaged over its m rotations (the scan's
    // one-sided noise cancels, a real asymmetry stays below that order). A slice under `circleBelowM` in mean radius is
    // a circle at its sectors' 75th-percentile radius (a shape below a metre is beyond the scan). The mean radius up the axis is then split into steps by the
    // least squares segmentation with a penalty per step (3 ln(n) times the slice noise squared, the noise from the
    // differences of neighbouring slices), each step a straight taper of the median shape of its slices. Measured.
    if (slenderH >= 0) {
        const int K = std::max(8, S.P.sectors);
        const int k0 = static_cast<int>(std::floor(slenderH / S.P.sliceM));
        // the axis
        std::vector<double> cu, cv;
        for (int k = k0; k < nSlices; ++k) {
            const auto& q = slice[k];
            if (q.size() < 30) continue;
            // Kasa circle fit: x^2 + y^2 + D x + E y + F = 0 by least squares
            double sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0, sxz = 0, syz = 0, sz = 0; const double n = static_cast<double>(q.size());
            for (const auto& p : q) { const double x = p.x, y = p.z, z = x * x + y * y; sxx += x * x; sxy += x * y; syy += y * y; sx += x; sy += y; sxz += x * z; syz += y * z; sz += z; }
            // normal equations for [D E F]
            const double A[3][3] = {{sxx, sxy, sx}, {sxy, syy, sy}, {sx, sy, n}}, B[3] = {-sxz, -syz, -sz};
            const double det = A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) - A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) + A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);
            if (std::abs(det) < 1e-9) continue;
            auto solve = [&](int col) { double M[3][3]; for (int i = 0; i < 3; ++i) for (int j = 0; j < 3; ++j) M[i][j] = j == col ? B[i] : A[i][j]; return (M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0])) / det; };
            const double D = solve(0), E2 = solve(1), Fc = solve(2);
            const double xc = -D / 2, yc = -E2 / 2, r2 = xc * xc + yc * yc - Fc;
            if (r2 < 1.5 * 1.5) continue;
            cu.push_back(xc); cv.push_back(yc);
        }
        double au = 0, av = 0;
        if (!cu.empty()) {
            std::vector<double> a = cu, b = cv;
            std::nth_element(a.begin(), a.begin() + a.size() / 2, a.end()); std::nth_element(b.begin(), b.begin() + b.size() / 2, b.end());
            au = a[a.size() / 2]; av = b[b.size() / 2];
        } else {
            int an = 0;
            for (int k = k0; k < nSlices; ++k) if (r95[k] >= 0) { au += cen[k].u; av += cen[k].v; ++an; }
            if (an) { au /= an; av /= an; }
        }
        rep.slenderAxisFits = cu.size();
        // sector radii per slice, harmonic smoothing
        struct Slice { double z0, z1, mean; std::vector<double> r; };
        std::vector<Slice> sl;
        for (int k = k0; k < nSlices; ++k) {
            if (slice[k].size() < 12) continue;
            std::vector<std::vector<double>> sec(K);
            for (const auto& p : slice[k]) {
                const double du = p.x - au, dv = p.z - av;
                const int s2 = ((static_cast<int>(std::floor((std::atan2(dv, du) + kPi) / (2 * kPi) * K)) % K) + K) % K;
                sec[s2].push_back(std::hypot(du, dv));
            }
            std::vector<double> rr(K, NAN), all;
            for (int s2 = 0; s2 < K; ++s2) if (sec[s2].size() >= 2) {
                auto& v = sec[s2];
                std::nth_element(v.begin(), v.begin() + static_cast<long>(0.95 * (v.size() - 1)), v.end());
                rr[s2] = v[static_cast<size_t>(0.95 * (v.size() - 1))];
                all.push_back(rr[s2]);
            }
            if (all.empty()) continue;
            std::nth_element(all.begin(), all.begin() + all.size() / 2, all.end());
            for (auto& x : rr) if (std::isnan(x)) x = all[all.size() / 2];
            const int Hn = std::min(S.P.harmonics, K / 2);
            std::vector<double> sm(K, 0);
            for (int h = 0; h <= Hn; ++h) {
                double ca = 0, cb = 0;
                for (int s2 = 0; s2 < K; ++s2) { const double th = 2 * kPi * h * (s2 + 0.5) / K; ca += rr[s2] * std::cos(th); cb += rr[s2] * std::sin(th); }
                ca *= (h == 0 ? 1.0 : 2.0) / K; cb *= 2.0 / K;
                for (int s2 = 0; s2 < K; ++s2) { const double th = 2 * kPi * h * (s2 + 0.5) / K; sm[s2] += ca * std::cos(th) + cb * std::sin(th); }
            }
            double mean = 0; for (auto& x : sm) { x = std::max(0.05, x); mean += x; } mean /= K;
            sl.push_back({k * S.P.sliceM, std::min(topH, (k + 1) * S.P.sliceM), mean, sm});
            ++rep.slenderSlices;
        }
        // the order of rotational symmetry, from the mean normalised profile of the slices wide enough to have a shape
        int order = 1;
        {
            std::vector<double> f(K, 0); int nf = 0;
            for (const auto& q : sl) if (q.mean >= S.P.circleBelowM) { for (int s2 = 0; s2 < K; ++s2) f[s2] += q.r[s2] / q.mean; ++nf; }
            if (nf) {
                for (auto& x : f) x /= nf;
                for (int m : {8, 4, 2}) {
                    if (K % m) continue;
                    double e = 0;
                    for (int s2 = 0; s2 < K; ++s2) { double g = 0; for (int j = 0; j < m; ++j) g += f[(s2 + j * K / m) % K]; g /= m; e += (f[s2] - g) * (f[s2] - g); }
                    if (std::sqrt(e / K) <= S.P.symmetryTol) { order = m; break; }
                }
            }
        }
        rep.slenderSymmetry = order;
        for (auto& q : sl) {
            if (q.mean < S.P.circleBelowM) {
                // a circle at the 75th percentile of its sector radii: a thin lattice or mast fills more of its circle than its mean
                std::vector<double> v = q.r;
                std::nth_element(v.begin(), v.begin() + static_cast<long>(0.75 * (v.size() - 1)), v.end());
                const double rc = v[static_cast<size_t>(0.75 * (v.size() - 1))];
                for (auto& x : q.r) x = rc;
                q.mean = rc;
                continue;
            }
            if (order > 1) { std::vector<double> g(K, 0); for (int s2 = 0; s2 < K; ++s2) { for (int j = 0; j < order; ++j) g[s2] += q.r[(s2 + j * K / order) % K]; g[s2] /= order; } q.r = g; }
        }
        // steps: the penalised least-squares segmentation of the mean radius (each step a straight line in z)
        struct Ring { double z0, z1; std::vector<double> r, r1; };
        std::vector<Ring> bands;
        const int N = static_cast<int>(sl.size());
        if (N) {
            std::vector<double> dif;
            for (int i = 1; i < N; ++i) dif.push_back(std::abs(sl[i].mean - sl[i - 1].mean));
            double sigma = 0.1;
            if (!dif.empty()) { std::nth_element(dif.begin(), dif.begin() + dif.size() / 2, dif.end()); sigma = std::max(0.03, dif[dif.size() / 2] / 0.6745 / std::sqrt(2.0)); }
            const double lambda = 3 * std::log(std::max(2, N)) * sigma * sigma;
            auto lineCost = [&](int i, int j, double& a, double& b) {  // slices i..j-1
                double s0 = 0, s1 = 0, s2 = 0, t0 = 0, t1 = 0;
                for (int k = i; k < j; ++k) { const double z = (sl[k].z0 + sl[k].z1) / 2, y = sl[k].mean; s0 += 1; s1 += z; s2 += z * z; t0 += y; t1 += z * y; }
                const double den = s0 * s2 - s1 * s1;
                b = std::abs(den) > 1e-9 ? (s0 * t1 - s1 * t0) / den : 0; a = (t0 - b * s1) / s0;
                double c = 0;
                for (int k = i; k < j; ++k) { const double z = (sl[k].z0 + sl[k].z1) / 2, e = sl[k].mean - (a + b * z); c += e * e; }
                return c;
            };
            std::vector<double> best(N + 1, 1e300); std::vector<int> from(N + 1, 0); best[0] = 0;
            for (int j = 2; j <= N; ++j) for (int i = std::max(0, j - 200); i <= j - 2; ++i) {
                if (best[i] >= 1e299) continue;
                double a, b; const double c = best[i] + lineCost(i, j, a, b) + lambda;
                if (c < best[j]) { best[j] = c; from[j] = i; }
            }
            if (N == 1) { best[1] = 0; from[1] = 0; }
            std::vector<std::pair<int, int>> segs;
            for (int j = N; j > 0; j = from[j]) segs.push_back({from[j], j});
            std::reverse(segs.begin(), segs.end());
            for (auto [i, j] : segs) {
                double a, b; lineCost(i, j, a, b);
                const double zA = sl[i].z0, zB = sl[j - 1].z1;
                if (std::abs(b * (zB - zA)) < 0.1) { b = 0; double m = 0; for (int k = i; k < j; ++k) m += sl[k].mean; a = m / (j - i); }
                // the step's shape: the median normalised profile of its slices
                std::vector<double> shape(K);
                for (int s2 = 0; s2 < K; ++s2) { std::vector<double> v; for (int k = i; k < j; ++k) v.push_back(sl[k].r[s2] / sl[k].mean); std::nth_element(v.begin(), v.begin() + v.size() / 2, v.end()); shape[s2] = v[v.size() / 2]; }
                Ring R0{zA, zB, std::vector<double>(K), std::vector<double>(K)};
                const double rA = std::max(0.05, a + b * zA), rB = std::max(0.05, a + b * zB);
                for (int s2 = 0; s2 < K; ++s2) { R0.r[s2] = shape[s2] * rA; R0.r1[s2] = shape[s2] * rB; }
                bands.push_back(R0);
            }
        }
        rep.slenderBands = bands.size();
        if (!bands.empty()) slenderFoot = {*std::max_element(bands[0].r.begin(), bands[0].r.end()), au, av};
        shellK = K; shellAu = au; shellAv = av;

        // fins, flutes and ribs: each step's angular profile stacked over its height. Dense samples of the scan (100 per
        // m^2) in the step's height span; each sample's excess beyond the step's ring at its height and angle (the ring's
        // polygon, its taper); per 0.5 degree bin the 85th percentile of the excess (the outermost surface the bin's
        // samples agree on). When the profile repeats around the axis (its autocorrelation at a lag of 2 to 90 degrees at
        // least finMinCorr: the strongest harmonic above the ring's carries that share of the excess's power), it is folded: the n copies averaged into one exemplar and drawn
        // n times; else drawn as it is. Bins at least finMinM beyond the ring become radial blocks from the ring out,
        // consecutive bins within 5 cm one block. Measured (stacked, folded); far finer than the scan's triangles.
        if (S.P.slenderFins) {
            constexpr int NB = 720;
            std::vector<P3> fs;  // frame (u, h, v)
            {
                std::mt19937 rng(17);
                std::uniform_real_distribution<double> U(0, 1);
                for (size_t ti = 0; ti < R.building.size(); ++ti) {
                    const P3 a = R.building.p[3 * ti], b = R.building.p[3 * ti + 1], c = R.building.p[3 * ti + 2];
                    if (std::max({a.y, b.y, c.y}) < slenderH) continue;
                    const double area = sp::len(sp::cross(b - a, c - a)) / 2;
                    const int n = std::max(1, static_cast<int>(std::ceil(area * 100)));
                    for (int k = 0; k < n; ++k) { double r1 = U(rng), r2 = U(rng); if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; } fs.push_back(a + (b - a) * r1 + (c - a) * r2); }
                }
            }
            // the ring's radius along the ray at angle th (its polygon through the sector boundaries), at height h
            auto ringAt = [&](const Ring& b, double th, double h) {
                const double t = b.z1 > b.z0 ? std::clamp((h - b.z0) / (b.z1 - b.z0), 0.0, 1.0) : 0.0;
                const double pos = (th + kPi) / (2 * kPi) * K;
                const int s0 = static_cast<int>(std::floor(pos)) % K;
                auto bound = [&](int s2) { s2 = ((s2 % K) + K) % K; return (1 - t) * (b.r[(s2 - 1 + K) % K] + b.r[s2]) / 2 + t * (b.r1[(s2 - 1 + K) % K] + b.r1[s2]) / 2; };
                const double ta = -kPi + 2 * kPi * s0 / K, tb = ta + 2 * kPi / K;
                const double ra = bound(s0), rb = bound(s0 + 1);
                const double ax2 = ra * std::cos(ta), ay2 = ra * std::sin(ta), bx2 = rb * std::cos(tb), by2 = rb * std::sin(tb);
                const double dx = std::cos(th), dy = std::sin(th);
                // ray (dx, dy) * r meets segment a + (b - a) s
                const double ex = bx2 - ax2, ey = by2 - ay2, den = dx * ey - dy * ex;
                if (std::abs(den) < 1e-12) return ra;
                return (ax2 * ey - ay2 * ex) / den;
            };
            for (auto& b : bands) {
                if (b.z1 - b.z0 < 2.0) continue;
                double meanR = 0; for (double x : b.r) meanR += x; meanR /= K;
                if (meanR < 1.5) continue;
                std::vector<std::vector<float>> bins(NB);
                for (const auto& q : fs) {
                    if (q.y < b.z0 || q.y > b.z1) continue;
                    const double du = q.x - au, dv = q.z - av, th = std::atan2(dv, du);
                    const int bi = std::clamp(static_cast<int>((th + kPi) / (2 * kPi) * NB), 0, NB - 1);
                    bins[bi].push_back(static_cast<float>(std::hypot(du, dv) - ringAt(b, th, q.y)));
                }
                std::vector<double> e(NB, NAN);
                for (int i = 0; i < NB; ++i) if (bins[i].size() >= 6) {
                    auto& v = bins[i];
                    std::nth_element(v.begin(), v.begin() + static_cast<long>(0.85 * (v.size() - 1)), v.end());
                    e[i] = v[static_cast<size_t>(0.85 * (v.size() - 1))];
                }
                // the period: the ring holds the step's shape up to `harmonics` lobes, so ribs and flutes are what repeats
                // faster: the strongest harmonic of the excess from harmonics + 1 to 180 lobes, kept when it carries at least
                // finMinCorr of that band's power (the excess's gaps filled with its median first)
                int bestN = 0; double bestC = 0;
                {
                    std::vector<double> v; for (double x : e) if (!std::isnan(x)) v.push_back(x);
                    if (v.size() > NB * 3 / 4) {
                        std::nth_element(v.begin(), v.begin() + v.size() / 2, v.end());
                        const double medE = v[v.size() / 2];
                        std::vector<double> f(NB); for (int i = 0; i < NB; ++i) f[i] = std::isnan(e[i]) ? medE : e[i] - medE;
                        double total = 0; std::vector<double> pw(181, 0);
                        for (int m = S.P.harmonics + 1; m <= 180; ++m) {
                            double cr = 0, ci = 0;
                            for (int i = 0; i < NB; ++i) { const double th = 2 * kPi * m * i / NB; cr += f[i] * std::cos(th); ci += f[i] * std::sin(th); }
                            pw[m] = cr * cr + ci * ci; total += pw[m];
                        }
                        for (int m = S.P.harmonics + 1; m <= 180; ++m) if (total > 0 && pw[m] / total > bestC) { bestC = pw[m] / total; bestN = m; }
                    }
                }
                std::vector<double> prof = e;
                int copies = 1;
                {
                    std::vector<double> v; for (double x : e) if (!std::isnan(x)) v.push_back(x);
                    std::sort(v.begin(), v.end());
                    char buf[200];
                    std::snprintf(buf, sizeof buf, "fins: step %.1f-%.1f m r %.2f: %zu bins, excess p10 %.2f p50 %.2f p90 %.2f, period %d corr %.2f", b.z0, b.z1, meanR, v.size(), v.empty() ? 0.0 : v[v.size() / 10], v.empty() ? 0.0 : v[v.size() / 2], v.empty() ? 0.0 : v[v.size() * 9 / 10], bestN, bestC);
                    rep.notes.push_back(buf);
                }
                if (bestN >= 2 && bestC >= S.P.finMinCorr) {
                    // folded: each bin the mean over the n rotations
                    copies = bestN;
                    for (int i = 0; i < NB; ++i) {
                        double sum = 0; int m = 0;
                        for (int k = 0; k < bestN; ++k) { const double x = e[(i + static_cast<int>(std::lround(static_cast<double>(k) * NB / bestN))) % NB]; if (!std::isnan(x)) { sum += x; ++m; } }
                        prof[i] = m * 2 >= bestN ? sum / m : NAN;
                    }
                }
                // the ring is the step's outer envelope: regular ribs read as grooves between their tips. Grooves deeper
                // than finMinM (the folded profile's 10th percentile), where the ribs' harmonic carries a quarter of the
                // power or more, pull the step's core in to their floor (half a metre at most), and the ribs stand out of it
                {
                    std::vector<double> v; for (double x : prof) if (!std::isnan(x)) v.push_back(x);
                    if (v.size() > NB / 2) {
                        std::nth_element(v.begin(), v.begin() + v.size() / 10, v.end());
                        const double low = v[v.size() / 10];
                        if (low < -S.P.finMinM && copies > 1 && bestC >= 0.25) {
                            const double pull = std::max(low, -0.5);  // at most half a metre: a deeper low is the step's shape, not its grooves
                            for (auto& x : b.r) x = std::max(0.05, x + pull);
                            for (auto& x : b.r1) x = std::max(0.05, x + pull);
                            for (auto& x : prof) if (!std::isnan(x)) x -= pull;
                        }
                    }
                }
                // the blocks: runs of bins at least finMinM out, within 5 cm of the run's start
                bool any = false;
                const double binA = 2 * kPi / NB;
                for (int i = 0; i < NB;) {
                    if (std::isnan(prof[i]) || prof[i] < S.P.finMinM || prof[i] > 4) { ++i; continue; }
                    int j = i + 1;
                    while (j < NB && !std::isnan(prof[j]) && prof[j] >= S.P.finMinM && std::abs(prof[j] - prof[i]) < 0.05) ++j;
                    double ex = 0; for (int k = i; k < j; ++k) ex += prof[k]; ex /= (j - i);
                    const double th0 = -kPi + i * binA, th1 = -kPi + j * binA;
                    auto pt = [&](double th, double h, double off) { const double rr = ringAt(b, th, h) + off; double x, z; F.toXZ(au + rr * std::cos(th), av + rr * std::sin(th), x, z); return P3{x, S.groundY + h, z}; };
                    const P3 up{0, 1, 0};
                    bool got;
                    const P3 m0 = pt((th0 + th1) / 2, (b.z0 + b.z1) / 2, ex);
                    double cx, cz; F.toXZ(au, av, cx, cz);
                    P3 nOut{m0.x - cx, 0, m0.z - cz}; nOut = nOut * (1.0 / std::max(1e-9, sp::len(nOut)));
                    const Rgb col = colourOf(pt(th0, b.z0, ex + 0.05), pt(th1, b.z0, ex) - pt(th0, b.z0, ex), P3{0, b.z1 - b.z0, 0}, nOut, classColour(0), got);
                    const int mt = E.classOf(col);
                    const int nh = std::max(1, static_cast<int>(std::ceil((b.z1 - b.z0) / 3.0)));
                    // the copies drawn here are the fold's rotations (one when the profile was not folded and the run is the profile itself)
                    if (copies == 1 || i < NB / copies) {
                        for (int k = 0; k < copies; ++k) {
                            const double rot = 2 * kPi * k / copies;
                            const double a0 = th0 + rot, a1 = th1 + rot;
                            for (int jh = 0; jh < nh; ++jh) {
                                const double h0 = b.z0 + (b.z1 - b.z0) * jh / nh, h1 = b.z0 + (b.z1 - b.z0) * (jh + 1) / nh;
                                const P3 o00 = pt(a0, h0, ex), o10 = pt(a1, h0, ex), o11 = pt(a1, h1, ex), o01 = pt(a0, h1, ex);
                                const P3 i00 = pt(a0, h0, 0), i10 = pt(a1, h0, 0), i11 = pt(a1, h1, 0), i01 = pt(a0, h1, 0);
                                const P3 mo = (o00 + o11) * 0.5; P3 no{mo.x - cx, 0, mo.z - cz}; no = no * (1.0 / std::max(1e-9, sp::len(no)));
                                E.quad(slender, mt, o00, o10, o11, o01, no, col, o10 - o00, up);
                                P3 s0 = sp::cross(up, o00 - i00); s0 = s0 * (-1.0 / std::max(1e-9, sp::len(s0)));
                                P3 s1 = sp::cross(up, o10 - i10); s1 = s1 * (1.0 / std::max(1e-9, sp::len(s1)));
                                E.quad(slender, mt, i00, o00, o01, i01, s0, col, o00 - i00, up);
                                E.quad(slender, mt, i10, i11, o11, o10, s1, col, o10 - i10, up);
                                if (jh == nh - 1) E.quad(slender, mt, i01, o01, o11, i11, up, col, P3{1, 0, 0}, P3{0, 0, 1});
                                if (jh == 0) E.quad(slender, mt, i00, i10, o10, o00, up * -1.0, col, P3{1, 0, 0}, P3{0, 0, 1});
                            }
                            ++rep.finSegments;
                        }
                        any = true;
                    }
                    i = j;
                }
                if (any) { ++rep.finBands; rep.finCount += copies; finSpans.push_back({b.z0, b.z1}); }
            }
        }
        for (const auto& b : bands) shellRings.push_back({b.z0, b.z1, b.r, b.r1});  // after the fins (a fluted step's core moves in)
        auto ringPt = [&](const Ring& b, int s, double h) {
            const double th = -kPi + 2 * kPi * s / K;  // sector boundaries
            const double t = b.z1 > b.z0 ? std::clamp((h - b.z0) / (b.z1 - b.z0), 0.0, 1.0) : 0.0;  // the step's taper
            const double rad = (1 - t) * (b.r[(s - 1 + K) % K] + b.r[s % K]) / 2 + t * (b.r1[(s - 1 + K) % K] + b.r1[s % K]) / 2;
            double x, z; F.toXZ(au + rad * std::cos(th), av + rad * std::sin(th), x, z);
            return P3{x, S.groundY + h, z};
        };
        for (size_t bi = 0; bi < bands.size(); ++bi) {
            const auto& b = bands[bi];
            const int nh = std::max(1, static_cast<int>(std::ceil((b.z1 - b.z0) / 3.0)));
            for (int s = 0; s < K; ++s) {
                for (int j = 0; j < nh; ++j) {
                    const double h0 = b.z0 + (b.z1 - b.z0) * j / nh, h1 = b.z0 + (b.z1 - b.z0) * (j + 1) / nh;
                    const P3 a0 = ringPt(b, s, h0), a1 = ringPt(b, s + 1, h0), c1 = ringPt(b, s + 1, h1), c0 = ringPt(b, s, h1);
                    P3 n = sp::cross(a1 - a0, c0 - a0);
                    const double L = sp::len(n);
                    if (L < 1e-9) continue;
                    n = n * (1 / L);
                    // outward: away from the axis (the sectors' winding alone leaves it pointing in, and a viewer that draws
                    // only front faces then shows the far wall's inside through the near one)
                    {
                        double ax, az; F.toXZ(au, av, ax, az);
                        const P3 mid = (a0 + a1) * 0.5;
                        if (n.x * (mid.x - ax) + n.z * (mid.z - az) < 0) n = n * -1.0;
                    }
                    bool got;
                    const Rgb c = colourOf(a0, a1 - a0, c0 - a0, n, classColour(0), got);
                    const int m = E.classOf(c);
                    ++rep.classUse[m];
                    E.quad(slender, m, a0, a1, c1, c0, n, c, sp::cross(up, n), up * -1.0);
                }
            }
            // the step to the next band (or the top cap): the annulus between this band's ring and the next's at b.z1
            const bool last = bi + 1 == bands.size() || std::abs(bands[bi + 1].z0 - b.z1) > 1e-6;
            Rgb capC = classColour(0);
            for (int s = 0; s < K; ++s) {
                const P3 o0 = ringPt(b, s, b.z1), o1 = ringPt(b, s + 1, b.z1);
                if (last) {
                    double x, z; F.toXZ(au, av, x, z);
                    const P3 cc{x, S.groundY + b.z1, z};
                    if (s == 0) { bool got; capC = colourOf(cc, (o0 - cc), (o1 - cc), up, classColour(0), got); }
                    E.tri(slender, E.classOf(capC), cc, o1, o0, up, capC, P3{1, 0, 0}, P3{0, 0, 1});
                } else {
                    const auto& nb = bands[bi + 1];
                    const P3 i0 = ringPt(nb, s, b.z1), i1 = ringPt(nb, s + 1, b.z1);
                    const double ro = sp::len(o0 - i0);
                    if (ro < 0.02) continue;
                    // facing up where this band is wider, down where the next one is
                    const bool wider = (b.r1[s] + b.r1[(s + K - 1) % K]) >= (nb.r[s] + nb.r[(s + K - 1) % K]);
                    const P3 n = wider ? up : up * -1.0;
                    if (s == 0) { bool got; capC = colourOf(i0, o0 - i0, o1 - o0, n, classColour(0), got); }
                    if (wider) E.quad(slender, E.classOf(capC), o0, i0, i1, o1, n, capC, P3{1, 0, 0}, P3{0, 0, 1});
                    else E.quad(slender, E.classOf(capC), o0, o1, i1, i0, n, capC, P3{1, 0, 0}, P3{0, 0, 1});
                }
            }
        }
    }

    // --- the procedural shell's distance from a point outside it (frame u, h, v), shared by the surface fit and the scan detail
    auto insideTier = [&](const sp::TierOut* t, double u, double v) { bool in = false; for (const auto& l : t->loopsUV) if (detail::inRingXZ(u, v, l)) in = !in; return in; };
    auto planDist = [&](const sp::TierOut* t, double u, double v) {
        double best = 1e30;
        for (const auto& l : t->loopsUV) for (size_t k = 0; k < l.size(); ++k) {
            const P2 a = l[k], b = l[(k + 1) % l.size()];
            const double du = b.u - a.u, dv = b.v - a.v, L2 = du * du + dv * dv;
            const double tt = L2 > 0 ? std::clamp(((u - a.u) * du + (v - a.v) * dv) / L2, 0.0, 1.0) : 0;
            best = std::min(best, std::hypot(u - a.u - tt * du, v - a.v - tt * dv));
        }
        return best;
    };
    const double topShell = tiers.empty() ? 0 : tiers.back()->topY;
    auto outside = [&](const P3& q) {  // q: frame (u, h, v)
        const double u = q.x, h = q.y, v = q.z;
        if (slenderH >= 0 && h >= slenderH && !shellRings.empty()) {
            const ShellRing* R0 = nullptr;
            for (const auto& r : shellRings) if (h >= r.z0 - 1e-6 && h <= r.z1 + 1e-6) { R0 = &r; break; }
            if (!R0) return h - shellRings.back().z1;  // above the top
            const double du = u - shellAu, dv = v - shellAv;
            const int sct = ((static_cast<int>(std::floor((std::atan2(dv, du) + kPi) / (2 * kPi) * shellK)) % shellK) + shellK) % shellK;
            const double t = R0->z1 > R0->z0 ? std::clamp((h - R0->z0) / (R0->z1 - R0->z0), 0.0, 1.0) : 0;
            return std::hypot(du, dv) - ((1 - t) * R0->r[sct] + t * R0->r1[sct]);
        }
        // the tier at this height
        const sp::TierOut* at = nullptr;
        for (const auto* t : tiers) if (h >= t->baseY - 1e-6 && h <= t->topY + 1e-6) at = t;
        double d = 1e30;
        if (at) { if (insideTier(at, u, v)) return -1.0; d = planDist(at, u, v); }
        else if (h > topShell) d = 1e30;
        // above the roof of the highest tier below whose outline holds it
        for (auto it = tiers.rbegin(); it != tiers.rend(); ++it) if ((*it)->topY <= h + 1e-6 && insideTier(*it, u, v)) { d = std::min(d, h - (*it)->topY); break; }
        return d >= 1e29 ? 0.0 : d;
    };

    // --- surface fit for irregular leftovers (with the relief maps). Connected pieces of the scan standing reliefM or more
    // off the shell, of 0.5 to 40 m^2, at least 1.5 m tall and not flat (their samples' smallest principal spread at least
    // a tenth of the largest) are what no operator describes (a statue, a sculpted finial). Each is rebuilt as a closed
    // surface fitted to its points: the signed distance to the piece's triangles (signed by the nearest one's normal) on a
    // 0.15 m grid, meshed by surface nets. A new surface from the measurements, not the scan's triangles; measured.
    std::vector<std::array<double, 6>> fitBoxes;  // the pieces' boxes (frame u, h, v min / max): the roof blocks and wall relief keep out
    if (S.P.reliefM > 0 && S.P.surfaceFit && S.P.scanDetailM <= 0 && R.building.size()) {
        const size_t T = R.building.size();
        std::vector<uint8_t> keep(T, 0);
        for (size_t t = 0; t < T; ++t) {
            const P3 c = (R.building.p[3 * t] + R.building.p[3 * t + 1] + R.building.p[3 * t + 2]) * (1.0 / 3);
            if (outside(c) >= S.P.reliefM) keep[t] = 1;
        }
        std::unordered_map<uint64_t, std::vector<uint32_t>> byVert;
        auto vkey = [](const P3& q) { auto r = [](double x) { return static_cast<uint64_t>(static_cast<int64_t>(std::llround(x * 1000)) & 0x1FFFFF); }; return (r(q.x) << 42) | (r(q.y) << 21) | r(q.z); };
        for (size_t t = 0; t < T; ++t) if (keep[t]) for (int k = 0; k < 3; ++k) byVert[vkey(R.building.p[3 * t + k])].push_back(static_cast<uint32_t>(t));
        std::vector<int> comp(T, -1);
        const double G2 = 0.15;
        for (size_t t0 = 0; t0 < T; ++t0) {
            if (!keep[t0] || comp[t0] >= 0) continue;
            std::vector<uint32_t> piece{static_cast<uint32_t>(t0)}; comp[t0] = 0;
            double area = 0; P3 lo{1e30, 1e30, 1e30}, hi{-1e30, -1e30, -1e30};
            for (size_t q = 0; q < piece.size(); ++q) {
                const uint32_t t = piece[q];
                const P3 a = R.building.p[3 * t], b = R.building.p[3 * t + 1], c = R.building.p[3 * t + 2];
                area += sp::len(sp::cross(b - a, c - a)) / 2;
                for (const P3& v : {a, b, c}) { lo = {std::min(lo.x, v.x), std::min(lo.y, v.y), std::min(lo.z, v.z)}; hi = {std::max(hi.x, v.x), std::max(hi.y, v.y), std::max(hi.z, v.z)}; }
                for (int k = 0; k < 3; ++k) for (uint32_t nb : byVert[vkey(R.building.p[3 * t + k])]) if (comp[nb] < 0) { comp[nb] = 0; piece.push_back(nb); }
            }
            if (area < 0.5 || area > 40 || hi.y - lo.y < 1.5) continue;
            // flatness: the principal spreads of the triangle centroids
            {
                P3 m{0, 0, 0}; for (uint32_t t : piece) m = m + (R.building.p[3 * t] + R.building.p[3 * t + 1] + R.building.p[3 * t + 2]) * (1.0 / 3);
                m = m * (1.0 / piece.size());
                double C3[3][3] = {{0}};
                for (uint32_t t : piece) { const P3 c = (R.building.p[3 * t] + R.building.p[3 * t + 1] + R.building.p[3 * t + 2]) * (1.0 / 3) - m; const double v[3] = {c.x, c.y, c.z}; for (int i = 0; i < 3; ++i) for (int j = 0; j < 3; ++j) C3[i][j] += v[i] * v[j]; }
                // eigenvalues of the symmetric 3x3 (closed form)
                const double p1 = C3[0][1] * C3[0][1] + C3[0][2] * C3[0][2] + C3[1][2] * C3[1][2];
                const double q3 = (C3[0][0] + C3[1][1] + C3[2][2]) / 3;
                const double p2 = (C3[0][0] - q3) * (C3[0][0] - q3) + (C3[1][1] - q3) * (C3[1][1] - q3) + (C3[2][2] - q3) * (C3[2][2] - q3) + 2 * p1;
                const double pp = std::sqrt(std::max(1e-18, p2 / 6));
                double Bm[3][3]; for (int i = 0; i < 3; ++i) for (int j = 0; j < 3; ++j) Bm[i][j] = (C3[i][j] - (i == j ? q3 : 0)) / pp;
                const double detB = Bm[0][0] * (Bm[1][1] * Bm[2][2] - Bm[1][2] * Bm[2][1]) - Bm[0][1] * (Bm[1][0] * Bm[2][2] - Bm[1][2] * Bm[2][0]) + Bm[0][2] * (Bm[1][0] * Bm[2][1] - Bm[1][1] * Bm[2][0]);
                const double phi = std::acos(std::clamp(detB / 2, -1.0, 1.0)) / 3;
                const double e1 = q3 + 2 * pp * std::cos(phi), e3 = q3 + 2 * pp * std::cos(phi + 2 * kPi / 3);
                if (e1 <= 0 || e3 / e1 < 0.01) continue;  // flat: a relief block's, not a surface's
            }
            // the signed distance on the grid, then surface nets
            lo = lo - P3{0.3, 0.3, 0.3}; hi = hi + P3{0.3, 0.3, 0.3};
            const int nx = static_cast<int>(std::ceil((hi.x - lo.x) / G2)) + 1, ny = static_cast<int>(std::ceil((hi.y - lo.y) / G2)) + 1, nz = static_cast<int>(std::ceil((hi.z - lo.z) / G2)) + 1;
            if (static_cast<double>(nx) * ny * nz > 3e6) continue;
            // a bucket grid of the piece's triangles (0.6 m)
            const double bc = 0.6;
            std::unordered_map<uint64_t, std::vector<uint32_t>> bucket;
            auto bk = [&](int a, int b, int c) { return (static_cast<uint64_t>(a & 0x1FFFFF) << 42) | (static_cast<uint64_t>(b & 0x1FFFFF) << 21) | static_cast<uint64_t>(c & 0x1FFFFF); };
            for (uint32_t t : piece) {
                P3 tl{1e30, 1e30, 1e30}, th{-1e30, -1e30, -1e30};
                for (int k = 0; k < 3; ++k) { const P3 v = R.building.p[3 * t + k]; tl = {std::min(tl.x, v.x), std::min(tl.y, v.y), std::min(tl.z, v.z)}; th = {std::max(th.x, v.x), std::max(th.y, v.y), std::max(th.z, v.z)}; }
                for (int a = static_cast<int>(std::floor((tl.x - lo.x) / bc)); a <= static_cast<int>(std::floor((th.x - lo.x) / bc)); ++a)
                    for (int b = static_cast<int>(std::floor((tl.y - lo.y) / bc)); b <= static_cast<int>(std::floor((th.y - lo.y) / bc)); ++b)
                        for (int c = static_cast<int>(std::floor((tl.z - lo.z) / bc)); c <= static_cast<int>(std::floor((th.z - lo.z) / bc)); ++c) bucket[bk(a, b, c)].push_back(t);
            }
            auto closestOn = [&](const P3& p, uint32_t t, P3& q) {
                const P3 a = R.building.p[3 * t], b = R.building.p[3 * t + 1], c = R.building.p[3 * t + 2];
                const P3 ab = b - a, ac = c - a, ap = p - a;
                const double d1 = sp::dot(ab, ap), d2 = sp::dot(ac, ap);
                if (d1 <= 0 && d2 <= 0) { q = a; return; }
                const P3 bp = p - b; const double d3 = sp::dot(ab, bp), d4 = sp::dot(ac, bp);
                if (d3 >= 0 && d4 <= d3) { q = b; return; }
                const double vc = d1 * d4 - d3 * d2;
                if (vc <= 0 && d1 >= 0 && d3 <= 0) { q = a + ab * (d1 / (d1 - d3)); return; }
                const P3 cp = p - c; const double d5 = sp::dot(ab, cp), d6 = sp::dot(ac, cp);
                if (d6 >= 0 && d5 <= d6) { q = c; return; }
                const double vb = d5 * d2 - d1 * d6;
                if (vb <= 0 && d2 >= 0 && d6 <= 0) { q = a + ac * (d2 / (d2 - d6)); return; }
                const double va = d3 * d6 - d5 * d4;
                if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) { q = b + (c - b) * ((d4 - d3) / ((d4 - d3) + (d5 - d6))); return; }
                const double den = 1 / (va + vb + vc); q = a + ab * (vb * den) + ac * (vc * den);
            };
            std::vector<float> sd(static_cast<size_t>(nx) * ny * nz, 1e3f);
            auto idx = [&](int i, int j, int k) { return (static_cast<size_t>(k) * ny + j) * nx + i; };
            for (int k = 0; k < nz; ++k) for (int j = 0; j < ny; ++j) for (int i = 0; i < nx; ++i) {
                const P3 p{lo.x + i * G2, lo.y + j * G2, lo.z + k * G2};
                const int a0 = static_cast<int>(std::floor((p.x - lo.x) / bc)), b0 = static_cast<int>(std::floor((p.y - lo.y) / bc)), c0 = static_cast<int>(std::floor((p.z - lo.z) / bc));
                double best = 1e30; int bt = -1; P3 bq;
                for (int a = a0 - 1; a <= a0 + 1; ++a) for (int b = b0 - 1; b <= b0 + 1; ++b) for (int c = c0 - 1; c <= c0 + 1; ++c) {
                    auto it = bucket.find(bk(a, b, c)); if (it == bucket.end()) continue;
                    for (uint32_t t : it->second) { P3 q; closestOn(p, t, q); const double d = sp::dot(p - q, p - q); if (d < best) { best = d; bt = static_cast<int>(t); bq = q; } }
                }
                if (bt < 0) continue;  // far from the piece: outside
                const P3 a = R.building.p[3 * bt], b = R.building.p[3 * bt + 1], c = R.building.p[3 * bt + 2];
                P3 n = sp::cross(b - a, c - a); const double L = sp::len(n); if (L < 1e-12) continue; n = n * (1 / L);
                const double dist = std::sqrt(best);
                sd[idx(i, j, k)] = static_cast<float>(sp::dot(p - bq, n) >= 0 ? dist : -dist);
            }
            // surface nets: a vertex per cell the surface crosses, a quad per crossed edge
            std::unordered_map<size_t, P3> cellV;
            auto cellIdx = [&](int i, int j, int k) { return (static_cast<size_t>(k) * ny + j) * nx + i; };
            for (int k = 0; k + 1 < nz; ++k) for (int j = 0; j + 1 < ny; ++j) for (int i = 0; i + 1 < nx; ++i) {
                P3 acc{0, 0, 0}; int n = 0;
                static const int E12[12][2][3] = {{{0,0,0},{1,0,0}},{{0,1,0},{1,1,0}},{{0,0,1},{1,0,1}},{{0,1,1},{1,1,1}},{{0,0,0},{0,1,0}},{{1,0,0},{1,1,0}},{{0,0,1},{0,1,1}},{{1,0,1},{1,1,1}},{{0,0,0},{0,0,1}},{{1,0,0},{1,0,1}},{{0,1,0},{0,1,1}},{{1,1,0},{1,1,1}}};
                for (const auto& e : E12) {
                    const float va = sd[idx(i + e[0][0], j + e[0][1], k + e[0][2])], vb = sd[idx(i + e[1][0], j + e[1][1], k + e[1][2])];
                    if ((va < 0) == (vb < 0)) continue;
                    const double t = va / (va - vb);
                    acc = acc + P3{lo.x + (i + e[0][0] + t * (e[1][0] - e[0][0])) * G2, lo.y + (j + e[0][1] + t * (e[1][1] - e[0][1])) * G2, lo.z + (k + e[0][2] + t * (e[1][2] - e[0][2])) * G2};
                    ++n;
                }
                if (n) cellV[cellIdx(i, j, k)] = acc * (1.0 / n);
            }
            size_t quads = 0;
            auto emit = [&](const P3& a, const P3& b, const P3& c, const P3& d, bool flip) {
                P3 A = F.toTile(a), B = F.toTile(b), C2 = F.toTile(c), D2 = F.toTile(d);
                if (flip) std::swap(B, D2);
                P3 n = sp::cross(B - A, C2 - A); const double L = sp::len(n); if (L < 1e-12) return; n = n * (1 / L);
                bool got;
                const Rgb col = colourOf(A, B - A, D2 - A, n, classColour(0), got);
                E.quad(scanDet, E.classOf(col), A, B, C2, D2, n, col, P3{1, 0, 0}, P3{0, 1, 0});
                ++quads;
            };
            auto cv = [&](int i, int j, int k, P3& out2) { auto it = cellV.find(cellIdx(i, j, k)); if (it == cellV.end()) return false; out2 = it->second; return true; };
            for (int k = 1; k + 1 < nz; ++k) for (int j = 1; j + 1 < ny; ++j) for (int i = 1; i + 1 < nx; ++i) {
                const float v0 = sd[idx(i, j, k)];
                // the x edge (i, j, k)-(i+1, j, k): cells (i, j-1..j, k-1..k)
                if (i + 1 < nx) { const float v1 = sd[idx(i + 1, j, k)]; if ((v0 < 0) != (v1 < 0)) { P3 a, b, c, d; if (cv(i, j - 1, k - 1, a) && cv(i, j, k - 1, b) && cv(i, j, k, c) && cv(i, j - 1, k, d)) emit(a, b, c, d, v0 < 0); } }
                if (j + 1 < ny) { const float v1 = sd[idx(i, j + 1, k)]; if ((v0 < 0) != (v1 < 0)) { P3 a, b, c, d; if (cv(i - 1, j, k - 1, a) && cv(i - 1, j, k, b) && cv(i, j, k, c) && cv(i, j, k - 1, d)) emit(a, b, c, d, v0 < 0); } }
                if (k + 1 < nz) { const float v1 = sd[idx(i, j, k + 1)]; if ((v0 < 0) != (v1 < 0)) { P3 a, b, c, d; if (cv(i - 1, j - 1, k, a) && cv(i, j - 1, k, b) && cv(i, j, k, c) && cv(i - 1, j, k, d)) emit(a, b, c, d, v0 < 0); } }
            }
            if (quads) { ++rep.surfacePieces; rep.surfaceQuads += quads; fitBoxes.push_back({lo.x, lo.y, lo.z, hi.x, hi.y, hi.z}); }
        }
    }

    // --- roof detail. The scan's height map (the building's top per 0.25 m cell) against the twin's: the top tier covering
    // each cell. Connected cells where the scan stands at least roofDetailMinM above the twin, over at least
    // roofDetailMinArea, away from the tiers' outlines (the parapets' band) unless 2.5 m above, and from the slender top's foot, are what the
    // tiers do not hold (the crown's wings and buttresses, bulkheads, plant, tanks: no kind is named). Each is rebuilt as
    // blocks from the twin's roof up to the scan's height in roofDetailStepM steps: maximal rectangles of cells sharing a
    // height and a roof. Measured; the colour is the photo's.
    if ((S.P.roofDetail || S.P.reliefM > 0) && S.P.scanDetailM <= 0 && R.grid.nu > 0) {
        // with relief maps: down to reliefM, parapets included (no ledge profiles draw them), in quarter-metre steps
        const double rdMin = S.P.reliefM > 0 ? S.P.reliefM : S.P.roofDetailMinM, rdStep = S.P.reliefM > 0 ? 0.25 : S.P.roofDetailStepM;
        const double rdArea = S.P.reliefM > 0 ? S.P.reliefMinArea : S.P.roofDetailMinArea;
        const bool rdEdge = S.P.reliefM <= 0;
        const auto& G = R.grid;
        const int NU = G.nu, NV = G.nv;
        std::vector<float> twinH(static_cast<size_t>(NU) * NV, NAN);
        std::vector<uint8_t> nearEdge(static_cast<size_t>(NU) * NV, 0);
        for (const auto* t : tiers) {
            for (const auto& l : t->loopsUV) {
                double lo_u = 1e30, hi_u = -1e30, lo_v = 1e30, hi_v = -1e30;
                for (const auto& q : l) { lo_u = std::min(lo_u, q.u); hi_u = std::max(hi_u, q.u); lo_v = std::min(lo_v, q.v); hi_v = std::max(hi_v, q.v); }
                const int i0 = std::max(0, static_cast<int>((lo_u - G.u0) / G.cell)), i1 = std::min(NU - 1, static_cast<int>((hi_u - G.u0) / G.cell));
                const int j0 = std::max(0, static_cast<int>((lo_v - G.v0) / G.cell)), j1 = std::min(NV - 1, static_cast<int>((hi_v - G.v0) / G.cell));
                for (int j = j0; j <= j1; ++j) for (int i = i0; i <= i1; ++i) {
                    const double pu = G.cu(i), pv = G.cv(j);
                    bool in = false;
                    for (const auto& l2 : t->loopsUV) if (detail::inRingXZ(pu, pv, l2)) in = !in;
                    float& h = twinH[static_cast<size_t>(j) * NU + i];
                    if (in && !(h >= t->topY)) h = static_cast<float>(t->topY);
                }
                // the parapets' band along each edge
                const double E2 = S.P.roofDetailEdgeM;
                for (size_t k = 0; k < l.size(); ++k) {
                    const P2 a = l[k], b = l[(k + 1) % l.size()];
                    const int ei0 = std::max(0, static_cast<int>((std::min(a.u, b.u) - E2 - G.u0) / G.cell)), ei1 = std::min(NU - 1, static_cast<int>((std::max(a.u, b.u) + E2 - G.u0) / G.cell));
                    const int ej0 = std::max(0, static_cast<int>((std::min(a.v, b.v) - E2 - G.v0) / G.cell)), ej1 = std::min(NV - 1, static_cast<int>((std::max(a.v, b.v) + E2 - G.v0) / G.cell));
                    const double du = b.u - a.u, dv = b.v - a.v, L2 = du * du + dv * dv;
                    for (int j = ej0; j <= ej1; ++j) for (int i = ei0; i <= ei1; ++i) {
                        const double pu = G.cu(i) - a.u, pv = G.cv(j) - a.v;
                        const double tt = L2 > 0 ? std::clamp((pu * du + pv * dv) / L2, 0.0, 1.0) : 0;
                        if (std::hypot(pu - tt * du, pv - tt * dv) <= E2) nearEdge[static_cast<size_t>(j) * NU + i] = 1;
                    }
                }
            }
        }
        // the slender top's foot: its widest first ring, and a metre and a half
        double footR = -1, fu = 0, fv = 0;
        if (rep.slenderFromM >= 0 && !slenderFoot.empty()) { footR = slenderFoot[0] + 1.5; fu = slenderFoot[1]; fv = slenderFoot[2]; }
        std::vector<uint8_t> cand(static_cast<size_t>(NU) * NV, 0);
        for (int j = 0; j < NV; ++j) for (int i = 0; i < NU; ++i) {
            const size_t k = static_cast<size_t>(j) * NU + i;
            const float hs = R.height[k], ht = twinH[k];
            if (!(hs == hs) || !(ht == ht)) continue;
            if (rdEdge && nearEdge[k] && hs - ht < 2.5) continue;  // the parapets' band: only what stands above any parapet
            { bool inFit = false; for (const auto& bx : fitBoxes) if (G.cu(i) >= bx[0] && G.cu(i) <= bx[3] && G.cv(j) >= bx[2] && G.cv(j) <= bx[5] && hs >= bx[1]) { inFit = true; break; } if (inFit) continue; }
            if (footR > 0 && std::hypot(G.cu(i) - fu, G.cv(j) - fv) <= footR) continue;
            if (hs - ht >= rdMin && hs - ht <= 40) cand[k] = 1;
        }
        // connected pieces (8-connected), each rebuilt
        std::vector<int> comp(cand.size(), -1);
        std::vector<double> heights;
        const double cellA = G.cell * G.cell;
        for (int j = 0; j < NV; ++j) for (int i = 0; i < NU; ++i) {
            const size_t k0 = static_cast<size_t>(j) * NU + i;
            if (!cand[k0] || comp[k0] >= 0) continue;
            std::vector<size_t> cells{k0}; comp[k0] = 0;
            for (size_t q = 0; q < cells.size(); ++q) {
                const int ci = static_cast<int>(cells[q] % NU), cj = static_cast<int>(cells[q] / NU);
                for (int dj = -1; dj <= 1; ++dj) for (int di = -1; di <= 1; ++di) {
                    const int ni = ci + di, nj = cj + dj;
                    if (ni < 0 || nj < 0 || ni >= NU || nj >= NV) continue;
                    const size_t nk = static_cast<size_t>(nj) * NU + ni;
                    if (cand[nk] && comp[nk] < 0) { comp[nk] = 0; cells.push_back(nk); }
                }
            }
            if (cells.size() * cellA < rdArea) continue;
            // each cell's height key (the scan's height in steps) and roof; maximal rectangles of equal keys
            std::unordered_map<size_t, std::pair<int, float>> key;
            for (size_t c : cells) key[c] = {static_cast<int>(std::lround(R.height[c] / rdStep)), twinH[c]};
            std::unordered_map<size_t, uint8_t> used;
            ++rep.roofDetailPieces; rep.roofDetailAreaM2 += cells.size() * cellA;
            std::sort(cells.begin(), cells.end());
            for (size_t c : cells) {
                if (used[c]) continue;
                const auto kc = key[c];
                const int ci = static_cast<int>(c % NU), cj = static_cast<int>(c / NU);
                auto same = [&](int ii, int jj) { if (ii < 0 || jj < 0 || ii >= NU || jj >= NV) return false; const size_t kk = static_cast<size_t>(jj) * NU + ii; auto it = key.find(kk); return it != key.end() && !used[kk] && it->second == kc; };
                int i1 = ci; while (same(i1 + 1, cj)) ++i1;
                int j1 = cj;
                for (;;) { bool ok = true; for (int ii = ci; ii <= i1 && ok; ++ii) ok = same(ii, j1 + 1); if (!ok) break; ++j1; }
                for (int jj = cj; jj <= j1; ++jj) for (int ii = ci; ii <= i1; ++ii) used[static_cast<size_t>(jj) * NU + ii] = 1;
                // the block in the tile frame: corners from the frame, base on the twin's roof, top at the stepped height
                const double h0 = kc.second, h1 = kc.first * rdStep;
                if (h1 - h0 < std::min(0.3, rdMin)) continue;
                heights.push_back(h1 - h0);
                const double u0 = G.u0 + ci * G.cell, u1 = G.u0 + (i1 + 1) * G.cell, v0 = G.v0 + cj * G.cell, v1 = G.v0 + (j1 + 1) * G.cell;
                auto at = [&](double u, double v, double h) { double x, z; F.toXZ(u, v, x, z); return P3{x, S.groundY + h, z}; };
                const P3 A0 = at(u0, v0, h0), B0 = at(u1, v0, h0), C0 = at(u1, v1, h0), D0 = at(u0, v1, h0);
                const P3 A1 = at(u0, v0, h1), B1 = at(u1, v0, h1), C1 = at(u1, v1, h1), D1 = at(u0, v1, h1);
                const P3 up{0, 1, 0};
                bool got;
                const Rgb ct = colourOf(A1, B1 - A1, D1 - A1, up, classColour(0), got);
                const int mt = E.classOf(ct);
                E.quad(roofDet, mt, A1, B1, C1, D1, up, ct, P3{1, 0, 0}, P3{0, 0, 1});
                // sides, each facing away from the block's centre
                const P3 cen = (A0 + C1) * 0.5;
                const P3 sides[4][4] = {{A0, B0, B1, A1}, {B0, C0, C1, B1}, {C0, D0, D1, C1}, {D0, A0, A1, D1}};
                for (const auto& q : sides) {
                    P3 n = sp::cross(q[1] - q[0], up); const double L = sp::len(n); if (L < 1e-9) continue; n = n * (1 / L);
                    const P3 mid = (q[0] + q[1]) * 0.5;
                    if (sp::dot(n, mid - cen) < 0) n = n * -1.0;
                    const Rgb cs = colourOf(q[0] + n * 0.05, q[1] - q[0], q[3] - q[0], n, ct, got);
                    E.quad(roofDet, E.classOf(cs), q[0], q[1], q[2], q[3], n, cs, q[1] - q[0], up);
                }
                ++rep.roofDetailBoxes;
            }
        }
        if (!heights.empty()) { std::nth_element(heights.begin(), heights.begin() + heights.size() / 2, heights.end()); rep.roofDetailMedianM = heights[heights.size() / 2]; }
    }

    // --- scan detail. Every triangle of the tree-free scan gets its distance outside the procedural shell: below the slender
    // top, the plan distance from its centroid to the outline of the tier at its height (inside it: none), and no more
    // than its height above the roof of the highest tier below it whose outline holds it; on the slender top, how far it
    // stands beyond the fitted ring at its height and sector. Triangles at least scanDetailM out, in connected pieces of at
    // least scanDetailMinArea, are kept as they are: the scan's own surface (measured), coloured from the photo.
    if (S.P.scanDetailM > 0 && R.building.size()) {
        const size_t T = R.building.size();
        std::vector<uint8_t> keep(T, 0);
        for (size_t t = 0; t < T; ++t) {
            const P3 c = (R.building.p[3 * t] + R.building.p[3 * t + 1] + R.building.p[3 * t + 2]) * (1.0 / 3);
            if (outside(c) >= S.P.scanDetailM) keep[t] = 1;
        }
        // connected pieces through shared vertices (positions to the millimetre)
        std::unordered_map<uint64_t, std::vector<uint32_t>> byVert;
        auto vkey = [](const P3& q) { auto r = [](double x) { return static_cast<uint64_t>(static_cast<int64_t>(std::llround(x * 1000)) & 0x1FFFFF); }; return (r(q.x) << 42) | (r(q.y) << 21) | r(q.z); };
        for (size_t t = 0; t < T; ++t) if (keep[t]) for (int k = 0; k < 3; ++k) byVert[vkey(R.building.p[3 * t + k])].push_back(static_cast<uint32_t>(t));
        std::vector<int> comp(T, -1);
        for (size_t t0 = 0; t0 < T; ++t0) {
            if (!keep[t0] || comp[t0] >= 0) continue;
            std::vector<uint32_t> piece{static_cast<uint32_t>(t0)}; comp[t0] = 0;
            double area = 0;
            for (size_t q = 0; q < piece.size(); ++q) {
                const uint32_t t = piece[q];
                const P3 a = R.building.p[3 * t], b = R.building.p[3 * t + 1], c = R.building.p[3 * t + 2];
                area += sp::len(sp::cross(b - a, c - a)) / 2;
                for (int k = 0; k < 3; ++k) for (uint32_t nb : byVert[vkey(R.building.p[3 * t + k])]) if (comp[nb] < 0) { comp[nb] = 0; piece.push_back(nb); }
            }
            if (area < S.P.scanDetailMinArea) continue;
            ++rep.scanDetailPieces; rep.scanDetailAreaM2 += area;
            for (uint32_t t : piece) {
                const P3 a = F.toTile(R.building.p[3 * t]), b = F.toTile(R.building.p[3 * t + 1]), c = F.toTile(R.building.p[3 * t + 2]);
                P3 n = sp::cross(b - a, c - a); const double L = sp::len(n); if (L < 1e-12) continue; n = n * (1 / L);
                bool got;
                const Rgb col = colourOf(a, b - a, c - a, n, classColour(0), got);
                E.tri(scanDet, E.classOf(col), a, b, c, n, col, P3{1, 0, 0}, P3{0, 1, 0});
                ++rep.scanDetailTriangles;
            }
        }
    }

    // --- relief maps (procedural, opt-in: reliefM above 0). Dense samples of the scan (reliefDensity per m^2). On each tier
    // wall, a map over the wall's (along, up) cells of reliefCellM: per cell the second-largest offset of the samples out of
    // the wall (the outermost surface two samples agree on); cells at least reliefM out, in connected pieces of reliefMinArea to
    // reliefMaxArea (a larger one is the wall standing off its squared outline), become blocks from the wall out to their offset (0.1 m steps), merged into maximal rectangles of one
    // offset. On the slender top, a map over (height, sector): how far the samples stand beyond the fitted ring; cells at
    // least reliefM out become ring segments out to that radius. Measured blocks: none of the scan's surface is kept.
    if (S.P.reliefM > 0 && S.P.scanDetailM <= 0 && R.building.size()) {
        struct Sm { float x, y, z; };
        std::vector<Sm> dense;
        {
            std::mt19937 rng(13);
            std::uniform_real_distribution<double> U(0, 1);
            for (size_t ti = 0; ti < R.building.size(); ++ti) {
                const P3 a = R.building.p[3 * ti], b = R.building.p[3 * ti + 1], c = R.building.p[3 * ti + 2];
                const double area = sp::len(sp::cross(b - a, c - a)) / 2;
                const int n = std::max(1, static_cast<int>(std::ceil(area * S.P.reliefDensity)));
                for (int k = 0; k < n; ++k) {
                    double r1 = U(rng), r2 = U(rng); if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; }
                    const P3 q = a + (b - a) * r1 + (c - a) * r2;  // frame (u, h, v)
                    dense.push_back({static_cast<float>(q.x), static_cast<float>(q.y), static_cast<float>(q.z)});
                }
            }
        }
        const double cell2 = 2.0;
        std::unordered_map<uint64_t, std::vector<uint32_t>> grid2;
        auto gk = [&](double u, double v) { return (static_cast<uint64_t>(static_cast<uint32_t>(static_cast<int32_t>(std::floor(u / cell2)))) << 32) | static_cast<uint32_t>(static_cast<int32_t>(std::floor(v / cell2))); };
        for (uint32_t i = 0; i < dense.size(); ++i) grid2[gk(dense[i].x, dense[i].z)].push_back(i);
        const double C = S.P.reliefCellM, thr = S.P.reliefM;
        const P3 up{0, 1, 0};
        // the walls (a block on a detail-textured wall samples that wall's texture, projected along its normal)
        for (size_t fi = 0; fi < faces.size(); ++fi) {
            const auto& w = faces[fi];
            if (w.L < 1.0) continue;
            E.tex = faceTex[fi].ok ? &faceTex[fi] : nullptr; E.texP0 = w.p0; E.texD = w.d;
            // the wall in the frame: its start and direction in (u, v)
            const P2 s0 = F.toUV(w.p0.x, w.p0.z);
            const P2 dU = F.toUV(w.p0.x + w.d.x, w.p0.z + w.d.z), nU = F.toUV(w.p0.x + w.n.x, w.p0.z + w.n.z);
            const double du = dU.u - s0.u, dv = dU.v - s0.v, nu = nU.u - s0.u, nv = nU.v - s0.v;
            const int NA = std::max(1, static_cast<int>(std::ceil(w.L / C))), NH = std::max(1, static_cast<int>(std::ceil((w.h1 - w.h0) / C)));
            std::vector<std::array<float, 2>> top2(static_cast<size_t>(NA) * NH, {-1e9f, -1e9f});
            const double minU = std::min(s0.u, s0.u + du * w.L) - 3.5, maxU = std::max(s0.u, s0.u + du * w.L) + 3.5;
            const double minV = std::min(s0.v, s0.v + dv * w.L) - 3.5, maxV = std::max(s0.v, s0.v + dv * w.L) + 3.5;
            for (double gu = std::floor(minU / cell2) * cell2; gu <= maxU; gu += cell2) for (double gv = std::floor(minV / cell2) * cell2; gv <= maxV; gv += cell2) {
                auto it = grid2.find(gk(gu + 0.5 * cell2, gv + 0.5 * cell2));
                if (it == grid2.end()) continue;
                for (uint32_t i : it->second) {
                    const auto& q = dense[i];
                    const double ru = q.x - s0.u, rv = q.z - s0.v;
                    const double a = ru * du + rv * dv, o = ru * nu + rv * nv;
                    if (a < 0 || a >= w.L || q.y < w.h0 || q.y >= w.h1 || o < -0.3 || o > 3.0) continue;
                    { bool inFit = false; for (const auto& bx : fitBoxes) if (q.x >= bx[0] && q.x <= bx[3] && q.y >= bx[1] && q.y <= bx[4] && q.z >= bx[2] && q.z <= bx[5]) { inFit = true; break; } if (inFit) continue; }
                    const int ia = std::min(NA - 1, static_cast<int>(a / C)), ih = std::min(NH - 1, static_cast<int>((q.y - w.h0) / C));
                    auto& t2 = top2[static_cast<size_t>(ih) * NA + ia];
                    if (o > t2[0]) { t2[1] = t2[0]; t2[0] = static_cast<float>(o); } else if (o > t2[1]) t2[1] = static_cast<float>(o);
                }
            }
            std::vector<int> q(top2.size(), 0);  // the cell's offset in 0.1 m steps, 0 below the threshold
            for (size_t k = 0; k < top2.size(); ++k) if (top2[k][1] >= thr) q[k] = static_cast<int>(std::lround(top2[k][1] / 0.1));
            // connected pieces of solid cells, small ones dropped
            std::vector<int> comp(q.size(), -1);
            for (size_t k0 = 0; k0 < q.size(); ++k0) {
                if (!q[k0] || comp[k0] >= 0) continue;
                std::vector<size_t> cells{k0}; comp[k0] = 0;
                for (size_t z = 0; z < cells.size(); ++z) {
                    const int ia = static_cast<int>(cells[z] % NA), ih = static_cast<int>(cells[z] / NA);
                    for (int dh = -1; dh <= 1; ++dh) for (int da = -1; da <= 1; ++da) {
                        const int na = ia + da, nh = ih + dh;
                        if (na < 0 || nh < 0 || na >= NA || nh >= NH) continue;
                        const size_t nk = static_cast<size_t>(nh) * NA + na;
                        if (q[nk] && comp[nk] < 0) { comp[nk] = 0; cells.push_back(nk); }
                    }
                }
                if (cells.size() * C * C < S.P.reliefMinArea || cells.size() * C * C > S.P.reliefMaxArea) { for (size_t c : cells) q[c] = -q[c]; continue; }  // marked dropped
                ++rep.reliefWallPieces; rep.reliefWallAreaM2 += cells.size() * C * C;
            }
            // maximal rectangles of one offset, each a block out of the wall
            std::vector<uint8_t> used(q.size(), 0);
            auto at = [&](double a, double h, double o) { return P3{w.p0.x + w.d.x * a + w.n.x * o, S.groundY + h, w.p0.z + w.d.z * a + w.n.z * o}; };
            for (int ih = 0; ih < NH; ++ih) for (int ia = 0; ia < NA; ++ia) {
                const size_t k = static_cast<size_t>(ih) * NA + ia;
                if (q[k] <= 0 || used[k]) continue;
                const int key = q[k];
                auto same = [&](int a2, int h2) { if (a2 >= NA || h2 >= NH) return false; const size_t kk = static_cast<size_t>(h2) * NA + a2; return q[kk] == key && !used[kk]; };
                int a1 = ia; while (same(a1 + 1, ih)) ++a1;
                int h1 = ih;
                for (;;) { bool ok = true; for (int a2 = ia; a2 <= a1 && ok; ++a2) ok = same(a2, h1 + 1); if (!ok) break; ++h1; }
                for (int h2 = ih; h2 <= h1; ++h2) for (int a2 = ia; a2 <= a1; ++a2) used[static_cast<size_t>(h2) * NA + a2] = 1;
                const double A0 = ia * C, A1 = std::min(w.L, (a1 + 1) * C), H0 = w.h0 + ih * C, H1 = std::min(w.h1, w.h0 + (h1 + 1) * C), O = key * 0.1;
                bool got;
                const Rgb c = colourOf(at(A0, H0, O + 0.05), w.d * (A1 - A0), P3{0, H1 - H0, 0}, w.n, classColour(0), got);
                const int m = E.classOf(c);
                E.quad(scanDet, m, at(A0, H0, O), at(A1, H0, O), at(A1, H1, O), at(A0, H1, O), w.n, c, w.d, up);       // front
                E.quad(scanDet, m, at(A0, H1, 0), at(A1, H1, 0), at(A1, H1, O), at(A0, H1, O), up, c, w.d, w.n);       // top
                E.quad(scanDet, m, at(A0, H0, 0), at(A0, H0, O), at(A1, H0, O), at(A1, H0, 0), up * -1.0, c, w.d, w.n); // underside
                E.quad(scanDet, m, at(A0, H0, 0), at(A0, H1, 0), at(A0, H1, O), at(A0, H0, O), w.d * -1.0, c, w.n, up); // sides
                E.quad(scanDet, m, at(A1, H0, 0), at(A1, H0, O), at(A1, H1, O), at(A1, H1, 0), w.d, c, w.n, up);
                ++rep.reliefWallBoxes;
            }
        }
        E.tex = nullptr;
        // the slender top: (height, sector) cells beyond the fitted ring
        if (slenderH >= 0 && !shellRings.empty()) {
            const int K2 = shellK;
            const double z0 = shellRings.front().z0, z1 = shellRings.back().z1;
            const int NZ = std::max(1, static_cast<int>(std::ceil((z1 - z0) / C)));
            std::vector<std::array<float, 2>> top2(static_cast<size_t>(NZ) * K2, {-1e9f, -1e9f});
            auto ringR = [&](double h, int sct) {
                for (const auto& r : shellRings) if (h >= r.z0 - 1e-6 && h <= r.z1 + 1e-6) { const double t = r.z1 > r.z0 ? std::clamp((h - r.z0) / (r.z1 - r.z0), 0.0, 1.0) : 0; return (1 - t) * r.r[sct] + t * r.r1[sct]; }
                return 0.0;
            };
            for (const auto& q : dense) {
                if (q.y < z0 || q.y >= z1) continue;
                const double du = q.x - shellAu, dv = q.z - shellAv;
                const int sct = ((static_cast<int>(std::floor((std::atan2(dv, du) + kPi) / (2 * kPi) * K2)) % K2) + K2) % K2;
                const int iz = std::min(NZ - 1, static_cast<int>((q.y - z0) / C));
                const float e = static_cast<float>(std::hypot(du, dv) - ringR(q.y, sct));
                auto& t2 = top2[static_cast<size_t>(iz) * K2 + sct];
                if (e > t2[0]) { t2[1] = t2[0]; t2[0] = e; } else if (e > t2[1]) t2[1] = e;
            }
            std::vector<uint8_t> solid(top2.size(), 0);
            for (size_t k = 0; k < top2.size(); ++k) if (top2[k][1] >= thr && top2[k][1] <= 6) solid[k] = 1;
            std::vector<int> comp(solid.size(), -1);
            for (size_t k0 = 0; k0 < solid.size(); ++k0) {
                if (!solid[k0] || comp[k0] >= 0) continue;
                std::vector<size_t> cells{k0}; comp[k0] = 0;
                for (size_t z = 0; z < cells.size(); ++z) {
                    const int s2 = static_cast<int>(cells[z] % K2), iz = static_cast<int>(cells[z] / K2);
                    for (int dz = -1; dz <= 1; ++dz) for (int ds = -1; ds <= 1; ++ds) {
                        const int ns = (s2 + ds + K2) % K2, nz = iz + dz;
                        if (nz < 0 || nz >= NZ) continue;
                        const size_t nk = static_cast<size_t>(nz) * K2 + ns;
                        if (solid[nk] && comp[nk] < 0) { comp[nk] = 0; cells.push_back(nk); }
                    }
                }
                if (cells.size() < 3) continue;
                ++rep.reliefMastPieces;
                for (size_t c : cells) {
                    const int s2 = static_cast<int>(c % K2), iz = static_cast<int>(c / K2);
                    const double hA = z0 + iz * C, hB = std::min(z1, hA + C), hm = (hA + hB) / 2;
                    const double r0 = ringR(hm, s2), r1 = r0 + std::round(top2[c][1] / 0.1) * 0.1;
                    const double t0 = -kPi + 2 * kPi * s2 / K2, t1 = -kPi + 2 * kPi * (s2 + 1) / K2;
                    auto pt = [&](double rr, double th, double h) { double x, z; F.toXZ(shellAu + rr * std::cos(th), shellAv + rr * std::sin(th), x, z); return P3{x, S.groundY + h, z}; };
                    const P3 o0 = pt(r1, t0, hA), o1 = pt(r1, t1, hA), o2 = pt(r1, t1, hB), o3 = pt(r1, t0, hB);
                    const P3 i0 = pt(r0, t0, hA), i1 = pt(r0, t1, hA), i2 = pt(r0, t1, hB), i3 = pt(r0, t0, hB);
                    double ax, az; F.toXZ(shellAu, shellAv, ax, az);
                    const P3 mid = (o0 + o1) * 0.5; P3 nOut{mid.x - ax, 0, mid.z - az}; nOut = nOut * (1.0 / std::max(1e-9, sp::len(nOut)));
                    bool got;
                    const Rgb col = colourOf(o0 + nOut * 0.05, o1 - o0, o3 - o0, nOut, classColour(0), got);
                    const int m = E.classOf(col);
                    E.quad(scanDet, m, o0, o1, o2, o3, nOut, col, o1 - o0, up);
                    E.quad(scanDet, m, i3, i2, o2, o3, up, col, P3{1, 0, 0}, P3{0, 0, 1});
                    E.quad(scanDet, m, i0, o0, o1, i1, up * -1.0, col, P3{1, 0, 0}, P3{0, 0, 1});
                    P3 sA = sp::cross(up, o0 - i0); sA = sA * (1.0 / std::max(1e-9, sp::len(sA)));
                    E.quad(scanDet, m, i0, i3, o3, o0, sA * -1.0, col, o0 - i0, up);
                    E.quad(scanDet, m, i1, o1, o2, i2, sp::cross(up, o1 - i1) * (1.0 / std::max(1e-9, sp::len(sp::cross(up, o1 - i1)))), col, o1 - i1, up);
                    ++rep.reliefMastCells;
                }
            }
        }
    }

    // --- the atlas: each element's measured colour baked over its rect as a gain on the repeat median (the median's own
    // mean over the rect brought toward the element's colour: the gain held within [1/3, 3], to the power
    // detailGainPower, so a cell's own colour shows without its edges reading as blocks); a texel no repeat
    // photographed takes the element's colour flat
    // the atlas's size: the walls' textures, then the palette's rows below them
    {
        const int H = ((E.paletteY0 + E.paletteRowsTexels() + 3) / 4) * 4;
        if (H > E.atlasW) throw std::runtime_error("measured twin: " + std::to_string(E.palette.size()) + " element colours do not fit the atlas below the walls' textures (raise detailAtlas or detailTexelM)");
        rep.atlasW = E.atlasW; rep.atlasH = std::max(4, H); rep.paletteColours = E.palette.size();
        E.normaliseUvs({&massing, &openings, &slender, &ledges, &roofDet, &scanDet}, rep.atlasH);
    }
    {
        texture::ImageBuffer atlas(rep.atlasW, rep.atlasH, 3, 128);
        // the palette: each colour a solid block
        for (size_t k = 0; k < E.palette.size(); ++k) {
            const int perRow = E.atlasW / Emitter::kBlock;
            const int x0 = static_cast<int>(k % perRow) * Emitter::kBlock, y0 = E.paletteY0 + static_cast<int>(k / perRow) * Emitter::kBlock;
            const uint32_t c = E.palette[k];
            for (int y = y0; y < y0 + Emitter::kBlock; ++y) for (int x = x0; x < x0 + Emitter::kBlock; ++x) {
                const size_t q = atlas.getIndex(x, y);
                atlas.data[q] = static_cast<uint8_t>(c >> 16); atlas.data[q + 1] = static_cast<uint8_t>(c >> 8); atlas.data[q + 2] = static_cast<uint8_t>(c);
            }
        }
        auto toS = [](double c) { c = std::clamp(c, 0.0, 1.0); return static_cast<uint8_t>(std::lround(255.0 * (c <= 0.0031308 ? 12.92 * c : 1.055 * std::pow(c, 1 / 2.4) - 0.055))); };
        for (auto& t : faceTex) {
            if (!t.ok) continue;
            std::vector<float> baked(t.M.size(), -1.0f);
            for (const auto& e : t.tints) {
                const int i0 = std::clamp(static_cast<int>(std::floor(e.a0 / t.texel)), 0, t.w), i1 = std::clamp(static_cast<int>(std::ceil(e.a1 / t.texel)), 0, t.w);
                const int j0 = std::clamp(static_cast<int>(std::floor((t.h1 - e.h1) / t.texel)), 0, t.h), j1 = std::clamp(static_cast<int>(std::ceil((t.h1 - e.h0) / t.texel)), 0, t.h);
                double m[3] = {0, 0, 0}; size_t n = 0;
                for (int j = j0; j < j1; ++j) for (int i = i0; i < i1; ++i) { const size_t o = (static_cast<size_t>(j) * t.w + i) * 3; if (t.M[o] >= 0) { m[0] += t.M[o]; m[1] += t.M[o + 1]; m[2] += t.M[o + 2]; ++n; } }
                const double cc[3] = {e.c.r, e.c.g, e.c.b};
                double gain[3] = {1, 1, 1};
                if (n) for (int k = 0; k < 3; ++k) gain[k] = std::pow(std::clamp(cc[k] / std::max(1e-4, m[k] / n), 1.0 / 3, 3.0), S.P.detailGainPower);
                for (int j = j0; j < j1; ++j) for (int i = i0; i < i1; ++i) {
                    const size_t o = (static_cast<size_t>(j) * t.w + i) * 3;
                    for (int k = 0; k < 3; ++k) baked[o + k] = static_cast<float>(t.M[o] >= 0 ? t.M[o + k] * gain[k] : cc[k]);
                }
            }
            // a texel past every element (the edge rounding) takes its neighbour's value; the 1-texel gutter repeats the edge
            for (int j = -1; j <= t.h; ++j) for (int i = -1; i <= t.w; ++i) {
                const int si = std::clamp(i, 0, t.w - 1), sj = std::clamp(j, 0, t.h - 1);
                const size_t o = (static_cast<size_t>(sj) * t.w + si) * 3;
                const int X = t.ax + i, Y = t.ay + j;
                if (X < 0 || Y < 0 || X >= atlas.width || Y >= atlas.height) continue;
                const size_t q = atlas.getIndex(X, Y);
                for (int k = 0; k < 3; ++k) atlas.data[q + k] = baked[o] >= 0 ? toS(baked[o + k]) : (t.M[o] >= 0 ? toS(t.M[o + k]) : 128);
            }
        }
        out.atlas = std::move(atlas);
    }

    const std::string colourSrc = ph.ok ? "photo-inferred: the per-channel median of the scan's own photo texture over each element" : "the nearest appearance class's measured colour (no photo sampled)";
    massing.extras = "{\"sb\":{\"provenance\":\"measured\",\"method\":\"tiers of the tree-free scan's height map (mean-shift levels, squared outlines), each a prism with a flat cap\",\"colour\":\"" + detail::esc(colourSrc) + "\",\"material\":\"photo-inferred: the nearest of pipeline K's measured appearance classes, its library set's maps at real size\"}}";
    openings.extras = "{\"sb\":{\"provenance\":\"photo-inferred\",\"method\":\"pipeline K's kept window boxes (facade reader, else window fit) mapped onto the prism walls, punched and recessed\",\"depthM\":" + detail::num(D) + ",\"depthProvenance\":\"" + detail::esc(S.revealLabel) + "\",\"depthSource\":\"" + detail::esc(S.revealSource) + "\",\"generatedWindows\":" + std::to_string(rep.windowsGenerated) + ",\"colour\":\"" + detail::esc(colourSrc) + "\"}}";
    slender.extras = "{\"sb\":{\"provenance\":\"measured\",\"method\":\"one axis from per-slice circle fits; 95th-percentile sector radii per slice, harmonic smoothing, averaged over the measured order of rotational symmetry; tapered steps by penalised least-squares segmentation of the radius\",\"symmetry\":" + std::to_string(rep.slenderSymmetry) + ",\"fromM\":" + detail::num(slenderH) + ",\"colour\":\"" + detail::esc(colourSrc) + "\"}}";
    ledges.extras = "{\"sb\":{\"provenance\":\"measured\",\"method\":\"each tier wall's scan sections stacked along it into one profile (outermost surface per 0.1 m of height), its continuous steps and parapet swept along the wall, mitred at the corners\",\"walls\":" + std::to_string(rep.profileWalls) + ",\"lips\":" + std::to_string(rep.profileLips) + ",\"parapets\":" + std::to_string(rep.profileParapets) + ",\"colour\":\"" + detail::esc(colourSrc) + "\"}}";
    roofDet.extras = "{\"sb\":{\"provenance\":\"measured\",\"method\":\"the scan's height map against the twin's tiers: connected cells standing above the twin's roof, rebuilt as blocks at the scan's heights in 0.5 m steps (maximal rectangles per height)\",\"pieces\":" + std::to_string(rep.roofDetailPieces) + ",\"colour\":\"" + detail::esc(colourSrc) + "\"}}";
    if (S.P.reliefM > 0 && S.P.scanDetailM <= 0) scanDet.name = "relief_detail";
    scanDet.extras = S.P.reliefM > 0 && S.P.scanDetailM <= 0
        ? "{\"sb\":{\"provenance\":\"measured\",\"method\":\"relief maps of the scan's dense samples on the walls (along, up) and the slender top (height, sector) in " + detail::num(S.P.reliefCellM) + " m cells: what stands at least " + detail::num(S.P.reliefM) + " m off the shell, rebuilt as blocks (no scan surface kept)\",\"source\":\"procedural\",\"colour\":\"" + detail::esc(colourSrc) + "\"}}"
        : "{\"sb\":{\"provenance\":\"measured\",\"method\":\"the scan's own surface (Google 3D Tiles), kept as it is wherever it stands at least " + detail::num(S.P.scanDetailM) + " m outside the procedural shell, in connected pieces\",\"source\":\"scan\",\"pieces\":" + std::to_string(rep.scanDetailPieces) + ",\"colour\":\"" + detail::esc(colourSrc) + "\"}}";
    for (auto* n : {&massing, &openings, &slender, &ledges, &roofDet, &scanDet}) if (!n->prims.empty()) out.nodes.push_back(std::move(*n));
    return out;
}

// =============================================================================================
// GLB writer: the classes' materials (sampling the atlas when there is one, else with their library maps), COLOR_0 as float
// =============================================================================================

inline std::vector<uint8_t> writeGlb(const std::vector<OutNode>& nodes, const std::vector<ClassMat>& classesIn, double glassRoughness, const std::string& rootExtras, size_t& triangles, const texture::ImageBuffer* atlas = nullptr) {
    std::vector<ClassMat> classes = classesIn;
    if (classes.empty()) classes.push_back(ClassMat{"neutral", {60, 0, 0}, 0.8, 0, 2, "", "", false});
    const int glass = static_cast<int>(classes.size());
    std::vector<uint8_t> bin;
    auto align = [&]() { while (bin.size() % 4) bin.push_back(0); };
    std::ostringstream views, accs, meshes, mats, imgs, texs, nodesJ;
    int nView = 0, nAcc = 0, nImg = 0;
    auto addView = [&](const void* data, size_t bytes, int target) {
        align();
        const size_t off = bin.size();
        bin.insert(bin.end(), static_cast<const uint8_t*>(data), static_cast<const uint8_t*>(data) + bytes);
        views << (nView ? "," : "") << "{\"buffer\":0,\"byteOffset\":" << off << ",\"byteLength\":" << bytes << (target ? ",\"target\":" + std::to_string(target) : std::string()) << "}";
        return nView++;
    };
    auto addAcc = [&](int view, int comp, size_t count, const char* type, const std::string& minmax) {
        accs << (nAcc ? "," : "") << "{\"bufferView\":" << view << ",\"componentType\":" << comp << ",\"count\":" << count << ",\"type\":\"" << type << "\"" << minmax << "}";
        return nAcc++;
    };
    // images: each class's normal and ORM maps, once per file
    std::map<std::string, int> imageOf;
    auto image = [&](const std::string& p) -> int {
        if (p.empty()) return -1;
        auto it = imageOf.find(p);
        if (it != imageOf.end()) return it->second;
        const auto bytes = detail::readFile(p);
        if (bytes.size() < 8) return imageOf[p] = -1;
        const int v = addView(bytes.data(), bytes.size(), 0);
        imgs << (nImg ? "," : "") << "{\"bufferView\":" << v << ",\"mimeType\":\"image/png\"}";
        texs << (nImg ? "," : "") << "{\"sampler\":0,\"source\":" << nImg << "}";
        return imageOf[p] = nImg++;
    };
    // the wall detail atlas (the detailed materials sample it through their elements' TEXCOORD_0)
    int atlasIm = -1;
    if (atlas && !atlas->empty()) {
        const auto bytes = png::encode(*atlas, 6);
        if (!bytes.empty()) {
            const int v = addView(bytes.data(), bytes.size(), 0);
            imgs << (nImg ? "," : "") << "{\"bufferView\":" << v << ",\"mimeType\":\"image/png\"}";
            texs << (nImg ? "," : "") << "{\"sampler\":1,\"source\":" << nImg << "}";
            atlasIm = nImg++;
        }
    }
    // materials: the classes and glass, then (with an atlas) the same again sampling it, at glass + 1 + class
    const int nMat = atlasIm >= 0 ? 2 * (glass + 1) : glass + 1;
    for (int mi = 0; mi < nMat; ++mi) {
        if (mi) mats << ",";
        const int m = mi % (glass + 1);
        const bool detailed = mi > glass;
        const std::string base = detailed ? ",\"baseColorTexture\":{\"index\":" + std::to_string(atlasIm) + "}" : std::string();
        const std::string detailNote = detailed ? ",\"detail\":\"photo-inferred: the wall's own photo, each texel the median over its storey repeats, each element's measured colour baked in as a gain\"" : std::string();
        if (m == glass) {
            mats << "{\"name\":\"glass" << (detailed ? "+detail" : "") << "\",\"pbrMetallicRoughness\":{\"baseColorFactor\":[1,1,1,1],\"metallicFactor\":0,\"roughnessFactor\":" << detail::num(glassRoughness) << base << "},\"extras\":{\"sb\":{\"provenance\":\"photo-inferred\",\"finish\":\"a smooth dielectric (glazing)\"" << detailNote << "}}}";
            continue;
        }
        const auto& c = classes[m];
        // a detailed element's UVs are the atlas's: the library's tiled maps stay on the flat-coloured elements
        const int nIm = detailed || atlasIm >= 0 ? -1 : image(c.normalPng), oIm = detailed || atlasIm >= 0 ? -1 : image(c.ormPng);  // with an atlas, only the detailed materials are used
        mats << "{\"name\":\"" << detail::esc(c.name) << (detailed ? "+detail" : "") << "\",\"pbrMetallicRoughness\":{\"baseColorFactor\":[1,1,1,1],\"metallicFactor\":" << detail::num(c.metallic) << ",\"roughnessFactor\":" << detail::num(c.roughness) << base
             << (oIm >= 0 ? ",\"metallicRoughnessTexture\":{\"index\":" + std::to_string(oIm) + "}" : std::string()) << "}"
             << (nIm >= 0 ? ",\"normalTexture\":{\"index\":" + std::to_string(nIm) + "}" : std::string())
             << (oIm >= 0 ? ",\"occlusionTexture\":{\"index\":" + std::to_string(oIm) + "}" : std::string())
             << ",\"extras\":{\"sb\":{\"provenance\":\"photo-inferred\",\"set\":\"" << detail::esc(c.name) << "\",\"tileM\":" << detail::num(c.tileM) << detailNote << "}}}";
    }
    triangles = 0;
    int nMesh = 0;
    for (size_t ni = 0; ni < nodes.size(); ++ni) {
        const auto& nd = nodes[ni];
        std::ostringstream prims;
        int np = 0;
        for (const auto& [mat, p] : nd.prims) {
            if (p.idx.empty()) continue;
            const size_t nv = p.pos.size() / 3;
            float lo[3] = {1e30f, 1e30f, 1e30f}, hi[3] = {-1e30f, -1e30f, -1e30f};
            for (size_t i = 0; i < nv; ++i) for (int k = 0; k < 3; ++k) { lo[k] = std::min(lo[k], p.pos[3 * i + k]); hi[k] = std::max(hi[k], p.pos[3 * i + k]); }
            char mm[200];
            std::snprintf(mm, sizeof mm, ",\"min\":[%.6g,%.6g,%.6g],\"max\":[%.6g,%.6g,%.6g]", lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]);
            const int aP = addAcc(addView(p.pos.data(), p.pos.size() * 4, 34962), 5126, nv, "VEC3", mm);
            const int aN = addAcc(addView(p.nrm.data(), p.nrm.size() * 4, 34962), 5126, nv, "VEC3", "");
            const int aT = addAcc(addView(p.uv.data(), p.uv.size() * 4, 34962), 5126, nv, "VEC2", "");
            const int aC = addAcc(addView(p.col.data(), p.col.size() * 4, 34962), 5126, nv, "VEC3", "");
            const int aI = addAcc(addView(p.idx.data(), p.idx.size() * 4, 34963), 5125, p.idx.size(), "SCALAR", "");
            prims << (np++ ? "," : "") << "{\"attributes\":{\"POSITION\":" << aP << ",\"NORMAL\":" << aN << ",\"TEXCOORD_0\":" << aT << ",\"COLOR_0\":" << aC << "},\"indices\":" << aI << ",\"material\":" << std::min(mat, nMat - 1) << ",\"mode\":4}";
            triangles += p.idx.size() / 3;
        }
        if (!np) continue;
        meshes << (nMesh ? "," : "") << "{\"name\":\"" << detail::esc(nd.name) << "\",\"primitives\":[" << prims.str() << "]}";
        nodesJ << (nMesh ? "," : "") << "{\"name\":\"" << detail::esc(nd.name) << "\",\"mesh\":" << nMesh << (nd.extras.empty() ? std::string() : ",\"extras\":" + nd.extras) << "}";
        ++nMesh;
    }
    align();
    std::ostringstream J;
    J << "{\"asset\":{\"version\":\"2.0\",\"generator\":\"Scratchbox measured procedural twin\"}";
    if (!rootExtras.empty()) J << ",\"extras\":" << rootExtras;
    J << ",\"scene\":0,\"scenes\":[{\"nodes\":[";
    for (int i = 0; i < nMesh; ++i) J << (i ? "," : "") << i;
    J << "]" << (rootExtras.empty() ? std::string() : ",\"extras\":" + rootExtras) << "}],\"nodes\":[" << nodesJ.str() << "],\"meshes\":[" << meshes.str() << "],\"materials\":[" << mats.str() << "]";
    if (nImg) J << ",\"images\":[" << imgs.str() << "],\"textures\":[" << texs.str() << "],\"samplers\":[{\"magFilter\":9729,\"minFilter\":9987,\"wrapS\":10497,\"wrapT\":10497},{\"magFilter\":9729,\"minFilter\":9987,\"wrapS\":33071,\"wrapT\":33071}]";
    J << ",\"accessors\":[" << accs.str() << "],\"bufferViews\":[" << views.str() << "],\"buffers\":[{\"byteLength\":" << bin.size() << "}]}";
    std::string json = J.str();
    while (json.size() % 4) json += ' ';
    std::vector<uint8_t> glb;
    auto u32 = [&](uint32_t v) { for (int k = 0; k < 4; ++k) glb.push_back(static_cast<uint8_t>(v >> (8 * k))); };
    u32(0x46546C67); u32(2); u32(static_cast<uint32_t>(12 + 8 + json.size() + 8 + bin.size()));
    u32(static_cast<uint32_t>(json.size())); u32(0x4E4F534A); glb.insert(glb.end(), json.begin(), json.end());
    u32(static_cast<uint32_t>(bin.size())); u32(0x004E4942); glb.insert(glb.end(), bin.begin(), bin.end());
    return glb;
}

inline std::string reportJson(const Report& r, const Spec& S, size_t triangles, size_t bytes) {
    std::ostringstream o;
    o << "{\"ok\":true,\"tiers\":" << r.tiers << ",\"wallFaces\":" << r.wallFaces << ",\"facesWithWindows\":" << r.facesWithWindows
      << ",\"wallCells\":" << r.wallCells << ",\"roofCells\":" << r.roofCells << ",\"capsCut\":" << r.capsCut << ",\"detail\":{\"faces\":" << r.facesTextured << ",\"texels\":" << r.texelsDetail << ",\"atlas\":[" << r.atlasW << "," << r.atlasH << "],\"texelM\":" << detail::num(r.detailTexelM) << ",\"paletteColours\":" << r.paletteColours << "}" << ",\"profiles\":{\"walls\":" << r.profileWalls << ",\"lips\":" << r.profileLips << ",\"parapets\":" << r.profileParapets << ",\"steps\":" << r.profileSteps << ",\"medianOutM\":" << detail::num(r.profileMedianOutM) << ",\"medianParapetM\":" << detail::num(r.profileMedianParapetM) << "}" << ",\"roofDetail\":{\"pieces\":" << r.roofDetailPieces << ",\"boxes\":" << r.roofDetailBoxes << ",\"areaM2\":" << detail::num(r.roofDetailAreaM2) << ",\"medianM\":" << detail::num(r.roofDetailMedianM) << "}" << ",\"scanDetail\":{\"thresholdM\":" << detail::num(S.P.scanDetailM) << ",\"pieces\":" << r.scanDetailPieces << ",\"triangles\":" << r.scanDetailTriangles << ",\"areaM2\":" << detail::num(r.scanDetailAreaM2) << "}" << ",\"relief\":{\"thresholdM\":" << detail::num(S.P.reliefM) << ",\"wallPieces\":" << r.reliefWallPieces << ",\"wallBoxes\":" << r.reliefWallBoxes << ",\"wallAreaM2\":" << detail::num(r.reliefWallAreaM2) << ",\"mastPieces\":" << r.reliefMastPieces << ",\"mastCells\":" << r.reliefMastCells << "}" 
      << ",\"windows\":{\"given\":" << r.windowsGiven << ",\"placed\":" << r.windowsPlaced << ",\"generated\":" << r.windowsGenerated << ",\"continued\":" << r.windowsContinued << ",\"rephased\":" << r.windowsRephased << ",\"wallsRephased\":" << r.wallsRephased << ",\"continueTested\":" << r.continueTested << ",\"panes\":" << r.panesPlaced
      << ",\"dropped\":{\"noWall\":" << r.droppedNoWall << ",\"clipped\":" << r.droppedClipped << ",\"overlap\":" << r.droppedOverlap << ",\"small\":" << r.droppedSmall << ",\"noFrame\":" << r.droppedNoFrame << "}}"
      << ",\"colour\":{\"elements\":" << r.colouredElements << ",\"uncoloured\":" << r.uncolouredElements << "}"
      << ",\"slender\":{\"fromM\":" << detail::num(r.slenderFromM) << ",\"slices\":" << r.slenderSlices << ",\"bands\":" << r.slenderBands << ",\"axisFits\":" << r.slenderAxisFits << ",\"symmetry\":" << r.slenderSymmetry << ",\"finBands\":" << r.finBands << ",\"fins\":" << r.finCount << ",\"finSegments\":" << r.finSegments << "}" << ",\"heads\":{\"types\":" << r.headTypes << ",\"windows\":" << r.headWindows << ",\"drawn\":" << r.headsDrawn << ",\"surfacePieces\":" << r.surfacePieces << ",\"surfaceQuads\":" << r.surfaceQuads << ",\"selfWalls\":" << r.selfWalls << ",\"selfWindowWalls\":" << r.selfWindowWalls << ",\"selfWindows\":" << r.selfWindows << ",\"medianRiseM\":" << detail::num([&] { auto v = r.headRises; if (v.empty()) return 0.0; std::nth_element(v.begin(), v.begin() + v.size() / 2, v.end()); return v[v.size() / 2]; }()) << "}"
      << ",\"topM\":" << detail::num(r.topM) << ",\"revealM\":" << detail::num(S.revealM) << ",\"revealLabel\":\"" << detail::esc(S.revealLabel) << "\""
      << ",\"triangles\":" << triangles << ",\"bytes\":" << bytes << ",\"classUse\":{";
    bool first = true;
    for (const auto& [k, n] : r.classUse) { o << (first ? "" : ",") << "\"" << k << "\":" << n; first = false; }
    o << "},\"notes\":[";
    for (size_t i = 0; i < r.notes.size(); ++i) o << (i ? "," : "") << "\"" << detail::esc(r.notes[i]) << "\"";
    o << "]}";
    return o.str();
}

}  // namespace measured_twin
}  // namespace scratchbox

#endif  // SCRATCHBOX_MEASURED_TWIN_HPP
