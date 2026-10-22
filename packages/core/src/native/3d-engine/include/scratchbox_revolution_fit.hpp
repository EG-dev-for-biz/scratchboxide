/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_REVOLUTION_FIT_HPP
#define SCRATCHBOX_REVOLUTION_FIT_HPP

/**
 * Revolution fit: the parts of a scan that are solids of revolution about a vertical axis, found from measurement alone,
 * fitted with a uniform smooth profile first and departures second, and rebuilt clean (universal operator 2: a radial
 * profile r(y) revolved about a vertical axis with K-periodic radial modulation). Nothing here names a kind of structure:
 * a part is accepted because its horizontal sections are circles about one vertical axis, not because of what it is.
 *
 *   1. Detection (plan). The scan's top surface is rasterised (DSM, `cellM`). Every summit (a local maximum standing
 *      `minRiseM` over its surroundings) is grown downwards by a priority flood: at each level (every `levelStepM`) the
 *      region of cells at or above the level joined to the summit is a horizontal section of what stands there. A level
 *      is round when the robust spread of its radial extent along 72 rays from its centroid (1.4826 MAD less half a cell,
 *      over the median) is at most `maxContourSpread` (a regular octagon 0.02, a hexagon 0.04, a square 0.11) and its
 *      centre stays within `centreDrift` r + 0.5 m of the stack's. The stack ends where the levels have failed over
 *      `maxFailM` (the region has joined the roof around it). A stack at least `minStackM` tall and `minRadiusM` wide is
 *      a candidate.
 *   2. Axis (3D). The candidate's scan is sampled (`density` points per square metre) inside a cylinder about the plan
 *      centre; horizontal slices (`sliceM`) are fitted with circles (Kasa, then trimmed at 2.5 robust sigma). A slice
 *      counts when its points fill `minSectorShare` of 24 sectors and its radial RMS is at most max(`maxSliceRmsRel` r,
 *      `sliceRmsFloorM`); at least `minSliceShare` of the slices must count, and their median RMS must be within
 *      `maxSliceRmsRel` of the radius. The axis is vertical through the weighted mean of the counted slices' centres; its
 *      error is their RMS about it; a tilt is fitted (at most `maxTiltDeg`) and reported, not applied.
 *   3. Profile, uniform first. With the axis fixed every point has (r, y, theta); each slice's radius is the half-sample
 *      mode of its points' r (dents and openings pull a median in; the mode stays on the surface most of the scan agrees
 *      on). Above a cap base y0 the meridian is one smooth curve of five continuous numbers,
 *          r(t) = R0 (1 - t^q)^(1/p) (1 + b 4 t (1 - t)),   t = (y - y0) / H,
 *      (p = q = 2 an ellipse, a hemisphere when H = R0; p = q = 1 a cone; p < 1 concave; b > 0 a bulge as an onion),
 *      fitted by Nelder-Mead to the orthogonal distance of the meridian points under a Welsch loss whose scale shrinks to
 *      twice the spread of the points it explains (down to `coreScaleM`). Below y0 the slices form bands: frusta merged
 *      while one straight line explains them within half a ring step (max(`ringStepM`, `ringStepRel` r)) at a taper of
 *      at most `maxTaper`; a band thinner than `minBandM` is allowed only as a ring standing proud of both neighbours (a
 *      cornice), else that y0 is no cap base. Every half slice (at most `maxCapBases`) is tried as y0; of those explaining the scan within
 *      `simplerShare` of the best, the one with the fewest bands (then the lowest) is kept.
 *   4b. Masts. A stack whose base sections are at most `mastStackRadiusShare` of the radius of the stack below and whose
 *      height over radius is at least `mastMinSlenderness`, or the topmost run of a stack's sections at most
 *      `mastMaxRadiusShare` of its base radius that is that slender and changes radius by at most `mastMaxTaperShare` of
 *      itself, is a mast: rebuilt as bands of its own measured section radii (each about its own centre, a ball or collar
 *      where they stand proud), flat at its measured top; the cap below is cut flat at its foot. No cap is put on it.
 *   4. Stacked revolutions. Points standing more than `stackRiseM` above the fitted cap within `stackMaxRadiusShare` of its radius of the
 *      axis, over at least `stackMinAreaM2`, are a second revolution standing on the first (a lantern, a finial): the
 *      cap is refitted without them and they are fitted as their own stack (bands + cap) the same way, up to `maxStacks`.
 *   5. Periodic departures (ribs, facets, lobes). Per part (the bands, the cap) the relative radial residual
 *      e = r / R(y) - 1 is binned over 720 angles (median per bin) and Fourier analysed for k = 1..90. A period k in
 *      [`minPeriods`, 72] scores the sum of its lines at k, 2k, 3k over the sum of their noise floors (each the median
 *      amplitude of its neighbours k-8..k+8: dents are broadband and strongest at low k, a period is a narrow line); the
 *      best (or its fundamental, when that stands out too) is kept when it scores at least `ribSignificance`, swings at
 *      least `ribMinAmpM`, and the lower and upper halves of the part agree on its phase within a quarter period; its
 *      lines 2k, 3k are kept when each is 3 times its floor. A part shorter than `minModulationM` is tested only at the
 *      period the other part kept. Everything else in the residual is noise and is not rebuilt. A kept swing over
 *      `maxModulationRel` rejects the part (polygons of few sides, not circles).
 *   6. Local departures. The residual of the full model over a (5 degree, 0.5 m) grid; connected cells whose median
 *      departs more than `departureM` over at least `departureMinAreaM2` are reported (outward: something stands proud;
 *      inward: a dent or opening), not rebuilt.
 *   7. Geometry. Each stack's meridian (bottom disk sunk `sinkM` into what it stands on, bands, steps, the cap curve) is
 *      revolved with `angularSegments` (at least 16 per period of a kept modulation) into a closed outward-facing solid,
 *      smooth-shaded per meridian run (runs split at corners over 25 degrees).
 *
 * Input: "SBRV" u32 version(1), u32 nTri, nTri * 9 f32 (tile frame: x east, y up, z south). Params are given as
 * "key=value" arguments. Output: report.json (schema scratchbox.revolution-fit/1) and mesh.bin (per accepted
 * revolution, at its offsets: positions f32 x3, normals f32 x3, indices u32).
 */

#include <algorithm>
#include <array>
#include <cmath>
#include <complex>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <functional>
#include <limits>
#include <map>
#include <numeric>
#include <queue>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace scratchbox {
namespace revolution_fit {

constexpr double PI = 3.14159265358979323846;

struct Params {
    // detection (plan)
    double cellM{0.5};
    double peakWindowM{3.0};
    double minRiseM{2.0};
    double levelStepM{0.25};
    double maxRadiusM{30.0};
    double minRadiusM{1.5};
    double minStackM{2.0};
    double maxContourSpread{0.065};
    double centreDrift{0.15};
    double maxFailM{1.0};
    // axis (3D)
    double density{60.0};
    double sliceM{0.4};
    double minSectorShare{0.75};
    double maxSliceRmsRel{0.08};
    double sliceRmsFloorM{0.3};
    int minSlices{4};
    double minSliceShare{0.5};
    double maxTiltDeg{3.0};
    double maxModulationRel{0.06};
    // profile
    double ringStepM{0.3};
    double ringStepRel{0.04};
    double minBandM{0.75};
    double simplerShare{0.05};
    int maxCapBases{64};
    double coreScaleM{0.1};
    double maxTaper{0.25};
    double stackRiseM{0.6};
    double stackMinAreaM2{0.8};
    double stackMaxRadiusShare{0.4};
    double mastMaxRadiusShare{0.35};
    double mastStackRadiusShare{0.15};
    double mastMinSlenderness{4.0};
    double mastMaxTaperShare{3.0};
    double mastMinHeightM{0.8};
    int maxStacks{3};
    // periodic departures
    double ribSignificance{4.0};
    int minPeriods{4};
    double ribMinAmpM{0.05};
    double minModulationM{1.5};
    double bumpPreference{0.8};
    // local departures
    double departureM{0.6};
    double departureMinAreaM2{2.0};
    // geometry
    int angularSegments{192};
    double sinkM{1.0};

