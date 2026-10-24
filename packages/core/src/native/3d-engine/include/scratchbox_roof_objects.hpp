/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The objects standing on a roof, each found and fitted from two measurements that sharpen each other:
 *  - the scan's height over the roof (a 0.5 m height map of the structure's samples): what stands up, and how high;
 *  - the photo straight down (the tile photo rendered top-down, optional): where an object's edge is, where the scan
 *    blurs it. The bare roof's own colour is learnt from the cells that lie on the roof plane; a cell whose colour departs
 *    from it, next to a raised cell, belongs to the object.
 * Each object's outline comes from those cells; its height from the scan. It is fitted by the simplest of three
 * candidates that explains its own scan samples (scan_massing::agreement, at a tolerance scaled to its size): its outline
 * raised to its height; a solid of revolution with the measured radius at each height (offered only when its outline is
 * round); its own lofted sections (legs, stacked parts). Nothing here names an object type: a tank, a bulkhead, a vent or
 * anything nobody anticipated is an outline, a height and a measured profile.
 */

#pragma once

#include "scratchbox_scan_massing.hpp"

#include <array>
#include <optional>

namespace scratchbox {
namespace roof_objects {

using geometry::Vec3;
using geometry::ScratchboxMesh;
using scan_massing::P2;

/** An RGBA image straight down over the frame (x0, z0 at pixel 0,0; texelM metres per pixel; +x right, +z down). */
struct TopPhoto { const uint8_t* rgba = nullptr; int width = 0, height = 0; double x0 = 0, z0 = 0, texelM = 0.05; };

struct RoofParams {
    double cellM = 0.5;
    /** Least height above the roof plane for a cell to stand up (m). */
    double minRiseM = 0.6;
    /** Neighbouring raised cells whose heights differ by more than this belong to different objects (m). */
    double jumpM = 1.5;
    /** Least footprint of an object (m2). */
    double minAreaM2 = 1.0;  // photo-led: 1.5 (colour noise)
    /** A colour this far from the bare roof (CIELAB delta E, and at least madK x the roof's own spread) marks an object edge. */
    double minDeltaE = 10, madK = 3;
    /** A plan outline whose distances from its centre vary by at most this share is offered a solid of revolution. */
    double roundCv = 0.12;
    double minCoverage = 0.85, minPrecision = 0.8;
    // photo-led (roofObjectsFromPhoto)
    /** Pixel size the photo is read at (m). */
    double pixelM = 0.1;
    /** A neighbouring pixel joins a region while its colour is within this of the region's mean (delta E). */
    double regionDeltaE = 12;
    /** An outline this round (sd / mean distance from its centre) is a solid of revolution. */
    double photoRoundCv = 0.08;
    /** Height given to a region that differs in colour but does not stand up in the scan (m, labelled estimated). */
    double flushHeightM = 0.3;
    /** How far the scan smears a tall object sideways (m: about the tiles' geometric error); a lower object reads no
     *  height within this of a taller one. */
    double blurM = 1.5;
    /** Neighbouring photo regions whose measured tops differ by at most this are one object (m). */
    double mergeRiseM = 0.4;
    /** Outline edges within this of the building's wall directions are snapped to them (degrees). */
    double squareTolDeg = 15;
    /** Small spots (m2) that line up in rows of at least minPosts at a steady spacing are posts, repeated along the row. */
    double minPostAreaM2 = 0.02, maxPostAreaM2 = 0.6, rowTolM = 0.25, maxPostGapM = 4.0, maxGapCv = 0.35;
    int minPosts = 5;
    /** Height of a post the scan is too coarse to see (m, labelled estimated: a guard rail's usual height). */
    double postHeightM = 1.07;
    /** A spot this much lighter than the bare roof (CIELAB L*) is a candidate post, whatever region it touches. */
    double spotLighterL = 30;
};

/**
 * The ring straightened toward two directions at right angles (axisRad and axisRad + 90 degrees): after a light
 * simplification, every edge within tolDeg of one of them is turned onto it about its midpoint, and consecutive edges
 * are re-intersected (an edge left off-axis keeps its own direction). Short edges that end up parallel to both
 * neighbours are dropped. A footprint traced from pixels or cells comes back with the building's own right angles.
 */
inline std::vector<P2> squareToAxes(const std::vector<P2>& ringIn, double axisRad, double tolDeg, double simplifyTol) {
    std::vector<P2> r = scan_massing::detail::simplify(ringIn, simplifyTol);
    const size_t n = r.size();
    if (n < 4) return r;
    struct L { P2 p, d; };
    std::vector<L> lines(n);
    const double tol = tolDeg * M_PI / 180;
    for (size_t i = 0; i < n; ++i) {
        const P2 a = r[i], b = r[(i + 1) % n];
        const P2 m{(a.x + b.x) / 2, (a.z + b.z) / 2};
        double ang = std::atan2(b.z - a.z, b.x - a.x);
        // nearest of the four axis directions
        double best = ang, bd = 1e9;
        for (int q = 0; q < 4; ++q) {
            const double t = axisRad + q * M_PI / 2;
            const double dd = std::abs(std::remainder(ang - t, 2 * M_PI));
            if (dd < bd) { bd = dd; best = t; }
        }
        if (bd <= tol) ang = best;
        lines[i] = {m, {std::cos(ang), std::sin(ang)}};
    }
    std::vector<P2> out;
    for (size_t i = 0; i < n; ++i) {
        const L& l0 = lines[(i + n - 1) % n];
        const L& l1 = lines[i];
        const double den = l0.d.x * l1.d.z - l0.d.z * l1.d.x;
        if (std::abs(den) < 1e-6) continue;  // parallel neighbours: the corner between them is not a corner
        const double t = ((l1.p.x - l0.p.x) * l1.d.z - (l1.p.z - l0.p.z) * l1.d.x) / den;
        const P2 c{l0.p.x + t * l0.d.x, l0.p.z + t * l0.d.z};
        // a re-intersection far from the original corner means the edges were nearly parallel: keep the original corner
        out.push_back(std::hypot(c.x - r[i].x, c.z - r[i].z) > 4 * simplifyTol + 0.5 ? r[i] : c);
    }
    return out.size() >= 3 ? out : r;
}

struct RoofObject {
    std::vector<P2> outline;
    P2 centre;
    double baseY, topY, areaM2;
    /** Cells whose edge the photo set (the rest are the scan's). */
    size_t photoCells = 0, scanCells = 0;
    std::string chosen, why;
    /** Where the outline and the height came from: 'photo' / 'scan' and 'scan' / 'estimated' (a flush feature's height). */
    std::string outlineSource = "scan", heightSource = "scan";
    /** The outline's roundness (sd / mean of its distances from the centre). */
    double roundness = 1;
    scan_massing::Agreement agreement;
    ScratchboxMesh mesh;
    std::vector<scan_massing::CandidateRow> candidates;
};

struct RoofReport {
    double roofY;
    double roofDeltaEMedian = 0, roofDeltaEMad = 0;
    bool photo = false;
    /** Areas the photo marks as different from the bare roof with nothing standing up in the scan (flush or thin things). */
    size_t photoOnlyAreas = 0;
    std::vector<RoofObject> objects;
};

namespace detail {
inline void srgbToLab(double r8, double g8, double b8, double& L, double& a, double& b) {
    auto lin = [](double c) { c /= 255.0; return c <= 0.04045 ? c / 12.92 : std::pow((c + 0.055) / 1.055, 2.4); };
    const double r = lin(r8), g = lin(g8), bl = lin(b8);
    double X = (0.4124 * r + 0.3576 * g + 0.1805 * bl) / 0.95047, Y = 0.2126 * r + 0.7152 * g + 0.0722 * bl, Z = (0.0193 * r + 0.1192 * g + 0.9505 * bl) / 1.08883;
    auto f = [](double t) { return t > 0.008856 ? std::cbrt(t) : 7.787 * t + 16.0 / 116; };
    const double fx = f(X), fy = f(Y), fz = f(Z);
    L = 116 * fy - 16; a = 500 * (fx - fy); b = 200 * (fy - fz);
}
inline double median(std::vector<double> v) { if (v.empty()) return 0; std::nth_element(v.begin(), v.begin() + v.size() / 2, v.end()); return v[v.size() / 2]; }
}  // namespace detail

/** The circle rings of a measured radius profile, skinned by Loft3D (a solid of revolution about a vertical axis). */
inline ScratchboxMesh revolveProfile(P2 c, const std::vector<std::pair<double, double>>& yr, int sides = 32) {
    std::vector<std::vector<Vec3>> rings;
    for (const auto& [y, r] : yr) {
        std::vector<Vec3> ring;
        for (int k = 0; k < sides; ++k) {
            const double t = 2 * M_PI * k / sides;
            ring.push_back(Vec3(static_cast<float>(c.x + r * std::cos(t)), static_cast<float>(y), static_cast<float>(c.z + r * std::sin(t))));
        }
        rings.push_back(std::move(ring));
    }
    return rings.size() >= 2 ? shaper::Loft3D::skin(rings, true) : ScratchboxMesh("empty");
}

/**
 * The objects on the roof of a structure: `samples` its scan (sampleSurface), `plan` its footprint (walls on the scan),
 * `roofY` the roof plane, `photo` the photo straight down (optional).
 */
inline RoofReport roofObjects(const std::vector<Vec3>& samples, const std::vector<P2>& plan, double roofY, const TopPhoto* photo = nullptr, const RoofParams& P = {}) {
    RoofReport rep;
    rep.roofY = roofY;
    rep.photo = photo && photo->rgba && photo->width > 0;
    const std::vector<std::vector<P2>> rings{plan};
    double xa = 1e18, xb = -1e18, za = 1e18, zb = -1e18;
    for (const auto& p : plan) { xa = std::min(xa, p.x); xb = std::max(xb, p.x); za = std::min(za, p.z); zb = std::max(zb, p.z); }
    const int i0 = static_cast<int>(std::floor(xa / P.cellM)) - 1, k0 = static_cast<int>(std::floor(za / P.cellM)) - 1;
    const int W = static_cast<int>(std::ceil(xb / P.cellM)) + 1 - i0 + 1, H = static_cast<int>(std::ceil(zb / P.cellM)) + 1 - k0 + 1;
    const size_t N = static_cast<size_t>(W) * H;
    auto cx = [&](int i) { return (i0 + i + 0.5) * P.cellM; };
    auto cz = [&](int k) { return (k0 + k + 0.5) * P.cellM; };
    std::vector<float> dsm(N, -std::numeric_limits<float>::infinity());
    std::vector<uint8_t> inside(N, 0);
    for (int k = 0; k < H; ++k) for (int i = 0; i < W; ++i) inside[k * W + i] = scan_massing::inRings(rings, cx(i), cz(k));
    for (const auto& s : samples) {
        const int i = static_cast<int>(std::floor(s.x / P.cellM)) - i0, k = static_cast<int>(std::floor(s.z / P.cellM)) - k0;
        if (i < 0 || k < 0 || i >= W || k >= H || s.y < roofY - 2.0) continue;
        dsm[k * W + i] = std::max(dsm[k * W + i], s.y);
    }
    // the photo's mean Lab per cell, and the bare roof's colour from the cells on the roof plane
    std::vector<std::array<double, 3>> lab(N, {0, 0, 0});
    std::vector<uint8_t> hasLab(N, 0);
    if (rep.photo) for (int k = 0; k < H; ++k) for (int i = 0; i < W; ++i) {
        double sr = 0, sg = 0, sb = 0; int n = 0;
        const int px0 = static_cast<int>((cx(i) - P.cellM / 2 - photo->x0) / photo->texelM), py0 = static_cast<int>((cz(k) - P.cellM / 2 - photo->z0) / photo->texelM);
        const int per = std::max(1, static_cast<int>(std::lround(P.cellM / photo->texelM)));
        for (int y = 0; y < per; ++y) for (int x = 0; x < per; ++x) {
            const int px = px0 + x, py = py0 + y;
            if (px < 0 || py < 0 || px >= photo->width || py >= photo->height) continue;
            const uint8_t* q = photo->rgba + (static_cast<size_t>(py) * photo->width + px) * 4;
            if (q[3] < 128) continue;
            sr += q[0]; sg += q[1]; sb += q[2]; ++n;
        }
        if (!n) continue;
        detail::srgbToLab(sr / n, sg / n, sb / n, lab[k * W + i][0], lab[k * W + i][1], lab[k * W + i][2]);
        hasLab[k * W + i] = 1;
    }
    std::array<double, 3> roofLab{0, 0, 0};
    double deThreshold = 1e18;
    if (rep.photo) {
        std::vector<double> Ls, as, bs;
        for (size_t c = 0; c < N; ++c) if (inside[c] && hasLab[c] && std::isfinite(dsm[c]) && std::abs(dsm[c] - roofY) < 0.4) { Ls.push_back(lab[c][0]); as.push_back(lab[c][1]); bs.push_back(lab[c][2]); }
        if (Ls.size() >= 20) {
            roofLab = {detail::median(Ls), detail::median(as), detail::median(bs)};
            std::vector<double> des;
            for (size_t j = 0; j < Ls.size(); ++j) des.push_back(std::sqrt(std::pow(Ls[j] - roofLab[0], 2) + std::pow(as[j] - roofLab[1], 2) + std::pow(bs[j] - roofLab[2], 2)));
            rep.roofDeltaEMedian = detail::median(des);
            std::vector<double> dev;
            for (double d : des) dev.push_back(std::abs(d - rep.roofDeltaEMedian));
            rep.roofDeltaEMad = detail::median(dev);
            deThreshold = std::max(P.minDeltaE, rep.roofDeltaEMedian + P.madK * 1.4826 * rep.roofDeltaEMad);
        }
    }
    auto differs = [&](size_t c) { return hasLab[c] && std::sqrt(std::pow(lab[c][0] - roofLab[0], 2) + std::pow(lab[c][1] - roofLab[1], 2) + std::pow(lab[c][2] - roofLab[2], 2)) > deThreshold; };
    std::vector<uint8_t> raised(N, 0), mask(N, 0);
    for (size_t c = 0; c < N; ++c) raised[c] = inside[c] && std::isfinite(dsm[c]) && dsm[c] > roofY + P.minRiseM;
    // the object mask: raised cells, grown into neighbours whose photo colour departs from the bare roof (an edge the
    // scan blurred), within two cells of a raised cell
    for (int k = 0; k < H; ++k) for (int i = 0; i < W; ++i) {
        const size_t c = k * W + i;
        if (!inside[c]) continue;
        if (raised[c]) { mask[c] = 1; continue; }
        if (!differs(c)) continue;
        bool nearRaised = false;
        for (int dk = -2; dk <= 2 && !nearRaised; ++dk) for (int di = -2; di <= 2; ++di) {
            const int ii = i + di, kk = k + dk;
            if (ii >= 0 && kk >= 0 && ii < W && kk < H && raised[kk * W + ii]) { nearRaised = true; break; }
        }
        if (nearRaised) mask[c] = 2;
    }
    // photo-only areas (different colour, nothing standing): counted, not built
    {
        std::vector<uint8_t> seen(N, 0);
        for (size_t s = 0; s < N; ++s) {
            if (seen[s] || !inside[s] || mask[s] || !differs(s)) continue;
            size_t n = 0; std::vector<size_t> st{s}; seen[s] = 1;
            while (!st.empty()) { const size_t c = st.back(); st.pop_back(); ++n; const int i = c % W, k = c / W;
                for (const auto& d : {std::pair{1, 0}, {-1, 0}, {0, 1}, {0, -1}}) { const int ii = i + d.first, kk = k + d.second; if (ii < 0 || kk < 0 || ii >= W || kk >= H) continue; const size_t q = kk * W + ii; if (!seen[q] && inside[q] && !mask[q] && differs(q)) { seen[q] = 1; st.push_back(q); } } }
            if (n * P.cellM * P.cellM >= P.minAreaM2) rep.photoOnlyAreas++;
        }
    }
    // the objects: raised cells joined while neighbouring heights differ by at most jumpM (a tank standing over the ducts
    // beside it is its own object), then the photo's edge cells joined to the object they touch
    std::vector<int> label(N, -1);
    int nLabels = 0;
    for (size_t s = 0; s < N; ++s) {
        if (mask[s] != 1 || label[s] >= 0) continue;
        std::vector<size_t> st{s};
        label[s] = nLabels;
        while (!st.empty()) { const size_t c = st.back(); st.pop_back(); const int i = c % W, k = c / W;
            for (const auto& d : {std::pair{1, 0}, {-1, 0}, {0, 1}, {0, -1}}) { const int ii = i + d.first, kk = k + d.second; if (ii < 0 || kk < 0 || ii >= W || kk >= H) continue; const size_t q = kk * W + ii;
                if (mask[q] == 1 && label[q] < 0 && std::abs(dsm[q] - dsm[c]) <= P.jumpM) { label[q] = nLabels; st.push_back(q); } } }
        ++nLabels;
    }
    {
        std::vector<size_t> frontier;
        for (size_t c = 0; c < N; ++c) if (label[c] >= 0) frontier.push_back(c);
        while (!frontier.empty()) {
            std::vector<size_t> next;
            for (size_t c : frontier) { const int i = c % W, k = c / W;
                for (const auto& d : {std::pair{1, 0}, {-1, 0}, {0, 1}, {0, -1}}) { const int ii = i + d.first, kk = k + d.second; if (ii < 0 || kk < 0 || ii >= W || kk >= H) continue; const size_t q = kk * W + ii;
                    if (mask[q] == 2 && label[q] < 0) { label[q] = label[c]; next.push_back(q); } } }
            frontier.swap(next);
        }
    }
    std::vector<std::vector<size_t>> comps(nLabels);
    for (size_t c = 0; c < N; ++c) if (label[c] >= 0) comps[label[c]].push_back(c);
    for (int L = 0; L < nLabels; ++L) {
        const std::vector<size_t>& comp = comps[L];
        if (comp.size() * P.cellM * P.cellM < P.minAreaM2) continue;
        RoofObject o;
        scan_massing::CellSet cells;
        double sx = 0, sz = 0;
        std::vector<double> tops;
        for (size_t c : comp) {
            const int i = c % W, k = c / W;
            cells.insert(scan_massing::ckey(i0 + i, k0 + k));
            sx += cx(i); sz += cz(k);
            if (mask[c] == 2) o.photoCells++; else o.scanCells++;
            if (std::isfinite(dsm[c]) && dsm[c] > roofY) tops.push_back(dsm[c]);
        }
        o.centre = {sx / comp.size(), sz / comp.size()};
        o.areaM2 = comp.size() * P.cellM * P.cellM;
        o.baseY = roofY;
        std::sort(tops.begin(), tops.end());
        o.topY = tops.empty() ? roofY + P.minRiseM : tops[std::min(tops.size() - 1, static_cast<size_t>(0.95 * tops.size()))];
        auto loop = scan_massing::outline(cells);
        for (auto& p : loop) { p.x *= P.cellM; p.z *= P.cellM; }
        o.outline = loop;
        // the object's own scan: samples over its cells, above the roof plane
        std::vector<Vec3> own;
        for (const auto& s2 : samples) {
            if (s2.y < roofY + 0.2) continue;
            const int i = static_cast<int>(std::floor(s2.x / P.cellM)) - i0, k = static_cast<int>(std::floor(s2.z / P.cellM)) - k0;
            if (i < 0 || k < 0 || i >= W || k >= H) continue;
            bool near = false;
            for (int dk = -1; dk <= 1 && !near; ++dk) for (int di = -1; di <= 1; ++di) { const int ii = i + di, kk = k + dk; if (ii >= 0 && kk >= 0 && ii < W && kk < H && label[kk * W + ii] == L) { near = true; break; } }
            if (near) { own.push_back(s2); if (s2.y > o.topY) o.topY = std::max(o.topY, static_cast<double>(s2.y)); }
        }
        // tolerance scaled to the object's size
        scan_massing::AgreementOptions ao;
        ao.tauM = std::clamp(0.05 * std::sqrt(o.areaM2) + 0.15, 0.25, 0.6);
        ao.bandM = std::max(0.5, (o.topY - o.baseY) / 8);
        ao.minBandSamples = 8;
        ao.groundY = roofY;
        std::vector<std::pair<std::string, std::pair<size_t, scan_massing::Agreement>>> rows;
        // each candidate with the count of numbers that describe it (its simplicity): candidates are judged simplest first
        struct Cand { std::string name; ScratchboxMesh mesh; size_t parameters; };
        std::vector<Cand> meshes;
        // 1. the outline raised to its height
        // (traced from the object's own samples on a 0.25 m grid: the 0.5 m detection cells stand up to half a cell proud)
        {
            std::vector<P2> fine;
            if (own.size() >= 10) fine = scan_massing::planOutline(scan_massing::slices(own, o.baseY, scan_massing::SliceParams{o.topY - o.baseY + 1, 0.25, 0.5}), 0.25);
            if (fine.size() >= 3) o.outline = fine;
            const auto simple = scan_massing::detail::simplify(o.outline, 0.15);
            meshes.push_back({"outline raised", scan_massing::extrudeBlock(simple, o.baseY, o.topY), 2 * simple.size() + 2});
        }
        // 2. a solid of revolution, when the outline is round: the radius at each height measured from the object's samples
        double meanD = 0, sdD = 0;
        for (const auto& p : o.outline) meanD += std::hypot(p.x - o.centre.x, p.z - o.centre.z);
        meanD /= std::max<size_t>(1, o.outline.size());
        for (const auto& p : o.outline) sdD += std::pow(std::hypot(p.x - o.centre.x, p.z - o.centre.z) - meanD, 2);
        sdD = std::sqrt(sdD / std::max<size_t>(1, o.outline.size()));
        if (meanD > 0 && sdD / meanD <= P.roundCv && !own.empty()) {
            const double band = std::max(0.25, (o.topY - o.baseY) / 24);
            std::map<int, std::vector<double>> byBand;
            for (const auto& p : own) byBand[static_cast<int>(std::floor((p.y - o.baseY) / band))].push_back(std::hypot(p.x - o.centre.x, p.z - o.centre.z));
            std::vector<std::pair<double, double>> yr{{o.baseY, 0.0}};
            for (const auto& [b, ds] : byBand) if (ds.size() >= 3) yr.push_back({o.baseY + (b + 0.5) * band, detail::median(ds)});
            yr.push_back({o.topY, 0.0});
            if (yr.size() >= 4) meshes.push_back({"solid of revolution", revolveProfile(o.centre, yr), 2 * yr.size() + 2});
        }
        // 3. its own lofted sections
        if (own.size() >= 30) {
            const auto sl = scan_massing::slices(own, o.baseY, scan_massing::SliceParams{std::max(0.25, (o.topY - o.baseY) / 30), 0.25, 0.5});
            scan_massing::LoftParams lp; lp.minPieceM2 = 0.1; lp.keepTolM = 0.15; lp.ringPoints = 24;
            const auto runs = scan_massing::loftRuns(sl, 0.25, lp);
            size_t rings = 0;
            for (const auto& r : runs) rings += r.rings.size();
            meshes.push_back({"lofted sections", scan_massing::loftSolids(runs), rings * (2 * static_cast<size_t>(lp.ringPoints) + 1)});
        }
        std::stable_sort(meshes.begin(), meshes.end(), [](const Cand& a, const Cand& b) { return a.parameters < b.parameters; });
        for (const auto& c : meshes) rows.push_back({c.name, {c.mesh.indices.size() / 3, scan_massing::agreement(own, scan_massing::sampleMesh(c.mesh, ao.tauM / 2), ao)}});
        const auto ch = scan_massing::choose(rows, scan_massing::ChoiceParams{P.minCoverage, P.minPrecision});
        o.candidates = ch.rows;
        o.chosen = ch.chosen >= 0 ? ch.rows[ch.chosen].label : "";
        o.why = ch.why;
        if (ch.chosen >= 0) { o.mesh = meshes[ch.chosen].mesh; o.agreement = ch.rows[ch.chosen].agreement; }
        rep.objects.push_back(std::move(o));
    }
    return rep;
}


/**
 * The roof's objects led by the photo: the roof is split into regions of uniform colour (the bare roof's colour learnt
 * from the cells on the roof plane; a neighbouring pixel joins a region while its colour stays within regionDeltaE of
 * the region's mean), each region's outline comes from the photo and its height from the scan's height map. A round
 * region is a solid of revolution (radius from the photo, the profile under it from the scan, never wider than the
 * photo's radius); any other is its outline raised to its height; a region the scan does not see standing is given
 * flushHeightM, labelled estimated. What stands up in the scan where the photo saw only roof colour (a parapet, a
 * raised strip) is added from the scan. Use when the scan is coarser than the objects (Google tiles: about 2 m).
 */
inline RoofReport roofObjectsFromPhoto(const std::vector<Vec3>& samples, const std::vector<P2>& plan, double roofY, const TopPhoto& photo, const RoofParams& P = {}) {
    RoofReport rep;
    rep.roofY = roofY;
    rep.photo = true;
    const std::vector<std::vector<P2>> rings{plan};
    // the building's wall direction: its footprint's longest edge
    double axis = 0, longest = -1;
    for (size_t i = 0; i < plan.size(); ++i) {
        const P2 a = plan[i], b = plan[(i + 1) % plan.size()];
        const double L = std::hypot(b.x - a.x, b.z - a.z);
        if (L > longest) { longest = L; axis = std::atan2(b.z - a.z, b.x - a.x); }
    }
    // the scan's height map (0.5 m cells), read by world position
    const double hc = P.cellM;
    std::unordered_map<int64_t, float> dsmMap;
    for (const auto& s : samples) {
        if (s.y < roofY - 2.0) continue;
        const int64_t k = scan_massing::ckey(static_cast<int32_t>(std::floor(s.x / hc)), static_cast<int32_t>(std::floor(s.z / hc)));
        auto it = dsmMap.find(k);
        if (it == dsmMap.end() || it->second < s.y) dsmMap[k] = s.y;
    }
    auto dsmAt = [&](double x, double z) {
        const int32_t i = static_cast<int32_t>(std::floor(x / hc)), k = static_cast<int32_t>(std::floor(z / hc));
        float best = -std::numeric_limits<float>::infinity();
        for (int r = 0; r <= 1 && !std::isfinite(best); ++r)
            for (int dk = -r; dk <= r; ++dk) for (int di = -r; di <= r; ++di) { auto it = dsmMap.find(scan_massing::ckey(i + di, k + dk)); if (it != dsmMap.end()) best = std::max(best, it->second); }
        return best;
    };
    // the photo read at pixelM over the plan's box
    double xa = 1e18, xb = -1e18, za = 1e18, zb = -1e18;
    for (const auto& p : plan) { xa = std::min(xa, p.x); xb = std::max(xb, p.x); za = std::min(za, p.z); zb = std::max(zb, p.z); }
    const double px = std::max(P.pixelM, photo.texelM);
    const int W = static_cast<int>(std::ceil((xb - xa) / px)) + 1, H = static_cast<int>(std::ceil((zb - za) / px)) + 1;
    const size_t N = static_cast<size_t>(W) * H;
    auto wx = [&](int i) { return xa + (i + 0.5) * px; };
    auto wz = [&](int k) { return za + (k + 0.5) * px; };
    std::vector<std::array<double, 3>> lab(N);
    std::vector<uint8_t> in(N, 0);
    for (int k = 0; k < H; ++k) for (int i = 0; i < W; ++i) {
        const size_t c = static_cast<size_t>(k) * W + i;
        if (!scan_massing::inRings(rings, wx(i), wz(k))) continue;
        const int per = std::max(1, static_cast<int>(std::lround(px / photo.texelM)));
        const int p0 = static_cast<int>((wx(i) - px / 2 - photo.x0) / photo.texelM), q0 = static_cast<int>((wz(k) - px / 2 - photo.z0) / photo.texelM);
        double sr = 0, sg = 0, sb = 0; int n = 0;
        for (int y = 0; y < per; ++y) for (int x = 0; x < per; ++x) {
            const int pp = p0 + x, qq = q0 + y;
            if (pp < 0 || qq < 0 || pp >= photo.width || qq >= photo.height) continue;
            const uint8_t* q = photo.rgba + (static_cast<size_t>(qq) * photo.width + pp) * 4;
            if (q[3] < 128) continue;
            sr += q[0]; sg += q[1]; sb += q[2]; ++n;
        }
        if (!n) continue;
        detail::srgbToLab(sr / n, sg / n, sb / n, lab[c][0], lab[c][1], lab[c][2]);
        in[c] = 1;
    }
    auto dE = [](const std::array<double, 3>& a, const std::array<double, 3>& b) { return std::sqrt(std::pow(a[0] - b[0], 2) + std::pow(a[1] - b[1], 2) + std::pow(a[2] - b[2], 2)); };
    // the bare roof's colour: pixels whose scan height is on the roof plane
    std::vector<double> Ls, as, bs;
    for (int k = 0; k < H; ++k) for (int i = 0; i < W; ++i) {
        const size_t c = static_cast<size_t>(k) * W + i;
        if (!in[c]) continue;
        const float h = dsmAt(wx(i), wz(k));
        if (std::isfinite(h) && std::abs(h - roofY) < 0.4) { Ls.push_back(lab[c][0]); as.push_back(lab[c][1]); bs.push_back(lab[c][2]); }
    }
    if (Ls.size() < 20) return roofObjects(samples, plan, roofY, &photo, P);
    const std::array<double, 3> roofLab{detail::median(Ls), detail::median(as), detail::median(bs)};
    std::vector<double> des;
    for (size_t j = 0; j < Ls.size(); ++j) des.push_back(dE({Ls[j], as[j], bs[j]}, roofLab));
    rep.roofDeltaEMedian = detail::median(des);
    std::vector<double> dev;
    for (double d : des) dev.push_back(std::abs(d - rep.roofDeltaEMedian));
    rep.roofDeltaEMad = detail::median(dev);
    const double T = std::max(P.minDeltaE, rep.roofDeltaEMedian + P.madK * 1.4826 * rep.roofDeltaEMad);
    std::vector<uint8_t> other(N, 0);
    for (size_t c = 0; c < N; ++c) other[c] = in[c] && dE(lab[c], roofLab) > T;
    // regions of uniform colour among the pixels that are not bare roof
    std::vector<int> reg(N, -1);
    std::vector<std::vector<size_t>> regions;
    for (size_t s = 0; s < N; ++s) {
        if (!other[s] || reg[s] >= 0) continue;
        std::array<double, 3> mean = lab[s];
        size_t n = 1;
        std::vector<size_t> members{s}, st{s};
        reg[s] = static_cast<int>(regions.size());
        while (!st.empty()) {
            const size_t c = st.back(); st.pop_back();
            const int i = c % W, k = c / W;
            for (const auto& d : {std::pair{1, 0}, {-1, 0}, {0, 1}, {0, -1}}) {
                const int ii = i + d.first, kk = k + d.second;
                if (ii < 0 || kk < 0 || ii >= W || kk >= H) continue;
                const size_t q = static_cast<size_t>(kk) * W + ii;
                if (!other[q] || reg[q] >= 0 || dE(lab[q], mean) > P.regionDeltaE) continue;
                reg[q] = reg[s];
                members.push_back(q); st.push_back(q);
                ++n;
                for (int t = 0; t < 3; ++t) mean[t] += (lab[q][t] - mean[t]) / n;
            }
        }
        regions.push_back(std::move(members));
    }
    struct HPt { double x, z, h; };
    std::vector<RoofObject> taller;  // objects already placed, tallest first (their outlines blur the scan around them)
    auto distToRing = [](const std::vector<P2>& r, double x, double z) {
        if (scan_massing::inRings({r}, x, z)) return 0.0;
        double best = 1e18;
        for (size_t i = 0, j = r.size() - 1; i < r.size(); j = i++) {
            const double ax = r[j].x, az = r[j].z, bx = r[i].x, bz = r[i].z, L2 = (bx - ax) * (bx - ax) + (bz - az) * (bz - az);
            const double t = L2 > 0 ? std::clamp(((x - ax) * (bx - ax) + (z - az) * (bz - az)) / L2, 0.0, 1.0) : 0.0;
            best = std::min(best, std::hypot(x - ax - t * (bx - ax), z - az - t * (bz - az)));
        }
        return best;
    };
    auto objectFrom = [&](const std::vector<P2>& outlineIn, const std::vector<HPt>& pts, const std::string& outlineSource) -> std::optional<RoofObject> {
        std::vector<double> heights;
        for (const auto& q : pts) {
            bool blurred = false;
            for (const auto& t : taller) if (t.topY > q.h - 0.01 && t.topY > roofY + 1.0 && distToRing(t.outline, q.x, q.z) <= P.blurM) { blurred = true; break; }
            if (!blurred) heights.push_back(q.h);
        }
        RoofObject o;
        o.outline = scan_massing::detail::simplify(outlineIn, outlineSource == "photo" ? 0.08 : 0.25);
        if (o.outline.size() < 3) return std::nullopt;
        double a2 = 0, cx = 0, cz = 0;
        for (size_t i = 0, j = o.outline.size() - 1; i < o.outline.size(); j = i++) {
            const double cr = o.outline[j].x * o.outline[i].z - o.outline[i].x * o.outline[j].z;
            a2 += cr; cx += (o.outline[j].x + o.outline[i].x) * cr; cz += (o.outline[j].z + o.outline[i].z) * cr;
        }
        if (std::abs(a2) < 1e-9) return std::nullopt;
        o.centre = {cx / (3 * a2), cz / (3 * a2)};
        o.areaM2 = std::abs(a2) / 2;
        o.baseY = roofY;
        o.outlineSource = outlineSource;
        std::vector<double> hs;
        for (double h : heights) if (std::isfinite(h)) hs.push_back(h);
        std::sort(hs.begin(), hs.end());
        const double rise = hs.empty() ? 0 : hs[std::min(hs.size() - 1, static_cast<size_t>(0.9 * hs.size()))] - roofY;
        if (rise >= 0.4) { o.topY = roofY + rise; o.heightSource = "scan"; } else { o.topY = roofY + P.flushHeightM; o.heightSource = "estimated"; }
        // outline roundness, measured on the outline resampled evenly (a polygon's corners would weigh it otherwise)
        const auto even = scan_massing::resampleRing(outlineIn, o.centre, 64);
        double meanD = 0, sdD = 0;
        for (const auto& p : even) meanD += std::hypot(p.x - o.centre.x, p.z - o.centre.z);
        meanD /= even.size();
        for (const auto& p : even) sdD += std::pow(std::hypot(p.x - o.centre.x, p.z - o.centre.z) - meanD, 2);
        o.roundness = meanD > 0 ? std::sqrt(sdD / even.size()) / meanD : 1;
        std::vector<Vec3> own;
        for (const auto& s2 : samples) if (s2.y > roofY + 0.2 && std::hypot(s2.x - o.centre.x, s2.z - o.centre.z) < std::sqrt(o.areaM2) + 1.0 && scan_massing::inRings({o.outline}, s2.x, s2.z)) own.push_back(s2);
        if (o.roundness <= P.photoRoundCv && o.areaM2 >= 1.5 && o.heightSource == "scan") {
            // the profile under the photo's disc: the scan's radius at each height, never wider than the photo's radius
            const double R = meanD, band = std::max(0.5, (o.topY - o.baseY) / 16);
            std::map<int, std::vector<double>> byBand;
            for (const auto& s2 : samples) {
                const double d = std::hypot(s2.x - o.centre.x, s2.z - o.centre.z);
                if (s2.y > roofY + 0.2 && s2.y <= o.topY + 0.5 && d < R + 1.0) byBand[static_cast<int>(std::floor((s2.y - o.baseY) / band))].push_back(d);
            }
            std::vector<std::pair<double, double>> yr{{o.baseY, 0.0}};
            for (const auto& [b, ds] : byBand) if (ds.size() >= 3) { auto v = ds; std::sort(v.begin(), v.end()); yr.push_back({o.baseY + (b + 0.5) * band, std::min(R, v[static_cast<size_t>(0.75 * (v.size() - 1))])}); }
            yr.push_back({o.topY, 0.0});
            if (yr.size() >= 4) { o.mesh = revolveProfile(o.centre, yr); o.chosen = "solid of revolution"; o.why = "round outline in the photo (roundness " + scan_massing::fmt3(o.roundness) + ", radius " + scan_massing::fmt3(R) + " m), profile from the scan"; }
        }
        if (o.chosen.empty()) {
            o.outline = squareToAxes(outlineIn, axis, P.squareTolDeg, outlineSource == "photo" ? 0.2 : 0.3);
            o.mesh = scan_massing::extrudeBlock(o.outline, o.baseY, o.topY);
            o.chosen = "outline raised";
            o.why = "outline from the " + outlineSource + ", height " + (o.heightSource == "scan" ? "from the scan (" + scan_massing::fmt3(o.topY - o.baseY) + " m)" : "estimated (the scan does not see it stand)");
        }
        scan_massing::AgreementOptions ao; ao.tauM = 1.0; ao.bandM = std::max(0.5, (o.topY - o.baseY) / 6); ao.minBandSamples = 5; ao.groundY = roofY;
        if (!own.empty()) o.agreement = scan_massing::agreement(own, scan_massing::sampleMesh(o.mesh, 0.25), ao);
        return o;
    };
    std::vector<uint8_t> covered(N, 0);
    // each region's raw top (its 90th percentile height), then neighbouring regions with like tops merged into one object
    std::vector<double> rawTop(regions.size(), -1e18);
    for (size_t r = 0; r < regions.size(); ++r) {
        std::vector<double> hs;
        for (size_t c : regions[r]) { const float h = dsmAt(wx(c % W), wz(c / W)); if (std::isfinite(h)) hs.push_back(h); }
        std::sort(hs.begin(), hs.end());
        if (!hs.empty()) rawTop[r] = hs[std::min(hs.size() - 1, static_cast<size_t>(0.9 * hs.size()))];
    }
    std::vector<int> parent(regions.size());
    for (size_t r = 0; r < regions.size(); ++r) parent[r] = static_cast<int>(r);
    std::function<int(int)> root = [&](int a) { return parent[a] == a ? a : parent[a] = root(parent[a]); };
    for (size_t c = 0; c < N; ++c) {
        if (reg[c] < 0) continue;
        const int i = c % W, k = c / W;
        for (const auto& d : {std::pair{1, 0}, {0, 1}}) {
            const int ii = i + d.first, kk = k + d.second;
            if (ii >= W || kk >= H) continue;
            const int o = reg[static_cast<size_t>(kk) * W + ii];
            if (o < 0 || o == reg[c]) continue;
            const double ta = rawTop[reg[c]], tb = rawTop[o];
            const bool bothFlush = ta < roofY + 0.4 && tb < roofY + 0.4;
            if (bothFlush || std::abs(ta - tb) <= P.mergeRiseM) parent[root(reg[c])] = root(o);
        }
    }
    std::map<int, std::vector<size_t>> merged;
    for (size_t r = 0; r < regions.size(); ++r) for (size_t c : regions[r]) merged[root(static_cast<int>(r))].push_back(c);
    std::vector<std::pair<double, std::vector<size_t>>> objs;
    for (auto& [rid, cells] : merged) {
        double t = -1e18;
        for (size_t r = 0; r < regions.size(); ++r) if (root(static_cast<int>(r)) == rid) t = std::max(t, rawTop[r]);
        objs.push_back({t, std::move(cells)});
    }
    std::sort(objs.begin(), objs.end(), [](const auto& a, const auto& b) { return a.first > b.first; });
    struct Spot { P2 c; double area; };
    std::vector<Spot> spots;
    for (const auto& [top, r] : objs) {
        const double area = r.size() * px * px;
        if (area < P.minAreaM2) continue;
        scan_massing::CellSet cells;
        std::vector<HPt> pts;
        for (size_t c : r) { const int i = c % W, k = c / W; cells.insert(scan_massing::ckey(i, k)); pts.push_back({wx(i), wz(k), dsmAt(wx(i), wz(k))}); covered[c] = 1; }
        auto loop = scan_massing::outline(cells);
        for (auto& p : loop) { p.x = xa + p.x * px; p.z = za + p.z * px; }
        if (auto o = objectFrom(loop, pts, "photo")) { o->photoCells = r.size(); taller.push_back(*o); rep.objects.push_back(std::move(*o)); }
    }
    // candidate posts: small groups of pixels much lighter than the bare roof (read on their own, so a rail or band they
    // touch does not hide them)
    {
        std::vector<uint8_t> bright(N, 0), seenB(N, 0);
        for (size_t c = 0; c < N; ++c) bright[c] = in[c] && lab[c][0] > roofLab[0] + P.spotLighterL;
        for (size_t s0 = 0; s0 < N; ++s0) {
            if (!bright[s0] || seenB[s0]) continue;
            std::vector<size_t> comp{s0}, st{s0}; seenB[s0] = 1;
            while (!st.empty()) { const size_t c = st.back(); st.pop_back(); const int i = c % W, k = c / W;
                for (const auto& d : {std::pair{1, 0}, {-1, 0}, {0, 1}, {0, -1}}) { const int ii = i + d.first, kk = k + d.second; if (ii < 0 || kk < 0 || ii >= W || kk >= H) continue; const size_t q = static_cast<size_t>(kk) * W + ii;
                    if (bright[q] && !seenB[q]) { seenB[q] = 1; comp.push_back(q); st.push_back(q); } } }
            const double area = comp.size() * px * px;
            if (area < P.minPostAreaM2 || area > P.maxPostAreaM2) continue;
            double sx = 0, sz = 0;
            for (size_t c : comp) { sx += wx(c % W); sz += wz(c / W); }
            spots.push_back({{sx / comp.size(), sz / comp.size()}, area});
        }
    }
    // rows of posts: small spots in a line at a steady spacing (a rail's posts, bollards, anything repeated), each row
    // repeated along its fitted line at the measured spacing; the scan is too coarse to see them stand, so their height is
    // estimated
    {
        std::vector<uint8_t> used(spots.size(), 0);
        for (;;) {
            size_t bestCount = 0; P2 bp{0, 0}, bd{1, 0};
            for (size_t i = 0; i < spots.size(); ++i) for (size_t j = i + 1; j < spots.size(); ++j) {
                if (used[i] || used[j]) continue;
                const double dx = spots[j].c.x - spots[i].c.x, dz = spots[j].c.z - spots[i].c.z, L = std::hypot(dx, dz);
                if (L < 0.3 || L > 3 * P.maxPostGapM) continue;
                const P2 d{dx / L, dz / L};
                size_t cnt = 0;
                for (size_t k = 0; k < spots.size(); ++k) if (!used[k] && std::abs((spots[k].c.x - spots[i].c.x) * d.z - (spots[k].c.z - spots[i].c.z) * d.x) <= P.rowTolM) cnt++;
                if (cnt > bestCount) { bestCount = cnt; bp = spots[i].c; bd = d; }
            }
            if (bestCount < static_cast<size_t>(P.minPosts)) break;
            std::vector<std::pair<double, size_t>> along;
            for (size_t k = 0; k < spots.size(); ++k) if (!used[k] && std::abs((spots[k].c.x - bp.x) * bd.z - (spots[k].c.z - bp.z) * bd.x) <= P.rowTolM) along.push_back({(spots[k].c.x - bp.x) * bd.x + (spots[k].c.z - bp.z) * bd.z, k});
            std::sort(along.begin(), along.end());
            for (const auto& a : along) used[a.second] = 1;
            // split the line into runs where the gap jumps, keep steady runs
            size_t start = 0;
            for (size_t e = 1; e <= along.size(); ++e) {
                if (e < along.size() && along[e].first - along[e - 1].first <= P.maxPostGapM) continue;
                const size_t count = e - start;
                if (count >= static_cast<size_t>(P.minPosts)) {
                    std::vector<double> gaps;
                    for (size_t g = start + 1; g < e; ++g) gaps.push_back(along[g].first - along[g - 1].first);
                    double mean = 0, sd = 0;
                    for (double g : gaps) mean += g;
                    mean /= gaps.size();
                    for (double g : gaps) sd += (g - mean) * (g - mean);
                    sd = std::sqrt(sd / gaps.size());
                    if (mean > 0 && sd / mean <= P.maxGapCv) {
                        std::vector<double> areas;
                        for (size_t g = start; g < e; ++g) areas.push_back(spots[along[g].second].area);
                        const double side = std::sqrt(detail::median(areas));
                        const double t0 = along[start].first, t1 = along[e - 1].first;
                        const int k = static_cast<int>(std::lround((t1 - t0) / mean));
                        const double pitch = k > 0 ? (t1 - t0) / k : mean;
                        RoofObject o;
                        o.outlineSource = "photo"; o.heightSource = "estimated";
                        o.baseY = roofY; o.topY = roofY + P.postHeightM;
                        o.mesh = ScratchboxMesh("posts");
                        for (int q = 0; q <= k; ++q) {
                            const P2 c{bp.x + bd.x * (t0 + q * pitch), bp.z + bd.z * (t0 + q * pitch)};
                            const double h = side / 2;
                            const std::vector<P2> sq{{c.x + bd.x * h - bd.z * h, c.z + bd.z * h + bd.x * h}, {c.x - bd.x * h - bd.z * h, c.z - bd.z * h + bd.x * h},
                                                     {c.x - bd.x * h + bd.z * h, c.z - bd.z * h - bd.x * h}, {c.x + bd.x * h + bd.z * h, c.z + bd.z * h - bd.x * h}};
                            const ScratchboxMesh post = scan_massing::extrudeBlock(sq, o.baseY, o.topY);
                            const uint32_t base = static_cast<uint32_t>(o.mesh.vertices.size());
                            for (const auto& v : post.vertices) o.mesh.vertices.push_back(v);
                            for (uint32_t ix : post.indices) o.mesh.indices.push_back(base + ix);
                        }
                        const P2 a{bp.x + bd.x * t0, bp.z + bd.z * t0}, b{bp.x + bd.x * t1, bp.z + bd.z * t1};
                        o.outline = {a, b, {b.x - bd.z * side, b.z + bd.x * side}, {a.x - bd.z * side, a.z + bd.x * side}};
                        o.centre = {(a.x + b.x) / 2, (a.z + b.z) / 2};
                        o.areaM2 = (k + 1) * side * side;
                        o.photoCells = count;
                        o.chosen = "posts repeated";
                        o.why = std::to_string(k + 1) + " posts " + scan_massing::fmt3(side) + " m square at a " + scan_massing::fmt3(pitch) + " m pitch along " + scan_massing::fmt3(t1 - t0) +
                                " m (" + std::to_string(count) + " seen in the photo; spacing varies " + scan_massing::fmt3(sd / mean) + "), height estimated " + scan_massing::fmt3(P.postHeightM) + " m";
                        rep.objects.push_back(std::move(o));
                    }
                }
                start = e;
            }
        }
    }
    // what stands up in the scan where the photo saw only roof colour (a parapet, a raised strip): from the scan
    scan_massing::CellSet raisedCells;
    for (int k = 0; k < H; ++k) for (int i = 0; i < W; ++i) {
        const size_t c = static_cast<size_t>(k) * W + i;
        if (!in[c] || covered[c]) continue;
        const float h = dsmAt(wx(i), wz(k));
        if (!std::isfinite(h) || h <= roofY + P.minRiseM) continue;
        bool blurred = false;
        for (const auto& t : taller) if (t.topY > h - 0.5 && t.topY > roofY + 1.0 && distToRing(t.outline, wx(i), wz(k)) <= P.blurM) { blurred = true; break; }
        if (!blurred) raisedCells.insert(scan_massing::ckey(i, k));
    }
    scan_massing::CellSet seen;
    for (int64_t c0 : raisedCells) {
        if (seen.count(c0)) continue;
        scan_massing::CellSet comp{c0};
        std::vector<int64_t> st{c0};
        seen.insert(c0);
        std::vector<HPt> hs;
        while (!st.empty()) {
            const int64_t q = st.back(); st.pop_back();
            hs.push_back({wx(scan_massing::ci(q)), wz(scan_massing::ck(q)), dsmAt(wx(scan_massing::ci(q)), wz(scan_massing::ck(q)))});
            for (const int64_t nb : {scan_massing::ckey(scan_massing::ci(q) + 1, scan_massing::ck(q)), scan_massing::ckey(scan_massing::ci(q) - 1, scan_massing::ck(q)), scan_massing::ckey(scan_massing::ci(q), scan_massing::ck(q) + 1), scan_massing::ckey(scan_massing::ci(q), scan_massing::ck(q) - 1)})
                if (raisedCells.count(nb) && !seen.count(nb)) { seen.insert(nb); comp.insert(nb); st.push_back(nb); }
        }
        if (comp.size() * px * px < P.minAreaM2) continue;
        auto loop = scan_massing::outline(comp);
        for (auto& p : loop) { p.x = xa + p.x * px; p.z = za + p.z * px; }
        if (auto o = objectFrom(loop, hs, "scan")) { o->scanCells = comp.size(); rep.objects.push_back(std::move(*o)); }
    }
    return rep;
}

}  // namespace roof_objects
}  // namespace scratchbox