    void set(const std::string& k, double v) {
        std::map<std::string, double*> m{{"cellM", &cellM}, {"peakWindowM", &peakWindowM}, {"minRiseM", &minRiseM}, {"levelStepM", &levelStepM},
            {"maxRadiusM", &maxRadiusM}, {"minRadiusM", &minRadiusM}, {"minStackM", &minStackM}, {"maxContourSpread", &maxContourSpread},
            {"centreDrift", &centreDrift}, {"maxFailM", &maxFailM}, {"density", &density}, {"sliceM", &sliceM}, {"minSectorShare", &minSectorShare},
            {"maxSliceRmsRel", &maxSliceRmsRel}, {"minSliceShare", &minSliceShare}, {"maxTiltDeg", &maxTiltDeg}, {"maxModulationRel", &maxModulationRel}, {"sliceRmsFloorM", &sliceRmsFloorM}, {"ringStepM", &ringStepM}, {"ringStepRel", &ringStepRel}, {"minBandM", &minBandM}, {"simplerShare", &simplerShare}, {"coreScaleM", &coreScaleM}, {"maxTaper", &maxTaper},
            {"stackRiseM", &stackRiseM}, {"stackMinAreaM2", &stackMinAreaM2}, {"stackMaxRadiusShare", &stackMaxRadiusShare}, {"mastMaxRadiusShare", &mastMaxRadiusShare}, {"mastStackRadiusShare", &mastStackRadiusShare}, {"mastMinSlenderness", &mastMinSlenderness}, {"mastMaxTaperShare", &mastMaxTaperShare}, {"mastMinHeightM", &mastMinHeightM}, {"ribSignificance", &ribSignificance}, {"ribMinAmpM", &ribMinAmpM}, {"minModulationM", &minModulationM}, {"bumpPreference", &bumpPreference},
            {"departureM", &departureM}, {"departureMinAreaM2", &departureMinAreaM2}, {"sinkM", &sinkM}};
        if (k == "minSlices") { minSlices = static_cast<int>(v); return; }
        if (k == "maxStacks") { maxStacks = static_cast<int>(v); return; }
        if (k == "minPeriods") { minPeriods = static_cast<int>(v); return; }
        if (k == "maxCapBases") { maxCapBases = static_cast<int>(v); return; }
        if (k == "angularSegments") { angularSegments = static_cast<int>(v); return; }
        auto it = m.find(k);
        if (it == m.end()) throw std::runtime_error("unknown parameter " + k);
        *it->second = v;
    }
};

struct Pt { double x, y, z; };

namespace detail {

inline std::string num(double v) {
    if (!std::isfinite(v)) return "null";
    char b[40]; std::snprintf(b, sizeof b, "%.6g", v); return b;
}
inline std::string jstr(const std::string& s) {
    std::string o = "\"";
    for (char c : s) { if (c == '"' || c == '\\') { o += '\\'; o += c; } else if (static_cast<unsigned char>(c) < 0x20) o += ' '; else o += c; }
    return o + "\"";
}
inline double median(std::vector<double> v) {
    if (v.empty()) return std::numeric_limits<double>::quiet_NaN();
    auto m = v.begin() + v.size() / 2;
    std::nth_element(v.begin(), m, v.end());
    return *m;
}
inline double mad(const std::vector<double>& v, double med) {
    std::vector<double> d; d.reserve(v.size());
    for (double x : v) d.push_back(std::abs(x - med));
    return median(d);
}
/**
 * Half-sample mode (Bickel and Fruehwirth): the densest value. A section's radius is its scan's surface where most of it
 * lies; dents and openings pull a median inwards, the mode stays on the surface while they cover less than half of it.
 */
inline double halfSampleMode(std::vector<double> v) {
    if (v.empty()) return std::numeric_limits<double>::quiet_NaN();
    std::sort(v.begin(), v.end());
    size_t lo = 0, n = v.size();
    while (n > 3) {
        const size_t h = (n + 1) / 2;
        size_t best = lo; double w = 1e300;
        for (size_t i = lo; i + h - 1 < lo + n; ++i) { const double d = v[i + h - 1] - v[i]; if (d < w) { w = d; best = i; } }
        lo = best; n = h;
    }
    if (n == 3) {
        const double a = v[lo + 1] - v[lo], b = v[lo + 2] - v[lo + 1];
        return a < b ? 0.5 * (v[lo] + v[lo + 1]) : a > b ? 0.5 * (v[lo + 1] + v[lo + 2]) : v[lo + 1];
    }
    return n == 2 ? 0.5 * (v[lo] + v[lo + 1]) : v[lo];
}
inline double wrapPi(double a) { while (a > PI) a -= 2 * PI; while (a < -PI) a += 2 * PI; return a; }

/** Kasa least-squares circle in (x, z). */
inline bool kasa(const std::vector<Pt>& p, double& cx, double& cz, double& r) {
    if (p.size() < 4) return false;
    double mx = 0, mz = 0;
    for (const auto& q : p) { mx += q.x; mz += q.z; }
    mx /= p.size(); mz /= p.size();
    double suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
    for (const auto& q : p) {
        const double u = q.x - mx, v = q.z - mz;
        suu += u * u; svv += v * v; suv += u * v; suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u;
    }
    const double det = suu * svv - suv * suv;
    if (std::abs(det) < 1e-12) return false;
    const double b1 = 0.5 * (suuu + suvv), b2 = 0.5 * (svvv + svuu);
    const double uc = (b1 * svv - b2 * suv) / det, vc = (suu * b2 - suv * b1) / det;
    cx = mx + uc; cz = mz + vc;
    r = std::sqrt(uc * uc + vc * vc + (suu + svv) / p.size());
    return std::isfinite(r);
}

/** Nelder-Mead minimisation (bounded by clamping inside f). */
inline std::vector<double> nelderMead(const std::function<double(const std::vector<double>&)>& f, std::vector<double> x0, const std::vector<double>& step, int maxEval, double& fBest) {
    const size_t n = x0.size();
    std::vector<std::vector<double>> s(n + 1, x0);
    std::vector<double> fv(n + 1);
    for (size_t i = 0; i < n; ++i) s[i + 1][i] += step[i];
    for (size_t i = 0; i <= n; ++i) fv[i] = f(s[i]);
    int evals = static_cast<int>(n + 1);
    while (evals < maxEval) {
        std::vector<size_t> o(n + 1);
        std::iota(o.begin(), o.end(), 0);
        std::sort(o.begin(), o.end(), [&](size_t a, size_t b) { return fv[a] < fv[b]; });
        { auto s2 = s; auto f2 = fv; for (size_t i = 0; i <= n; ++i) { s[i] = s2[o[i]]; fv[i] = f2[o[i]]; } }
        if (std::abs(fv[n] - fv[0]) <= 1e-9 * (std::abs(fv[0]) + 1e-12)) break;
        std::vector<double> c(n, 0.0);
        for (size_t i = 0; i < n; ++i) for (size_t j = 0; j < n; ++j) c[j] += s[i][j] / n;
        auto lerp = [&](double t) { std::vector<double> x(n); for (size_t j = 0; j < n; ++j) x[j] = c[j] + t * (s[n][j] - c[j]); return x; };
        auto xr = lerp(-1); double fr = f(xr); ++evals;
        if (fr < fv[0]) {
            auto xe = lerp(-2); double fe = f(xe); ++evals;
            if (fe < fr) { s[n] = xe; fv[n] = fe; } else { s[n] = xr; fv[n] = fr; }
        } else if (fr < fv[n - 1]) { s[n] = xr; fv[n] = fr; }
        else {
            auto xc = fr < fv[n] ? lerp(-0.5) : lerp(0.5); double fc = f(xc); ++evals;
            if (fc < std::min(fr, fv[n])) { s[n] = xc; fv[n] = fc; }
            else {
                for (size_t i = 1; i <= n; ++i) { for (size_t j = 0; j < n; ++j) s[i][j] = s[0][j] + 0.5 * (s[i][j] - s[0][j]); fv[i] = f(s[i]); ++evals; }
            }
        }
    }
    size_t b = std::min_element(fv.begin(), fv.end()) - fv.begin();
    fBest = fv[b];
    return s[b];
}

/** Distance from (r, y) to a polyline in the meridian half plane. */
inline double polyDist(const std::vector<std::array<double, 2>>& pl, double r, double y) {
    double best = 1e300;
    for (size_t i = 0; i + 1 < pl.size(); ++i) {
        const double ax = pl[i][0], ay = pl[i][1], bx = pl[i + 1][0], by = pl[i + 1][1];
        const double dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
        double t = l2 > 1e-18 ? ((r - ax) * dx + (y - ay) * dy) / l2 : 0;
        t = std::clamp(t, 0.0, 1.0);
        const double ex = ax + t * dx - r, ey = ay + t * dy - y;
        best = std::min(best, ex * ex + ey * ey);
    }
    return std::sqrt(best);
}

}  // namespace detail

/** The smooth cap: r(t) = R0 (1 - t^q)^(1/p) (1 + b 4 t (1 - t)), t = (y - y0) / H. */
struct Cap {
    bool present{false};
    double y0{0}, R0{0}, H{0}, p{2}, q{2}, b{0};
    /** Where a mast stands on the cap: the cap ends there in a flat top (infinity: it closes at its apex). */
    double cut{std::numeric_limits<double>::infinity()};
    double radiusAt(double y) const {
        if (!present || H <= 0 || y > cut) return 0;
        const double t = (y - y0) / H;
        if (t < 0) return R0;
        if (t >= 1) return 0;
        return R0 * std::pow(std::max(0.0, 1 - std::pow(t, q)), 1 / p) * (1 + b * 4 * t * (1 - t));
    }
    /** The meridian, `n` points from (R0, y0) to (0, y0 + H), evenly in phi with t = sin(phi)^(2/q)-like spacing. */
    std::vector<std::array<double, 2>> meridian(int n) const {
        std::vector<std::array<double, 2>> o;
        for (int i = 0; i <= n; ++i) {
            const double phi = 0.5 * PI * i / n;
            const double t = std::pow(std::sin(phi), 2.0 / std::max(0.5, q));
            o.push_back({i == n ? 0.0 : R0 * std::pow(std::max(0.0, 1 - std::pow(t, q)), 1 / p) * (1 + b * 4 * t * (1 - t)), y0 + t * H});
        }
        if (std::isfinite(cut) && cut < y0 + H) {
            std::vector<std::array<double, 2>> c;
            for (const auto& q2 : o) if (q2[1] < cut) c.push_back(q2);
            const double t = std::clamp((cut - y0) / H, 0.0, 1.0);
            c.push_back({R0 * std::pow(std::max(0.0, 1 - std::pow(t, q)), 1 / p) * (1 + b * 4 * t * (1 - t)), cut});
            c.push_back({0.0, cut});
            return c;
        }
        return o;
    }
};

/** A band: a frustum of the profile between two heights (a drum, a ring, a plinth), its radius linear in y. */
struct Band {
    double y0{0}, y1{0}, r0{0}, r1{0};
    int slices{0};
    double rAt(double y) const { return y1 > y0 ? r0 + (r1 - r0) * std::clamp((y - y0) / (y1 - y0), 0.0, 1.0) : r0; }
};

/**
 * A K-periodic radial modulation, relative to the radius. Its shape over one period (phi = K (theta - theta0) wrapped to
 * [-pi, pi), the residual's crest at phi = 0) is fitted to the residual folded over one period:
 *     m(phi) = offset + cosAmp cos(phi) + bumpAmp g(phi - bumpCentre) + facetAmp (P(phi) - mean P)
 * with g(x) = exp(-|x / (bumpWidth pi)|^bumpExponent) (bumpWidth: the rib's half width as a share of half the period;
 * bumpExponent: its edge sharpness, 1 a cusp, 2 a smooth bump, 8+ flat-topped with sharp edges) and P the radius of a
 * K-gon's flat facets, corners at phi = 0. Only the family that fits the folded residual best carries an amplitude.
 */
struct Modulation {
    int K{0};
    std::vector<std::array<double, 3>> h;  // the kept Fourier lines (k, a, b), reported
    double ampRel{0}, ampM{0}, significance{0}, phaseAgreeDeg{0}, floorRel{0};
    int bestK{0};
    double bestSignificance{0};
    double theta0{0}, offset{0}, cosAmp{0}, bumpAmp{0}, bumpWidth{0.25}, bumpExponent{2}, bumpCentre{0}, facetAmp{0};
    double shapeRmsRel{0}, shapeExplained{0};
    static double facetRaw(double phi, int K) { return 1.0 / std::cos((PI - std::abs(phi)) / K); }
    static double facetMean(int K) { const double a = PI / K; return (K / PI) * std::log(1 / std::cos(a) + std::tan(a)); }
    double bump(double x) const {
        while (x > PI) x -= 2 * PI;
        while (x < -PI) x += 2 * PI;
        return std::exp(-std::pow(std::abs(x) / (bumpWidth * PI), bumpExponent));
    }
    double atPhase(double phi) const {
        return offset + cosAmp * std::cos(phi) + bumpAmp * bump(phi - bumpCentre) + (facetAmp != 0 ? facetAmp * (facetRaw(phi, K) - facetMean(K)) : 0.0);
    }
    double at(double th) const {
        if (!K) return 0;
        double phi = std::fmod(K * (th - theta0), 2 * PI);
        if (phi >= PI) phi -= 2 * PI;
        if (phi < -PI) phi += 2 * PI;
        return atPhase(phi);
    }
    double maxAbs() const { if (!K) return 0; double m = 0; for (int i = 0; i < 512; ++i) m = std::max(m, std::abs(atPhase(-PI + 2 * PI * i / 512))); return m; }
};

struct Stack {
    double yBottom{0}, yTop{0};
    /** Bands only, no cap: a thin part measured as straight sections (a mast standing on the cap below it). */
    bool bandsOnly{false};
    /** The cap is cut where a mast stands on it (the next stack). */
    bool mastAbove{false};
    /** Height over radius of the stack's topmost run of thin sections (0: none measured). */
    double slenderness{0};
    std::vector<Band> bands;
    Cap cap;
    Modulation bandMod, capMod;
    int points{0};
    double rmsM{0}, rmsTruncM{0}, within25{0};
    /** The meridian from the bottom axis out, up and back to the top axis; `capFlag` (optional) marks the cap's points. */
    std::vector<std::array<double, 2>> meridianPolyline(int capSamples = 48, double bottom = std::numeric_limits<double>::quiet_NaN(), std::vector<uint8_t>* capFlag = nullptr) const {
        std::vector<std::array<double, 2>> pl;
        const double yb = std::isfinite(bottom) ? bottom : yBottom;
        auto push = [&](double r, double y, bool c) { pl.push_back({r, y}); if (capFlag) capFlag->push_back(c ? 1 : 0); };
        const double r0 = !bands.empty() ? bands.front().r0 : cap.R0;
        push(0, yb, false);
        push(r0, yb, false);
        for (size_t i = 0; i < bands.size(); ++i) {
            push(bands[i].r0, bands[i].y0, false);
            push(bands[i].r1, bands[i].y1, false);
        }
        if (cap.present) {
            const auto m = cap.meridian(capSamples);
            for (const auto& q : m) push(q[0], q[1], true);
        } else if (!bands.empty()) push(0, bands.back().y1, false);
        // drop zero-length segments
        std::vector<std::array<double, 2>> o; std::vector<uint8_t> f;
        for (size_t i = 0; i < pl.size(); ++i) {
            if (!o.empty() && std::hypot(pl[i][0] - o.back()[0], pl[i][1] - o.back()[1]) < 1e-6) { if (capFlag && (*capFlag)[i]) f.back() = 1; continue; }
            o.push_back(pl[i]); if (capFlag) f.push_back((*capFlag)[i]);
        }
        if (capFlag) *capFlag = f;
        return o;
    }
    double radiusAt(double y) const {
        if (y < yBottom) return 0;
        for (const auto& b : bands) if (y >= b.y0 - 1e-9 && y <= b.y1 + 1e-9) return b.rAt(y);
        if (cap.present && y >= cap.y0) return cap.radiusAt(y);
        if (!bands.empty() && y < bands.front().y0) return bands.front().r0;
        if (cap.present && y < cap.y0) return cap.R0;
        return 0;
    }
};

struct Slice {
    double y{0}, cx{0}, cz{0}, r{0}, rmsRel{0}, sectors{0};
    /** The section's own radius: the median distance of its points from their own centre (a thin part that leans off
     *  the axis has a small own radius however far its centre is from the axis). */
    double rOwn{0};
    int n{0};
    bool ok{false};
};

struct Departure { double areaM2{0}, meanM{0}, thetaLoDeg{0}, thetaHiDeg{0}, yLo{0}, yHi{0}; int cells{0}; };

struct Revolution {
    int id{0};
    // detection
    double peakY{0}, baseY{0}, planX{0}, planZ{0}, planR{0}, planSpread{0};
    int levels{0};
    // axis
    double cx{0}, cz{0}, axisErrM{0}, tiltDeg{0};
    std::vector<Slice> slices;
    int slicesOk{0};
    double sliceRmsRelMedian{0}, sectorShareMedian{0};
    // profile
    std::vector<Stack> stacks;
    int points{0};
    double rmsM{0}, rmsTruncM{0}, within25{0}, dentRmsRemovedM{0};
    std::vector<Departure> departures;
    std::vector<std::array<double, 2>> envelope;  // (y, max radius incl. modulation)
    // geometry
    std::vector<float> pos, nrm;
    std::vector<uint32_t> idx;
    bool accepted{false};
    std::string reason;
};

class RevolutionFit {
public:
    RevolutionFit(std::vector<float> tris, Params p) : t_(std::move(tris)), p_(p) {
        nt_ = t_.size() / 9;
        triBox_.resize(nt_);
        for (size_t i = 0; i < nt_; ++i) {
            auto& b = triBox_[i];
            b = {1e300, 1e300, 1e300, -1e300, -1e300, -1e300};
            for (int k = 0; k < 3; ++k) for (int c = 0; c < 3; ++c) { b[c] = std::min(b[c], static_cast<double>(t_[i * 9 + k * 3 + c])); b[3 + c] = std::max(b[3 + c], static_cast<double>(t_[i * 9 + k * 3 + c])); }
        }
    }

    void run() {
        buildDsm();
        findCandidates();
        for (auto& r : revs_) fit3d(r);
    }

    const std::vector<Revolution>& revolutions() const { return revs_; }

    std::string reportJson() const {
        std::ostringstream o;
        o << "{\"schema\":\"scratchbox.revolution-fit/1\",\"triangles\":" << nt_ << ",\"dsm\":{\"cellM\":" << detail::num(p_.cellM) << ",\"nx\":" << nx_ << ",\"nz\":" << nz_ << "},\"summits\":" << summits_ << ",\"candidates\":" << revs_.size() << ",\"revolutions\":[";
        size_t off = 0;
        bool first = true;
        for (const auto& r : revs_) {
            if (!first) o << ",";
            first = false;
            o << "{\"id\":" << r.id << ",\"accepted\":" << (r.accepted ? "true" : "false") << ",\"reason\":" << detail::jstr(r.reason)
              << ",\"plan\":{\"x\":" << detail::num(r.planX) << ",\"z\":" << detail::num(r.planZ) << ",\"r\":" << detail::num(r.planR) << ",\"peakY\":" << detail::num(r.peakY) << ",\"baseY\":" << detail::num(r.baseY) << ",\"levels\":" << r.levels << ",\"spread\":" << detail::num(r.planSpread) << "}"
              << ",\"axis\":{\"x\":" << detail::num(r.cx) << ",\"z\":" << detail::num(r.cz) << ",\"errM\":" << detail::num(r.axisErrM) << ",\"tiltDeg\":" << detail::num(r.tiltDeg) << ",\"slices\":" << r.slices.size() << ",\"slicesOk\":" << r.slicesOk
              << ",\"sliceRmsRelMedian\":" << detail::num(r.sliceRmsRelMedian) << ",\"sectorShareMedian\":" << detail::num(r.sectorShareMedian) << "}";
            o << ",\"fit\":{\"points\":" << r.points << ",\"rmsM\":" << detail::num(r.rmsM) << ",\"rmsTruncM\":" << detail::num(r.rmsTruncM) << ",\"within25cm\":" << detail::num(r.within25) << "}";
            o << ",\"stacks\":[";
            for (size_t s = 0; s < r.stacks.size(); ++s) {
                const auto& st = r.stacks[s];
                if (s) o << ",";
                o << "{\"yBottom\":" << detail::num(st.yBottom) << ",\"yTop\":" << detail::num(st.yTop) << ",\"bandsOnly\":" << (st.bandsOnly ? "true" : "false") << ",\"mastAbove\":" << (st.mastAbove ? "true" : "false") << ",\"slenderness\":" << detail::num(st.slenderness) << ",\"points\":" << st.points << ",\"rmsM\":" << detail::num(st.rmsM) << ",\"rmsTruncM\":" << detail::num(st.rmsTruncM) << ",\"bands\":[";
                for (size_t b = 0; b < st.bands.size(); ++b) { if (b) o << ","; o << "{\"y0\":" << detail::num(st.bands[b].y0) << ",\"y1\":" << detail::num(st.bands[b].y1) << ",\"r0\":" << detail::num(st.bands[b].r0) << ",\"r1\":" << detail::num(st.bands[b].r1) << ",\"slices\":" << st.bands[b].slices << "}"; }
                o << "],\"cap\":";
                if (st.cap.present) o << "{\"y0\":" << detail::num(st.cap.y0) << ",\"R0\":" << detail::num(st.cap.R0) << ",\"H\":" << detail::num(st.cap.H) << ",\"p\":" << detail::num(st.cap.p) << ",\"q\":" << detail::num(st.cap.q) << ",\"b\":" << detail::num(st.cap.b) << ",\"cut\":" << detail::num(st.cap.cut) << "}";
                else o << "null";
                auto mod = [&](const Modulation& m) {
                    o << "{\"K\":" << m.K << ",\"ampRel\":" << detail::num(m.ampRel) << ",\"ampM\":" << detail::num(m.ampM) << ",\"significance\":" << detail::num(m.significance) << ",\"phaseAgreeDeg\":" << detail::num(m.phaseAgreeDeg)
                      << ",\"floorRel\":" << detail::num(m.floorRel) << ",\"bestK\":" << m.bestK << ",\"bestSignificance\":" << detail::num(m.bestSignificance)
                      << ",\"shape\":{\"theta0\":" << detail::num(m.theta0) << ",\"offset\":" << detail::num(m.offset) << ",\"cosAmp\":" << detail::num(m.cosAmp) << ",\"bumpAmp\":" << detail::num(m.bumpAmp)
                      << ",\"bumpWidth\":" << detail::num(m.bumpWidth) << ",\"bumpExponent\":" << detail::num(m.bumpExponent) << ",\"bumpCentre\":" << detail::num(m.bumpCentre) << ",\"facetAmp\":" << detail::num(m.facetAmp)
                      << ",\"rmsRel\":" << detail::num(m.shapeRmsRel) << ",\"explained\":" << detail::num(m.shapeExplained) << "},\"harmonics\":[";
                    for (size_t i = 0; i < m.h.size(); ++i) { if (i) o << ","; o << "[" << detail::num(m.h[i][0]) << "," << detail::num(m.h[i][1]) << "," << detail::num(m.h[i][2]) << "]"; }
                    o << "]}";
                };
                o << ",\"bandModulation\":"; mod(st.bandMod);
                o << ",\"capModulation\":"; mod(st.capMod);
                o << ",\"meridian\":[";
                auto pl = st.meridianPolyline();
                for (size_t i = 0; i < pl.size(); ++i) { if (i) o << ","; o << "[" << detail::num(pl[i][0]) << "," << detail::num(pl[i][1]) << "]"; }
                o << "]}";
            }
            o << "],\"departures\":[";
            for (size_t i = 0; i < r.departures.size(); ++i) {
                const auto& d = r.departures[i];
                if (i) o << ",";
                o << "{\"areaM2\":" << detail::num(d.areaM2) << ",\"meanM\":" << detail::num(d.meanM) << ",\"thetaDeg\":[" << detail::num(d.thetaLoDeg) << "," << detail::num(d.thetaHiDeg) << "],\"y\":[" << detail::num(d.yLo) << "," << detail::num(d.yHi) << "],\"cells\":" << d.cells << "}";
            }
            o << "],\"envelope\":[";
            for (size_t i = 0; i < r.envelope.size(); ++i) { if (i) o << ","; o << "[" << detail::num(r.envelope[i][0]) << "," << detail::num(r.envelope[i][1]) << "]"; }
            o << "],\"slices\":[";
            for (size_t i = 0; i < r.slices.size(); ++i) {
                const auto& s = r.slices[i];
                if (i) o << ",";
                o << "[" << detail::num(s.y) << "," << detail::num(s.cx) << "," << detail::num(s.cz) << "," << detail::num(s.r) << "," << detail::num(s.rmsRel) << "," << detail::num(s.sectors) << "," << s.n << "," << (s.ok ? 1 : 0) << "]";
            }
            o << "],\"mesh\":{\"offset\":" << off << ",\"vertices\":" << r.pos.size() / 3 << ",\"indices\":" << r.idx.size() << "}}";
            off += r.pos.size() * 4 * 2 + r.idx.size() * 4;
        }
        o << "]}";
        return o.str();
    }

    void writeMesh(const std::string& file) const {
        std::ofstream f(file, std::ios::binary);
        if (!f) throw std::runtime_error("cannot write " + file);
        for (const auto& r : revs_) {
            f.write(reinterpret_cast<const char*>(r.pos.data()), static_cast<std::streamsize>(r.pos.size() * 4));
            f.write(reinterpret_cast<const char*>(r.nrm.data()), static_cast<std::streamsize>(r.nrm.size() * 4));
            f.write(reinterpret_cast<const char*>(r.idx.data()), static_cast<std::streamsize>(r.idx.size() * 4));
        }
    }

    // ------------------------------------------------------------------------------------------------------------
private:
    std::vector<float> t_;
    size_t nt_{0};
    Params p_;
    std::vector<std::array<double, 6>> triBox_;
    double x0_{0}, z0_{0};
    int nx_{0}, nz_{0};
    std::vector<float> top_;
    std::vector<uint8_t> inRegion_;
    int summits_{0};
    std::vector<Revolution> revs_;

    /** Deterministic area-weighted samples of triangle i (an R2 low-discrepancy sequence folded into the triangle). */
    template <class F> void sampleTri(size_t i, double density, F&& emit) const {
        const float* v = &t_[i * 9];
        const double ax = v[3] - v[0], ay = v[4] - v[1], az = v[5] - v[2], bx = v[6] - v[0], by = v[7] - v[1], bz = v[8] - v[2];
        const double area = 0.5 * std::sqrt(std::pow(ay * bz - az * by, 2) + std::pow(az * bx - ax * bz, 2) + std::pow(ax * by - ay * bx, 2));
        const int n = std::max(1, static_cast<int>(std::ceil(area * density)));
        const double g1 = 0.7548776662466927, g2 = 0.5698402909980532;
        for (int k = 0; k < n; ++k) {
            double u = std::fmod(0.5 + g1 * (k + 1), 1.0), w = std::fmod(0.5 + g2 * (k + 1), 1.0);
            if (u + w > 1) { u = 1 - u; w = 1 - w; }
            emit(Pt{v[0] + u * ax + w * bx, v[1] + u * ay + w * by, v[2] + u * az + w * bz}, area / n);
        }
    }

    void buildDsm() {
        double minX = 1e300, minZ = 1e300, maxX = -1e300, maxZ = -1e300;
        for (const auto& b : triBox_) { minX = std::min(minX, b[0]); minZ = std::min(minZ, b[2]); maxX = std::max(maxX, b[3]); maxZ = std::max(maxZ, b[5]); }
        if (!nt_) return;
        const double c = p_.cellM;
        x0_ = std::floor(minX / c) * c; z0_ = std::floor(minZ / c) * c;
        nx_ = static_cast<int>(std::ceil((maxX - x0_) / c)) + 1; nz_ = static_cast<int>(std::ceil((maxZ - z0_) / c)) + 1;
        if (static_cast<double>(nx_) * nz_ > 64e6) throw std::runtime_error("the scan is too wide for the revolution DSM");
        top_.assign(static_cast<size_t>(nx_) * nz_, -std::numeric_limits<float>::infinity());
        const double dens = 4.0 / (c * c);
        for (size_t i = 0; i < nt_; ++i) {
            sampleTri(i, dens, [&](const Pt& q, double) {
                const int a = static_cast<int>((q.x - x0_) / c), b = static_cast<int>((q.z - z0_) / c);
                if (a < 0 || b < 0 || a >= nx_ || b >= nz_) return;
                float& t = top_[static_cast<size_t>(b) * nx_ + a];
                t = std::max(t, static_cast<float>(q.y));
            });
            // the vertices themselves (thin spikes)
            for (int k = 0; k < 3; ++k) {
                const int a = static_cast<int>((t_[i * 9 + k * 3] - x0_) / c), b = static_cast<int>((t_[i * 9 + k * 3 + 2] - z0_) / c);
                if (a < 0 || b < 0 || a >= nx_ || b >= nz_) continue;
                float& t = top_[static_cast<size_t>(b) * nx_ + a];
                t = std::max(t, t_[i * 9 + k * 3 + 1]);
            }
        }
    }

    float topAt(int a, int b) const { return (a < 0 || b < 0 || a >= nx_ || b >= nz_) ? -std::numeric_limits<float>::infinity() : top_[static_cast<size_t>(b) * nx_ + a]; }

    /** Square-window max / min filters (separable). */
    std::vector<float> windowFilter(int R, bool takeMax) const {
        const float init = takeMax ? -std::numeric_limits<float>::infinity() : std::numeric_limits<float>::infinity();
        std::vector<float> tmp(top_.size(), init), out(top_.size(), init);
        auto pick = [&](float a, float b) { if (!std::isfinite(b)) return a; return takeMax ? std::max(a, b) : std::min(a, b); };
        for (int b = 0; b < nz_; ++b) for (int a = 0; a < nx_; ++a) {
            float m = init;
            for (int d = -R; d <= R; ++d) m = pick(m, topAt(a + d, b));
            tmp[static_cast<size_t>(b) * nx_ + a] = m;
        }
        for (int b = 0; b < nz_; ++b) for (int a = 0; a < nx_; ++a) {
            float m = init;
            for (int d = -R; d <= R; ++d) { const int bb = b + d; if (bb < 0 || bb >= nz_) continue; m = pick(m, tmp[static_cast<size_t>(bb) * nx_ + a]); }
            out[static_cast<size_t>(b) * nx_ + a] = m;
        }
        return out;
    }

    void findCandidates() {
        if (!nx_) return;
        const int Rw = std::max(1, static_cast<int>(std::round(p_.peakWindowM / p_.cellM)));
        const auto mx = windowFilter(Rw, true);
        const auto mn = windowFilter(2 * Rw, false);
        std::vector<uint8_t> seedMark(top_.size(), 0);
        std::vector<std::pair<float, size_t>> seeds;
        for (size_t i = 0; i < top_.size(); ++i) {
            if (!std::isfinite(top_[i])) continue;
            if (top_[i] < mx[i]) continue;
            if (top_[i] - mn[i] < p_.minRiseM) continue;
            seeds.push_back({top_[i], i});
        }
        std::sort(seeds.begin(), seeds.end(), [](auto& a, auto& b) { return a.first > b.first; });
        std::vector<int> stamp(top_.size(), -1);
        inRegion_.assign(top_.size(), 0);
        std::vector<uint8_t> claimed(top_.size(), 0);
        int sid = 0;
        for (const auto& [h, cell] : seeds) {
            if (claimed[cell]) continue;  // inside an accepted stack, or the same plateau
            ++summits_;
            Revolution r;
            if (growStack(cell, sid++, stamp, r, claimed)) { r.id = static_cast<int>(revs_.size()); revs_.push_back(std::move(r)); }
        }
    }

    /** The priority flood from a summit; true when a round stack was found (its cells are claimed). */
    bool growStack(size_t seed, int sid, std::vector<int>& stamp, Revolution& out, std::vector<uint8_t>& claimed) {
        const double c = p_.cellM;
        const float peak = top_[seed];
        using QE = std::pair<float, size_t>;
        std::priority_queue<QE> pq;
        pq.push({peak, seed});
        stamp[seed] = sid;
        std::vector<size_t> region;
        double level = peak - p_.levelStepM;
        struct Lv { double y, cx, cz, req, spread; };
        std::vector<Lv> ok;
        int fails = 0;
        double sumX = 0, sumZ = 0;
        size_t okRegionSize = 0;
        std::vector<size_t> okRegion;
        const int maxCells = static_cast<int>(PI * std::pow(p_.maxRadiusM / c, 2) * 1.6);
        auto evaluate = [&](double y) -> bool {
            double cx = 0, cz = 0;
            for (size_t i : region) { cx += x0_ + (i % nx_ + 0.5) * c; cz += z0_ + (i / nx_ + 0.5) * c; }
            cx /= region.size(); cz /= region.size();
            const double req = std::sqrt(region.size() * c * c / PI);
            if (req < 1.0) { ok.push_back({y, cx, cz, req, 0}); return true; }
            // the radial extent along 72 rays from the centroid: the first step leaving the region (cells joined to it)
            std::array<double, 72> rk{};
            for (int k = 0; k < 72; ++k) {
                const double th = 2 * PI * (k + 0.5) / 72, dx = std::cos(th), dz = std::sin(th);
                double t = 0;
                const double stepM = 0.25 * c;
                while (t < p_.maxRadiusM * 1.5) {
                    const double x = cx + (t + stepM) * dx, z = cz + (t + stepM) * dz;
                    const int a = static_cast<int>(std::floor((x - x0_) / c)), b = static_cast<int>(std::floor((z - z0_) / c));
                    if (a < 0 || b < 0 || a >= nx_ || b >= nz_ || !inRegion_[static_cast<size_t>(b) * nx_ + a]) break;
                    t += stepM;
                }
                rk[k] = t + 0.5 * c;
            }
            std::vector<double> v(rk.begin(), rk.end());
            const double med = detail::median(v);
            // the spread allows half a cell of rasterisation on top of the relative bound
            const double spreadM = 1.4826 * detail::mad(v, med);
            const double spread = std::max(0.0, spreadM - 0.5 * c) / std::max(1e-6, med);
            // the stack's centre: the larger levels' mean (the summit's few cells say little)
            double mcx = cx, mcz = cz, wsum = 0, ax = 0, az = 0;
            for (const auto& l : ok) if (l.req >= 1.0) { ax += l.req * l.cx; az += l.req * l.cz; wsum += l.req; }
            if (wsum > 0) { mcx = ax / wsum; mcz = az / wsum; }
            const double drift = std::hypot(cx - mcx, cz - mcz);
            const bool round = spread <= p_.maxContourSpread && drift <= p_.centreDrift * req + 0.5 && req <= p_.maxRadiusM;
            if (std::getenv("SB_REV_DEBUG")) std::fprintf(stderr, "seed %d level %.2f req %.2f spread %.3f drift %.2f cells %zu %s\n", sid, y, req, spread, drift, region.size(), round ? "ok" : "FAIL");
            if (round) ok.push_back({y, cx, cz, req, spread});
            return round;
        };
        bool subordinate = false;
        while (!pq.empty()) {
            const auto [h, i] = pq.top();
            if (h > peak + 0.05f) { subordinate = true; break; }
            if (h < level) {
                // the region at `level` is complete
                if (!region.empty()) {
                    if (evaluate(level)) { fails = 0; okRegionSize = region.size(); }
                    else if (std::any_of(ok.begin(), ok.end(), [](const Lv& l) { return l.req >= 1.0; }) && ++fails * p_.levelStepM > p_.maxFailM + 1e-9) break;
                }
                level -= p_.levelStepM;
                continue;
            }
            pq.pop();
            region.push_back(i);
            inRegion_[i] = 1;
            if (static_cast<int>(region.size()) > maxCells) break;
            const int a = static_cast<int>(i % nx_), b = static_cast<int>(i / nx_);
            for (int d = 0; d < 8; ++d) {
                static const int DA[8] = {1, -1, 0, 0, 1, 1, -1, -1}, DB[8] = {0, 0, 1, -1, 1, -1, 1, -1};
                const int aa = a + DA[d], bb = b + DB[d];
                if (aa < 0 || bb < 0 || aa >= nx_ || bb >= nz_) continue;
                const size_t j = static_cast<size_t>(bb) * nx_ + aa;
                if (stamp[j] == sid || !std::isfinite(top_[j])) continue;
                stamp[j] = sid;
                pq.push({top_[j], j});
            }
        }
        for (size_t i : region) inRegion_[i] = 0;
        // claim the summit's plateau so its other maxima are not grown again
        for (size_t k = 0; k < std::min(region.size(), static_cast<size_t>(16)); ++k) if (top_[region[k]] >= peak - 0.05f) claimed[region[k]] = 1;
        (void)subordinate;
        (void)sumX; (void)sumZ;
        // the accepted stack: the levels down to the last round one
        std::vector<Lv> big;
        for (const auto& l : ok) if (l.req >= 1.0) big.push_back(l);
        if (big.empty()) return false;
        const auto& base = big.back();
        if (peak - base.y < p_.minStackM || base.req < p_.minRadiusM) return false;
        double wx = 0, wz = 0, ws = 0, sp = 0;
        for (const auto& l : big) { wx += l.req * l.cx; wz += l.req * l.cz; ws += l.req; sp = std::max(sp, l.spread); }
        out.peakY = peak; out.baseY = base.y; out.planX = wx / ws; out.planZ = wz / ws; out.planR = base.req; out.levels = static_cast<int>(big.size()); out.planSpread = sp;
        for (size_t k = 0; k < std::min(region.size(), okRegionSize); ++k) claimed[region[k]] = 1;
        return true;
    }

    // ---------------------------------------------- 3D fit ----------------------------------------------
    struct MP { double r, y, th, w; int stack{0}; };

    void fit3d(Revolution& R) {
        const double Rc = 1.3 * R.planR + 1.5;
        const double yLo = R.baseY - 0.5, yHi = R.peakY + 0.5;
        std::vector<Pt> pts; std::vector<double> wts;
        for (size_t i = 0; i < nt_; ++i) {
            const auto& b = triBox_[i];
            if (b[3] < R.planX - Rc || b[0] > R.planX + Rc || b[5] < R.planZ - Rc || b[2] > R.planZ + Rc || b[4] < yLo || b[1] > yHi) continue;
            sampleTri(i, p_.density, [&](const Pt& q, double w) {
                if (q.y < yLo || q.y > yHi || std::hypot(q.x - R.planX, q.z - R.planZ) > Rc) return;
                pts.push_back(q); wts.push_back(w);
            });
        }
        if (pts.size() < 200) { R.reason = "too few scan points in the stack"; return; }
        // slices
        const double s = p_.sliceM;
        std::vector<Slice> sl;
        std::vector<std::vector<size_t>> sliceIdx;
        const int ns = static_cast<int>(std::floor((R.peakY - R.baseY) / s));
        sliceIdx.resize(std::max(0, ns));
        for (size_t i = 0; i < pts.size(); ++i) {
            const int k = static_cast<int>(std::floor((pts[i].y - R.baseY) / s));
            if (k >= 0 && k < ns) sliceIdx[k].push_back(i);
        }
        for (int k = 0; k < ns; ++k) {
            Slice c; c.y = R.baseY + (k + 0.5) * s;
            std::vector<Pt> q; for (size_t i : sliceIdx[k]) q.push_back(pts[i]);
            c.n = static_cast<int>(q.size());
            double cx, cz, r;
            if (q.size() >= 12 && detail::kasa(q, cx, cz, r)) {
                for (int it = 0; it < 3; ++it) {
                    std::vector<double> d; for (const auto& p : q) d.push_back(std::hypot(p.x - cx, p.z - cz) - r);
                    const double m = detail::median(d), sd = 1.4826 * detail::mad(d, m) + 0.03;
                    std::vector<Pt> keep; for (size_t i = 0; i < q.size(); ++i) if (std::abs(d[i] - m) <= 2.5 * sd) keep.push_back(q[i]);
                    if (keep.size() < 12 || !detail::kasa(keep, cx, cz, r)) break;
                    q.swap(keep);
                }
                double ss = 0; std::array<int, 24> sec{};
                for (const auto& p : q) { const double d = std::hypot(p.x - cx, p.z - cz) - r; ss += d * d; sec[static_cast<int>((std::atan2(p.z - cz, p.x - cx) + PI) / (2 * PI) * 24) % 24] = 1; }
                c.cx = cx; c.cz = cz; c.r = r; c.rmsRel = std::sqrt(ss / q.size()) / std::max(1e-6, r);
                c.sectors = std::accumulate(sec.begin(), sec.end(), 0) / 24.0;
                c.ok = c.sectors >= p_.minSectorShare && c.rmsRel * r <= std::max(p_.maxSliceRmsRel * r, p_.sliceRmsFloorM) && r >= 0.4 && r <= 1.6 * R.planR + 1.0 && std::hypot(cx - R.planX, cz - R.planZ) <= 0.35 * R.planR + 0.75;
            }
            sl.push_back(c);
        }
        R.slices = sl;
        std::vector<double> rr, sec;
        double wx = 0, wz = 0, ws = 0;
        for (const auto& c : sl) if (c.ok) { ++R.slicesOk; rr.push_back(c.rmsRel); sec.push_back(c.sectors); const double w = c.n * c.r; wx += w * c.cx; wz += w * c.cz; ws += w; }
        R.sliceRmsRelMedian = detail::median(rr); R.sectorShareMedian = detail::median(sec);
        if (R.slicesOk < p_.minSliceShare * sl.size() && ws > 0) { R.reason = "only " + std::to_string(R.slicesOk) + " of " + std::to_string(sl.size()) + " horizontal sections of the stack are circles about one centre"; return; }
        if (R.slicesOk < p_.minSlices || ws <= 0) { R.reason = "fewer than " + std::to_string(p_.minSlices) + " horizontal sections of the stack are circles about one centre (" + std::to_string(R.slicesOk) + ")"; return; }
        R.cx = wx / ws; R.cz = wz / ws;
        {
            double e = 0, n = 0, sy = 0, syy = 0, sx = 0, sz = 0, sxy = 0, szy = 0;
            for (const auto& c : sl) if (c.ok) {
                const double w = c.n * c.r;
                e += w * (std::pow(c.cx - R.cx, 2) + std::pow(c.cz - R.cz, 2)); n += w;
                sy += w * c.y; syy += w * c.y * c.y; sx += w * c.cx; sz += w * c.cz; sxy += w * c.cx * c.y; szy += w * c.cz * c.y;
            }
            R.axisErrM = std::sqrt(e / n);
            const double vy = syy / n - std::pow(sy / n, 2);
            if (vy > 1e-9) {
                const double kx = (sxy / n - sx / n * sy / n) / vy, kz = (szy / n - sz / n * sy / n) / vy;
                R.tiltDeg = std::atan(std::hypot(kx, kz)) * 180 / PI;
            }
        }
        // the sections as a whole: round within maxSliceRmsRel of their radius (the per-slice floor lets a small coarse
        // section count, not a small lump pass), and about one vertical axis
        if (R.sliceRmsRelMedian > p_.maxSliceRmsRel) { char b[160]; std::snprintf(b, sizeof b, "its sections depart %.0f%% of their radius from circles (median; at most %.0f%%)", 100 * R.sliceRmsRelMedian, 100 * p_.maxSliceRmsRel); R.reason = b; return; }
        if (R.tiltDeg > p_.maxTiltDeg) { char b[160]; std::snprintf(b, sizeof b, "its sections' centres lean %.1f degrees off vertical (at most %.1f)", R.tiltDeg, p_.maxTiltDeg); R.reason = b; return; }
        // the lowest counted slice: the stack's bottom (below it the region had joined what it stands on)
        double yBottom = R.peakY;
        for (const auto& c : sl) if (c.ok) { yBottom = std::min(yBottom, c.y - 0.5 * s); }
        std::vector<MP> mp;
        for (size_t i = 0; i < pts.size(); ++i) {
            const auto& q = pts[i];
            if (q.y < yBottom) continue;
            mp.push_back({std::hypot(q.x - R.cx, q.z - R.cz), q.y, std::atan2(q.z - R.cz, q.x - R.cx), wts[i]});
        }
        // a point far outside every counted section's radius belongs to something beside the stack
        double rMax = 0; for (const auto& c : sl) if (c.ok) rMax = std::max(rMax, c.r);
        mp.erase(std::remove_if(mp.begin(), mp.end(), [&](const MP& m) { return m.r > rMax * 1.15 + 0.6; }), mp.end());
        R.points = static_cast<int>(mp.size());
        // the stacks: the first from the whole, the next from what stands above its cap near the axis
        std::vector<MP> rest = mp;
        double bottom = yBottom;
        bool mastNext = false;
        for (int k = 0; k < p_.maxStacks && rest.size() >= (mastNext ? 12u : 60u); ++k) {
            Stack st;
            std::vector<MP> above;
            const double belowR = R.stacks.empty() ? 0 : (!R.stacks.back().bands.empty() ? R.stacks.back().bands.front().r0 : R.stacks.back().cap.R0);
            fitStack(rest, bottom, R.peakY, st, above, k == 0 ? &sl : nullptr, mastNext, belowR);
            if (!st.cap.present && st.bands.empty()) break;
            // a mast found on its own stands on the cap below, cut flat at its foot (the cap is not continued inside it)
            if (st.bandsOnly && !R.stacks.empty() && !R.stacks.back().mastAbove && R.stacks.back().cap.present && st.yBottom > R.stacks.back().cap.y0 + 0.3) {
                auto& prev = R.stacks.back();
                prev.mastAbove = true;
                prev.cap.cut = std::min(prev.cap.cut, st.yBottom);
                prev.yTop = std::min(prev.yTop, prev.cap.cut);
            }
            R.stacks.push_back(st);
            mastNext = st.mastAbove;
            double area = 0; for (const auto& m : above) area += m.w;
            if (mastNext ? above.size() < 12 : (area < p_.stackMinAreaM2 || above.size() < 60)) break;
            double lo = 1e300; for (const auto& m : above) lo = std::min(lo, m.y);
            // the next stack stands on this cap: its bottom inside the cap, so the two solids meet without a gap
            bottom = lo;
            rest = above;
        }
        if (R.stacks.empty()) { R.reason = "no profile could be fitted"; return; }
        // the modulation, residuals and departures over the whole
        for (size_t k = 0; k < R.stacks.size(); ++k) fitModulation(R.stacks[k], k + 1 < R.stacks.size() ? &R.stacks[k + 1] : nullptr, mp);
        // a part whose sections are polygons of few sides (a square turret roof) is not uniform about its axis
        for (const auto& st : R.stacks) for (const Modulation* m : {&st.bandMod, &st.capMod}) {
            if (m->K > 0 && m->ampRel > p_.maxModulationRel) {
                char b[200]; std::snprintf(b, sizeof b, "its sections are %d-periodic with a %.0f%% radial swing (at most %.0f%%): polygons of few sides, not circles", m->K, 100 * m->ampRel, 100 * p_.maxModulationRel);
                R.reason = b; R.stacks.clear(); return;
            }
        }
        residuals(R, mp);
        envelope(R);
        emit(R);
        R.accepted = true;
        R.reason = "accepted";
    }

    /** Radius of the full model of stack `st` at height y and angle th, with its modulation. */
    static double modelR(const Stack& st, double y, double th) {
        const double r = st.radiusAt(y);
        const bool inCap = st.cap.present && y >= st.cap.y0;
        return r * (1 + (inCap ? st.capMod.at(th) : st.bandMod.at(th)));
    }

    /** Bands below y0 from the slices; the cap above y0 fitted to the meridian points. */
    void fitStack(const std::vector<MP>& pts, double yBottom, double yPeak, Stack& st, std::vector<MP>& above, const std::vector<Slice>* slicesIn, bool bandsOnly = false, double belowBaseR = 0) {
        st.yBottom = yBottom;
        double yTop = yBottom; for (const auto& m : pts) yTop = std::max(yTop, m.y);
        st.yTop = yTop;
        (void)yPeak;
        // per-slice radius about the fixed axis (median r), the stack's own slices
        const double s = p_.sliceM;
        std::vector<Slice> sl;
        {
            const int ns = std::max(1, static_cast<int>(std::floor((yTop - yBottom) / s)));
            std::vector<std::vector<double>> rs(ns);
            std::vector<std::vector<std::array<double, 2>>> xz(ns);
            std::vector<std::array<int, 24>> sec(ns, std::array<int, 24>{});
            for (const auto& m : pts) {
                const int k = static_cast<int>(std::floor((m.y - yBottom) / s));
                if (k < 0 || k >= ns) continue;
                rs[k].push_back(m.r);
                xz[k].push_back({m.r * std::cos(m.th), m.r * std::sin(m.th)});
                sec[k][static_cast<int>((m.th + PI) / (2 * PI) * 24) % 24] = 1;
            }
            for (int k = 0; k < ns; ++k) {
                Slice c; c.y = yBottom + (k + 0.5) * s; c.n = static_cast<int>(rs[k].size());
                if (c.n >= 4) {
                    double mx = 0, mz = 0; for (const auto& q : xz[k]) { mx += q[0]; mz += q[1]; }
                    mx /= c.n; mz /= c.n;
                    std::vector<double> dd; for (const auto& q : xz[k]) dd.push_back(std::hypot(q[0] - mx, q[1] - mz));
                    c.rOwn = detail::median(dd);
                    c.r = detail::halfSampleMode(rs[k]);
                    // a thin part's section is measured about its own centre (it may lean off the axis)
                    if (bandsOnly) c.r = c.rOwn;
                    c.sectors = std::accumulate(sec[k].begin(), sec[k].end(), 0) / 24.0;
                    const double sd = 1.4826 * detail::mad(rs[k], c.r);
                    c.rmsRel = sd / std::max(1e-6, c.r);
                    // a thin part's sections (a mast) are measured from fewer points and fill fewer sectors
                    c.ok = bandsOnly || (c.n >= 8 && c.sectors >= p_.minSectorShare && sd <= std::max(p_.maxSliceRmsRel * 1.5 * c.r, p_.sliceRmsFloorM));
                }
                if (std::getenv("SB_REV_DEBUG")) std::fprintf(stderr, "stack slice y %.2f n %d r %.2f sectors %.2f sd %.3f ok %d\n", c.y, c.n, c.r, c.sectors, c.rmsRel * c.r, c.ok ? 1 : 0);
                sl.push_back(c);
            }
        }
        (void)slicesIn;
        // a whole stack that is thin against the one it stands on (its sections at most mastMaxRadiusShare of that one's
        // base radius) and slender (height over radius at least mastMinSlenderness) is a mast: bands only, no cap
        if (!bandsOnly && belowBaseR > 0) {
            // the stack's own base: its lowest three measured sections
            std::vector<double> rr; for (const auto& c : sl) if (c.n >= 4) { rr.push_back(c.rOwn); if (rr.size() >= 3) break; }
            if (rr.size() >= 2) {
                const double rm = std::max(0.03, detail::median(rr));
                if (rm <= p_.mastStackRadiusShare * belowBaseR && (yTop - yBottom) / rm >= p_.mastMinSlenderness) {
                    bandsOnly = true;
                    for (auto& c : sl) if (c.n >= 4) { c.r = c.rOwn; c.ok = true; }
                }
            }
        }
        st.bandsOnly = bandsOnly;
        // the meridian points, thinned on a 2D grid (weights summed)
        std::vector<MP> mer;
        {
            std::map<std::pair<int, int>, MP> g;
            const double gc = 0.12;
            for (const auto& m : pts) {
                auto key = std::make_pair(static_cast<int>(std::floor(m.r / gc)), static_cast<int>(std::floor(m.y / gc)));
                auto it = g.find(key);
                if (it == g.end()) g[key] = {m.r * m.w, m.y * m.w, 0, m.w};
                else { it->second.r += m.r * m.w; it->second.y += m.y * m.w; it->second.w += m.w; }
            }
            for (auto& [k, v] : g) mer.push_back({v.r / v.w, v.y / v.w, 0, v.w});
        }
        // candidate cap bases: every slice boundary in the lower 85% of the stack
        // bands below y0: frusta merged from the slices while a straight line in y explains the merged slices within half a
        // ring step and the taper stays near vertical; a band thinner than minBandM is allowed only as a ring standing proud
        // of both neighbours (a cornice), otherwise y0 is not a valid cap base (the slices there slope: they are cap)
        auto buildBands = [&](double y0, bool& valid) {
            struct G { std::vector<const Slice*> m; double y0, y1, a, b, maxRes; };
            auto lineFit = [&](G& g) {
                double sw = 0, sy = 0, sr = 0, syy = 0, syr = 0;
                for (auto* c : g.m) { const double w = c->n; sw += w; sy += w * c->y; sr += w * c->r; syy += w * c->y * c->y; syr += w * c->y * c->r; }
                const double vy = syy / sw - std::pow(sy / sw, 2);
                g.b = vy > 1e-9 ? (syr / sw - sy / sw * sr / sw) / vy : 0;
                g.a = sr / sw - g.b * sy / sw;
                g.maxRes = 0;
                for (auto* c : g.m) g.maxRes = std::max(g.maxRes, std::abs(g.a + g.b * c->y - c->r));
            };
            std::vector<G> g;
            for (const auto& c : sl) if (c.ok && c.y + 0.5 * s <= y0 + 1e-9) { G x{{&c}, c.y - 0.5 * s, c.y + 0.5 * s, c.r, 0, 0}; g.push_back(x); }
            while (g.size() > 1) {
                size_t best = 0; double bres = 1e300; G bm;
                for (size_t i = 0; i + 1 < g.size(); ++i) {
                    G m; m.m = g[i].m; m.m.insert(m.m.end(), g[i + 1].m.begin(), g[i + 1].m.end()); m.y0 = g[i].y0; m.y1 = g[i + 1].y1;
                    lineFit(m);
                    const double thr = std::max(p_.ringStepM, p_.ringStepRel * std::max(g[i].a + g[i].b * g[i].y1, g[i + 1].a + g[i + 1].b * g[i + 1].y0));
                    if (m.maxRes > 0.5 * thr || std::abs(m.b) > p_.maxTaper) continue;
                    if (m.maxRes < bres) { bres = m.maxRes; best = i; bm = m; }
                }
                if (bres >= 1e299) break;
                g[best] = bm; g.erase(g.begin() + best + 1);
            }
            std::vector<Band> b;
            for (auto& x : g) b.push_back({x.y0, x.y1, x.a + x.b * x.y0, x.a + x.b * x.y1, static_cast<int>(x.m.size())});
            // contiguous: a gap left by an uncounted slice is closed by the band below
            for (size_t i = 0; i + 1 < b.size(); ++i) { b[i].r1 = b[i].rAt(b[i + 1].y0); b[i].y1 = b[i + 1].y0; }
            if (!b.empty()) { b.front().y0 = yBottom; b.back().y1 = y0; }
            valid = true;
            for (size_t i = 0; i < b.size(); ++i) {
                if (b[i].y1 - b[i].y0 >= p_.minBandM - 1e-9) continue;
                const double r = 0.5 * (b[i].r0 + b[i].r1), thr = std::max(p_.ringStepM, p_.ringStepRel * r);
                const bool proudBelow = i == 0 || r > b[i - 1].r1 + thr;
                const bool proudAbove = i + 1 == b.size() || r > b[i + 1].r0 + thr;
                if (!(proudBelow && proudAbove)) { valid = false; break; }
            }
            return b;
        };
        // a mast: its measured sections as frusta (a ball or collar where they stand proud), flat at its measured top
        if (bandsOnly) {
            // sections far wider than the mast's own (the top of the cap it stands in) are not the mast's
            {
                std::vector<double> rr; for (const auto& c : sl) if (c.n >= 4) rr.push_back(c.rOwn);
                const double rm = rr.empty() ? 0 : detail::median(rr);
                for (auto& c : sl) if (c.n >= 4) { c.r = c.rOwn; c.ok = c.rOwn <= 2.5 * rm + 0.1; }
            }
            bool valid = true;
            auto b = buildBands(yTop, valid);
            std::vector<const Slice*> ms; for (const auto& c : sl) if (c.ok) ms.push_back(&c);
            if (ms.empty()) return;
            if (!valid || b.empty()) {
                double sw = 0, sy = 0, sr = 0, syy = 0, syr = 0;
                for (auto* c : ms) { const double w = c->n; sw += w; sy += w * c->y; sr += w * c->r; syy += w * c->y * c->y; syr += w * c->y * c->r; }
                const double vy = syy / sw - std::pow(sy / sw, 2), k = vy > 1e-9 ? (syr / sw - sy / sw * sr / sw) / vy : 0, a0 = sr / sw - k * sy / sw;
                b = {Band{yBottom, yTop, a0 + k * yBottom, a0 + k * yTop, static_cast<int>(ms.size())}};
            }
            for (auto& x : b) { x.r0 = std::max(0.03, x.r0); x.r1 = std::max(0.03, x.r1); }
            b.back().y1 = yTop;
            st.bands = b; st.cap.present = false; st.yTop = yTop;
            std::vector<double> rr; for (auto* c : ms) rr.push_back(c->r);
            st.slenderness = (yTop - yBottom) / std::max(0.05, detail::median(rr));
            const auto pl = st.meridianPolyline();
            double ss = 0, w = 0, w25 = 0, st2 = 0;
            for (const auto& m : pts) { const double d = detail::polyDist(pl, m.r, m.y); ss += m.w * d * d; st2 += m.w * std::min(d * d, 0.25); w += m.w; if (d <= 0.25) w25 += m.w; }
            st.points = static_cast<int>(pts.size()); st.rmsM = std::sqrt(ss / std::max(1e-12, w)); st.rmsTruncM = std::sqrt(st2 / std::max(1e-12, w)); st.within25 = w25 / std::max(1e-12, w);
            return;
        }
        auto fitCap = [&](double y0, const std::vector<MP>& use, double trunc, Cap init, bool haveInit, bool quick = false) {
            // strictly above the base: a step's annulus at y0 belongs to the band below (the polyline's step explains it)
            std::vector<const MP*> sub; for (const auto& m : use) if (m.y >= y0 + 0.1) sub.push_back(&m);
            Cap c; c.present = false;
            if (sub.size() < 15) return std::make_pair(c, 1e300);
            double r0 = 0, hmax = y0;
            {
                std::vector<double> lr; for (auto* m : sub) { if (m->y < y0 + 0.6) lr.push_back(m->r); hmax = std::max(hmax, m->y); }
                r0 = lr.empty() ? 1.0 : detail::median(lr);
            }
            const double H0 = std::max(0.3, hmax - y0);
            std::vector<double> x0 = haveInit ? std::vector<double>{init.R0, init.H, std::log(init.p), std::log(init.q), init.b} : std::vector<double>{r0, H0, std::log(2.0), std::log(2.0), 0.0};
            auto make = [&](const std::vector<double>& x) {
                Cap k; k.present = true; k.y0 = y0;
                k.R0 = std::clamp(x[0], 0.3 * r0 + 0.1, 1.6 * r0 + 0.5);
                k.H = std::clamp(x[1], 0.2 * H0, 3.0 * H0 + 1.0);
                k.p = std::exp(std::clamp(x[2], std::log(0.25), std::log(10.0)));
                k.q = std::exp(std::clamp(x[3], std::log(0.25), std::log(10.0)));
                k.b = std::clamp(x[4], -0.5, 1.5);
                return k;
            };
            auto cost = [&](const std::vector<double>& x) {
                const Cap k = make(x);
                const auto pl = k.meridian(quick ? 40 : 80);
                double e = 0;
                // Welsch: a redescending loss, so the fit settles on the surface most of the scan agrees on (its mode), not
                // on the mean the dents pull inwards
                const double c2 = trunc * trunc;
                for (auto* m : sub) { const double d = detail::polyDist(pl, m->r, m->y); e += m->w * c2 * (1 - std::exp(-d * d / c2)); }
                return e;
            };
            double f;
            auto xb = detail::nelderMead(cost, x0, {0.15 * r0 + 0.1, 0.15 * H0 + 0.1, 0.3, 0.3, 0.1}, quick ? 250 : 500, f);
            xb = detail::nelderMead(cost, xb, {0.05 * r0 + 0.05, 0.05 * H0 + 0.05, 0.1, 0.1, 0.05}, quick ? 120 : 300, f);
            return std::make_pair(make(xb), f);
        };
        // full-model cost for a candidate y0
        auto fullCost = [&](const std::vector<Band>& b, const Cap& c, const std::vector<MP>& use, double trunc) {
            Stack t; t.yBottom = yBottom; t.bands = b; t.cap = c;
            const auto pl = t.meridianPolyline();
            double e = 0;
            for (const auto& m : use) { const double d = detail::polyDist(pl, m.r, m.y); e += m.w * std::min(d * d, trunc * trunc); }
            return e;
        };
        const double span = yTop - yBottom;
        double bestE = 1e300, bestY0 = yBottom;
        Cap bestCap; std::vector<Band> bestBands;
        const double trunc0 = 0.5;
        struct Cand { double y0, e; Cap c; std::vector<Band> b; };
        std::vector<Cand> cands;
        std::vector<double> rejectedY0;
        auto tryY0 = [&](double y0) {
            if (y0 < yBottom - 1e-9 || y0 > yBottom + 0.85 * span + 1e-9) return;
            for (const auto& c : cands) if (std::abs(c.y0 - y0) < 1e-6) return;
            for (const double r : rejectedY0) if (std::abs(r - y0) < 1e-6) return;
            bool valid = true;
            auto b = buildBands(y0, valid);
            if (!valid) { rejectedY0.push_back(y0); return; }
            auto [c, fc] = fitCap(y0, mer, trunc0, Cap{}, false, true);
            if (!c.present) return;
            const double e = fullCost(b, c, mer, trunc0);
            cands.push_back({y0, e, c, b});
            if (e < bestE) { bestE = e; bestY0 = y0; bestCap = c; bestBands = b; }
        };
        // every half slice (a step rarely falls on a slice boundary), at most `maxCapBases` bases over a tall stack
        const double baseStep = std::max(0.5 * s, 0.85 * span / std::max(8, p_.maxCapBases));
        for (double y0 = yBottom; y0 <= yBottom + 0.85 * span + 1e-9; y0 += baseStep) tryY0(y0);
        // uniform first: of the bases explaining the scan within `simplerShare` of the best, the one with the fewest bands
        // (then the lowest base: the most of the profile in the one smooth curve)
        {
            const Cand* pick = nullptr;
            if (std::getenv("SB_REV_DEBUG")) for (const auto& c : cands) std::fprintf(stderr, "cand y0 %.2f e %.4f bands %zu R0 %.2f H %.2f p %.2f q %.2f b %.2f\n", c.y0, c.e / bestE, c.b.size(), c.c.R0, c.c.H, c.c.p, c.c.q, c.c.b);
            for (const auto& c : cands) {
                if (c.e > bestE * (1 + p_.simplerShare)) continue;
                if (!pick || c.b.size() < pick->b.size() || (c.b.size() == pick->b.size() && c.y0 < pick->y0)) pick = &c;
            }
            if (pick) { bestY0 = pick->y0; bestCap = pick->c; bestBands = pick->b; }
        }
        if (!bestCap.present) return;
        // refine: the loss scale shrinks to twice the robust spread of the points it already explains (down to
        // `coreScaleM`), so the cap settles on the scan's undamaged surface; then what stands above the cap near the axis
        std::vector<MP> capUse = mer;
        double trunc = trunc0;
        for (int it = 0; it < 4; ++it) {
            Stack t; t.yBottom = yBottom; t.bands = bestBands; t.cap = bestCap;
            const auto pl = t.meridianPolyline();
            std::vector<double> d; for (const auto& m : capUse) { const double x = detail::polyDist(pl, m.r, m.y); if (x < trunc) d.push_back(x); }
            const double sig = d.empty() ? trunc : 1.4826 * detail::median(d);
            trunc = std::max(p_.coreScaleM, 2.0 * sig);
            // standing above the cap within half its radius: a stacked revolution, not the cap's
            above.clear();
            std::vector<MP> keep;
            const auto cm = bestCap.meridian(120);
            for (const auto& m : pts) {
                const double capY = capHeightOn(bestCap, cm, m.r);
                if (m.r < p_.stackMaxRadiusShare * bestCap.R0 && std::isfinite(capY) && m.y > capY + p_.stackRiseM) above.push_back(m);
            }
            for (const auto& m : mer) {
                const double capY = capHeightOn(bestCap, cm, m.r);
                if (!(m.r < p_.stackMaxRadiusShare * bestCap.R0 && std::isfinite(capY) && m.y > capY + p_.stackRiseM)) keep.push_back(m);
            }
            capUse = keep;
            auto [c, fc] = fitCap(bestY0, capUse, trunc, bestCap, true);
            (void)fc;
            if (c.present) bestCap = c;
        }
        // a mast on top: when nothing stacks on the cap, the topmost run of thin sections (at most mastMaxRadiusShare of the
        // stack's base radius) that is slender (height over radius at least mastMinSlenderness) and nearly straight (its
        // radius changes by at most mastMaxTaperShare of itself over its height) is not cap: the cap is refitted below it
        // and cut flat there, and the run becomes a stack of bands of its own measured radius (no cap is invented on it)
        {
            double area = 0; for (const auto& m : above) area += m.w;
            std::vector<double> lowR; for (const auto& c : sl) if (c.ok) { lowR.push_back(c.r); if (lowR.size() >= 3) break; }
            const double baseR = lowR.empty() ? bestCap.R0 : detail::median(lowR);
            int k = static_cast<int>(sl.size()) - 1;
            while (k >= 0 && sl[k].n < 4) --k;
            std::vector<const Slice*> run;
            while (k >= 0 && sl[k].n >= 4 && sl[k].rOwn <= p_.mastMaxRadiusShare * baseR) { run.push_back(&sl[k]); --k; }
            if ((above.size() < 60 || area < p_.stackMinAreaM2) && run.size() >= 2 && k >= 0) {
                const double ys = run.back()->y - 0.5 * s;
                std::vector<double> rr; for (auto* c : run) rr.push_back(c->rOwn);
                const double rs = std::max(0.03, detail::median(rr)), h = yTop - ys;
                double sw = 0, sy = 0, sr = 0, syy = 0, syr = 0;
                for (auto* c : run) { sw += 1; sy += c->y; sr += c->rOwn; syy += c->y * c->y; syr += c->y * c->rOwn; }
                const double vy = syy / sw - std::pow(sy / sw, 2), slope = vy > 1e-9 ? (syr / sw - sy / sw * sr / sw) / vy : 0;
                const double taper = std::abs(slope) * h / rs;
                st.slenderness = h / std::max(0.05, rs);
                if (std::getenv("SB_REV_DEBUG")) std::fprintf(stderr, "mast? ys %.2f h %.2f rs %.2f slender %.1f taper %.2f above %zu area %.2f y0 %.2f baseR %.2f\n", ys, h, rs, st.slenderness, taper, above.size(), area, bestY0, baseR);
                if (h >= p_.mastMinHeightM && st.slenderness >= p_.mastMinSlenderness && taper <= p_.mastMaxTaperShare && ys > bestY0 + 0.3) {
                    above.clear();
                    for (const auto& m : pts) if (m.y >= ys && m.r <= 2 * rs + 0.3) above.push_back(m);
                    std::vector<MP> below; for (const auto& m : capUse) if (m.y < ys) below.push_back(m);
                    for (int it = 0; it < 2; ++it) { auto [c, fc] = fitCap(bestY0, below, trunc, bestCap, true); (void)fc; if (c.present) bestCap = c; }
                    bestCap.cut = ys;
                    st.mastAbove = true;
                    capUse = below;
                }
            }
        }
        st.bands = bestBands;
        st.cap = bestCap;
        // the stack's top is the cap's apex or its cut (a stacked revolution continues above it)
        st.yTop = std::min(bestCap.y0 + bestCap.H, bestCap.cut);
        {
            const auto pl = st.meridianPolyline();
            double ss = 0, st2 = 0, w = 0, w25 = 0;
            int n = 0;
            for (const auto& m : capUse) { const double d = detail::polyDist(pl, m.r, m.y); ss += m.w * d * d; st2 += m.w * std::min(d * d, 0.25); w += m.w; if (d <= 0.25) w25 += m.w; ++n; }
            st.points = n; st.rmsM = std::sqrt(ss / std::max(1e-12, w)); st.rmsTruncM = std::sqrt(st2 / std::max(1e-12, w)); st.within25 = w25 / std::max(1e-12, w);
        }
    }

    /** The cap's height at radius r (its meridian is monotone in r for the fitted range), NaN outside it. */
    static double capHeightAt(const Cap& c, double r) { return capHeightOn(c, c.meridian(120), r); }
    static double capHeightOn(const Cap& c, const std::vector<std::array<double, 2>>& pl, double r) {
        if (!c.present || r > c.R0 * 1.3) return std::numeric_limits<double>::quiet_NaN();
        // the outermost crossing from the apex down
        for (size_t i = pl.size() - 1; i > 0; --i) {
            const double r1 = pl[i][0], r0 = pl[i - 1][0];
            if ((r >= std::min(r0, r1)) && (r <= std::max(r0, r1)) && std::abs(r0 - r1) > 1e-12) {
                const double t = (r - r1) / (r0 - r1);
                return pl[i][1] + t * (pl[i - 1][1] - pl[i][1]);
            }
        }
        return r <= pl.back()[0] ? pl.back()[1] : c.y0;
    }

    /**
     * The shape of a kept period: the binned residual folded over one period about the fundamental's crest, fitted with a
     * sinusoid, with the flat facets of a K-gon, and with a bump of continuous width and edge sharpness (at the crest or,
     * a groove, half a period from it). The bump wins only when it explains clearly more (it has two more numbers).
     */
    void fitShape(Modulation& m, const std::vector<double>& v) const {
        const int NB = static_cast<int>(v.size()), K = m.K;
        if (!K || NB < 64) return;
        std::complex<double> c1{0, 0};
        for (int i = 0; i < NB; ++i) { const double th = -PI + (i + 0.5) * 2 * PI / NB; c1 += v[i] * std::complex<double>(std::cos(K * th), -std::sin(K * th)); }
        m.theta0 = -std::arg(c1) / K;  // Re(c e^{iK th}) peaks where K th + arg c = 0
        constexpr int NF = 48;
        std::vector<double> f(NF, 0.0), phi(NF);
        std::vector<int> cnt(NF, 0);
        for (int i = 0; i < NB; ++i) {
            const double th = -PI + (i + 0.5) * 2 * PI / NB;
            double ph = std::fmod(K * (th - m.theta0), 2 * PI);
            if (ph >= PI) ph -= 2 * PI;
            if (ph < -PI) ph += 2 * PI;
            const int j = std::clamp(static_cast<int>((ph + PI) / (2 * PI) * NF), 0, NF - 1);
            f[j] += v[i]; ++cnt[j];
        }
        double fm = 0; int nf = 0;
        for (int j = 0; j < NF; ++j) { phi[j] = -PI + (j + 0.5) * 2 * PI / NF; if (cnt[j]) { f[j] /= cnt[j]; fm += f[j]; ++nf; } }
        if (nf < NF / 2) return;
        fm /= nf;
        double sst = 0; for (int j = 0; j < NF; ++j) if (cnt[j]) sst += (f[j] - fm) * (f[j] - fm);
        // least squares of f ~ a + b basis
        auto ls = [&](const std::function<double(double)>& basis, double& a, double& b) {
            double sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0;
            for (int j = 0; j < NF; ++j) if (cnt[j]) { const double x = basis(phi[j]); sx += x; sy += f[j]; sxx += x * x; sxy += x * f[j]; ++n; }
            const double d = n * sxx - sx * sx;
            b = std::abs(d) > 1e-15 ? (n * sxy - sx * sy) / d : 0; a = (sy - b * sx) / n;
            double e = 0; for (int j = 0; j < NF; ++j) if (cnt[j]) { const double r = f[j] - a - b * basis(phi[j]); e += r * r; }
            return e;
        };
        double aC, bC, aF, bF;
        const double eC = ls([](double x) { return std::cos(x); }, aC, bC);
        const double fMean = Modulation::facetMean(K);
        const double eF = ls([&](double x) { return Modulation::facetRaw(x, K) - fMean; }, aF, bF);
        double eB = 1e300, aB = 0, bB = 0, wB = 0.25, nB = 2, cB = 0;
        for (double centre : {0.0, PI}) for (int iw = 0; iw < 20; ++iw) {
            const double w = 0.03 * std::pow(0.8 / 0.03, iw / 19.0);
            for (double n : {1.0, 1.5, 2.0, 3.0, 4.0, 6.0, 8.0, 12.0}) {
                Modulation g; g.bumpWidth = w; g.bumpExponent = n;
                double a, b;
                const double e = ls([&](double x) { return g.bump(x - centre); }, a, b);
                if (e < eB) { eB = e; aB = a; bB = b; wB = w; nB = n; cB = centre; }
            }
        }
        m.cosAmp = m.bumpAmp = m.facetAmp = 0;
        const double eCF = std::min(eC, eF);
        double e;
        // a sinusoid or facets swing about the profile (zero mean: the profile keeps its radius); a bump stands on a shell
        // whose level relative to the profile is the fit's own intercept (the residual is measured from the profile)
        if (eB < p_.bumpPreference * eCF) { m.offset = aB; m.bumpAmp = bB; m.bumpWidth = wB; m.bumpExponent = nB; m.bumpCentre = cB; e = eB; }
        else if (eF < eC) { m.offset = 0; m.facetAmp = bF; e = eF; }
        else { m.offset = 0; m.cosAmp = bC; e = eC; }
        m.shapeRmsRel = std::sqrt(e / nf);
        m.shapeExplained = sst > 0 ? 1 - e / sst : 0;
    }

    /** K-periodic radial modulation of a stack's bands and its cap, from the relative residual. */
    void fitModulation(Stack& st, const Stack* next, const std::vector<MP>& all) {
        // a part shorter than minModulationM is tested only at the period the other part kept (a band of two slices cannot
        // tell a rib count apart from a window rhythm on its own)
        auto run = [&](bool cap, Modulation& out, int onlyK) {
            std::vector<const MP*> use;
            for (const auto& m : all) {
                if (m.y < st.yBottom || m.y > st.yTop) continue;
                if (next && m.y > next->yBottom && m.r < 0.6 * (next->bands.empty() ? next->cap.R0 : next->bands.front().r0) + 0.3) continue;
                const bool inCap = st.cap.present && m.y >= st.cap.y0;
                if (inCap != cap) continue;
                if (cap) { const double t = (m.y - st.cap.y0) / st.cap.H; if (t > 0.85) continue; }
                const double R = st.radiusAt(m.y);
                if (R < 0.3) continue;
                use.push_back(&m);
            }
            if (use.size() < 300 || onlyK < 0) return;
            double meanR = 0, yMid = 0;
            std::vector<double> ys;
            for (auto* m : use) { meanR += st.radiusAt(m->y); ys.push_back(m->y); }
            meanR /= use.size(); yMid = detail::median(ys);
            constexpr int NB = 720;
            std::vector<double> vAll;
            auto spectrum = [&](int half, std::vector<std::complex<double>>& c) {
                std::vector<std::vector<double>> bins(NB);
                for (auto* m : use) {
                    if (half == 1 && m->y > yMid) continue;
                    if (half == 2 && m->y <= yMid) continue;
                    const double e = m->r / st.radiusAt(m->y) - 1;
                    if (std::abs(e) > 0.5) continue;
                    bins[static_cast<int>((m->th + PI) / (2 * PI) * NB) % NB].push_back(e);
                }
                std::vector<double> v(NB, 0.0);
                std::vector<int> have(NB, 0);
                for (int i = 0; i < NB; ++i) if (bins[i].size() >= 2) { v[i] = detail::median(bins[i]); have[i] = 1; }
                // gaps: linear between the neighbours that have data
                int filled = 0; for (int i = 0; i < NB; ++i) filled += have[i];
                if (filled < NB / 3) return false;
                for (int i = 0; i < NB; ++i) if (!have[i]) {
                    int a = i, b = i; int da = 0, db = 0;
                    while (!have[(a + NB) % NB] && da < NB) { --a; ++da; }
                    while (!have[b % NB] && db < NB) { ++b; ++db; }
                    v[i] = (v[(a + NB) % NB] * db + v[b % NB] * da) / std::max(1, da + db);
                }
                const double mean = std::accumulate(v.begin(), v.end(), 0.0) / NB;
                if (half == 0) vAll = v;
                c.assign(91, {0, 0});
                for (int k = 1; k <= 90; ++k) {
                    std::complex<double> acc{0, 0};
                    for (int i = 0; i < NB; ++i) { const double th = -PI + (i + 0.5) * 2 * PI / NB; acc += (v[i] - mean) * std::complex<double>(std::cos(k * th), -std::sin(k * th)); }
                    c[k] = acc * (2.0 / NB);
                }
                return true;
            };
            std::vector<std::complex<double>> c, c1, c2;
            if (!spectrum(0, c)) return;
            // the noise floor at k: the median amplitude of its neighbours k-8..k+8 (dents are broadband and strongest at low
            // k; a period is a narrow line standing above its own neighbourhood)
            auto floorAt = [&](int k) {
                std::vector<double> m;
                for (int j = std::max(2, k - 8); j <= std::min(90, k + 8); ++j) if (j != k && j != 2 * k && 2 * j != k) m.push_back(std::abs(c[j]));
                return std::max(1e-6, detail::median(m));
            };
            // a period's significance: its lines at k, 2k, 3k (a sharp rib puts energy in all three) over their floors
            auto signif = [&](int k) {
                double a = 0, f = 0;
                for (int j = 1; j <= 3 && j * k <= 90; ++j) { a += std::abs(c[j * k]); f += floorAt(j * k); }
                return a / std::max(1e-9, f);
            };
            int K = 0; double best = 0, floor = 1e-6;
            for (int k = p_.minPeriods; k <= 72; ++k) {
                if (onlyK > 0 && k != onlyK) continue;
                const double sg = signif(k);
                if (sg > best) { best = sg; K = k; floor = floorAt(k); }
            }
            // the period is the fundamental when it stands above its floor too (2K's lines are a subset of K's)
            for (int d = 2; K && d <= 4; ++d) {
                if (K % d || K / d < p_.minPeriods) continue;
                const int k = K / d;
                // (and carries a real share of the line it would be the fundamental of: a dent at k = K/2 is not)
                if (signif(k) >= p_.ribSignificance && std::abs(c[k]) >= 3 * floorAt(k) && std::abs(c[k]) >= 0.3 * std::abs(c[K])) { K = k; best = signif(k); floor = floorAt(k); }
            }
            out.floorRel = floor; out.bestK = K; out.bestSignificance = best;
            double amp = 0;
            for (int j = 1; K && j <= 3 && j * K <= 90; ++j) if (j == 1 || std::abs(c[j * K]) >= 3 * floorAt(j * K)) amp += std::abs(c[j * K]);
            if (!K || best < p_.ribSignificance || amp * meanR < p_.ribMinAmpM) return;
            if (!spectrum(1, c1) || !spectrum(2, c2)) return;
            const double dphi = std::abs(detail::wrapPi(std::arg(c1[K]) - std::arg(c2[K])));
            out.phaseAgreeDeg = dphi * 180 / PI;  // in units of the K-th harmonic: 180 = half a period
            if (dphi > PI / 2) return;
            out.K = K; out.significance = best;
            for (int j = 1; j <= 3 && j * K <= 90; ++j) {
                const auto cj = c[j * K];
                if (j > 1 && std::abs(cj) < 3 * floorAt(j * K)) continue;
                // m(th) = Re(c e^{i k th}) = a cos(k th) - b sin(k th) with c = a + i b
                out.h.push_back({static_cast<double>(j * K), cj.real(), -cj.imag()});
            }
            fitShape(out, vAll);
            out.ampRel = out.maxAbs(); out.ampM = out.ampRel * meanR;
        };
        double bandH = 0; for (const auto& b : st.bands) bandH += b.y1 - b.y0;
        const double capH = st.cap.present ? 0.85 * st.cap.H : 0;
        if (capH >= bandH) {
            if (st.cap.present) run(true, st.capMod, capH >= p_.minModulationM ? 0 : -1);
            // bands too short to tell on their own carry the cap's modulation (one continuous surface where they meet)
            if (bandH > 0 && bandH >= p_.minModulationM) run(false, st.bandMod, 0);
            else if (bandH > 0 && st.capMod.K > 0) { run(false, st.bandMod, st.capMod.K); if (st.bandMod.K == st.capMod.K) { const auto stats = st.bandMod; st.bandMod = st.capMod; st.bandMod.significance = stats.significance; st.bandMod.phaseAgreeDeg = stats.phaseAgreeDeg; } }
        } else {
            run(false, st.bandMod, bandH >= p_.minModulationM ? 0 : -1);
            if (st.cap.present) run(true, st.capMod, capH >= p_.minModulationM ? 0 : st.bandMod.K > 0 ? st.bandMod.K : -1);
        }
    }

    /** Which stack explains a point best, and the point's signed radial residual against the full model. */
    double residualOf(const Revolution& R, const MP& m, int& which) const {
        double best = 1e300, signedD = 0;
        which = -1;
        for (size_t k = 0; k < R.stacks.size(); ++k) {
            const auto& st = R.stacks[k];
            auto pl = st.meridianPolyline();
            // the meridian scaled by the modulation at this angle
            const double capM = st.capMod.at(m.th), bandM = st.bandMod.at(m.th);
            for (auto& q : pl) q[0] *= 1 + ((st.cap.present && q[1] >= st.cap.y0) ? capM : bandM);
            const double d = detail::polyDist(pl, m.r, m.y);
            if (d < best) { best = d; which = static_cast<int>(k); const double rm = modelR(st, m.y, m.th); signedD = (rm > 0 && m.r < rm) ? -d : d; }
        }
        return signedD;
    }

    void residuals(Revolution& R, const std::vector<MP>& mp) {
        double ss = 0, st = 0, w = 0, w25 = 0;
        // (5 degree, 0.5 m) cells of the signed residual
        const int NT = 72;
        const double cy = 0.5;
        double y0 = 1e300, y1 = -1e300; for (const auto& m : mp) { y0 = std::min(y0, m.y); y1 = std::max(y1, m.y); }
        const int NY = std::max(1, static_cast<int>(std::ceil((y1 - y0) / cy)));
        std::vector<std::vector<double>> cell(static_cast<size_t>(NT) * NY);
        std::vector<double> cellR(static_cast<size_t>(NT) * NY, 0.0);
        for (const auto& m : mp) {
            int which;
            const double d = residualOf(R, m, which);
            ss += m.w * d * d; st += m.w * std::min(d * d, 0.25); w += m.w; if (std::abs(d) <= 0.25) w25 += m.w;
            const int a = static_cast<int>((m.th + PI) / (2 * PI) * NT) % NT, b = std::min(NY - 1, static_cast<int>((m.y - y0) / cy));
            cell[static_cast<size_t>(b) * NT + a].push_back(d);
            cellR[static_cast<size_t>(b) * NT + a] = std::max(cellR[static_cast<size_t>(b) * NT + a], m.r);
        }
        R.rmsM = std::sqrt(ss / std::max(1e-12, w)); R.rmsTruncM = std::sqrt(st / std::max(1e-12, w)); R.within25 = w25 / std::max(1e-12, w);
        std::vector<double> med(cell.size(), 0.0);
        std::vector<int> mark(cell.size(), 0);
        for (size_t i = 0; i < cell.size(); ++i) if (cell[i].size() >= 3) { med[i] = detail::median(cell[i]); if (std::abs(med[i]) > p_.departureM) mark[i] = med[i] > 0 ? 1 : -1; }
        std::vector<int> comp(cell.size(), -1);
        for (size_t i = 0; i < cell.size(); ++i) {
            if (!mark[i] || comp[i] >= 0) continue;
            Departure d; d.thetaLoDeg = 1e9; d.thetaHiDeg = -1e9; d.yLo = 1e9; d.yHi = -1e9;
            std::vector<size_t> q{i}; comp[i] = 1;
            double sum = 0;
            while (!q.empty()) {
                const size_t c = q.back(); q.pop_back();
                const int a = static_cast<int>(c % NT), b = static_cast<int>(c / NT);
                const double area = (2 * PI / NT) * std::max(0.3, cellR[c]) * cy;
                d.areaM2 += area; sum += med[c] * area; ++d.cells;
                const double th = -180 + (a + 0.5) * 360.0 / NT;
                d.thetaLoDeg = std::min(d.thetaLoDeg, th - 2.5); d.thetaHiDeg = std::max(d.thetaHiDeg, th + 2.5);
                d.yLo = std::min(d.yLo, y0 + b * cy); d.yHi = std::max(d.yHi, y0 + (b + 1) * cy);
                const int nb[4][2] = {{(a + 1) % NT, b}, {(a + NT - 1) % NT, b}, {a, b + 1}, {a, b - 1}};
                for (auto& n : nb) {
                    if (n[1] < 0 || n[1] >= NY) continue;
                    const size_t j = static_cast<size_t>(n[1]) * NT + n[0];
                    if (mark[j] == mark[i] && comp[j] < 0) { comp[j] = 1; q.push_back(j); }
                }
            }
            d.meanM = sum / std::max(1e-12, d.areaM2);
            if (d.areaM2 >= p_.departureMinAreaM2) R.departures.push_back(d);
        }
        std::sort(R.departures.begin(), R.departures.end(), [](const Departure& a, const Departure& b) { return a.areaM2 > b.areaM2; });
    }

    void envelope(Revolution& R) {
        double lo = 1e300, hi = -1e300;
        for (const auto& st : R.stacks) { lo = std::min(lo, st.yBottom); hi = std::max(hi, st.yTop); }
        for (double y = lo; y <= hi + 1e-9; y += 0.1) {
            double r = 0;
            for (const auto& st : R.stacks) {
                const bool inCap = st.cap.present && y >= st.cap.y0;
                r = std::max(r, st.radiusAt(y) * (1 + (inCap ? st.capMod.maxAbs() : st.bandMod.maxAbs())));
            }
            R.envelope.push_back({y, r});
        }
    }

    /** Each stack's meridian revolved into a closed solid (smooth normals per meridian segment run). */
    void emit(Revolution& R) {
        for (size_t k = 0; k < R.stacks.size(); ++k) {
            const auto& st = R.stacks[k];
            // angular samples: a whole number per period, enough for the narrowest kept rib (12 across its width), a vertex on
            // every crest (theta0: a facet's corner, a rib's ridge)
            const Modulation& dom = st.capMod.K ? st.capMod : st.bandMod;
            int N = p_.angularSegments;
            if (dom.K) {
                double per = 16;
                for (const Modulation* m : {&st.capMod, &st.bandMod}) if (m->K && m->bumpAmp != 0) per = std::max(per, std::ceil(12.0 / std::max(0.02, m->bumpWidth)));
                if (dom.facetAmp != 0) per = std::max(per, 24.0);
                const int perK = static_cast<int>(std::ceil(std::max(per, static_cast<double>(p_.angularSegments) / dom.K)));
                N = std::min(2048, dom.K * perK);
                N -= N % dom.K;
            }
            const double thBase = dom.K ? dom.theta0 : -PI;
            // the meridian: (r, y, cap?) split into runs at corners (each run smooth-shaded on its own)
            struct MV { double r, y; bool cap; };
            std::vector<std::vector<MV>> runs;
            const double yb = st.yBottom - (k == 0 ? p_.sinkM : 0.3);
            std::vector<uint8_t> flag;
            const auto pl = st.meridianPolyline(96, yb, &flag);
            std::vector<MV> cur{{pl[0][0], pl[0][1], flag[0] != 0}};
            for (size_t i = 1; i < pl.size(); ++i) {
                cur.push_back({pl[i][0], pl[i][1], flag[i] != 0});
                if (i + 1 < pl.size()) {
                    const double ax = pl[i][0] - pl[i - 1][0], ay = pl[i][1] - pl[i - 1][1], bx = pl[i + 1][0] - pl[i][0], by = pl[i + 1][1] - pl[i][1];
                    const double cosT = (ax * bx + ay * by) / std::max(1e-12, std::hypot(ax, ay) * std::hypot(bx, by));
                    if (cosT < std::cos(25 * PI / 180) || flag[i] != flag[i + 1]) { runs.push_back(cur); cur = {{pl[i][0], pl[i][1], flag[i + 1] != 0 && flag[i] != 0}}; }
                }
            }
            runs.push_back(cur);
            if (st.cap.present && !runs.back().empty()) runs.back().back().r = 0;
            for (const auto& run : runs) {
                if (run.size() < 2) continue;
                const uint32_t base = static_cast<uint32_t>(R.pos.size() / 3);
                const size_t M = run.size();
                std::vector<double> nacc((M) * N * 3, 0.0);
                for (size_t i = 0; i < M; ++i) for (int a = 0; a < N; ++a) {
                    const double th = thBase + 2 * PI * a / N;
                    const double m = run[i].cap ? st.capMod.at(th) : st.bandMod.at(th);
                    const double r = run[i].r * (1 + m);
                    R.pos.push_back(static_cast<float>(R.cx + r * std::cos(th)));
                    R.pos.push_back(static_cast<float>(run[i].y));
                    R.pos.push_back(static_cast<float>(R.cz + r * std::sin(th)));
                }
                auto P = [&](size_t v) { return std::array<double, 3>{R.pos[(base + v) * 3], R.pos[(base + v) * 3 + 1], R.pos[(base + v) * 3 + 2]}; };
                for (size_t i = 0; i + 1 < M; ++i) {
                    // outward in the meridian plane: (dy, -dr) for the traversal bottom-axis -> out -> up -> top-axis
                    const double dr = run[i + 1].r - run[i].r, dy = run[i + 1].y - run[i].y;
                    for (int a = 0; a < N; ++a) {
                        const int a1 = (a + 1) % N;
                        const size_t v00 = i * N + a, v01 = i * N + a1, v10 = (i + 1) * N + a, v11 = (i + 1) * N + a1;
                        const double th = thBase + 2 * PI * (a + 0.5) / N;
                        const std::array<double, 3> out{dy * std::cos(th), -dr, dy * std::sin(th)};
                        auto tri = [&](size_t A, size_t B, size_t C) {
                            auto pa = P(A), pb = P(B), pc = P(C);
                            const double ux = pb[0] - pa[0], uy = pb[1] - pa[1], uz = pb[2] - pa[2], vx = pc[0] - pa[0], vy = pc[1] - pa[1], vz = pc[2] - pa[2];
                            double nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
                            const double l = std::sqrt(nx * nx + ny * ny + nz * nz);
                            if (l < 1e-10) return;
                            if (nx * out[0] + ny * out[1] + nz * out[2] < 0) { std::swap(B, C); nx = -nx; ny = -ny; nz = -nz; }
                            R.idx.push_back(base + static_cast<uint32_t>(A)); R.idx.push_back(base + static_cast<uint32_t>(B)); R.idx.push_back(base + static_cast<uint32_t>(C));
                            for (size_t v : {A, B, C}) { nacc[v * 3] += nx; nacc[v * 3 + 1] += ny; nacc[v * 3 + 2] += nz; }
                        };
                        tri(v00, v01, v11);
                        tri(v00, v11, v10);
                    }
                }
                for (size_t v = 0; v < M * N; ++v) {
                    double nx = nacc[v * 3], ny = nacc[v * 3 + 1], nz = nacc[v * 3 + 2];
                    const double l = std::sqrt(nx * nx + ny * ny + nz * nz);
                    if (l > 1e-12) { nx /= l; ny /= l; nz /= l; } else { nx = 0; ny = 1; nz = 0; }
                    R.nrm.push_back(static_cast<float>(nx)); R.nrm.push_back(static_cast<float>(ny)); R.nrm.push_back(static_cast<float>(nz));
                }
            }
        }
    }
};

/** Reads "SBRV" u32 version, u32 nTri, nTri * 9 f32. */
inline std::vector<float> readInput(const std::string& file) {
    std::ifstream f(file, std::ios::binary);
    if (!f) throw std::runtime_error("cannot read " + file);
    char magic[4]; f.read(magic, 4);
    if (std::memcmp(magic, "SBRV", 4) != 0) throw std::runtime_error("not an SBRV file");
    uint32_t ver = 0, n = 0; f.read(reinterpret_cast<char*>(&ver), 4); f.read(reinterpret_cast<char*>(&n), 4);
    if (ver != 1) throw std::runtime_error("unsupported SBRV version");
    std::vector<float> t(static_cast<size_t>(n) * 9);
    f.read(reinterpret_cast<char*>(t.data()), static_cast<std::streamsize>(t.size() * 4));
    if (!f) throw std::runtime_error("SBRV file is truncated");
    return t;
}

}  // namespace revolution_fit
}  // namespace scratchbox

#endif
