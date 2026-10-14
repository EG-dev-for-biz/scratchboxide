/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Photometric relief: information inversion from photogrammetric tile photos.
 *
 * A rectified photogrammetric facade is a flat polygon carrying a photograph of the real wall.
 * The photo still holds the relief: glazing reads as periodic dark cells, cornices and string
 * courses as long horizontal luminance steps, and a projecting element casts a shadow band
 * whose width scales with its projection. This module reads that evidence and turns it into
 * bounded geometry, with no knowledge of what the building is:
 *
 *  1. Facade regions: planar, near-vertical, connected sets of triangles (refitted here from the
 *     mesh, so any rectified or raw scan works).
 *  2. Orthophoto: every region is resampled into a fronto-parallel metric image
 *     (plane (s, t) -> triangle -> UV -> texel), with a coverage mask.
 *  3. Analysis on that image only:
 *       - periodic grid: normalized autocorrelation of the detrended luminance along s and t,
 *         pitch from the first prominent peak refined over its harmonics;
 *       - the dark cell of the folded unit cell (phase + extent per axis), and then either a
 *         rectangular cell grid or continuous strips when only one axis carries the contrast;
 *       - per-cell / per-run evidence: glazing contrast against the surrounding frame;
 *       - structural lines: luminance steps consistent across the facade width (row / column
 *         gradient profiles), with the cast-shadow band width measured on the dark side.
 *  4. Relief field: recessed cells / strips (depth from contrast, only where evidence is strong)
 *     and proud bands above shadowed lines (depth = shadow width x shadow slope), all clamped
 *     to |dh| <= maxDepth.
 *  5. Re-tessellation: each treated region's triangles are clipped by the feature lines
 *     (axis-aligned in (s, t)), so geometry edges fall exactly on window borders and cornices.
 *     Every new vertex is computed canonically from the original edge or parent triangle,
 *     keeping its UV on the original photo mapping. Displacement is applied along the region
 *     normal; region borders stay fixed and their new vertices are inserted into the
 *     neighbouring triangles (no cracks, no T-junctions).
 *
 * Everything is derived from the data: no building constants, no closed category sets.
 * String labels on features are diagnostics only and never drive execution.
 */

#ifndef SCRATCHBOX_PHOTOMETRIC_RELIEF_HPP
#define SCRATCHBOX_PHOTOMETRIC_RELIEF_HPP

#include "scratchbox_gltf_scene.hpp"
#include "scratchbox_png.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <deque>
#include <fstream>
#include <functional>
#include <limits>
#include <numeric>
#include <sstream>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

namespace scratchbox {
namespace photometric_relief {

// ============================================================================================
// Basic types
// ============================================================================================

struct P3 {
    double x{0}, y{0}, z{0};
    P3() = default;
    P3(double X, double Y, double Z) : x(X), y(Y), z(Z) {}
    P3 operator+(const P3& o) const { return {x + o.x, y + o.y, z + o.z}; }
    P3 operator-(const P3& o) const { return {x - o.x, y - o.y, z - o.z}; }
    P3 operator*(double k) const { return {x * k, y * k, z * k}; }
    double dot(const P3& o) const { return x * o.x + y * o.y + z * o.z; }
    P3 cross(const P3& o) const { return {y * o.z - z * o.y, z * o.x - x * o.z, x * o.y - y * o.x}; }
    double length() const { return std::sqrt(dot(*this)); }
    P3 normalized() const {
        double l = length();
        return l > 0 ? (*this) * (1.0 / l) : P3();
    }
};

struct ReliefParams {
    // Facade regions
    double wallMaxAbsNy{0.2};        // candidate facade triangles: |normal.y| at most this
    double planeAngleDeg{2.0};       // region growth: normal agreement with the seed
    double planeOffset{0.06};        // region growth: vertex distance to the seed plane (m)
    double seamTolerance{0.12};      // coplanar patches closer than this across unwelded seams merge (m)
    double seamGridCell{6.0};        // spatial hash cell for the seam search (m)
    double minRegionArea{120.0};     // m^2; smaller regions are not analysed
    double weldEpsilon{0.001};       // m
    // Orthophoto
    double pixel{0.0};               // m per ortho pixel; 0 = derived from the photo texel size
    double texelFraction{0.5};       // ortho pixel = texel * fraction (then clamped)
    double minPixel{0.04};
    double maxPixel{0.30};
    int maxOrthoDim{8192};
    int orthoGapClosePx{2};          // closes seam gaps up to ~2 * this many ortho pixels wide
    double detrendRadius{0.0};       // m; 0 = max(maxPitch, 2)
    // Periodic grid
    double minPitch{0.8};
    double maxPitch{8.0};
    double minPeriodicity{0.15};     // normalized autocorrelation of the chosen peak
    double minProminence{0.08};      // peak height above the preceding dip
    double minTemplateContrast{0.015};
    double darkRunMinDepth{0.15};    // a dark band of the folded profile dips at least this share of its contrast below mid level
    double darkRunSplit{0.2};        // ...and splits at an interior bright bar this high (share of the band's depth)
    // Period search scales: the luminance is detrended along the lag axis only, at radii maxPitch / 2^k (k <
    // periodScales, radius >= minPitch / 2); a radius r searches pitches up to scalePitchReach * r and the most periodic
    // estimate over the scales wins. Small radii keep a weak floor rhythm from drowning in tier-scale variation.
    int periodScales{3};
    double scalePitchReach{2.2};
    // Two-axis lattice (both axes periodic): window columns come from the s fold; along each column the window rows are
    // the photo's own luminance minima (no global t phase), so cells follow the photo's floors where pitch drifts.
    double cellRowSeparation{0.45};  // minima of one column are at least this share of the t pitch apart
    double cellRowSpan{0.6};         // a minimum is measured against the brightest rows within this share of the pitch
    double cellMinRowContrast{0.05}; // relative depth of the minimum along t (then the 2D cell / frame test decides)
    // Dark cells (glazing) evidence
    double contrastLo{0.10};         // relative darkness of a cell vs its frame where recess starts
    double contrastHi{0.35};         // ... and where it reaches recessMax
    double recessMin{0.15};
    double recessMax{0.25};
    double minCellCoverage{0.98};
    double minStripLength{1.5};      // m
    double stripSmoothing{1.5};      // m; contrast smoothing along a strip (bridges per-floor variation)
    double stripHysteresis{0.6};     // a strip run continues while contrast >= this * contrastLo
    // Structural lines
    double lineMinSeparation{0.5};   // m
    double lineMinConsistency{0.6};  // fraction of the facade width agreeing on the step sign
    double lineMinStep{0.04};        // luminance step (0..1)
    double lineMadK{4.0};
    double minLineLength{3.0};       // m of covered width
    int maxLinesPerAxis{48};
    // Shadows -> projection
    double shadowSlope{1.0};         // projection per metre of cast-shadow width
    double maxBandHeight{1.2};       // m; longest shadow / proud band considered
    double minShadowContrast{0.10};  // relative depth of the shadow dip vs the lit wall
    double minProudDepth{0.03};
    // Relief
    double maxDepth{0.35};           // |dh| clamp (m)
    double jambWidth{0.02};          // reveal strip between the face and the recessed / proud level
    size_t maxRegionPieces{900000};  // clipping budget per region
    double creaseAngleDeg{30.0};
    int threads{0};
    // Region of interest (horizontal x/z box in the scan frame): when enabled only facade triangles whose centroid lies
    // inside it are candidates, so only facades there are analysed and re-tessellated (the rest is passed through).
    bool roiEnabled{false};
    double roiMinX{0}, roiMaxX{0}, roiMinZ{0}, roiMaxZ{0};
};

struct Orthophoto {
    int width{0}, height{0};
    double pixel{0}, sMin{0}, tMax{0};
    std::vector<float> lum;     // row-major; row 0 at tMax (top), column 0 at sMin
    std::vector<uint8_t> rgb;
    std::vector<uint8_t> cov;
    double sAt(double col) const { return sMin + (col + 0.5) * pixel; }
    double tAt(double row) const { return tMax - (row + 0.5) * pixel; }
};

struct PeriodEstimate {
    bool found{false};
    double pitch{0};
    double periodicity{0};
    int harmonics{0};
};

/** The dark rectangle of the folded unit cell, in plane coordinates (start mod pitch, extent). */
struct DarkCell {
    bool foundS{false}, foundT{false};
    double s0{0}, widthS{0}, t0{0}, heightT{0};
    double contrastS{0}, contrastT{0};
    double phaseS{0}, phaseT{0};  // dark-cell centre modulo the pitch, from the plane origin
    std::vector<std::pair<double, double>> runsS, runsT;  // every dark band per period: (start mod pitch, extent)
};

struct StructuralLine {
    char axis{'t'};          // 't': line of constant t (horizontal); 's': constant s (vertical)
    double coord{0};
    double step{0};          // luminance after minus before (after = decreasing t / increasing s)
    double consistency{0};
    double from{0}, to{0};   // extent along the line
    double shadowWidth{0};
    double proudDepth{0};
    bool relief{false};
    bool explainedByGrid{false};
};

struct ReliefFeature {
    std::string label;             // diagnostic only
    double s0{0}, s1{0}, t0{0}, t1{0};      // outer rectangle (edges of the photographic feature)
    double si0{0}, si1{0}, ti0{0}, ti1{0};  // inner rectangle (full height)
    double height{0};              // along the facade normal; negative = recessed
    double evidence{0};
};

struct FacadeAnalysis {
    PeriodEstimate periodS, periodT;
    DarkCell cell;
    std::string pattern{"none"};   // diagnostic only
    int cellsTested{0}, cellsAccepted{0};
    int stripsTested{0}, stripRuns{0};
    std::vector<StructuralLine> lines;
    std::vector<ReliefFeature> features;
    double meanLuminance{0};
};

struct FacadeReport {
    int id{0};
    size_t inputTriangles{0};
    double area{0};
    P3 centroid, normal, axisS, axisT;
    double sMin{0}, sMax{0}, tMin{0}, tMax{0};
    double texel{0}, pixel{0};
    int orthoWidth{0}, orthoHeight{0};
    double coverage{0};
    FacadeAnalysis analysis;
    bool treated{false};
    std::string skipReason;
    size_t outputTriangles{0};
    size_t sLines{0}, tLines{0};
    double minHeight{0}, maxHeight{0};
    double recessArea{0}, proudArea{0};
};

struct OutputTriangle {
    uint32_t p[3];
    float uv[3][2];
    uint32_t material;
    int32_t region;
    uint32_t parent{0};  // input triangle this one was cut from (for orientation checks)
};

struct ReliefMesh {
    std::vector<P3> positions;
    std::vector<float> heights;      // displacement applied to each position (0 = original surface)
    std::vector<int32_t> positionRegion;
    std::vector<OutputTriangle> triangles;
};

struct ReliefResult {
    bool ok{false};
    std::string error;
    ReliefMesh mesh;
    std::vector<FacadeReport> facades;
    size_t inputTriangles{0}, inputVertices{0}, weldedVertices{0};
    size_t candidateTriangles{0}, regionsFound{0}, regionsAnalysed{0}, regionsTreated{0};
    size_t patchesMerged{0}, internalSeamEdges{0};
    size_t insertedBorderVertices{0}, borderPolygonsPatched{0};
    size_t earClipFallbacks{0}, earClipUnfilled{0};  // polygons whose ear clipping needed the relaxed ear test / left a remainder
    double minHeight{0}, maxHeight{0}, meanRecess{0}, meanProud{0};
    size_t recessedVertices{0}, proudVertices{0};
    double recessArea{0}, proudArea{0};
    std::vector<std::pair<std::string, double>> timingsMs;
};

// ============================================================================================
// Helpers
// ============================================================================================
namespace detail {

inline unsigned resolveThreads(int requested) {
    if (requested > 0) return static_cast<unsigned>(requested);
    unsigned hw = std::thread::hardware_concurrency();
    return std::max(1u, hw ? hw : 4u);
}

template <class F>
inline void parallelFor(size_t n, unsigned threads, F&& fn) {
    if (n == 0) return;
    if (threads <= 1 || n < 2) {
        fn(size_t(0), n);
        return;
    }
    size_t t = std::min<size_t>(threads, n);
    size_t chunk = (n + t - 1) / t;
    std::vector<std::thread> pool;
    for (size_t i = 0; i < t; ++i) {
        size_t b = i * chunk, e = std::min(n, b + chunk);
        if (b >= e) break;
        pool.emplace_back([&fn, b, e] { fn(b, e); });
    }
    for (auto& th : pool) th.join();
}

inline uint64_t mix64(uint64_t z) {
    z += 0x9E3779B97F4A7C15ull;
    z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ull;
    z = (z ^ (z >> 27)) * 0x94D049BB133111EBull;
    return z ^ (z >> 31);
}

inline uint64_t bitsOf(double v) {
    uint64_t b;
    std::memcpy(&b, &v, 8);
    return b;
}

inline uint64_t edgeKey(uint32_t a, uint32_t b) {
    if (a > b) std::swap(a, b);
    return (static_cast<uint64_t>(a) << 32) | b;
}

inline double smoothstep(double lo, double hi, double x) {
    if (hi <= lo) return x >= hi ? 1.0 : 0.0;
    double t = std::clamp((x - lo) / (hi - lo), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
}

inline int wrapCoord(int i, int n, int mode) {
    if (n <= 0) return 0;
    if (mode == 33071) return std::clamp(i, 0, n - 1);
    if (mode == 33648) {
        int period = 2 * n;
        int m = ((i % period) + period) % period;
        return m < n ? m : period - 1 - m;
    }
    return ((i % n) + n) % n;
}

inline void sampleBilinear(const texture::ImageBuffer& img, double u, double v, int wrapS, int wrapT, double out[3]) {
    const int W = img.width, H = img.height, ch = img.channels;
    double x = u * W - 0.5, y = v * H - 0.5;
    int x0 = static_cast<int>(std::floor(x)), y0 = static_cast<int>(std::floor(y));
    double fx = x - x0, fy = y - y0;
    int xs[2] = {wrapCoord(x0, W, wrapS), wrapCoord(x0 + 1, W, wrapS)};
    int ys[2] = {wrapCoord(y0, H, wrapT), wrapCoord(y0 + 1, H, wrapT)};
    double w[4] = {(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy};
    out[0] = out[1] = out[2] = 0;
    for (int k = 0; k < 4; ++k) {
        size_t idx = (static_cast<size_t>(ys[k >> 1]) * W + xs[k & 1]) * ch;
        for (int c = 0; c < 3; ++c) out[c] += w[k] * img.data[idx + (ch == 1 ? 0 : c)] / 255.0;
    }
}

/** Mean of `v` over covered pixels in a (2r+1)^2 box (normalized convolution via integral images). */
inline std::vector<float> boxMean(const std::vector<float>& v, const std::vector<uint8_t>& cov, int W, int H, int r) {
    std::vector<double> S(static_cast<size_t>(W + 1) * (H + 1), 0.0), C(S.size(), 0.0);
    for (int y = 0; y < H; ++y) {
        double rs = 0, rc = 0;
        for (int x = 0; x < W; ++x) {
            size_t i = static_cast<size_t>(y) * W + x;
            if (cov[i]) { rs += v[i]; rc += 1; }
            S[static_cast<size_t>(y + 1) * (W + 1) + x + 1] = S[static_cast<size_t>(y) * (W + 1) + x + 1] + rs;
            C[static_cast<size_t>(y + 1) * (W + 1) + x + 1] = C[static_cast<size_t>(y) * (W + 1) + x + 1] + rc;
        }
    }
    std::vector<float> out(static_cast<size_t>(W) * H, 0.0f);
    for (int y = 0; y < H; ++y) {
        int y0 = std::max(0, y - r), y1 = std::min(H, y + r + 1);
        for (int x = 0; x < W; ++x) {
            int x0 = std::max(0, x - r), x1 = std::min(W, x + r + 1);
            auto at = [&](const std::vector<double>& A, int yy, int xx) { return A[static_cast<size_t>(yy) * (W + 1) + xx]; };
            double s = at(S, y1, x1) - at(S, y0, x1) - at(S, y1, x0) + at(S, y0, x0);
            double c = at(C, y1, x1) - at(C, y0, x1) - at(C, y1, x0) + at(C, y0, x0);
            out[static_cast<size_t>(y) * W + x] = c > 0 ? static_cast<float>(s / c) : 0.0f;
        }
    }
    return out;
}

/**
 * Normalized autocorrelation of a masked image along rows (lag in columns) or along columns
 * (lag in rows), for lags 0..kMax. Only pairs with both pixels covered contribute.
 */
inline std::vector<double> autocorrelation(const std::vector<float>& x, const std::vector<float>& m, int W, int H,
                                           bool alongRows, int kMax, unsigned threads) {
    std::vector<double> R(static_cast<size_t>(std::max(kMax, 0)) + 1, 0.0);
    parallelFor(R.size(), threads, [&](size_t b, size_t e) {
        for (size_t kk = b; kk < e; ++kk) {
            const int k = static_cast<int>(kk);
            double num = 0, d1 = 0, d2 = 0;
            if (alongRows) {
                for (int r = 0; r < H; ++r) {
                    const float* xr = x.data() + static_cast<size_t>(r) * W;
                    const float* mr = m.data() + static_cast<size_t>(r) * W;
                    float fn = 0, f1 = 0, f2 = 0;
                    for (int c = 0; c + k < W; ++c) {
                        float a = xr[c], bb = xr[c + k];
                        fn += a * bb;
                        f1 += a * a * mr[c + k];
                        f2 += bb * bb * mr[c];
                    }
                    num += fn; d1 += f1; d2 += f2;
                }
            } else {
                for (int r = 0; r + k < H; ++r) {
                    const float* xa = x.data() + static_cast<size_t>(r) * W;
                    const float* xb = x.data() + static_cast<size_t>(r + k) * W;
                    const float* ma = m.data() + static_cast<size_t>(r) * W;
                    const float* mb = m.data() + static_cast<size_t>(r + k) * W;
                    float fn = 0, f1 = 0, f2 = 0;
                    for (int c = 0; c < W; ++c) {
                        float a = xa[c], bb = xb[c];
                        fn += a * bb;
                        f1 += a * a * mb[c];
                        f2 += bb * bb * ma[c];
                    }
                    num += fn; d1 += f1; d2 += f2;
                }
            }
            R[kk] = (d1 > 0 && d2 > 0) ? num / std::sqrt(d1 * d2) : 0.0;
        }
    });
    return R;
}

/** First prominent autocorrelation peak in [kMin, kMax], refined by parabola and harmonics. */
inline PeriodEstimate pickPeriod(const std::vector<double>& R, int kMin, int kMax, double px, const ReliefParams& p) {
    PeriodEstimate pe;
    const int n = static_cast<int>(R.size());
    kMin = std::max(kMin, 2);
    kMax = std::min(kMax, n - 2);
    if (kMax <= kMin) return pe;
    std::vector<int> peaks;
    double rmax = -1;
    for (int k = kMin; k <= kMax; ++k) {
        if (!(R[k] >= R[k - 1] && R[k] > R[k + 1])) continue;
        double dip = *std::min_element(R.begin() + 1, R.begin() + k);
        if (R[k] - dip < p.minProminence) continue;
        peaks.push_back(k);
        rmax = std::max(rmax, R[k]);
    }
    if (peaks.empty() || rmax < p.minPeriodicity) return pe;
    int k0 = -1;
    for (int k : peaks) {
        if (R[k] >= std::max(p.minPeriodicity, 0.7 * rmax)) { k0 = k; break; }
    }
    if (k0 < 0) return pe;
    auto refine = [&](int k) {
        double a = R[k - 1], b = R[k], c = R[k + 1];
        double den = a - 2 * b + c;
        double d = den < 0 ? 0.5 * (a - c) / den : 0.0;
        return k + std::clamp(d, -0.5, 0.5);
    };
    double p0 = refine(k0);
    double num = p0, den = 1;
    int harmonics = 1;
    for (int m = 2; m <= 16; ++m) {
        double target = m * p0, win = std::max(2.0, 0.08 * target);
        int lo = static_cast<int>(std::floor(target - win)), hi = static_cast<int>(std::ceil(target + win));
        if (hi >= n - 1 || lo < 1) break;
        int best = -1;
        for (int k = lo; k <= hi; ++k) {
            if (R[k] >= R[k - 1] && R[k] > R[k + 1] && (best < 0 || R[k] > R[best])) best = k;
        }
        if (best < 0 || R[best] < 0.5 * R[k0]) continue;
        double pm = refine(best);
        num += m * pm;
        den += static_cast<double>(m) * m;
        ++harmonics;
    }
    pe.found = true;
    pe.pitch = num / den * px;
    pe.periodicity = R[k0];
    pe.harmonics = harmonics;
    return pe;
}

/**
 * Period along one axis of a masked orthophoto. The luminance is detrended along that axis only (running mean over
 * covered pixels of each row / column), so structure that is constant along the axis (a pier for the t axis, a floor
 * band for the s axis) adds nothing at any lag. `lineMask` (optional) keeps only some lines across the axis: the
 * columns for the t axis (alongRows = false), the rows for the s axis. Several detrend radii are tried (see
 * ReliefParams::periodScales); the most periodic estimate wins.
 */
inline PeriodEstimate detectPeriod(const std::vector<float>& lum, const std::vector<uint8_t>& cov, int W, int H, double px,
                                   bool alongRows, const std::vector<uint8_t>* lineMask, const ReliefParams& p, unsigned threads) {
    PeriodEstimate best;
    const int n = alongRows ? W : H;      // samples along the axis
    const int lines = alongRows ? H : W;  // lines across it
    const int kMin = std::max(3, static_cast<int>(std::ceil(p.minPitch / px)));
    const size_t N = static_cast<size_t>(W) * H;
    std::vector<float> x(N), m(N);
    std::vector<double> ps, pc;
    for (int scale = 0; scale < std::max(1, p.periodScales); ++scale) {
        const double r = std::max(p.maxPitch, 2.0) / std::pow(2.0, scale);
        if (scale > 0 && r < 0.5 * p.minPitch) break;
        const int kMax = std::min(static_cast<int>(std::floor(std::min(p.maxPitch, p.scalePitchReach * r) / px)), n / 3);
        if (kMax <= kMin + 2) continue;
        const int rad = std::max(1, static_cast<int>(std::lround(r / px)));
        std::fill(x.begin(), x.end(), 0.0f);
        std::fill(m.begin(), m.end(), 0.0f);
        ps.assign(static_cast<size_t>(n) + 1, 0.0);
        pc.assign(static_cast<size_t>(n) + 1, 0.0);
        for (int l = 0; l < lines; ++l) {
            if (lineMask && !(*lineMask)[static_cast<size_t>(l)]) continue;
            auto at = [&](int k) { return alongRows ? static_cast<size_t>(l) * W + k : static_cast<size_t>(k) * W + l; };
            for (int k = 0; k < n; ++k) {
                const size_t i = at(k);
                ps[static_cast<size_t>(k) + 1] = ps[static_cast<size_t>(k)] + (cov[i] ? lum[i] : 0.0);
                pc[static_cast<size_t>(k) + 1] = pc[static_cast<size_t>(k)] + (cov[i] ? 1.0 : 0.0);
            }
            for (int k = 0; k < n; ++k) {
                const size_t i = at(k);
                if (!cov[i]) continue;
                const int a = std::max(0, k - rad), b = std::min(n, k + rad + 1);
                const double c = pc[static_cast<size_t>(b)] - pc[static_cast<size_t>(a)];
                x[i] = static_cast<float>(lum[i] - (ps[static_cast<size_t>(b)] - ps[static_cast<size_t>(a)]) / c);
                m[i] = 1.0f;
            }
        }
        const int kExt = std::min(n / 2, 4 * kMax + 4);
        auto R = autocorrelation(x, m, W, H, alongRows, kExt, threads);
        PeriodEstimate pe = pickPeriod(R, kMin, kMax, px, p);
        if (pe.found && (!best.found || pe.periodicity > best.periodicity)) best = pe;
    }
    return best;
}

struct DarkRun {
    double lo{0};     // start, in bin units (bin i spans [i, i+1))
    double width{0};  // in bin units
    double depth{0};  // mid level minus the run minimum
};

struct DarkProfile {
    bool ok{false};
    double contrast{0};
    std::vector<DarkRun> runs;  // darkest first
};

/**
 * Circular runs of a folded profile below its mid level: the dark bands of the unit cell. A run must be at least
 * `minBins` wide and dip at least `minDepthShare` of the profile's contrast below the mid level. A run is split at an
 * interior bright bar (a mullion between two windows of one bay) that rises at least `splitShare` of the run's depth
 * above the shallower of the two dips beside it; each part ends where the profile crosses halfway between its dip and
 * the bar, so a frame of photo stays between them.
 */
inline DarkProfile darkRuns(const std::vector<double>& prof, double minBins, double minDepthShare = 0.25, double splitShare = 0.0) {
    DarkProfile dp;
    const int n = static_cast<int>(prof.size());
    if (n < 4) return dp;
    int imax = static_cast<int>(std::max_element(prof.begin(), prof.end()) - prof.begin());
    double mx = prof[static_cast<size_t>(imax)], mn = *std::min_element(prof.begin(), prof.end());
    if (!(mx > mn)) return dp;
    const double thr = 0.5 * (mx + mn);
    dp.contrast = mx - mn;
    auto at = [&](int i) { return prof[static_cast<size_t>(((i % n) + n) % n)]; };
    // crossing of `lvl` between bin centres i and i + 1 (bin-edge units: bin i spans [i, i+1))
    auto cross = [&](int i, double lvl) {
        const double a = at(i), b = at(i + 1);
        const double f = std::abs(b - a) > 1e-12 ? (lvl - a) / (b - a) : 0.5;
        return i + 0.5 + std::clamp(f, 0.0, 1.0);
    };
    std::vector<DarkRun> runs;
    // split [s, e] (unwrapped bin indices, all below thr) bounded by [left, right] at its most prominent interior bar
    std::function<void(int, int, double, double)> emit = [&](int s, int e, double left, double right) {
        double mnr = at(s);
        for (int i = s; i <= e; ++i) mnr = std::min(mnr, at(i));
        if (splitShare > 0 && e - s >= 2) {
            int best = -1;
            double bestProm = 0, bestL = 0, bestR = 0;
            for (int m = s + 1; m < e; ++m) {
                if (!(at(m) >= at(m - 1) && at(m) >= at(m + 1))) continue;
                double ml = at(s), mr = at(e);
                for (int i = s; i < m; ++i) ml = std::min(ml, at(i));
                for (int i = m + 1; i <= e; ++i) mr = std::min(mr, at(i));
                const double prom = at(m) - std::max(ml, mr);
                if (prom > bestProm) { bestProm = prom; best = m; bestL = ml; bestR = mr; }
            }
            if (best >= 0 && bestProm >= splitShare * (thr - mnr)) {
                const double lvlL = 0.5 * (at(best) + bestL), lvlR = 0.5 * (at(best) + bestR);
                int kl = best - 1;
                while (kl > s && at(kl) >= lvlL) --kl;
                int kr = best + 1;
                while (kr < e && at(kr) >= lvlR) ++kr;
                const double endL = cross(kl, lvlL), startR = cross(kr - 1, lvlR);
                if (endL - left >= minBins && right - startR >= minBins && at(kl) < lvlL && at(kr) < lvlR) {
                    emit(s, kl, left, endL);
                    emit(kr, e, startR, right);
                    return;
                }
            }
        }
        DarkRun r;
        r.width = right - left;
        r.lo = left - std::floor(left / n) * n;
        r.depth = thr - mnr;
        if (r.width >= minBins && r.depth >= minDepthShare * dp.contrast) runs.push_back(r);
    };
    double darkTotal = 0;
    int k = 1;
    while (k < n) {
        if (at(imax + k) >= thr) { ++k; continue; }
        const int start = imax + k;
        while (k < n && at(imax + k) < thr) ++k;
        const int end = imax + k - 1;
        const double left = cross(start - 1, thr), right = cross(end, thr);
        darkTotal += right - left;
        emit(start, end, left, right);
    }
    if (runs.empty() || n - darkTotal < minBins) return dp;
    dp.runs = std::move(runs);
    std::sort(dp.runs.begin(), dp.runs.end(), [](const DarkRun& a, const DarkRun& b) { return a.depth > b.depth; });
    dp.ok = true;
    return dp;
}

/** A 2D view of the orthophoto where lines of constant `along` are image rows. */
struct View {
    int W{0}, H{0};
    std::vector<float> lum;
    std::vector<uint8_t> cov;
    double a0{0}, a1{1}, b0{0}, b1{1};  // across(x) = a0 + a1*x, along(y) = b0 + b1*y (pixel-edge units)
    bool transposed{false};
    double across(double x) const { return a0 + a1 * x; }
    double along(double y) const { return b0 + b1 * y; }
    // pixel centres with coordinate inside [q0, q1]
    static void range(double q0, double q1, double o, double k, int n, int& i0, int& i1) {
        double f0 = (q0 - o) / k - 0.5, f1 = (q1 - o) / k - 0.5;
        if (f0 > f1) std::swap(f0, f1);
        i0 = std::max(0, static_cast<int>(std::ceil(f0 - 1e-9)));
        i1 = std::min(n - 1, static_cast<int>(std::floor(f1 + 1e-9)));
    }
    void acrossRange(double q0, double q1, int& x0, int& x1) const { range(q0, q1, a0, a1, W, x0, x1); }
    void alongRange(double q0, double q1, int& y0, int& y1) const { range(q0, q1, b0, b1, H, y0, y1); }
    float L(int x, int y) const { return lum[static_cast<size_t>(y) * W + x]; }
    bool C(int x, int y) const { return cov[static_cast<size_t>(y) * W + x] != 0; }
};

inline View makeView(const Orthophoto& o, bool transposed) {
    View v;
    v.transposed = transposed;
    const double px = o.pixel;
    if (!transposed) {
        v.W = o.width; v.H = o.height;
        v.lum = o.lum; v.cov = o.cov;
        v.a0 = o.sMin; v.a1 = px; v.b0 = o.tMax; v.b1 = -px;
    } else {
        v.W = o.height; v.H = o.width;
        v.lum.resize(o.lum.size()); v.cov.resize(o.cov.size());
        for (int r = 0; r < o.height; ++r) {
            for (int c = 0; c < o.width; ++c) {
                size_t src = static_cast<size_t>(r) * o.width + c, dst = static_cast<size_t>(c) * o.height + r;
                v.lum[dst] = o.lum[src];
                v.cov[dst] = o.cov[src];
            }
        }
        v.a0 = o.tMax; v.a1 = -px; v.b0 = o.sMin; v.b1 = px;
    }
    return v;
}

/** Rectangle given in a view's (across, along) coordinates, returned in plane (s, t). */
inline void viewRectToPlane(const View& v, double ac0, double ac1, double al0, double al1, double& s0, double& s1, double& t0, double& t1) {
    if (ac0 > ac1) std::swap(ac0, ac1);
    if (al0 > al1) std::swap(al0, al1);
    if (!v.transposed) { s0 = ac0; s1 = ac1; t0 = al0; t1 = al1; }
    else { t0 = ac0; t1 = ac1; s0 = al0; s1 = al1; }
}

inline ReliefFeature makeFeature(const std::string& label, double s0, double s1, double t0, double t1, double height,
                                 double evidence, double jamb) {
    ReliefFeature f;
    f.label = label;
    f.s0 = std::min(s0, s1); f.s1 = std::max(s0, s1);
    f.t0 = std::min(t0, t1); f.t1 = std::max(t0, t1);
    double es = std::min(jamb, 0.25 * (f.s1 - f.s0)), et = std::min(jamb, 0.25 * (f.t1 - f.t0));
    f.si0 = f.s0 + es; f.si1 = f.s1 - es;
    f.ti0 = f.t0 + et; f.ti1 = f.t1 - et;
    f.height = height;
    f.evidence = evidence;
    return f;
}

struct LineCandidate {
    int y{0};             // edge between rows y-1 and y
    double step{0}, consistency{0}, score{0};
    int x0{0}, x1{-1};
};

/** Rows edges where the luminance steps consistently across the view width. */
inline std::vector<LineCandidate> detectLineCandidates(const View& v, int span, double pxLen, const ReliefParams& p) {
    const int W = v.W, H = v.H;
    std::vector<LineCandidate> out;
    if (H < 2 * span + 2 || W < 4) return out;
    std::vector<double> PL(static_cast<size_t>(H + 1) * W, 0.0);
    std::vector<int> PC(static_cast<size_t>(H + 1) * W, 0);
    for (int y = 0; y < H; ++y) {
        for (int x = 0; x < W; ++x) {
            size_t i = static_cast<size_t>(y) * W + x, n0 = static_cast<size_t>(y) * W + x, n1 = static_cast<size_t>(y + 1) * W + x;
            PL[n1] = PL[n0] + (v.cov[i] ? v.lum[i] : 0.0);
            PC[n1] = PC[n0] + (v.cov[i] ? 1 : 0);
        }
    }
    const int minValid = std::max(4, static_cast<int>(std::ceil(p.minLineLength / pxLen)));
    std::vector<double> G(H + 1, 0), Cn(H + 1, 0), S(H + 1, 0);
    std::vector<int> N(H + 1, 0);
    std::vector<double> d(W);
    std::vector<uint8_t> ok(W);
    auto columnSteps = [&](int y) {
        int n = 0;
        double sum = 0;
        for (int x = 0; x < W; ++x) {
            int c1 = PC[static_cast<size_t>(y) * W + x] - PC[static_cast<size_t>(y - span) * W + x];
            int c2 = PC[static_cast<size_t>(y + span) * W + x] - PC[static_cast<size_t>(y) * W + x];
            ok[x] = (c1 == span && c2 == span);
            if (!ok[x]) continue;
            double above = (PL[static_cast<size_t>(y) * W + x] - PL[static_cast<size_t>(y - span) * W + x]) / span;
            double below = (PL[static_cast<size_t>(y + span) * W + x] - PL[static_cast<size_t>(y) * W + x]) / span;
            d[x] = below - above;
            sum += d[x];
            ++n;
        }
        return std::make_pair(n, sum);
    };
    const double tau = 0.5 * p.lineMinStep;
    for (int y = span; y <= H - span; ++y) {
        auto [n, sum] = columnSteps(y);
        if (n < minValid) continue;
        double g = sum / n;
        double sg = g >= 0 ? 1.0 : -1.0;
        int agree = 0;
        for (int x = 0; x < W; ++x) {
            if (ok[x] && d[x] * sg > tau) ++agree;
        }
        G[y] = g;
        Cn[y] = static_cast<double>(agree) / n;
        N[y] = n;
        S[y] = std::abs(g) * Cn[y];
    }
    std::vector<double> vals;
    for (int y = 0; y <= H; ++y) if (N[y] > 0) vals.push_back(S[y]);
    if (vals.size() < 8) return out;
    std::vector<double> tmp = vals;
    std::nth_element(tmp.begin(), tmp.begin() + tmp.size() / 2, tmp.end());
    double med = tmp[tmp.size() / 2];
    for (auto& t : tmp) t = std::abs(t - med);
    std::nth_element(tmp.begin(), tmp.begin() + tmp.size() / 2, tmp.end());
    double mad = tmp[tmp.size() / 2];
    double thr = med + p.lineMadK * 1.4826 * mad;
    const int sep = std::max(1, static_cast<int>(std::lround(p.lineMinSeparation / pxLen)));
    const int gapPx = std::max(2, static_cast<int>(std::lround(1.0 / pxLen)));
    for (int y = span; y <= H - span; ++y) {
        if (N[y] == 0 || std::abs(G[y]) < p.lineMinStep || Cn[y] < p.lineMinConsistency || S[y] < thr) continue;
        bool isMax = true;
        for (int k = std::max(0, y - sep); k <= std::min(H, y + sep) && isMax; ++k) {
            if (k == y || N[k] == 0) continue;
            if (S[k] > S[y] || (S[k] == S[y] && k < y)) isMax = false;
        }
        if (!isMax) continue;
        columnSteps(y);
        double sg = G[y] >= 0 ? 1.0 : -1.0;
        int bestA = -1, bestB = -1, curA = -1, lastAgree = -1;
        for (int x = 0; x < W; ++x) {
            bool agree = ok[x] && d[x] * sg > tau;
            if (!agree) continue;
            if (curA < 0 || x - lastAgree > gapPx) curA = x;
            lastAgree = x;
            if (bestA < 0 || (x - curA) > (bestB - bestA)) { bestA = curA; bestB = x; }
        }
        if (bestA < 0 || (bestB - bestA + 1) < minValid / 2) continue;
        LineCandidate lc;
        lc.y = y;
        lc.step = G[y];
        lc.consistency = Cn[y];
        lc.score = S[y];
        lc.x0 = bestA;
        lc.x1 = bestB;
        out.push_back(lc);
    }
    std::sort(out.begin(), out.end(), [](const LineCandidate& a, const LineCandidate& b) { return a.score > b.score; });
    if (static_cast<int>(out.size()) > p.maxLinesPerAxis) out.resize(static_cast<size_t>(p.maxLinesPerAxis));
    std::sort(out.begin(), out.end(), [](const LineCandidate& a, const LineCandidate& b) { return a.y < b.y; });
    return out;
}

/**
 * Cast-shadow band on the dark side of a line: number of rows (from the line) whose mean
 * luminance stays below the midpoint between the darkest rows and the lit wall further away.
 * Returns the width in pixels (fractional) or 0 when the band does not recover in range.
 */
inline double shadowBandWidth(const View& v, const LineCandidate& lc, bool darkAfter, int span, int maxBandPx, double minShadowContrast) {
    const int B = 2 * maxBandPx + span;
    auto rowMean = [&](int y) -> double {
        if (y < 0 || y >= v.H) return std::numeric_limits<double>::quiet_NaN();
        double s = 0;
        int n = 0, tot = 0;
        for (int x = lc.x0; x <= lc.x1; ++x) {
            ++tot;
            if (v.C(x, y)) { s += v.L(x, y); ++n; }
        }
        return (tot > 0 && n >= 0.8 * tot) ? s / n : std::numeric_limits<double>::quiet_NaN();
    };
    auto darkRow = [&](int k) { return darkAfter ? lc.y + k : lc.y - 1 - k; };
    auto brightRow = [&](int k) { return darkAfter ? lc.y - 1 - k : lc.y + k; };
    std::vector<double> dark(static_cast<size_t>(B), std::numeric_limits<double>::quiet_NaN());
    for (int k = 0; k < B; ++k) dark[static_cast<size_t>(k)] = rowMean(darkRow(k));
    double Lb = 0;
    int nb = 0;
    for (int k = 0; k < span; ++k) {
        double r = rowMean(brightRow(k));
        if (!std::isnan(r)) { Lb += r; ++nb; }
    }
    if (nb == 0) return 0;
    Lb /= nb;
    double Ld0 = std::numeric_limits<double>::infinity();
    for (int k = 0; k <= span && k < B; ++k) if (!std::isnan(dark[static_cast<size_t>(k)])) Ld0 = std::min(Ld0, dark[static_cast<size_t>(k)]);
    if (!std::isfinite(Ld0)) return 0;
    std::vector<double> far;
    for (int k = 0; k < B; ++k) if (!std::isnan(dark[static_cast<size_t>(k)])) far.push_back(dark[static_cast<size_t>(k)]);
    if (far.size() < 4) return 0;
    std::sort(far.begin(), far.end());
    double Lfar = far[static_cast<size_t>(0.75 * (far.size() - 1))];
    if (Lfar - Ld0 < minShadowContrast * std::max(Lfar, 0.05)) return 0;
    double thr = 0.5 * (Ld0 + Lfar);
    if (Lb < thr) return 0;
    int k = 0;
    while (k < B && !std::isnan(dark[static_cast<size_t>(k)]) && dark[static_cast<size_t>(k)] < thr) ++k;
    if (k == 0 || k >= maxBandPx || k >= B || std::isnan(dark[static_cast<size_t>(k)])) return 0;
    double a = dark[static_cast<size_t>(k - 1)], b = dark[static_cast<size_t>(k)];
    return (k - 0.5) + (thr - a) / std::max(1e-9, b - a);
}

} // namespace detail

// ============================================================================================
// Orthophoto analysis (pure image -> relief features; exposed for reuse and tests)
// ============================================================================================

inline FacadeAnalysis analyzeOrthophoto(const Orthophoto& o, double texel, const ReliefParams& p, unsigned threads = 1) {
    FacadeAnalysis fa;
    const int W = o.width, H = o.height;
    const double px = o.pixel;
    if (W < 8 || H < 8) return fa;
    const size_t N = static_cast<size_t>(W) * H;
    double lsum = 0;
    size_t lcount = 0;
    for (size_t i = 0; i < N; ++i) if (o.cov[i]) { lsum += o.lum[i]; ++lcount; }
    if (lcount < 64) return fa;
    fa.meanLuminance = lsum / lcount;

    // 1. Detrended luminance (removes slow lighting / chart gradients) for the folded unit cell
    const double detrend = p.detrendRadius > 0 ? p.detrendRadius : std::max(p.maxPitch, 2.0);
    const int rad = std::max(1, static_cast<int>(std::lround(detrend / px)));
    std::vector<float> mean = detail::boxMean(o.lum, o.cov, W, H, rad);
    std::vector<float> hp(N, 0.0f);
    for (size_t i = 0; i < N; ++i) {
        if (o.cov[i]) hp[i] = o.lum[i] - mean[i];
    }

    // 2. Periods along s (columns) and t (rows), each on the luminance detrended along its own axis. The second axis is
    //    measured only inside the first axis' dark bands (the rows of windows live in the window columns; piers carry no
    //    floor rhythm and would only dilute it), so both axes of a lattice are found even when one dominates the photo.
    auto darkLines = [&](bool sAxis, double pitch) {
        // the dark bands of the axis' folded luminance profile, as a mask over its pixel columns (s) or rows (t)
        const int n = sAxis ? W : H;
        const int nb = std::max(4, static_cast<int>(std::lround(pitch / px)));
        std::vector<double> sum(static_cast<size_t>(nb), 0.0), cnt(static_cast<size_t>(nb), 0.0);
        std::vector<int> binOf(static_cast<size_t>(n));
        for (int k = 0; k < n; ++k) {
            const double q = sAxis ? o.sAt(k) : o.tAt(k);
            binOf[static_cast<size_t>(k)] = std::min(nb - 1, static_cast<int>((q / pitch - std::floor(q / pitch)) * nb));
        }
        for (int r = 0; r < H; ++r)
            for (int c = 0; c < W; ++c) {
                const size_t i = static_cast<size_t>(r) * W + c;
                if (!o.cov[i]) continue;
                const int b = binOf[static_cast<size_t>(sAxis ? c : r)];
                sum[static_cast<size_t>(b)] += hp[i];
                cnt[static_cast<size_t>(b)] += 1;
            }
        for (int b = 0; b < nb; ++b) sum[static_cast<size_t>(b)] = cnt[static_cast<size_t>(b)] > 0 ? sum[static_cast<size_t>(b)] / cnt[static_cast<size_t>(b)] : 0.0;
        const detail::DarkProfile dp = detail::darkRuns(sum, 1.5, p.darkRunMinDepth, p.darkRunSplit);
        std::vector<uint8_t> m;
        if (!dp.ok || dp.contrast < p.minTemplateContrast) return m;
        m.assign(static_cast<size_t>(n), 0);
        for (int k = 0; k < n; ++k)
            for (const auto& r : dp.runs) {
                double rel = (binOf[static_cast<size_t>(k)] + 0.5) - r.lo;
                rel -= std::floor(rel / nb) * nb;
                if (rel <= r.width) m[static_cast<size_t>(k)] = 1;
            }
        return m;
    };
    fa.periodS = detail::detectPeriod(o.lum, o.cov, W, H, px, true, nullptr, p, threads);
    if (fa.periodS.found) {
        const std::vector<uint8_t> cols = darkLines(true, fa.periodS.pitch);
        if (!cols.empty()) fa.periodT = detail::detectPeriod(o.lum, o.cov, W, H, px, false, &cols, p, threads);
        if (!fa.periodT.found) fa.periodT = detail::detectPeriod(o.lum, o.cov, W, H, px, false, nullptr, p, threads);
    } else {
        fa.periodT = detail::detectPeriod(o.lum, o.cov, W, H, px, false, nullptr, p, threads);
        if (fa.periodT.found) {
            const std::vector<uint8_t> rows = darkLines(false, fa.periodT.pitch);
            if (!rows.empty()) fa.periodS = detail::detectPeriod(o.lum, o.cov, W, H, px, true, &rows, p, threads);
        }
    }

    // 3. Folded unit cell (template) and its dark bands
    const double Ps = fa.periodS.pitch, Pt = fa.periodT.pitch;
    const int nbS = fa.periodS.found ? std::max(4, static_cast<int>(std::lround(Ps / px))) : 1;
    const int nbT = fa.periodT.found ? std::max(4, static_cast<int>(std::lround(Pt / px))) : 1;
    std::vector<double> tsum(static_cast<size_t>(nbS) * nbT, 0.0), tcnt(tsum.size(), 0.0);
    if (fa.periodS.found || fa.periodT.found) {
        for (int r = 0; r < H; ++r) {
            double t = o.tAt(r);
            int b = 0;
            if (fa.periodT.found) {
                double f = t / Pt - std::floor(t / Pt);
                b = std::min(nbT - 1, static_cast<int>(f * nbT));
            }
            for (int c = 0; c < W; ++c) {
                size_t i = static_cast<size_t>(r) * W + c;
                if (!o.cov[i]) continue;
                int a = 0;
                if (fa.periodS.found) {
                    double s = o.sAt(c);
                    double f = s / Ps - std::floor(s / Ps);
                    a = std::min(nbS - 1, static_cast<int>(f * nbS));
                }
                tsum[static_cast<size_t>(b) * nbS + a] += hp[i];
                tcnt[static_cast<size_t>(b) * nbS + a] += 1;
            }
        }
    }
    auto colProfile = [&](const std::vector<uint8_t>& rowsOn) {
        std::vector<double> prof(static_cast<size_t>(nbS), 0.0);
        for (int a = 0; a < nbS; ++a) {
            double s = 0, c = 0;
            for (int b = 0; b < nbT; ++b) {
                if (!rowsOn[static_cast<size_t>(b)]) continue;
                s += tsum[static_cast<size_t>(b) * nbS + a];
                c += tcnt[static_cast<size_t>(b) * nbS + a];
            }
            prof[static_cast<size_t>(a)] = c > 0 ? s / c : 0.0;
        }
        return prof;
    };
    auto rowProfile = [&](const std::vector<uint8_t>& colsOn) {
        std::vector<double> prof(static_cast<size_t>(nbT), 0.0);
        for (int b = 0; b < nbT; ++b) {
            double s = 0, c = 0;
            for (int a = 0; a < nbS; ++a) {
                if (!colsOn[static_cast<size_t>(a)]) continue;
                s += tsum[static_cast<size_t>(b) * nbS + a];
                c += tcnt[static_cast<size_t>(b) * nbS + a];
            }
            prof[static_cast<size_t>(b)] = c > 0 ? s / c : 0.0;
        }
        return prof;
    };
    auto runsMask = [](const detail::DarkProfile& dp, int n) {
        std::vector<uint8_t> m(static_cast<size_t>(n), 0);
        for (int i = 0; i < n; ++i) {
            for (const auto& r : dp.runs) {
                double rel = (i + 0.5) - r.lo;
                rel -= std::floor(rel / n) * n;
                if (rel <= r.width) m[static_cast<size_t>(i)] = 1;
            }
        }
        return m;
    };
    const double minBins = 1.5;
    std::vector<uint8_t> allS(static_cast<size_t>(nbS), 1), allT(static_cast<size_t>(nbT), 1);
    detail::DarkProfile profS, profT;
    if (fa.periodS.found) profS = detail::darkRuns(colProfile(allT), minBins, p.darkRunMinDepth, p.darkRunSplit);
    if (fa.periodT.found) profT = detail::darkRuns(rowProfile(allS), minBins, p.darkRunMinDepth, p.darkRunSplit);
    const bool hasS = fa.periodS.found && profS.ok && profS.contrast >= p.minTemplateContrast;
    const bool hasT = fa.periodT.found && profT.ok && profT.contrast >= p.minTemplateContrast;
    const double contrastS = profS.contrast, contrastT = profT.contrast;
    // both axes periodic: a lattice of cells (each cell then needs its own evidence), however unequal the two contrasts
    // are; one axis: continuous strips along the other
    // (the lattice needs only the t pitch: its rows are found along each column, so a t fold blurred by pitch drift does
    // not matter there)
    bool cells = false, stripsAlongT = false, stripsAlongS = false;
    if (hasS && (hasT || fa.periodT.found)) {
        cells = true;
    } else if (hasS) {
        stripsAlongT = true;
    } else if (hasT) {
        stripsAlongS = true;
    }
    if (cells) {
        // each axis' bands, measured inside the other axis' bands
        auto rs = detail::darkRuns(colProfile(runsMask(profT, nbT)), minBins, p.darkRunMinDepth, p.darkRunSplit);
        auto rt = detail::darkRuns(rowProfile(runsMask(profS, nbS)), minBins, p.darkRunMinDepth, p.darkRunSplit);
        if (rs.ok && rs.contrast >= p.minTemplateContrast) profS = rs;
        if (rt.ok && rt.contrast >= p.minTemplateContrast) profT = rt;
    }
    fa.pattern = cells ? "cells" : stripsAlongT ? "strips-along-t" : stripsAlongS ? "strips-along-s" : "none";
    if (hasS) {
        fa.cell.foundS = true;
        fa.cell.contrastS = contrastS;
        for (const auto& r : profS.runs) fa.cell.runsS.push_back({r.lo / nbS * Ps, r.width / nbS * Ps});
        fa.cell.s0 = fa.cell.runsS[0].first;
        fa.cell.widthS = fa.cell.runsS[0].second;
        fa.cell.phaseS = std::fmod(fa.cell.s0 + 0.5 * fa.cell.widthS, Ps);
    }
    if (hasT) {
        fa.cell.foundT = true;
        fa.cell.contrastT = contrastT;
        for (const auto& r : profT.runs) fa.cell.runsT.push_back({r.lo / nbT * Pt, r.width / nbT * Pt});
        fa.cell.t0 = fa.cell.runsT[0].first;
        fa.cell.heightT = fa.cell.runsT[0].second;
        fa.cell.phaseT = std::fmod(fa.cell.t0 + 0.5 * fa.cell.heightT, Pt);
    }
    // smallest bright gap between consecutive dark bands of an axis (circular)
    auto minGap = [](std::vector<std::pair<double, double>> runs, double pitch) {
        std::sort(runs.begin(), runs.end());
        double g = pitch;
        for (size_t i = 0; i < runs.size(); ++i) {
            double next = i + 1 < runs.size() ? runs[i + 1].first : runs[0].first + pitch;
            g = std::min(g, next - (runs[i].first + runs[i].second));
        }
        return std::max(g, 0.0);
    };

    const double sMaxImg = o.sMin + W * px, tMinImg = o.tMax - H * px;
    auto pixelRect = [&](double s0, double s1, double t0, double t1, int& c0, int& c1, int& r0, int& r1) {
        detail::View::range(s0, s1, o.sMin, px, W, c0, c1);
        detail::View::range(t0, t1, o.tMax, -px, H, r0, r1);
    };
    auto depthFor = [&](double contrast) {
        double strength = detail::smoothstep(p.contrastLo, p.contrastHi, contrast);
        return std::min(p.maxDepth, p.recessMin + (p.recessMax - p.recessMin) * strength);
    };

    // dark rectangle vs the frame around it (the rectangle grown by g): relative contrast of its core, or < 0 when the
    // photo does not cover it well enough to judge
    auto cellContrast = [&](double s0, double s1, double t0, double t1, double g) -> double {
        int c0, c1, r0, r1;
        pixelRect(s0 - g, s1 + g, t0 - g, t1 + g, c0, c1, r0, r1);
        if (c1 < c0 || r1 < r0) return -1.0;
        size_t tot = 0, covd = 0, coreN = 0, ringN = 0;
        double coreSum = 0, ringSum = 0;
        const double ws = s1 - s0, ht = t1 - t0;
        const double cs0 = s0 + 0.2 * ws, cs1 = s1 - 0.2 * ws, ct0 = t0 + 0.2 * ht, ct1 = t1 - 0.2 * ht;
        for (int r = r0; r <= r1; ++r) {
            const double t = o.tAt(r);
            for (int c = c0; c <= c1; ++c) {
                ++tot;
                const size_t idx = static_cast<size_t>(r) * W + c;
                if (!o.cov[idx]) continue;
                ++covd;
                const double s = o.sAt(c);
                const bool inRect = s >= s0 && s <= s1 && t >= t0 && t <= t1;
                const bool inCore = s >= cs0 && s <= cs1 && t >= ct0 && t <= ct1;
                if (inCore) { coreSum += o.lum[idx]; ++coreN; }
                else if (!inRect) { ringSum += o.lum[idx]; ++ringN; }
            }
        }
        if (tot == 0 || static_cast<double>(covd) / tot < p.minCellCoverage || coreN == 0 || ringN == 0) return -1.0;
        const double Lc = coreSum / coreN, Lr = ringSum / ringN;
        return (Lr - Lc) / std::max(Lr, 0.05);
    };

    // 4a. Two-axis lattice. Window columns are the dark bands of the s fold (piers are straight and regular over a whole
    //     facade). Along each column the window rows are found in the photo itself: minima of the column's luminance
    //     profile along t, at least cellRowSeparation pitches apart, each measured against the brightest rows within
    //     cellRowSpan pitches. Every cell takes the median window height and its own minimum's position, so cells sit on
    //     the photo's windows even where the floor pitch drifts over the height of a tall facade; a cell is kept only
    //     when its core is darker than the frame around it (contrastLo), so no cell is placed without photo evidence.
    if (cells) {
        const double gapS = minGap(fa.cell.runsS, Ps);
        const double gS = std::clamp(0.5 * gapS, px, 1.0);
        const int sep = std::max(1, static_cast<int>(std::lround(p.cellRowSeparation * Pt / px)));
        const int span = std::max(sep, static_cast<int>(std::lround(p.cellRowSpan * Pt / px)));
        const int rad = std::max(1, static_cast<int>(std::lround(0.5 * Pt / px)));
        struct RowMin { double q0, q1, y, ext, rel; };
        std::vector<RowMin> mins;
        std::vector<double> prof(static_cast<size_t>(H)), dpf(static_cast<size_t>(H)), cps(static_cast<size_t>(H) + 1), cpc(static_cast<size_t>(H) + 1);
        std::vector<uint8_t> ok(static_cast<size_t>(H));
        for (const auto& rS : fa.cell.runsS) {
            const double ws = rS.second;
            const int i0 = static_cast<int>(std::floor((o.sMin - rS.first) / Ps)) - 1;
            const int i1 = static_cast<int>(std::ceil((sMaxImg - rS.first) / Ps)) + 1;
            for (int i = i0; i <= i1; ++i) {
                const double q0 = rS.first + i * Ps, q1 = q0 + ws;
                if (q0 - gS < o.sMin || q1 + gS > sMaxImg) continue;
                int x0, x1, cx0, cx1;
                detail::View::range(q0 - gS, q1 + gS, o.sMin, px, W, x0, x1);
                detail::View::range(q0 + 0.2 * ws, q1 - 0.2 * ws, o.sMin, px, W, cx0, cx1);
                if (x1 < x0 || cx1 < cx0) continue;
                for (int y = 0; y < H; ++y) {
                    bool full = true;
                    for (int x = x0; x <= x1 && full; ++x) full = o.cov[static_cast<size_t>(y) * W + x] != 0;
                    double s = 0;
                    if (full) for (int x = cx0; x <= cx1; ++x) s += o.lum[static_cast<size_t>(y) * W + x];
                    ok[static_cast<size_t>(y)] = full ? 1 : 0;
                    prof[static_cast<size_t>(y)] = full ? s / (cx1 - cx0 + 1) : 0.0;
                    cps[static_cast<size_t>(y) + 1] = cps[static_cast<size_t>(y)] + prof[static_cast<size_t>(y)];
                    cpc[static_cast<size_t>(y) + 1] = cpc[static_cast<size_t>(y)] + (full ? 1.0 : 0.0);
                }
                for (int y = 0; y < H; ++y) {
                    if (!ok[static_cast<size_t>(y)]) continue;
                    const size_t a = static_cast<size_t>(std::max(0, y - rad)), b = static_cast<size_t>(std::min(H, y + rad + 1));
                    dpf[static_cast<size_t>(y)] = prof[static_cast<size_t>(y)] - (cps[b] - cps[a]) / (cpc[b] - cpc[a]);
                }
                for (int y = span; y + span < H; ++y) {
                    if (cpc[static_cast<size_t>(y + span + 1)] - cpc[static_cast<size_t>(y - span)] < 2 * span + 1) continue;  // gap in the column
                    const double v = dpf[static_cast<size_t>(y)];
                    bool isMin = true;
                    for (int k = y - sep; k <= y + sep && isMin; ++k)
                        if (k != y && (dpf[static_cast<size_t>(k)] < v || (dpf[static_cast<size_t>(k)] == v && k < y))) isMin = false;
                    if (!isMin) continue;
                    double lm = v, rm = v;
                    for (int k = y - span; k < y; ++k) lm = std::max(lm, dpf[static_cast<size_t>(k)]);
                    for (int k = y + 1; k <= y + span; ++k) rm = std::max(rm, dpf[static_cast<size_t>(k)]);
                    const double depth = std::min(lm, rm) - v;
                    const double level = (cps[static_cast<size_t>(y + span + 1)] - cps[static_cast<size_t>(y - span)]) / (2 * span + 1);
                    const double rel = depth / std::max(level, 0.05);
                    if (rel < p.cellMinRowContrast) continue;
                    // half-depth crossings on both sides (pixel-centre units; the bright side of each lies inside the span)
                    const double lvl = v + 0.5 * depth;
                    int k = y;
                    while (k > y - span && dpf[static_cast<size_t>(k - 1)] < lvl) --k;
                    const double top = k > y - span ? k - (lvl - dpf[static_cast<size_t>(k)]) / std::max(1e-12, dpf[static_cast<size_t>(k - 1)] - dpf[static_cast<size_t>(k)]) : k - 0.5;
                    k = y;
                    while (k < y + span && dpf[static_cast<size_t>(k + 1)] < lvl) ++k;
                    const double bot = k < y + span ? k + (lvl - dpf[static_cast<size_t>(k)]) / std::max(1e-12, dpf[static_cast<size_t>(k + 1)] - dpf[static_cast<size_t>(k)]) : k + 0.5;
                    mins.push_back({q0, q1, 0.5 * (top + bot), bot - top, rel});
                }
            }
        }
        if (!mins.empty()) {
            std::vector<double> ext;
            ext.reserve(mins.size());
            for (const auto& m : mins) ext.push_back(m.ext);
            std::nth_element(ext.begin(), ext.begin() + static_cast<std::ptrdiff_t>(ext.size() / 2), ext.end());
            const double hT = std::clamp(ext[ext.size() / 2] * px, 2.0 * px, std::max(2.0 * px, Pt - 2.0 * px));
            const double g = std::clamp(0.5 * std::min(gapS, Pt - hT), px, 1.0);
            fa.cell.heightT = hT;
            std::sort(mins.begin(), mins.end(), [](const RowMin& a, const RowMin& b) { return a.q0 != b.q0 ? a.q0 < b.q0 : a.y < b.y; });
            size_t colStart = fa.features.size();
            double colQ0 = std::numeric_limits<double>::quiet_NaN();
            for (const auto& m : mins) {
                const double tc = o.tMax - (m.y + 0.5) * px;
                const double t0 = tc - 0.5 * hT, t1 = tc + 0.5 * hT;
                if (t0 - g < tMinImg || t1 + g > o.tMax) continue;
                ++fa.cellsTested;
                const double contrast = cellContrast(m.q0, m.q1, t0, t1, g);
                if (contrast < p.contrastLo) continue;
                if (!(m.q0 == colQ0)) { colQ0 = m.q0; colStart = fa.features.size(); }
                // one column, in t order: a cell overlapping its predecessor (with the frame between) keeps the darker one
                if (fa.features.size() > colStart) {
                    ReliefFeature& prev = fa.features.back();
                    if (t1 + g > prev.t0 && t0 - g < prev.t1) {
                        if (contrast > prev.evidence) prev = detail::makeFeature("dark-cell", m.q0, m.q1, t0, t1, -depthFor(contrast), contrast, p.jambWidth);
                        continue;
                    }
                }
                fa.features.push_back(detail::makeFeature("dark-cell", m.q0, m.q1, t0, t1, -depthFor(contrast), contrast, p.jambWidth));
            }
            fa.cellsAccepted = static_cast<int>(fa.features.size());
        }
    }

    // 4b. Continuous dark strips (one axis periodic, the other axis continuous)
    auto runStrips = [&](const detail::View& v, double start, double width, double pitch, double gap) {
        const double g = std::clamp(0.5 * gap, px, 1.0);
        const double acrossMin = std::min(v.across(0), v.across(v.W)), acrossMax = std::max(v.across(0), v.across(v.W));
        int i0 = static_cast<int>(std::floor((acrossMin - start) / pitch)) - 1;
        int i1 = static_cast<int>(std::ceil((acrossMax - start) / pitch)) + 1;
        const int smoothRows = std::max(1, static_cast<int>(std::lround(p.stripSmoothing / px)));
        const double keepLevel = p.stripHysteresis * p.contrastLo;
        const int minRunRows = std::max(2, static_cast<int>(std::ceil(p.minStripLength / px)));
        for (int i = i0; i <= i1; ++i) {
            double q0 = start + i * pitch, q1 = q0 + width;
            if (q0 - g < acrossMin || q1 + g > acrossMax) continue;
            int x0, x1, cx0, cx1;
            v.acrossRange(q0 - g, q1 + g, x0, x1);
            v.acrossRange(q0 + 0.2 * width, q1 - 0.2 * width, cx0, cx1);
            int ix0, ix1;
            v.acrossRange(q0, q1, ix0, ix1);
            if (x1 < x0 || cx1 < cx0) continue;
            ++fa.stripsTested;
            std::vector<double> con(static_cast<size_t>(v.H), 0.0);
            std::vector<uint8_t> valid(static_cast<size_t>(v.H), 0);
            for (int y = 0; y < v.H; ++y) {
                bool full = true;
                double cS = 0, fS = 0;
                int cN = 0, fN = 0;
                for (int x = x0; x <= x1 && full; ++x) {
                    if (!v.C(x, y)) { full = false; break; }
                    if (x >= cx0 && x <= cx1) { cS += v.L(x, y); ++cN; }
                    else if (x < ix0 || x > ix1) { fS += v.L(x, y); ++fN; }
                }
                if (!full || cN == 0 || fN == 0) continue;
                double Lf = fS / fN;
                con[static_cast<size_t>(y)] = (Lf - cS / cN) / std::max(Lf, 0.05);
                valid[static_cast<size_t>(y)] = 1;
            }
            std::vector<double> sm(static_cast<size_t>(v.H), 0.0);
            for (int y = 0; y < v.H; ++y) {
                if (!valid[static_cast<size_t>(y)]) continue;
                double s = 0;
                int n = 0;
                for (int k = std::max(0, y - smoothRows); k <= std::min(v.H - 1, y + smoothRows); ++k) {
                    if (valid[static_cast<size_t>(k)]) { s += con[static_cast<size_t>(k)]; ++n; }
                }
                sm[static_cast<size_t>(y)] = s / n;
            }
            int y = 0;
            while (y < v.H) {
                if (!(valid[static_cast<size_t>(y)] && sm[static_cast<size_t>(y)] >= p.contrastLo)) { ++y; continue; }
                int ys = y;
                double csum = 0;
                // hysteresis: a run starts on strong evidence and continues while it stays reasonable
                while (y < v.H && valid[static_cast<size_t>(y)] && sm[static_cast<size_t>(y)] >= keepLevel) { csum += con[static_cast<size_t>(y)]; ++y; }
                int ye = y - 1;
                double contrast = csum / (ye - ys + 1);
                // keep one pixel of photo between the run ends and whatever stopped it
                if (ys > 0) ++ys;
                if (ye < v.H - 1) --ye;
                if (ye - ys + 1 < minRunRows || contrast < p.contrastLo) continue;
                double s0, s1, t0, t1;
                detail::viewRectToPlane(v, q0, q1, v.along(ys), v.along(ye + 1), s0, s1, t0, t1);
                ++fa.stripRuns;
                fa.features.push_back(detail::makeFeature("dark-strip", s0, s1, t0, t1, -depthFor(contrast), contrast, p.jambWidth));
            }
        }
    };
    detail::View viewT = detail::makeView(o, false);  // rows = constant t
    detail::View viewS;                               // rows = constant s (built lazily)
    bool viewSBuilt = false;
    auto getViewS = [&]() -> const detail::View& {
        if (!viewSBuilt) { viewS = detail::makeView(o, true); viewSBuilt = true; }
        return viewS;
    };
    if (stripsAlongT) {
        double gap = minGap(fa.cell.runsS, Ps);
        for (const auto& r : fa.cell.runsS) runStrips(viewT, r.first, r.second, Ps, gap);
    }
    if (stripsAlongS) {
        double gap = minGap(fa.cell.runsT, Pt);
        for (const auto& r : fa.cell.runsT) runStrips(getViewS(), r.first, r.second, Pt, gap);
    }

    // 5. Structural lines and shadowed proud bands
    const int span = std::max(1, static_cast<int>(std::lround(texel / px)));
    const int maxBandPx = std::max(2, static_cast<int>(std::lround(p.maxBandHeight / px)));
    const double exclTol = std::max(1.5 * px, 2.0 * p.jambWidth);
    auto nearGrid = [&](double coord, const std::vector<std::pair<double, double>>& runs, double pitch) {
        auto md = [&](double d) { d -= std::floor(d / pitch) * pitch; return std::min(d, pitch - d); };
        for (const auto& r : runs) {
            if (std::min(md(coord - r.first), md(coord - (r.first + r.second))) <= exclTol) return true;
        }
        return false;
    };
    const size_t recessCount = fa.features.size();
    auto nearCellEdge = [&](double t) {
        for (size_t k = 0; k < recessCount; ++k) {
            if (std::abs(t - fa.features[k].t0) <= exclTol || std::abs(t - fa.features[k].t1) <= exclTol) return true;
        }
        return false;
    };
    auto overlapsRecess = [&](double s0, double s1, double t0, double t1) {
        for (size_t k = 0; k < recessCount; ++k) {
            const auto& f = fa.features[k];
            if (s0 < f.s1 + p.jambWidth && s1 > f.s0 - p.jambWidth && t0 < f.t1 + p.jambWidth && t1 > f.t0 - p.jambWidth) return true;
        }
        return false;
    };
    std::vector<std::array<double, 4>> proudRects;
    for (int axisPass = 0; axisPass < 2; ++axisPass) {
        const detail::View& v = axisPass == 0 ? viewT : getViewS();
        const char axis = axisPass == 0 ? 't' : 's';
        auto cands = detail::detectLineCandidates(v, span, px, p);
        for (size_t ci = 0; ci < cands.size(); ++ci) {
            const auto& lc = cands[ci];
            StructuralLine L;
            L.axis = axis;
            L.coord = v.along(lc.y);
            L.step = lc.step;
            L.consistency = lc.consistency;
            L.from = std::min(v.across(lc.x0), v.across(lc.x1 + 1));
            L.to = std::max(v.across(lc.x0), v.across(lc.x1 + 1));
            if (axis == 't' && cells) L.explainedByGrid = nearCellEdge(L.coord);  // window rows follow the photo, not one phase
            if (axis == 't' && stripsAlongS && fa.cell.foundT) L.explainedByGrid = nearGrid(L.coord, fa.cell.runsT, Pt);
            if (axis == 's' && (cells || stripsAlongT) && fa.cell.foundS) L.explainedByGrid = nearGrid(L.coord, fa.cell.runsS, Ps);
            if (L.explainedByGrid) { fa.lines.push_back(L); continue; }
            // Shadow on the dark side. Horizontal lines only cast downwards (light comes from above).
            const bool darkAfter = lc.step < 0;
            const bool admissible = axis == 's' || darkAfter;  // after = downwards for 't' lines
            double wpx = admissible ? detail::shadowBandWidth(v, lc, darkAfter, span, maxBandPx, p.minShadowContrast) : 0.0;
            if (wpx > 0) {
                L.shadowWidth = wpx * px;
                L.proudDepth = std::min(p.maxDepth, L.shadowWidth * p.shadowSlope);
                // proud element on the bright side, up to the neighbouring line or a band height
                double bandPx = std::clamp(std::max(wpx, 2.0), 2.0, static_cast<double>(maxBandPx));
                const int dirBright = darkAfter ? -1 : +1;
                for (size_t cj = 0; cj < cands.size(); ++cj) {
                    if (cj == ci) continue;
                    int dy = (cands[cj].y - lc.y) * dirBright;
                    if (dy >= 2 && dy <= maxBandPx) bandPx = std::min(bandPx, static_cast<double>(dy));
                }
                double al0 = v.along(lc.y), al1 = v.along(lc.y + dirBright * bandPx);
                double s0, s1, t0, t1;
                detail::viewRectToPlane(v, L.from + px, L.to - px, al0, al1, s0, s1, t0, t1);
                bool clash = overlapsRecess(s0, s1, t0, t1);
                for (const auto& r : proudRects) {
                    if (s0 < r[1] && s1 > r[0] && t0 < r[3] && t1 > r[2]) clash = true;
                }
                if (!clash && L.proudDepth >= p.minProudDepth) {
                    L.relief = true;
                    proudRects.push_back({s0, s1, t0, t1});
                    fa.features.push_back(detail::makeFeature("shadowed-band", s0, s1, t0, t1, L.proudDepth, L.shadowWidth, p.jambWidth));
                }
            }
            fa.lines.push_back(L);
        }
    }
    return fa;
}

// ============================================================================================
// Mesh pipeline
// ============================================================================================

class PhotometricRelief {
public:
    using Clock = std::chrono::steady_clock;

    /**
     * Runs the full pipeline on a flattened glTF scene. `debugDir` (optional) receives annotated
     * orthophotos of the largest `debugMax` analysed regions.
     */
    static ReliefResult run(const gltf::GltfScene& scene, const ReliefParams& params, const std::string& debugDir = "", int debugMax = 0) {
        PhotometricRelief engine(scene, params);
        engine.debugDir_ = debugDir;
        engine.debugMax_ = debugMax;
        engine.execute();
        return std::move(engine.result_);
    }

    /** Studio-clay / textured GLB writers (plain glTF 2.0: POSITION, NORMAL, TEXCOORD_0, uint32 indices). */
    static std::vector<uint8_t> writeTexturedGlb(const gltf::GltfScene& scene, const ReliefMesh& mesh, double creaseAngleDeg);
    static std::vector<uint8_t> writeClayGlb(const ReliefMesh& mesh, double creaseAngleDeg, const std::string& name = "PhotometricRelief_StudioGreyClay");
    static std::string statsJson(const ReliefResult& r, const ReliefParams& p);

private:
    struct VKey {
        uint32_t kind{0}, a{0}, b{0}, c{0};
        uint64_t x{0}, y{0};
        bool operator==(const VKey& o) const { return kind == o.kind && a == o.a && b == o.b && c == o.c && x == o.x && y == o.y; }
    };
    struct VKeyHash {
        size_t operator()(const VKey& k) const {
            uint64_t h = detail::mix64(k.kind * 0x9E37ull + k.a);
            h = detail::mix64(h ^ (static_cast<uint64_t>(k.b) << 32 | k.c));
            h = detail::mix64(h ^ k.x);
            h = detail::mix64(h ^ k.y);
            return static_cast<size_t>(h);
        }
    };
    struct PV {
        double s{0}, t{0}, u{0}, v{0};
        uint32_t id{0};
        uint32_t orig{UINT32_MAX};
        uint64_t edge{0};
        double lambda{0};
    };
    struct Poly {
        std::vector<PV> v;
        std::vector<uint64_t> e;  // tag of edge i -> i+1: original welded edge key, 0 for a line
        uint32_t tri{0};
        int32_t region{-1};
    };
    struct Region {
        int id{0};
        std::vector<uint32_t> tris;
        double area{0};
        P3 n, c, u, v, centroid;
        double sMin{0}, sMax{0}, tMin{0}, tMax{0};
        std::vector<ReliefFeature> features;
        // feature buckets
        double bs0{0}, bt0{0}, cell{2.0};
        int bw{0}, bh{0};
        std::vector<std::vector<uint32_t>> buckets;
        double project(const P3& p, double& s, double& t) const {
            P3 d = p - c;
            s = d.dot(u);
            t = d.dot(v);
            return d.dot(n);
        }
    };

    PhotometricRelief(const gltf::GltfScene& scene, const ReliefParams& p) : scene_(scene), p_(p) {}

    const gltf::GltfScene& scene_;
    ReliefParams p_;
    std::string debugDir_;
    int debugMax_{0};
    ReliefResult result_;
    unsigned threads_{1};

    std::vector<P3> wpos_;
    std::vector<std::array<uint32_t, 3>> wtri_;
    std::vector<P3> fnorm_;
    std::vector<double> farea_;
    std::unordered_map<uint64_t, std::vector<uint32_t>> edgeTris_;
    std::vector<uint32_t> vtOffset_, vtList_;  // vertex -> triangles (CSR)
    std::vector<int32_t> regionOf_;
    std::vector<int32_t> patchOf_;
    std::unordered_map<uint64_t, uint8_t> internalSeam_;
    std::vector<Region> regions_;

    std::unordered_map<VKey, uint32_t, VKeyHash> keys_;
    std::unordered_map<uint64_t, std::vector<std::pair<double, uint32_t>>> edgeInserts_;
    std::vector<uint8_t> boundaryVertex_;  // per welded vertex, for the region being tessellated
    std::vector<Poly> deferred_;

    Clock::time_point mark_;
    void lap(const std::string& name) {
        auto now = Clock::now();
        result_.timingsMs.push_back({name, std::chrono::duration<double, std::milli>(now - mark_).count()});
        mark_ = now;
    }

    // ----------------------------------------------------------------------------------------
    void execute() {
        mark_ = Clock::now();
        threads_ = detail::resolveThreads(p_.threads);
        const auto& mesh = scene_.mesh;
        const size_t T = mesh.indices.size() / 3;
        result_.inputTriangles = T;
        result_.inputVertices = mesh.vertices.size();
        if (T == 0) { result_.error = "scene has no triangles"; return; }
        weld();
        lap("weld");
        buildTopology();
        lap("topology");
        growRegions();
        lap("regions");
        analyseRegions();
        lap("analysis");
        tessellate();
        lap("tessellation");
        summarize();
        result_.ok = true;
    }

    void weld() {
        const auto& verts = scene_.mesh.vertices;
        const double eps = std::max(1e-9, p_.weldEpsilon);
        std::unordered_map<uint64_t, std::vector<uint32_t>> grid;
        grid.reserve(verts.size());
        std::vector<uint32_t> map(verts.size());
        auto cellKey = [](int64_t i, int64_t j, int64_t k) {
            return detail::mix64(static_cast<uint64_t>(i) * 0x100000001B3ull ^ detail::mix64(static_cast<uint64_t>(j) ^ detail::mix64(static_cast<uint64_t>(k))));
        };
        for (size_t i = 0; i < verts.size(); ++i) {
            P3 p(verts[i].position.x, verts[i].position.y, verts[i].position.z);
            int64_t ci = static_cast<int64_t>(std::floor(p.x / eps)), cj = static_cast<int64_t>(std::floor(p.y / eps)), ck = static_cast<int64_t>(std::floor(p.z / eps));
            uint32_t found = UINT32_MAX;
            for (int dz = -1; dz <= 1 && found == UINT32_MAX; ++dz) {
                for (int dy = -1; dy <= 1 && found == UINT32_MAX; ++dy) {
                    for (int dx = -1; dx <= 1 && found == UINT32_MAX; ++dx) {
                        auto it = grid.find(cellKey(ci + dx, cj + dy, ck + dz));
                        if (it == grid.end()) continue;
                        for (uint32_t r : it->second) {
                            if ((wpos_[r] - p).length() <= eps) { found = r; break; }
                        }
                    }
                }
            }
            if (found == UINT32_MAX) {
                found = static_cast<uint32_t>(wpos_.size());
                wpos_.push_back(p);
                grid[cellKey(ci, cj, ck)].push_back(found);
            }
            map[i] = found;
        }
        const auto& idx = scene_.mesh.indices;
        wtri_.resize(idx.size() / 3);
        for (size_t t = 0; t < wtri_.size(); ++t) {
            wtri_[t] = {map[idx[3 * t]], map[idx[3 * t + 1]], map[idx[3 * t + 2]]};
        }
        result_.weldedVertices = wpos_.size();
    }

    void buildTopology() {
        const size_t T = wtri_.size(), V = wpos_.size();
        fnorm_.resize(T);
        farea_.resize(T);
        edgeTris_.reserve(T * 2);
        std::vector<uint32_t> deg(V + 1, 0);
        for (size_t t = 0; t < T; ++t) {
            const auto& w = wtri_[t];
            P3 cr = (wpos_[w[1]] - wpos_[w[0]]).cross(wpos_[w[2]] - wpos_[w[0]]);
            double l = cr.length();
            farea_[t] = 0.5 * l;
            fnorm_[t] = l > 0 ? cr * (1.0 / l) : P3();
            if (w[0] == w[1] || w[1] == w[2] || w[0] == w[2]) continue;
            for (int k = 0; k < 3; ++k) {
                edgeTris_[detail::edgeKey(w[k], w[(k + 1) % 3])].push_back(static_cast<uint32_t>(t));
                deg[w[k]]++;
            }
        }
        vtOffset_.assign(V + 1, 0);
        for (size_t v = 0; v < V; ++v) vtOffset_[v + 1] = vtOffset_[v] + deg[v];
        vtList_.assign(vtOffset_[V], 0);
        std::vector<uint32_t> fill(vtOffset_.begin(), vtOffset_.end() - 1);
        for (size_t t = 0; t < T; ++t) {
            const auto& w = wtri_[t];
            if (w[0] == w[1] || w[1] == w[2] || w[0] == w[2]) continue;
            for (int k = 0; k < 3; ++k) vtList_[fill[w[k]]++] = static_cast<uint32_t>(t);
        }
    }

    static P3 closestOnTriangle(const P3& p, const P3& a, const P3& b, const P3& c) {
        P3 ab = b - a, ac = c - a, ap = p - a;
        double d1 = ab.dot(ap), d2 = ac.dot(ap);
        if (d1 <= 0 && d2 <= 0) return a;
        P3 bp = p - b;
        double d3 = ab.dot(bp), d4 = ac.dot(bp);
        if (d3 >= 0 && d4 <= d3) return b;
        double vc = d1 * d4 - d3 * d2;
        if (vc <= 0 && d1 >= 0 && d3 <= 0) return a + ab * (d1 / (d1 - d3));
        P3 cp = p - c;
        double d5 = ab.dot(cp), d6 = ac.dot(cp);
        if (d6 >= 0 && d5 <= d6) return c;
        double vb = d5 * d2 - d1 * d6;
        if (vb <= 0 && d2 >= 0 && d6 <= 0) return a + ac * (d2 / (d2 - d6));
        double va = d3 * d6 - d5 * d4;
        if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) return b + (c - b) * ((d4 - d3) / ((d4 - d3) + (d5 - d6)));
        double den = 1.0 / (va + vb + vc);
        return a + ab * (vb * den) + ac * (vc * den);
    }

    double distToTriangle(const P3& p, uint32_t t) const {
        const auto& w = wtri_[t];
        return (closestOnTriangle(p, wpos_[w[0]], wpos_[w[1]], wpos_[w[2]]) - p).length();
    }

    struct UnionFind {
        std::vector<int> parent;
        explicit UnionFind(size_t n) : parent(n) { std::iota(parent.begin(), parent.end(), 0); }
        int find(int x) {
            while (parent[static_cast<size_t>(x)] != x) {
                parent[static_cast<size_t>(x)] = parent[static_cast<size_t>(parent[static_cast<size_t>(x)])];
                x = parent[static_cast<size_t>(x)];
            }
            return x;
        }
        void unite(int a, int b) {
            a = find(a); b = find(b);
            if (a != b) parent[static_cast<size_t>(std::max(a, b))] = std::min(a, b);
        }
    };

    /**
     * Facade regions. Patches are grown over welded edges (coplanar with their seed); patches on
     * the same plane that touch across unwelded tile-chunk seams (gaps or T-junctions within the
     * seam tolerance) are merged, and those seams are remembered as interior to the region.
     */
    void growRegions() {
        const size_t T = wtri_.size();
        regionOf_.assign(T, -1);
        patchOf_.assign(T, -1);
        std::vector<uint32_t> cand;
        for (size_t t = 0; t < T; ++t) {
            const auto& w = wtri_[t];
            if (farea_[t] <= 1e-10 || w[0] == w[1] || w[1] == w[2] || w[0] == w[2]) continue;
            if (std::abs(fnorm_[t].y) > p_.wallMaxAbsNy) continue;
            if (p_.roiEnabled) {
                const P3 c = (wpos_[w[0]] + wpos_[w[1]] + wpos_[w[2]]) * (1.0 / 3.0);
                if (c.x < p_.roiMinX || c.x > p_.roiMaxX || c.z < p_.roiMinZ || c.z > p_.roiMaxZ) continue;
            }
            cand.push_back(static_cast<uint32_t>(t));
        }
        result_.candidateTriangles = cand.size();
        std::vector<uint8_t> isCand(T, 0);
        for (uint32_t t : cand) isCand[t] = 1;
        std::vector<uint32_t> bySize = cand;
        std::stable_sort(bySize.begin(), bySize.end(), [&](uint32_t a, uint32_t b) { return farea_[a] > farea_[b]; });
        const double cosTol = std::cos(p_.planeAngleDeg * 3.14159265358979323846 / 180.0);

        // 1. patches
        struct Patch { P3 n; double d{0}; double area{0}; };
        std::vector<Patch> patches;
        std::vector<uint32_t> queue;
        for (uint32_t seed : bySize) {
            if (patchOf_[seed] != -1) continue;
            const int pid = static_cast<int>(patches.size());
            const P3 ns = fnorm_[seed];
            const double ds = ns.dot(wpos_[wtri_[seed][0]]);
            queue.clear();
            queue.push_back(seed);
            patchOf_[seed] = pid;
            P3 nsum, csum;
            double area = 0;
            for (size_t qi = 0; qi < queue.size(); ++qi) {
                uint32_t t = queue[qi];
                const auto& w = wtri_[t];
                area += farea_[t];
                nsum = nsum + fnorm_[t] * farea_[t];
                csum = csum + (wpos_[w[0]] + wpos_[w[1]] + wpos_[w[2]]) * (farea_[t] / 3.0);
                for (int k = 0; k < 3; ++k) {
                    auto it = edgeTris_.find(detail::edgeKey(w[k], w[(k + 1) % 3]));
                    if (it == edgeTris_.end()) continue;
                    for (uint32_t u : it->second) {
                        if (u == t || patchOf_[u] != -1 || !isCand[u]) continue;
                        if (fnorm_[u].dot(ns) < cosTol) continue;
                        bool near = true;
                        for (int m = 0; m < 3 && near; ++m) near = std::abs(ns.dot(wpos_[wtri_[u][m]]) - ds) <= p_.planeOffset;
                        if (!near) continue;
                        patchOf_[u] = pid;
                        queue.push_back(u);
                    }
                }
            }
            Patch P;
            P.area = area;
            P.n = nsum.normalized();
            P.d = P.n.dot(csum * (1.0 / area));
            patches.push_back(P);
        }
        result_.regionsFound = patches.size();

        // 2. merge coplanar patches across unwelded seams
        const double tol = std::max(0.0, p_.seamTolerance);
        const double cell = std::max(p_.seamGridCell, 4.0 * tol);
        auto cellKey = [](int64_t i, int64_t j, int64_t k) {
            return detail::mix64(static_cast<uint64_t>(i) * 0x100000001B3ull ^ detail::mix64(static_cast<uint64_t>(j) ^ detail::mix64(static_cast<uint64_t>(k))));
        };
        auto cellOf = [&](double x) { return static_cast<int64_t>(std::floor(x / cell)); };
        std::unordered_map<uint64_t, std::vector<uint32_t>> grid;
        for (uint32_t t : cand) {
            const auto& w = wtri_[t];
            P3 lo(1e300, 1e300, 1e300), hi(-1e300, -1e300, -1e300);
            for (int k = 0; k < 3; ++k) {
                const P3& q = wpos_[w[k]];
                lo = P3(std::min(lo.x, q.x), std::min(lo.y, q.y), std::min(lo.z, q.z));
                hi = P3(std::max(hi.x, q.x), std::max(hi.y, q.y), std::max(hi.z, q.z));
            }
            for (int64_t i = cellOf(lo.x - tol); i <= cellOf(hi.x + tol); ++i)
                for (int64_t j = cellOf(lo.y - tol); j <= cellOf(hi.y + tol); ++j)
                    for (int64_t k = cellOf(lo.z - tol); k <= cellOf(hi.z + tol); ++k) grid[cellKey(i, j, k)].push_back(t);
        }
        auto nearby = [&](const P3& q) -> const std::vector<uint32_t>* {
            auto it = grid.find(cellKey(cellOf(q.x), cellOf(q.y), cellOf(q.z)));
            return it == grid.end() ? nullptr : &it->second;
        };
        UnionFind uf(patches.size());
        std::unordered_map<uint64_t, uint8_t> visited;
        size_t merges = 0;
        if (tol > 0) {
            for (uint32_t t : cand) {
                const int pt = patchOf_[t];
                for (int k = 0; k < 3; ++k) {
                    uint32_t v = wtri_[t][k];
                    uint64_t key = (static_cast<uint64_t>(v) << 32) | static_cast<uint32_t>(pt);
                    if (!visited.emplace(key, 1).second) continue;
                    const P3& q = wpos_[v];
                    const auto* list = nearby(q);
                    if (!list) continue;
                    for (uint32_t u : *list) {
                        const int pu = patchOf_[u];
                        if (pu == pt || uf.find(pu) == uf.find(pt)) continue;
                        const Patch& A = patches[static_cast<size_t>(pt)];
                        const Patch& B = patches[static_cast<size_t>(pu)];
                        if (A.n.dot(B.n) < cosTol) continue;
                        if (std::abs(B.n.dot(q) - B.d) > p_.planeOffset) continue;
                        if (distToTriangle(q, u) > tol) continue;
                        uf.unite(pt, pu);
                        ++merges;
                    }
                }
            }
        }
        result_.patchesMerged = merges;

        // 3. regions: merged components with enough area
        std::vector<double> compArea(patches.size(), 0.0);
        for (size_t i = 0; i < patches.size(); ++i) compArea[static_cast<size_t>(uf.find(static_cast<int>(i)))] += patches[i].area;
        std::vector<int> regionOfComp(patches.size(), -1);
        for (uint32_t t : bySize) {
            int comp = uf.find(patchOf_[t]);
            if (compArea[static_cast<size_t>(comp)] < p_.minRegionArea) continue;
            if (regionOfComp[static_cast<size_t>(comp)] < 0) {
                regionOfComp[static_cast<size_t>(comp)] = static_cast<int>(regions_.size());
                Region R;
                R.id = static_cast<int>(regions_.size());
                regions_.push_back(std::move(R));
            }
            int rid = regionOfComp[static_cast<size_t>(comp)];
            regionOf_[t] = rid;
            regions_[static_cast<size_t>(rid)].tris.push_back(t);
        }
        for (auto& R : regions_) {
            double area = 0;
            P3 nsum, csum;
            for (uint32_t t : R.tris) {
                area += farea_[t];
                nsum = nsum + fnorm_[t] * farea_[t];
                const auto& w = wtri_[t];
                csum = csum + (wpos_[w[0]] + wpos_[w[1]] + wpos_[w[2]]) * (farea_[t] / 3.0);
            }
            R.area = area;
            R.n = nsum.normalized();
            R.c = csum * (1.0 / area);
            R.centroid = R.c;
            P3 up(0, 1, 0);
            R.u = up.cross(R.n);
            if (R.u.length() < 1e-6) R.u = P3(1, 0, 0);
            R.u = R.u.normalized();
            R.v = R.n.cross(R.u).normalized();
            R.sMin = R.tMin = std::numeric_limits<double>::infinity();
            R.sMax = R.tMax = -std::numeric_limits<double>::infinity();
            for (uint32_t t : R.tris) {
                for (int k = 0; k < 3; ++k) {
                    double s, tt;
                    R.project(wpos_[wtri_[t][k]], s, tt);
                    R.sMin = std::min(R.sMin, s); R.sMax = std::max(R.sMax, s);
                    R.tMin = std::min(R.tMin, tt); R.tMax = std::max(R.tMax, tt);
                }
            }
        }

        // 4. open edges that lie on another patch of the same region are interior seams
        if (tol > 0) {
            for (const auto& R : regions_) {
                for (uint32_t t : R.tris) {
                    const auto& w = wtri_[t];
                    for (int k = 0; k < 3; ++k) {
                        uint64_t ek = detail::edgeKey(w[k], w[(k + 1) % 3]);
                        auto it = edgeTris_.find(ek);
                        if (it == edgeTris_.end() || it->second.size() != 1) continue;
                        const P3& a = wpos_[w[k]];
                        const P3& b = wpos_[w[(k + 1) % 3]];
                        bool interior = true;
                        for (double f : {0.0, 0.5, 1.0}) {
                            P3 q = a + (b - a) * f;
                            bool hit = false;
                            if (const auto* list = nearby(q)) {
                                for (uint32_t u : *list) {
                                    if (regionOf_[u] != R.id || patchOf_[u] == patchOf_[t]) continue;
                                    if (distToTriangle(q, u) <= tol) { hit = true; break; }
                                }
                            }
                            if (!hit) { interior = false; break; }
                        }
                        if (interior) internalSeam_.emplace(ek, 1);
                    }
                }
            }
        }
        result_.internalSeamEdges = internalSeam_.size();
    }

    // ----------------------------------------------------------------------------------------
    double regionTexel(const Region& R) const {
        std::vector<std::pair<double, double>> samples;  // (m^2 per texel, weight)
        const auto& verts = scene_.mesh.vertices;
        const auto& idx = scene_.mesh.indices;
        for (uint32_t t : R.tris) {
            uint32_t mat = scene_.triangleMaterial[t];
            int img = mat < scene_.materials.size() ? scene_.materials[mat].baseColorImage : -1;
            if (img < 0 || img >= static_cast<int>(scene_.images.size()) || !scene_.images[static_cast<size_t>(img)].decoded) continue;
            const auto& im = scene_.images[static_cast<size_t>(img)].pixels;
            const auto& a = verts[idx[3 * t]].uv;
            const auto& b = verts[idx[3 * t + 1]].uv;
            const auto& c = verts[idx[3 * t + 2]].uv;
            double uvArea = 0.5 * std::abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) * im.width * im.height;
            if (uvArea <= 1e-9) continue;
            samples.push_back({farea_[t] / uvArea, farea_[t]});
        }
        if (samples.empty()) return 0;
        std::sort(samples.begin(), samples.end());
        double total = 0;
        for (auto& s : samples) total += s.second;
        double acc = 0;
        for (auto& s : samples) {
            acc += s.second;
            if (acc >= 0.5 * total) return std::sqrt(s.first);
        }
        return std::sqrt(samples.back().first);
    }

    Orthophoto rasterize(const Region& R, double px) const {
        Orthophoto o;
        o.pixel = px;
        o.sMin = R.sMin;
        o.tMax = R.tMax;
        o.width = std::max(1, static_cast<int>(std::ceil((R.sMax - R.sMin) / px)));
        o.height = std::max(1, static_cast<int>(std::ceil((R.tMax - R.tMin) / px)));
        const size_t N = static_cast<size_t>(o.width) * o.height;
        o.lum.assign(N, 0.0f);
        o.rgb.assign(N * 3, 0);
        o.cov.assign(N, 0);
        const auto& verts = scene_.mesh.vertices;
        const auto& idx = scene_.mesh.indices;
        for (uint32_t t : R.tris) {
            double xs[3], ys[3], us[3], vs[3];
            for (int k = 0; k < 3; ++k) {
                double s, tt;
                R.project(wpos_[wtri_[t][k]], s, tt);
                xs[k] = (s - o.sMin) / px;
                ys[k] = (o.tMax - tt) / px;
                us[k] = verts[idx[3 * t + k]].uv.x;
                vs[k] = verts[idx[3 * t + k]].uv.y;
            }
            double area = (xs[1] - xs[0]) * (ys[2] - ys[0]) - (xs[2] - xs[0]) * (ys[1] - ys[0]);
            if (std::abs(area) < 1e-12) continue;
            uint32_t mat = scene_.triangleMaterial[t];
            const gltf::SceneMaterial* sm = mat < scene_.materials.size() ? &scene_.materials[mat] : nullptr;
            const texture::ImageBuffer* img = nullptr;
            if (sm && sm->baseColorImage >= 0 && sm->baseColorImage < static_cast<int>(scene_.images.size()) &&
                scene_.images[static_cast<size_t>(sm->baseColorImage)].decoded) {
                img = &scene_.images[static_cast<size_t>(sm->baseColorImage)].pixels;
            }
            int x0 = std::max(0, static_cast<int>(std::floor(std::min({xs[0], xs[1], xs[2]}))));
            int x1 = std::min(o.width - 1, static_cast<int>(std::ceil(std::max({xs[0], xs[1], xs[2]}))));
            int y0 = std::max(0, static_cast<int>(std::floor(std::min({ys[0], ys[1], ys[2]}))));
            int y1 = std::min(o.height - 1, static_cast<int>(std::ceil(std::max({ys[0], ys[1], ys[2]}))));
            const double tol = -1e-7 * std::abs(area);
            for (int y = y0; y <= y1; ++y) {
                double py = y + 0.5;
                for (int x = x0; x <= x1; ++x) {
                    double pxc = x + 0.5;
                    double w0 = (xs[1] - pxc) * (ys[2] - py) - (xs[2] - pxc) * (ys[1] - py);
                    double w1 = (xs[2] - pxc) * (ys[0] - py) - (xs[0] - pxc) * (ys[2] - py);
                    double w2 = (xs[0] - pxc) * (ys[1] - py) - (xs[1] - pxc) * (ys[0] - py);
                    if (area < 0) { w0 = -w0; w1 = -w1; w2 = -w2; }
                    if (w0 < tol || w1 < tol || w2 < tol) continue;
                    double sum = w0 + w1 + w2;
                    w0 /= sum; w1 /= sum; w2 /= sum;
                    double rgb[3];
                    if (img) {
                        detail::sampleBilinear(*img, w0 * us[0] + w1 * us[1] + w2 * us[2], w0 * vs[0] + w1 * vs[1] + w2 * vs[2], sm->wrapS, sm->wrapT, rgb);
                    } else {
                        rgb[0] = sm ? sm->baseColorFactor.x : 1.0;
                        rgb[1] = sm ? sm->baseColorFactor.y : 1.0;
                        rgb[2] = sm ? sm->baseColorFactor.z : 1.0;
                    }
                    size_t i = static_cast<size_t>(y) * o.width + x;
                    o.lum[i] = static_cast<float>(0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]);
                    for (int c = 0; c < 3; ++c) o.rgb[i * 3 + c] = static_cast<uint8_t>(std::clamp(rgb[c] * 255.0 + 0.5, 0.0, 255.0));
                    o.cov[i] = 1;
                }
            }
        }
        closeSeamGaps(o, p_.orthoGapClosePx);
        return o;
    }

    /**
     * Unwelded tile-chunk seams leave sub-pixel geometric gaps that rasterize as thin uncovered
     * lines across the facade. Close them (morphological closing of the coverage mask) and fill
     * the closed pixels from their covered neighbours, so the analysis sees one continuous photo.
     */
    static void closeSeamGaps(Orthophoto& o, int radius) {
        if (radius <= 0) return;
        const int W = o.width, H = o.height;
        std::vector<uint8_t> m = o.cov, tmp(m.size());
        auto morph = [&](bool dilate) {
            for (int y = 0; y < H; ++y) {
                for (int x = 0; x < W; ++x) {
                    uint8_t v = dilate ? 0 : 1;
                    for (int dy = -1; dy <= 1; ++dy) {
                        for (int dx = -1; dx <= 1; ++dx) {
                            int xx = x + dx, yy = y + dy;
                            uint8_t q = (xx < 0 || yy < 0 || xx >= W || yy >= H) ? 0 : m[static_cast<size_t>(yy) * W + xx];
                            v = dilate ? std::max(v, q) : std::min(v, q);
                        }
                    }
                    tmp[static_cast<size_t>(y) * W + x] = v;
                }
            }
            m.swap(tmp);
        };
        for (int i = 0; i < radius; ++i) morph(true);
        for (int i = 0; i < radius; ++i) morph(false);
        std::vector<size_t> todo;
        for (size_t i = 0; i < m.size(); ++i) if (m[i] && !o.cov[i]) todo.push_back(i);
        for (int pass = 0; pass < 2 * radius + 2 && !todo.empty(); ++pass) {
            std::vector<size_t> next;
            std::vector<std::pair<size_t, std::array<double, 4>>> fills;
            for (size_t i : todo) {
                int x = static_cast<int>(i % W), y = static_cast<int>(i / W);
                double acc[4] = {0, 0, 0, 0};
                int n = 0;
                for (int dy = -1; dy <= 1; ++dy) {
                    for (int dx = -1; dx <= 1; ++dx) {
                        int xx = x + dx, yy = y + dy;
                        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
                        size_t j = static_cast<size_t>(yy) * W + xx;
                        if (!o.cov[j]) continue;
                        acc[0] += o.lum[j];
                        for (int c = 0; c < 3; ++c) acc[1 + c] += o.rgb[j * 3 + c];
                        ++n;
                    }
                }
                if (n == 0) { next.push_back(i); continue; }
                fills.push_back({i, {acc[0] / n, acc[1] / n, acc[2] / n, acc[3] / n}});
            }
            for (const auto& f : fills) {
                o.lum[f.first] = static_cast<float>(f.second[0]);
                for (int c = 0; c < 3; ++c) o.rgb[f.first * 3 + c] = static_cast<uint8_t>(std::lround(f.second[1 + c]));
                o.cov[f.first] = 1;
            }
            if (fills.empty()) break;
            todo.swap(next);
        }
    }

    void writeDebug(const FacadeReport& rep, const Orthophoto& o) const {
        texture::ImageBuffer img(o.width, o.height, 3, 0);
        for (size_t i = 0; i < o.cov.size(); ++i) {
            for (int c = 0; c < 3; ++c) img.data[i * 3 + c] = o.cov[i] ? o.rgb[i * 3 + c] : static_cast<uint8_t>(c == 2 ? 60 : 30);
        }
        {
            // the plain orthophoto too (no annotations), with its metric frame in the name
            auto raw = png::encode(img, 6);
            std::ostringstream name;
            name << debugDir_ << "/region_" << rep.id << "_raw_px" << o.pixel << "_s" << o.sMin << "_t" << o.tMax << ".png";
            std::ofstream rf(name.str(), std::ios::binary);
            rf.write(reinterpret_cast<const char*>(raw.data()), static_cast<std::streamsize>(raw.size()));
        }
        auto put = [&](int x, int y, uint8_t r, uint8_t g, uint8_t b) {
            if (x < 0 || y < 0 || x >= o.width || y >= o.height) return;
            size_t i = (static_cast<size_t>(y) * o.width + x) * 3;
            img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b;
        };
        auto toX = [&](double s) { return static_cast<int>(std::floor((s - o.sMin) / o.pixel)); };
        auto toY = [&](double t) { return static_cast<int>(std::floor((o.tMax - t) / o.pixel)); };
        for (const auto& L : rep.analysis.lines) {
            uint8_t r = L.relief ? 255 : (L.explainedByGrid ? 120 : 255), g = L.relief ? 160 : (L.explainedByGrid ? 120 : 40), b = L.explainedByGrid ? 120 : 40;
            if (L.axis == 't') { int y = toY(L.coord); for (int x = toX(L.from); x <= toX(L.to); ++x) put(x, y, r, g, b); }
            else { int x = toX(L.coord); for (int y = toY(L.to); y <= toY(L.from); ++y) put(x, y, r, g, b); }
        }
        for (const auto& f : rep.analysis.features) {
            uint8_t r = f.height < 0 ? 40 : 255, g = f.height < 0 ? 140 : 150, b = f.height < 0 ? 255 : 0;
            int xa = toX(f.s0), xb = toX(f.s1), ya = toY(f.t1), yb = toY(f.t0);
            for (int x = xa; x <= xb; ++x) { put(x, ya, r, g, b); put(x, yb, r, g, b); }
            for (int y = ya; y <= yb; ++y) { put(xa, y, r, g, b); put(xb, y, r, g, b); }
        }
        auto bytes = png::encode(img, 6);
        std::ofstream f(debugDir_ + "/region_" + std::to_string(rep.id) + "_ortho.png", std::ios::binary);
        f.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
    }

    void analyseRegions() {
        std::vector<size_t> order(regions_.size());
        std::iota(order.begin(), order.end(), 0);
        std::sort(order.begin(), order.end(), [&](size_t a, size_t b) { return regions_[a].area > regions_[b].area; });
        // every region is analysed on its own: workers take the largest remaining region first (dynamic scheduling, one
        // thread per region); reports are appended in area order afterwards, so the result does not depend on threads
        std::vector<FacadeReport> reps(order.size());
        std::vector<uint8_t> analysed(order.size(), 0);
        std::vector<Orthophoto> keep(debugDir_.empty() ? 0 : order.size());
        auto analyseOne = [&](size_t oi, unsigned innerThreads) {
            Region& R = regions_[order[oi]];
            FacadeReport& rep = reps[oi];
            rep.id = R.id;
            rep.inputTriangles = R.tris.size();
            rep.area = R.area;
            rep.centroid = R.centroid;
            rep.normal = R.n;
            rep.axisS = R.u;
            rep.axisT = R.v;
            rep.sMin = R.sMin; rep.sMax = R.sMax; rep.tMin = R.tMin; rep.tMax = R.tMax;
            rep.texel = regionTexel(R);
            if (rep.texel <= 0) {
                rep.skipReason = "no decoded photo texture";
                return;
            }
            double px = p_.pixel > 0 ? p_.pixel : std::clamp(rep.texel * p_.texelFraction, p_.minPixel, p_.maxPixel);
            double longest = std::max(R.sMax - R.sMin, R.tMax - R.tMin);
            if (longest / px > p_.maxOrthoDim) px = longest / p_.maxOrthoDim;
            rep.pixel = px;
            Orthophoto o = rasterize(R, px);
            rep.orthoWidth = o.width;
            rep.orthoHeight = o.height;
            size_t covered = 0;
            for (uint8_t c : o.cov) covered += c;
            rep.coverage = o.cov.empty() ? 0.0 : static_cast<double>(covered) / o.cov.size();
            rep.analysis = analyzeOrthophoto(o, rep.texel, p_, innerThreads);
            analysed[oi] = 1;
            R.features = rep.analysis.features;
            if (R.features.empty()) rep.skipReason = "no photometric relief evidence";
            if (!keep.empty() && static_cast<int>(oi) < debugMax_) keep[oi] = std::move(o);
        };
        if (threads_ <= 1 || order.size() < 2) {
            for (size_t oi = 0; oi < order.size(); ++oi) analyseOne(oi, threads_);
        } else {
            // the few largest regions first, each with every thread (their orthophotos dominate), then the rest in parallel
            size_t big = 0;
            while (big < order.size() && big < threads_ && regions_[order[big]].area >= 0.25 * regions_[order[0]].area) analyseOne(big++, threads_);
            std::atomic<size_t> next{big};
            std::vector<std::thread> pool;
            const unsigned nt = static_cast<unsigned>(std::min<size_t>(threads_, order.size()));
            for (unsigned t = 0; t < nt; ++t)
                pool.emplace_back([&]() { for (size_t oi; (oi = next.fetch_add(1)) < order.size();) analyseOne(oi, 1); });
            for (auto& th : pool) th.join();
        }
        int debugWritten = 0;
        for (size_t oi = 0; oi < order.size(); ++oi) {
            if (analysed[oi]) ++result_.regionsAnalysed;
            if (analysed[oi] && !debugDir_.empty() && debugWritten < debugMax_) {
                writeDebug(reps[oi], keep[oi]);
                ++debugWritten;
            }
            result_.facades.push_back(std::move(reps[oi]));
        }
    }

    // ----------------------------------------------------------------------------------------
    // Relief field
    void buildBuckets(Region& R) {
        R.bs0 = R.sMin; R.bt0 = R.tMin;
        R.cell = std::max(1.0, std::max(R.sMax - R.sMin, R.tMax - R.tMin) / 512.0);
        R.bw = std::max(1, static_cast<int>(std::ceil((R.sMax - R.sMin) / R.cell)) + 1);
        R.bh = std::max(1, static_cast<int>(std::ceil((R.tMax - R.tMin) / R.cell)) + 1);
        R.buckets.assign(static_cast<size_t>(R.bw) * R.bh, {});
        for (uint32_t k = 0; k < R.features.size(); ++k) {
            const auto& f = R.features[k];
            int i0 = std::clamp(static_cast<int>(std::floor((f.s0 - R.bs0) / R.cell)), 0, R.bw - 1);
            int i1 = std::clamp(static_cast<int>(std::floor((f.s1 - R.bs0) / R.cell)), 0, R.bw - 1);
            int j0 = std::clamp(static_cast<int>(std::floor((f.t0 - R.bt0) / R.cell)), 0, R.bh - 1);
            int j1 = std::clamp(static_cast<int>(std::floor((f.t1 - R.bt0) / R.cell)), 0, R.bh - 1);
            for (int j = j0; j <= j1; ++j)
                for (int i = i0; i <= i1; ++i) R.buckets[static_cast<size_t>(j) * R.bw + i].push_back(k);
        }
    }

    double heightAt(const Region& R, double s, double t) const {
        int i = std::clamp(static_cast<int>(std::floor((s - R.bs0) / R.cell)), 0, R.bw - 1);
        int j = std::clamp(static_cast<int>(std::floor((t - R.bt0) / R.cell)), 0, R.bh - 1);
        const double tol = 2e-6;  // cut lines are snapped to canonical values within 1e-6
        double recess = 0, proud = 0;
        for (uint32_t k : R.buckets[static_cast<size_t>(j) * R.bw + i]) {
            const auto& f = R.features[k];
            if (s < f.si0 - tol || s > f.si1 + tol || t < f.ti0 - tol || t > f.ti1 + tol) continue;
            if (f.height < 0) recess = std::min(recess, f.height);
            else proud = std::max(proud, f.height);
        }
        double h = recess < 0 ? recess : proud;
        return std::clamp(h, -p_.maxDepth, p_.maxDepth);
    }

    uint32_t newPosition(const P3& base, const Region* R, double h) {
        uint32_t id = static_cast<uint32_t>(result_.mesh.positions.size());
        result_.mesh.positions.push_back(R ? base + R->n * h : base);
        result_.mesh.heights.push_back(static_cast<float>(h));
        result_.mesh.positionRegion.push_back(R && h != 0 ? R->id : -1);
        return id;
    }

    uint32_t origVertex(uint32_t w, const Region* R) {
        VKey k;
        k.kind = 0;
        k.a = w;
        auto it = keys_.find(k);
        if (it != keys_.end()) return it->second;
        double h = 0;
        if (R && !boundaryVertex_[w]) {
            double s, t;
            R->project(wpos_[w], s, t);
            h = heightAt(*R, s, t);
        }
        uint32_t id = newPosition(wpos_[w], R, h);
        keys_.emplace(k, id);
        return id;
    }

    bool isBoundaryEdge(const Region& R, uint64_t ek) const {
        auto it = edgeTris_.find(ek);
        if (it == edgeTris_.end()) return true;
        const auto& v = it->second;
        if (v.size() == 1) return !(regionOf_[v[0]] == R.id && internalSeam_.count(ek) != 0);
        if (v.size() != 2) return true;
        return regionOf_[v[0]] != R.id || regionOf_[v[1]] != R.id;
    }

    uint32_t edgeVertex(const Region& R, uint32_t a, uint32_t b, int axis, double c, double lam, const P3& base, double s, double t) {
        VKey k;
        k.kind = 1;
        k.a = a; k.b = b;
        k.c = static_cast<uint32_t>(R.id);
        k.x = detail::bitsOf(c);
        k.y = static_cast<uint64_t>(axis);
        auto it = keys_.find(k);
        if (it != keys_.end()) return it->second;
        uint64_t ek = detail::edgeKey(a, b);
        double h = isBoundaryEdge(R, ek) ? 0.0 : heightAt(R, s, t);
        uint32_t id = newPosition(base, &R, h);
        keys_.emplace(k, id);
        edgeInserts_[ek].push_back({lam, id});
        return id;
    }

    uint32_t interiorVertex(const Region& R, uint32_t tri, double s, double t, const P3& base) {
        VKey k;
        k.kind = 2;
        k.a = tri;
        k.x = detail::bitsOf(s);
        k.y = detail::bitsOf(t);
        auto it = keys_.find(k);
        if (it != keys_.end()) return it->second;
        uint32_t id = newPosition(base, &R, heightAt(R, s, t));
        keys_.emplace(k, id);
        return id;
    }

    struct TriMap {
        double s[3], t[3], u[3], v[3];
        P3 p[3];
        void bary(double S, double Tt, double w[3]) const {
            double d = (t[1] - t[2]) * (s[0] - s[2]) + (s[2] - s[1]) * (t[0] - t[2]);
            if (std::abs(d) < 1e-300) { w[0] = 1; w[1] = w[2] = 0; return; }
            w[0] = ((t[1] - t[2]) * (S - s[2]) + (s[2] - s[1]) * (Tt - t[2])) / d;
            w[1] = ((t[2] - t[0]) * (S - s[2]) + (s[0] - s[2]) * (Tt - t[2])) / d;
            w[2] = 1 - w[0] - w[1];
        }
    };

    static double lambdaOn(const PV& q, uint32_t a, uint32_t b) {
        if (q.orig == a) return 0.0;
        if (q.orig == b) return 1.0;
        return q.lambda;
    }

    PV intersect(const Region& R, uint32_t tri, const TriMap& tm, const PV& A, const PV& B, uint64_t tag, int axis, double c) {
        PV x;
        if (tag != 0) {
            uint32_t a = static_cast<uint32_t>(tag >> 32), b = static_cast<uint32_t>(tag & 0xffffffffu);
            double sa, ta, sb, tb;
            R.project(wpos_[a], sa, ta);
            R.project(wpos_[b], sb, tb);
            double ca = axis == 0 ? sa : ta, cb = axis == 0 ? sb : tb;
            double lam = (c - ca) / (cb - ca);
            if (axis == 0) { x.s = c; x.t = ta + lam * (tb - ta); }
            else { x.t = c; x.s = sa + lam * (sb - sa); }
            double la = lambdaOn(A, a, b), lb = lambdaOn(B, a, b);
            double f = std::abs(lb - la) > 1e-300 ? (lam - la) / (lb - la) : 0.0;
            x.u = A.u + f * (B.u - A.u);
            x.v = A.v + f * (B.v - A.v);
            P3 base = wpos_[a] + (wpos_[b] - wpos_[a]) * lam;
            x.id = edgeVertex(R, a, b, axis, c, lam, base, x.s, x.t);
            x.edge = tag;
            x.lambda = lam;
        } else {
            if (axis == 0) { x.s = c; x.t = A.t; }
            else { x.t = c; x.s = A.s; }
            double w[3];
            tm.bary(x.s, x.t, w);
            P3 base = tm.p[0] * w[0] + tm.p[1] * w[1] + tm.p[2] * w[2];
            x.u = tm.u[0] * w[0] + tm.u[1] * w[1] + tm.u[2] * w[2];
            x.v = tm.v[0] * w[0] + tm.v[1] * w[1] + tm.v[2] * w[2];
            x.id = interiorVertex(R, tri, x.s, x.t, base);
        }
        return x;
    }

    void split(const Region& R, uint32_t tri, const TriMap& tm, const Poly& P, int axis, double c, Poly& lo, Poly& hi) {
        const size_t n = P.v.size();
        struct E { PV v; uint64_t tag; double d; };
        std::vector<E> S;
        S.reserve(n * 2);
        std::vector<double> d(n);
        for (size_t i = 0; i < n; ++i) {
            double coord = axis == 0 ? P.v[i].s : P.v[i].t;
            d[i] = coord - c;
            if (std::abs(d[i]) <= 1e-9) d[i] = 0;
        }
        for (size_t i = 0; i < n; ++i) {
            size_t j = (i + 1) % n;
            S.push_back({P.v[i], P.e[i], d[i]});
            if ((d[i] < 0 && d[j] > 0) || (d[i] > 0 && d[j] < 0)) {
                S.push_back({intersect(R, tri, tm, P.v[i], P.v[j], P.e[i], axis, c), P.e[i], 0.0});
            }
        }
        auto build = [&](bool loSide, Poly& out) {
            out.v.clear();
            out.e.clear();
            out.tri = P.tri;
            out.region = P.region;
            std::vector<size_t> idx;
            for (size_t k = 0; k < S.size(); ++k) {
                if (loSide ? S[k].d <= 0 : S[k].d >= 0) idx.push_back(k);
            }
            if (idx.size() < 3) return;
            for (size_t m = 0; m < idx.size(); ++m) {
                size_t k = idx[m], kn = idx[(m + 1) % idx.size()];
                out.v.push_back(S[k].v);
                out.e.push_back(kn == (k + 1) % S.size() ? S[k].tag : 0);
            }
        };
        build(true, lo);
        build(false, hi);
    }

    static double polyArea2(const std::vector<PV>& v) {
        double a = 0;
        for (size_t i = 0; i < v.size(); ++i) {
            const auto& p = v[i];
            const auto& q = v[(i + 1) % v.size()];
            a += p.s * q.t - q.s * p.t;
        }
        return a;
    }

    void emitPolygon(const std::vector<PV>& v, uint32_t tri, int32_t region) {
        const uint32_t material = scene_.triangleMaterial[tri];
        auto emit = [&](size_t i, size_t j, size_t k) {
            OutputTriangle o;
            const PV* c[3] = {&v[i], &v[j], &v[k]};
            for (int m = 0; m < 3; ++m) {
                o.p[m] = c[m]->id;
                o.uv[m][0] = static_cast<float>(c[m]->u);
                o.uv[m][1] = static_cast<float>(c[m]->v);
            }
            if (o.p[0] == o.p[1] || o.p[1] == o.p[2] || o.p[0] == o.p[2]) return;
            o.material = material;
            o.region = region;
            o.parent = tri;
            result_.mesh.triangles.push_back(o);
        };
        const size_t n = v.size();
        if (n < 3) return;
        if (n == 3) { emit(0, 1, 2); return; }
        std::vector<size_t> idx(n);
        std::iota(idx.begin(), idx.end(), 0);
        // local coordinates (the plane frames are world-anchored: absolute s, t of hundreds of metres would put the
        // cancellation error of the area tests above the tolerance)
        std::vector<std::array<double, 2>> L(n);
        double scale = 0;
        for (size_t i = 0; i < n; ++i) {
            L[i] = {v[i].s - v[0].s, v[i].t - v[0].t};
            scale = std::max({scale, std::abs(L[i][0]), std::abs(L[i][1])});
        }
        const double eps = 1e-12 * std::max(1e-6, scale * scale);
        auto cross = [&](size_t a, size_t b, size_t c) {
            return (L[b][0] - L[a][0]) * (L[c][1] - L[a][1]) - (L[c][0] - L[a][0]) * (L[b][1] - L[a][1]);
        };
        double remaining = 0;
        for (size_t i = 0; i < n; ++i) remaining += L[i][0] * L[(i + 1) % n][1] - L[(i + 1) % n][0] * L[i][1];
        // Convex polygons with collinear runs (inserted border vertices): an ear is valid only if it and the remaining
        // polygon both keep positive area and no other vertex lies inside it or on its closing diagonal, so no ear spans
        // a collinear run (that would leave the run's vertices on a T-junction).
        // When no ear passes the vertex test (inserted vertices lying a rounding error off a straight run), the ear test
        // falls back to the two area conditions alone for the rest of the polygon.
        bool strict = true;
        while (idx.size() > 3) {
            int best = -1;
            double bestQ = -1, bestArea = 0;
            const size_t m = idx.size();
            for (size_t k = 0; k < m; ++k) {
                const size_t ia = idx[(k + m - 1) % m], ib = idx[k], ic = idx[(k + 1) % m];
                const PV& a = v[ia];
                const PV& b = v[ib];
                const PV& c = v[ic];
                double area2 = cross(ia, ib, ic);
                if (area2 <= eps || remaining - area2 <= eps) continue;
                bool blocked = false;
                for (size_t j = 0; j < m && !blocked && strict; ++j) {
                    const size_t ip = idx[j];
                    if (ip == ia || ip == ib || ip == ic || v[ip].id == a.id || v[ip].id == b.id || v[ip].id == c.id) continue;
                    // inside or on the triangle, within a relative tolerance of its edges
                    const double tol = -1e-9 * std::max(1e-6, scale * scale);
                    blocked = cross(ia, ib, ip) >= tol && cross(ib, ic, ip) >= tol && cross(ic, ia, ip) >= tol;
                }
                if (blocked) continue;
                double l = (b.s - a.s) * (b.s - a.s) + (b.t - a.t) * (b.t - a.t) + (c.s - b.s) * (c.s - b.s) + (c.t - b.t) * (c.t - b.t) +
                           (a.s - c.s) * (a.s - c.s) + (a.t - c.t) * (a.t - c.t);
                double q = area2 / std::max(l, 1e-300);
                if (q > bestQ) { bestQ = q; best = static_cast<int>(k); bestArea = area2; }
            }
            if (best < 0 && strict) { strict = false; ++result_.earClipFallbacks; continue; }
            if (best < 0) { ++result_.earClipUnfilled; break; }
            emit(idx[(best + m - 1) % m], idx[best], idx[(best + 1) % m]);
            idx.erase(idx.begin() + best);
            remaining -= bestArea;
        }
        if (idx.size() == 3) emit(idx[0], idx[1], idx[2]);
    }

    void finishPiece(Poly&& P) {
        // drop consecutive duplicates
        std::vector<PV> v;
        std::vector<uint64_t> e;
        for (size_t i = 0; i < P.v.size(); ++i) {
            if (!v.empty() && v.back().id == P.v[i].id) { e.back() = P.e[i]; continue; }
            v.push_back(P.v[i]);
            e.push_back(P.e[i]);
        }
        while (v.size() > 1 && v.front().id == v.back().id) { v.pop_back(); e.pop_back(); }
        if (v.size() < 3) return;
        bool tagged = false;
        for (uint64_t t : e) tagged = tagged || t != 0;
        if (!tagged) {
            if (polyArea2(v) > 0) emitPolygon(v, P.tri, P.region);
            return;
        }
        P.v = std::move(v);
        P.e = std::move(e);
        deferred_.push_back(std::move(P));
    }

    struct LineSeg {
        double c, a, b;  // cut line at coordinate c, needed over the perpendicular range [a, b]
    };

    /** Snaps line coordinates closer than 1e-6 m onto one canonical value; returns the count. */
    static size_t canonicalize(std::vector<LineSeg>& segs) {
        std::sort(segs.begin(), segs.end(), [](const LineSeg& x, const LineSeg& y) { return x.c < y.c; });
        double anchor = 0;
        size_t unique = 0;
        for (auto& s : segs) {
            if (unique == 0 || s.c - anchor > 1e-6) { anchor = s.c; ++unique; }
            s.c = anchor;
        }
        return unique;
    }

    /**
     * Lines strictly inside (cmin, cmax) whose extent overlaps (pmin, pmax) with positive length: the cuts a polygon needs.
     * A line that only touches the polygon's range ends on its border (a window's edge on the pier beside it); the
     * vertices it leaves there are inserted into the neighbour by closeStripSeams, so no cut is needed for them.
     */
    static void activeLines(const std::vector<LineSeg>& segs, double cmin, double cmax, double pmin, double pmax, std::vector<double>& out) {
        out.clear();
        auto it = std::upper_bound(segs.begin(), segs.end(), cmin, [](double v, const LineSeg& s) { return v < s.c; });
        for (; it != segs.end() && it->c < cmax; ++it) {
            if (it->a >= pmax - 1e-9 || it->b <= pmin + 1e-9) continue;
            if (out.empty() || out.back() != it->c) out.push_back(it->c);
        }
    }

    size_t estimatePieces(const Region& R, const std::vector<LineSeg>& sSegs, const std::vector<LineSeg>& tSegs) const {
        size_t est = 0;
        std::vector<double> tmp;
        for (uint32_t t : R.tris) {
            double s0 = 1e300, s1 = -1e300, t0 = 1e300, t1 = -1e300;
            for (int k = 0; k < 3; ++k) {
                double s, tt;
                R.project(wpos_[wtri_[t][k]], s, tt);
                s0 = std::min(s0, s); s1 = std::max(s1, s); t0 = std::min(t0, tt); t1 = std::max(t1, tt);
            }
            activeLines(sSegs, s0, s1, t0, t1, tmp);
            size_t ns = tmp.size();
            activeLines(tSegs, t0, t1, s0, s1, tmp);
            est += (ns + 1) * (tmp.size() + 1);
        }
        return est;
    }

    /**
     * Strips of one parent triangle take different t-cuts, so a cut edge s = c shared by two strips
     * can carry vertices on one side only. Insert them into the other side (same ids), so every
     * strip seam is closed (no T-junctions inside the facade).
     */
    void closeStripSeams(const TriMap& tm, const std::vector<double>& sCuts, std::vector<Poly>& pieces) const {
        if (sCuts.empty() || pieces.size() < 2) return;
        std::unordered_map<uint64_t, std::vector<std::pair<double, const PV*>>> onLine;
        for (const auto& P : pieces) {
            for (const auto& q : P.v) {
                auto it = std::lower_bound(sCuts.begin(), sCuts.end(), q.s - 1e-9);
                if (it != sCuts.end() && std::abs(*it - q.s) <= 1e-9) onLine[detail::bitsOf(*it)].push_back({q.t, &q});
            }
        }
        std::vector<std::vector<PV>> patched(pieces.size());
        std::vector<std::vector<uint64_t>> patchedTags(pieces.size());
        std::vector<uint8_t> changed(pieces.size(), 0);
        for (size_t pi = 0; pi < pieces.size(); ++pi) {
            const Poly& P = pieces[pi];
            const size_t n = P.v.size();
            auto& out = patched[pi];
            auto& tags = patchedTags[pi];
            for (size_t i = 0; i < n; ++i) {
                const PV& A = P.v[i];
                const PV& B = P.v[(i + 1) % n];
                out.push_back(A);
                tags.push_back(P.e[i]);
                if (P.e[i] != 0 || std::abs(A.s - B.s) > 1e-9) continue;
                auto it = std::lower_bound(sCuts.begin(), sCuts.end(), A.s - 1e-9);
                if (it == sCuts.end() || std::abs(*it - A.s) > 1e-9) continue;
                auto lt = onLine.find(detail::bitsOf(*it));
                if (lt == onLine.end()) continue;
                const double lo = std::min(A.t, B.t), hi = std::max(A.t, B.t);
                std::vector<std::pair<double, const PV*>> ins;
                for (const auto& q : lt->second) {
                    if (q.first > lo + 1e-9 && q.first < hi - 1e-9 && q.second->id != A.id && q.second->id != B.id) ins.push_back(q);
                }
                if (ins.empty()) continue;
                std::sort(ins.begin(), ins.end(), [](const auto& x, const auto& y) { return x.first < y.first; });
                if (A.t > B.t) std::reverse(ins.begin(), ins.end());
                uint32_t last = A.id;
                for (const auto& q : ins) {
                    if (q.second->id == last) continue;
                    PV x = *q.second;
                    double w[3];
                    tm.bary(x.s, x.t, w);
                    x.u = tm.u[0] * w[0] + tm.u[1] * w[1] + tm.u[2] * w[2];
                    x.v = tm.v[0] * w[0] + tm.v[1] * w[1] + tm.v[2] * w[2];
                    out.push_back(x);
                    tags.push_back(0);
                    last = x.id;
                    changed[pi] = 1;
                }
            }
        }
        for (size_t pi = 0; pi < pieces.size(); ++pi) {
            if (!changed[pi]) continue;
            pieces[pi].v = std::move(patched[pi]);
            pieces[pi].e = std::move(patchedTags[pi]);
        }
    }

    void tessellateRegion(Region& R, FacadeReport& rep) {
        buildBuckets(R);
        std::vector<LineSeg> sSegs, tSegs;
        for (const auto& f : R.features) {
            for (double x : {f.s0, f.si0, f.si1, f.s1}) sSegs.push_back({x, f.t0, f.t1});
            for (double x : {f.t0, f.ti0, f.ti1, f.t1}) tSegs.push_back({x, f.s0, f.s1});
        }
        std::vector<LineSeg> sFeat = sSegs, tFeat = tSegs;
        for (const auto& L : rep.analysis.lines) {
            if (!L.explainedByGrid) (L.axis == 's' ? sSegs : tSegs).push_back({L.coord, L.from, L.to});
        }
        size_t ns = canonicalize(sSegs), nt = canonicalize(tSegs);
        if (estimatePieces(R, sSegs, tSegs) > p_.maxRegionPieces) {
            sSegs = sFeat;
            tSegs = tFeat;
            ns = canonicalize(sSegs);
            nt = canonicalize(tSegs);
            if (estimatePieces(R, sSegs, tSegs) > p_.maxRegionPieces) {
                rep.treated = false;
                rep.skipReason = "tessellation budget exceeded";
                R.features.clear();
                buildBuckets(R);
                return;
            }
        }
        rep.sLines = ns;
        rep.tLines = nt;
        // boundary vertices: touched by a triangle outside the region or by an open / foreign edge
        std::vector<uint32_t> touched;
        for (uint32_t t : R.tris) {
            for (int k = 0; k < 3; ++k) {
                uint32_t w = wtri_[t][k];
                if (boundaryVertex_[w] == 2) continue;
                boundaryVertex_[w] = 2;  // visited marker
                touched.push_back(w);
            }
        }
        for (uint32_t w : touched) {
            bool boundary = false;
            for (uint32_t k = vtOffset_[w]; k < vtOffset_[w + 1] && !boundary; ++k) {
                uint32_t t = vtList_[k];
                if (regionOf_[t] != R.id) { boundary = true; break; }
                for (int m = 0; m < 3; ++m) {
                    uint32_t a = wtri_[t][m], b = wtri_[t][(m + 1) % 3];
                    if ((a == w || b == w) && isBoundaryEdge(R, detail::edgeKey(a, b))) { boundary = true; break; }
                }
            }
            boundaryVertex_[w] = boundary ? 1 : 0;
        }
        const size_t before = result_.mesh.triangles.size();
        const size_t deferredBefore = deferred_.size();
        const auto& verts = scene_.mesh.vertices;
        const auto& idx = scene_.mesh.indices;
        std::vector<double> sel, selT;
        std::vector<Poly> pieces;
        for (uint32_t tri : R.tris) {
            const auto& w = wtri_[tri];
            TriMap tm;
            Poly P;
            P.tri = tri;
            P.region = R.id;
            for (int k = 0; k < 3; ++k) {
                PV q;
                R.project(wpos_[w[k]], q.s, q.t);
                q.u = verts[idx[3 * tri + k]].uv.x;
                q.v = verts[idx[3 * tri + k]].uv.y;
                q.id = origVertex(w[k], &R);
                q.orig = w[k];
                tm.s[k] = q.s; tm.t[k] = q.t; tm.u[k] = q.u; tm.v[k] = q.v; tm.p[k] = wpos_[w[k]];
                P.v.push_back(q);
            }
            for (int k = 0; k < 3; ++k) P.e.push_back(detail::edgeKey(w[k], w[(k + 1) % 3]));
            double smin = std::min({tm.s[0], tm.s[1], tm.s[2]}), smax = std::max({tm.s[0], tm.s[1], tm.s[2]});
            double tmin3 = std::min({tm.t[0], tm.t[1], tm.t[2]}), tmax3 = std::max({tm.t[0], tm.t[1], tm.t[2]});
            activeLines(sSegs, smin, smax, tmin3, tmax3, sel);
            std::vector<Poly> strips;
            Poly rest = P;
            for (double c : sel) {
                Poly lo, hi;
                split(R, tri, tm, rest, 0, c, lo, hi);
                if (lo.v.size() >= 3) strips.push_back(std::move(lo));
                rest = std::move(hi);
                if (rest.v.size() < 3) break;
            }
            if (rest.v.size() >= 3) strips.push_back(std::move(rest));
            // each strip takes only the t-cuts its own s-range needs
            pieces.clear();
            for (auto& strip : strips) {
                double tmin = 1e300, tmax = -1e300, sa = 1e300, sb = -1e300;
                for (const auto& q : strip.v) {
                    tmin = std::min(tmin, q.t); tmax = std::max(tmax, q.t);
                    sa = std::min(sa, q.s); sb = std::max(sb, q.s);
                }
                activeLines(tSegs, tmin, tmax, sa, sb, selT);
                Poly cur = std::move(strip);
                for (double c : selT) {
                    Poly lo, hi;
                    split(R, tri, tm, cur, 1, c, lo, hi);
                    if (lo.v.size() >= 3) pieces.push_back(std::move(lo));
                    cur = std::move(hi);
                    if (cur.v.size() < 3) break;
                }
                if (cur.v.size() >= 3) pieces.push_back(std::move(cur));
            }
            closeStripSeams(tm, sel, pieces);
            for (auto& piece : pieces) finishPiece(std::move(piece));
        }
        for (uint32_t w : touched) boundaryVertex_[w] = 0;
        rep.treated = true;
        rep.outputTriangles = (result_.mesh.triangles.size() - before) + 2 * (deferred_.size() - deferredBefore);
    }

    void tessellate() {
        boundaryVertex_.assign(wpos_.size(), 0);
        std::unordered_map<int, size_t> repOf;
        for (size_t i = 0; i < result_.facades.size(); ++i) repOf[result_.facades[i].id] = i;
        std::vector<uint8_t> treated(regions_.size(), 0);
        for (auto& R : regions_) {
            auto it = repOf.find(R.id);
            if (it == repOf.end() || R.features.empty()) continue;
            tessellateRegion(R, result_.facades[it->second]);
            if (result_.facades[it->second].treated) treated[static_cast<size_t>(R.id)] = 1;
        }
        // untreated triangles (all of them, including regions without evidence)
        const auto& verts = scene_.mesh.vertices;
        const auto& idx = scene_.mesh.indices;
        for (uint32_t tri = 0; tri < wtri_.size(); ++tri) {
            int32_t r = regionOf_[tri];
            if (r >= 0 && treated[static_cast<size_t>(r)]) continue;
            const auto& w = wtri_[tri];
            Poly P;
            P.tri = tri;
            P.region = -1;
            bool degenerate = w[0] == w[1] || w[1] == w[2] || w[0] == w[2];
            for (int k = 0; k < 3; ++k) {
                PV q;
                q.u = verts[idx[3 * tri + k]].uv.x;
                q.v = verts[idx[3 * tri + k]].uv.y;
                q.id = origVertex(w[k], nullptr);
                q.orig = w[k];
                P.v.push_back(q);
                P.e.push_back(degenerate ? 0 : detail::edgeKey(w[k], w[(k + 1) % 3]));
            }
            if (degenerate) {
                OutputTriangle o;
                for (int k = 0; k < 3; ++k) { o.p[k] = P.v[k].id; o.uv[k][0] = static_cast<float>(P.v[k].u); o.uv[k][1] = static_cast<float>(P.v[k].v); }
                o.material = scene_.triangleMaterial[tri];
                o.region = -1;
                o.parent = tri;
                result_.mesh.triangles.push_back(o);
                continue;
            }
            deferred_.push_back(std::move(P));
        }
        // close borders: insert every vertex created on an original edge into the polygons sharing it
        for (auto& kv : edgeInserts_) {
            std::sort(kv.second.begin(), kv.second.end());
        }
        result_.insertedBorderVertices = 0;
        for (auto& P : deferred_) {
            std::vector<PV> out;
            bool patched = false;
            const size_t n = P.v.size();
            // 2D frame for polygons outside regions: the parent triangle's own plane
            P3 fu, fv;
            const bool ownFrame = P.region < 0;
            if (ownFrame) {
                P3 nrm = fnorm_[P.tri];
                fu = std::abs(nrm.y) < 0.9 ? P3(0, 1, 0).cross(nrm).normalized() : P3(1, 0, 0).cross(nrm).normalized();
                fv = nrm.cross(fu);
                for (auto& q : P.v) {
                    const P3& pos = wpos_[q.orig];
                    q.s = pos.dot(fu);
                    q.t = pos.dot(fv);
                }
            }
            for (size_t i = 0; i < n; ++i) {
                const PV& A = P.v[i];
                const PV& B = P.v[(i + 1) % n];
                out.push_back(A);
                uint64_t tag = P.e[i];
                if (tag == 0) continue;
                auto it = edgeInserts_.find(tag);
                if (it == edgeInserts_.end()) continue;
                uint32_t a = static_cast<uint32_t>(tag >> 32), b = static_cast<uint32_t>(tag & 0xffffffffu);
                double la = lambdaOn(A, a, b), lb = lambdaOn(B, a, b);
                double lo = std::min(la, lb), hi = std::max(la, lb);
                std::vector<std::pair<double, uint32_t>> ins;
                for (const auto& q : it->second) {
                    if (q.first > lo + 1e-9 && q.first < hi - 1e-9 && q.second != A.id && q.second != B.id) ins.push_back(q);
                }
                if (ins.empty()) continue;
                if (la > lb) std::reverse(ins.begin(), ins.end());
                double lastLam = la;
                for (const auto& q : ins) {
                    if (std::abs(q.first - lastLam) <= 1e-9) continue;
                    double f = (q.first - la) / (lb - la);
                    PV x;
                    x.s = A.s + f * (B.s - A.s);
                    x.t = A.t + f * (B.t - A.t);
                    x.u = A.u + f * (B.u - A.u);
                    x.v = A.v + f * (B.v - A.v);
                    x.id = q.second;
                    x.edge = tag;
                    x.lambda = q.first;
                    out.push_back(x);
                    lastLam = q.first;
                    ++result_.insertedBorderVertices;
                    patched = true;
                }
            }
            if (patched) ++result_.borderPolygonsPatched;
            if (!patched && P.region < 0) {
                // untouched original triangle
                OutputTriangle o;
                for (int k = 0; k < 3; ++k) { o.p[k] = P.v[k].id; o.uv[k][0] = static_cast<float>(P.v[k].u); o.uv[k][1] = static_cast<float>(P.v[k].v); }
                o.material = scene_.triangleMaterial[P.tri];
                o.region = -1;
                o.parent = P.tri;
                result_.mesh.triangles.push_back(o);
                continue;
            }
            if (polyArea2(out) <= 0) {
                // degenerate in its frame: keep original fan to avoid holes
                for (size_t k = 1; k + 1 < out.size(); ++k) {
                    std::vector<PV> tri3 = {out[0], out[k], out[k + 1]};
                    emitPolygon(tri3, P.tri, P.region);
                }
                continue;
            }
            emitPolygon(out, P.tri, P.region);
        }
        deferred_.clear();
        deferred_.shrink_to_fit();
        // per-region output triangle counts
        std::unordered_map<int, size_t> count;
        for (const auto& t : result_.mesh.triangles) if (t.region >= 0) count[t.region]++;
        for (auto& f : result_.facades) {
            if (f.treated) f.outputTriangles = count[f.id];
        }
    }

    void summarize() {
        auto& m = result_.mesh;
        double rs = 0, ps = 0;
        result_.minHeight = 0;
        result_.maxHeight = 0;
        std::unordered_map<int, std::pair<double, double>> perRegion;
        for (size_t i = 0; i < m.heights.size(); ++i) {
            double h = m.heights[i];
            if (h < 0) { ++result_.recessedVertices; rs += h; }
            if (h > 0) { ++result_.proudVertices; ps += h; }
            result_.minHeight = std::min(result_.minHeight, h);
            result_.maxHeight = std::max(result_.maxHeight, h);
            int r = m.positionRegion[i];
            if (r >= 0) {
                auto& pr = perRegion[r];
                pr.first = std::min(pr.first, h);
                pr.second = std::max(pr.second, h);
            }
        }
        result_.meanRecess = result_.recessedVertices ? rs / result_.recessedVertices : 0;
        result_.meanProud = result_.proudVertices ? ps / result_.proudVertices : 0;
        for (auto& f : result_.facades) {
            if (!f.treated) continue;
            ++result_.regionsTreated;
            auto it = perRegion.find(f.id);
            if (it != perRegion.end()) { f.minHeight = it->second.first; f.maxHeight = it->second.second; }
            for (const auto& ft : f.analysis.features) {
                double a = (ft.s1 - ft.s0) * (ft.t1 - ft.t0);
                if (ft.height < 0) f.recessArea += a; else f.proudArea += a;
            }
            result_.recessArea += f.recessArea;
            result_.proudArea += f.proudArea;
        }
    }
};

// ============================================================================================
// Output: crease-split normals and plain glTF 2.0 writers
// ============================================================================================
namespace detail {

/** Angle-weighted crease-split corner normals (per output triangle corner). */
inline std::vector<std::array<float, 3>> cornerNormals(const ReliefMesh& m, double creaseAngleDeg) {
    const size_t T = m.triangles.size(), V = m.positions.size();
    std::vector<P3> fn(T);
    std::vector<std::array<double, 3>> ang(T);
    std::vector<uint32_t> deg(V + 1, 0);
    for (size_t t = 0; t < T; ++t) {
        const auto& tr = m.triangles[t];
        const P3& a = m.positions[tr.p[0]];
        const P3& b = m.positions[tr.p[1]];
        const P3& c = m.positions[tr.p[2]];
        fn[t] = (b - a).cross(c - a).normalized();
        const P3* P[3] = {&a, &b, &c};
        for (int k = 0; k < 3; ++k) {
            P3 e1 = (*P[(k + 1) % 3] - *P[k]).normalized(), e2 = (*P[(k + 2) % 3] - *P[k]).normalized();
            ang[t][k] = std::acos(std::clamp(e1.dot(e2), -1.0, 1.0));
            deg[tr.p[k]]++;
        }
    }
    std::vector<uint32_t> off(V + 1, 0);
    for (size_t v = 0; v < V; ++v) off[v + 1] = off[v] + deg[v];
    std::vector<uint32_t> inc(off[V]);
    std::vector<uint32_t> fill(off.begin(), off.end() - 1);
    for (size_t t = 0; t < T; ++t) for (int k = 0; k < 3; ++k) inc[fill[m.triangles[t].p[k]]++] = static_cast<uint32_t>(t * 3 + k);
    const double cosCrease = std::cos(creaseAngleDeg * 3.14159265358979323846 / 180.0);
    std::vector<std::array<float, 3>> out(T * 3);
    for (size_t t = 0; t < T; ++t) {
        for (int k = 0; k < 3; ++k) {
            uint32_t v = m.triangles[t].p[k];
            P3 sum;
            for (uint32_t i = off[v]; i < off[v + 1]; ++i) {
                uint32_t g = inc[i] / 3, l = inc[i] % 3;
                if (fn[g].dot(fn[t]) < cosCrease) continue;
                sum = sum + fn[g] * ang[g][l];
            }
            P3 n = sum.length() > 0 ? sum.normalized() : fn[t];
            if (n.length() < 0.5) n = P3(0, 1, 0);
            out[t * 3 + k] = {static_cast<float>(n.x), static_cast<float>(n.y), static_cast<float>(n.z)};
        }
    }
    return out;
}

class GlbBuilder {
public:
    std::vector<uint8_t> bin;
    std::vector<std::string> views, accessors;

    int addView(const void* data, size_t bytes, int target) {
        while (bin.size() % 4) bin.push_back(0);
        size_t off = bin.size();
        bin.insert(bin.end(), static_cast<const uint8_t*>(data), static_cast<const uint8_t*>(data) + bytes);
        std::ostringstream s;
        s << "{\"buffer\":0,\"byteOffset\":" << off << ",\"byteLength\":" << bytes;
        if (target) s << ",\"target\":" << target;
        s << "}";
        views.push_back(s.str());
        return static_cast<int>(views.size()) - 1;
    }
    int addAccessor(int view, int componentType, size_t count, const std::string& type, const std::string& minmax = "") {
        std::ostringstream s;
        s << "{\"bufferView\":" << view << ",\"componentType\":" << componentType << ",\"count\":" << count << ",\"type\":\"" << type << "\"" << minmax << "}";
        accessors.push_back(s.str());
        return static_cast<int>(accessors.size()) - 1;
    }
    static std::string join(const std::vector<std::string>& v) {
        std::string out;
        for (size_t i = 0; i < v.size(); ++i) { if (i) out += ","; out += v[i]; }
        return out;
    }
    std::vector<uint8_t> finish(std::string json) {
        while (json.size() % 4) json.push_back(' ');
        while (bin.size() % 4) bin.push_back(0);
        std::vector<uint8_t> glb;
        auto u32 = [&](uint32_t v) { for (int i = 0; i < 4; ++i) glb.push_back(static_cast<uint8_t>((v >> (8 * i)) & 0xff)); };
        u32(0x46546C67);
        u32(2);
        u32(static_cast<uint32_t>(12 + 8 + json.size() + 8 + bin.size()));
        u32(static_cast<uint32_t>(json.size()));
        u32(0x4E4F534A);
        glb.insert(glb.end(), json.begin(), json.end());
        u32(static_cast<uint32_t>(bin.size()));
        u32(0x004E4942);
        glb.insert(glb.end(), bin.begin(), bin.end());
        return glb;
    }
};

struct PackedPrimitive {
    std::vector<float> pos, nrm, uv;
    std::vector<uint32_t> indices;
    float mn[3]{1e30f, 1e30f, 1e30f}, mx[3]{-1e30f, -1e30f, -1e30f};
};

struct CornerKey {
    uint32_t p;
    float n[3], uv[2];
    bool operator==(const CornerKey& o) const {
        return p == o.p && std::memcmp(n, o.n, sizeof n) == 0 && std::memcmp(uv, o.uv, sizeof uv) == 0;
    }
};
struct CornerKeyHash {
    size_t operator()(const CornerKey& k) const {
        uint64_t h = mix64(k.p);
        uint32_t b[5];
        std::memcpy(b, k.n, 12);
        std::memcpy(b + 3, k.uv, 8);
        for (uint32_t x : b) h = mix64(h ^ x);
        return static_cast<size_t>(h);
    }
};

inline void packCorner(PackedPrimitive& prim, std::unordered_map<CornerKey, uint32_t, CornerKeyHash>& map, const ReliefMesh& m,
                       uint32_t p, const std::array<float, 3>& n, const float* uv, bool withUv) {
    CornerKey k{};
    k.p = p;
    std::memcpy(k.n, n.data(), 12);
    if (withUv) { k.uv[0] = uv[0]; k.uv[1] = uv[1]; }
    auto it = map.find(k);
    if (it != map.end()) { prim.indices.push_back(it->second); return; }
    uint32_t id = static_cast<uint32_t>(prim.pos.size() / 3);
    const P3& q = m.positions[p];
    float f[3] = {static_cast<float>(q.x), static_cast<float>(q.y), static_cast<float>(q.z)};
    for (int c = 0; c < 3; ++c) {
        prim.pos.push_back(f[c]);
        prim.mn[c] = std::min(prim.mn[c], f[c]);
        prim.mx[c] = std::max(prim.mx[c], f[c]);
        prim.nrm.push_back(n[c]);
    }
    if (withUv) { prim.uv.push_back(uv[0]); prim.uv.push_back(uv[1]); }
    map.emplace(k, id);
    prim.indices.push_back(id);
}

inline std::string minmax3(const PackedPrimitive& p) {
    std::ostringstream s;
    s.precision(9);
    s << ",\"min\":[" << p.mn[0] << "," << p.mn[1] << "," << p.mn[2] << "],\"max\":[" << p.mx[0] << "," << p.mx[1] << "," << p.mx[2] << "]";
    return s.str();
}

inline void addPrimitiveBuffers(GlbBuilder& g, const PackedPrimitive& p, bool withUv, int& aPos, int& aNrm, int& aUv, int& aIdx) {
    size_t vc = p.pos.size() / 3;
    aPos = g.addAccessor(g.addView(p.pos.data(), p.pos.size() * 4, 34962), 5126, vc, "VEC3", minmax3(p));
    aNrm = g.addAccessor(g.addView(p.nrm.data(), p.nrm.size() * 4, 34962), 5126, vc, "VEC3");
    aUv = withUv ? g.addAccessor(g.addView(p.uv.data(), p.uv.size() * 4, 34962), 5126, vc, "VEC2") : -1;
    aIdx = g.addAccessor(g.addView(p.indices.data(), p.indices.size() * 4, 34963), 5125, p.indices.size(), "SCALAR");
}

inline std::string fmt(double v) {
    if (!std::isfinite(v)) v = 0;
    std::ostringstream s;
    s.precision(9);
    s << v;
    return s.str();
}

} // namespace detail

inline std::vector<uint8_t> PhotometricRelief::writeTexturedGlb(const gltf::GltfScene& scene, const ReliefMesh& mesh, double creaseAngleDeg) {
    auto normals = detail::cornerNormals(mesh, creaseAngleDeg);
    const size_t M = std::max<size_t>(scene.materials.size(), 1);
    std::vector<detail::PackedPrimitive> prims(M);
    std::vector<std::unordered_map<detail::CornerKey, uint32_t, detail::CornerKeyHash>> maps(M);
    for (size_t t = 0; t < mesh.triangles.size(); ++t) {
        const auto& tr = mesh.triangles[t];
        size_t mi = std::min<size_t>(tr.material, M - 1);
        for (int k = 0; k < 3; ++k) detail::packCorner(prims[mi], maps[mi], mesh, tr.p[k], normals[t * 3 + k], tr.uv[k], true);
    }
    detail::GlbBuilder g;
    // images: original encoded bytes
    std::vector<std::string> images, textures, samplers, materials, meshes, nodes;
    for (const auto& im : scene.images) {
        int view = g.addView(im.encoded.data(), im.encoded.size(), 0);
        images.push_back("{\"mimeType\":\"" + (im.mimeType.empty() ? std::string("image/jpeg") : im.mimeType) + "\",\"bufferView\":" + std::to_string(view) + "}");
    }
    bool anyUnlit = false;
    auto texRef = [&](int image, int wrapS, int wrapT) {
        samplers.push_back("{\"magFilter\":9729,\"minFilter\":9987,\"wrapS\":" + std::to_string(wrapS) + ",\"wrapT\":" + std::to_string(wrapT) + "}");
        textures.push_back("{\"source\":" + std::to_string(image) + ",\"sampler\":" + std::to_string(samplers.size() - 1) + "}");
        return static_cast<int>(textures.size()) - 1;
    };
    auto validImage = [&](int i) { return i >= 0 && i < static_cast<int>(scene.images.size()) && !scene.images[static_cast<size_t>(i)].encoded.empty(); };
    for (size_t mi = 0; mi < scene.materials.size(); ++mi) {
        const auto& sm = scene.materials[mi];
        std::ostringstream s;
        s << "{\"pbrMetallicRoughness\":{\"baseColorFactor\":[" << detail::fmt(sm.baseColorFactor.x) << "," << detail::fmt(sm.baseColorFactor.y) << ","
          << detail::fmt(sm.baseColorFactor.z) << "," << detail::fmt(sm.baseColorFactor.w) << "],\"metallicFactor\":" << detail::fmt(sm.metallicFactor)
          << ",\"roughnessFactor\":" << detail::fmt(sm.roughnessFactor);
        if (validImage(sm.baseColorImage)) s << ",\"baseColorTexture\":{\"index\":" << texRef(sm.baseColorImage, sm.wrapS, sm.wrapT) << "}";
        if (validImage(sm.metallicRoughnessImage)) s << ",\"metallicRoughnessTexture\":{\"index\":" << texRef(sm.metallicRoughnessImage, sm.mrWrapS, sm.mrWrapT) << "}";
        s << "}";
        if (validImage(sm.normalImage)) s << ",\"normalTexture\":{\"index\":" << texRef(sm.normalImage, sm.normalWrapS, sm.normalWrapT) << ",\"scale\":" << detail::fmt(sm.normalScale) << "}";
        if (validImage(sm.occlusionImage)) s << ",\"occlusionTexture\":{\"index\":" << texRef(sm.occlusionImage, 10497, 10497) << ",\"strength\":" << detail::fmt(sm.occlusionStrength) << "}";
        if (sm.emissiveFactor.x != 0 || sm.emissiveFactor.y != 0 || sm.emissiveFactor.z != 0)
            s << ",\"emissiveFactor\":[" << detail::fmt(sm.emissiveFactor.x) << "," << detail::fmt(sm.emissiveFactor.y) << "," << detail::fmt(sm.emissiveFactor.z) << "]";
        if (sm.doubleSided) s << ",\"doubleSided\":true";
        if (sm.unlit) { s << ",\"extensions\":{\"KHR_materials_unlit\":{}}"; anyUnlit = true; }
        s << "}";
        materials.push_back(s.str());
    }
    if (materials.empty()) materials.push_back("{\"pbrMetallicRoughness\":{\"metallicFactor\":0,\"roughnessFactor\":0.9}}");
    std::vector<std::string> children;
    for (size_t mi = 0; mi < M; ++mi) {
        const auto& p = prims[mi];
        if (p.indices.empty()) continue;
        int aPos, aNrm, aUv, aIdx;
        detail::addPrimitiveBuffers(g, p, true, aPos, aNrm, aUv, aIdx);
        meshes.push_back("{\"name\":\"relief_m" + std::to_string(mi) + "\",\"primitives\":[{\"attributes\":{\"POSITION\":" + std::to_string(aPos) +
                         ",\"NORMAL\":" + std::to_string(aNrm) + ",\"TEXCOORD_0\":" + std::to_string(aUv) + "},\"indices\":" + std::to_string(aIdx) +
                         ",\"material\":" + std::to_string(mi) + ",\"mode\":4}]}");
        nodes.push_back("{\"name\":\"relief_m" + std::to_string(mi) + "\",\"mesh\":" + std::to_string(meshes.size() - 1) + "}");
        children.push_back(std::to_string(nodes.size()));
    }
    std::string json = "{\"asset\":{\"version\":\"2.0\",\"generator\":\"Scratchbox photometric relief\"},";
    if (anyUnlit) json += "\"extensionsUsed\":[\"KHR_materials_unlit\"],";
    json += "\"scene\":0,\"scenes\":[{\"nodes\":[0]}],\"nodes\":[{\"name\":\"PhotometricRelief\",\"children\":[" + detail::GlbBuilder::join(children) + "]}";
    if (!nodes.empty()) json += "," + detail::GlbBuilder::join(nodes);
    json += "],\"meshes\":[" + detail::GlbBuilder::join(meshes) + "],\"materials\":[" + detail::GlbBuilder::join(materials) + "]";
    if (!textures.empty()) json += ",\"textures\":[" + detail::GlbBuilder::join(textures) + "],\"samplers\":[" + detail::GlbBuilder::join(samplers) + "]";
    if (!images.empty()) json += ",\"images\":[" + detail::GlbBuilder::join(images) + "]";
    json += ",\"accessors\":[" + detail::GlbBuilder::join(g.accessors) + "],\"bufferViews\":[" + detail::GlbBuilder::join(g.views) + "]";
    while (g.bin.size() % 4) g.bin.push_back(0);
    json += ",\"buffers\":[{\"byteLength\":" + std::to_string(g.bin.size()) + "}]}";
    return g.finish(json);
}

inline std::vector<uint8_t> PhotometricRelief::writeClayGlb(const ReliefMesh& mesh, double creaseAngleDeg, const std::string& name) {
    auto normals = detail::cornerNormals(mesh, creaseAngleDeg);
    detail::PackedPrimitive prim;
    std::unordered_map<detail::CornerKey, uint32_t, detail::CornerKeyHash> map;
    for (size_t t = 0; t < mesh.triangles.size(); ++t) {
        for (int k = 0; k < 3; ++k) detail::packCorner(prim, map, mesh, mesh.triangles[t].p[k], normals[t * 3 + k], mesh.triangles[t].uv[k], false);
    }
    detail::GlbBuilder g;
    int aPos, aNrm, aUv, aIdx;
    detail::addPrimitiveBuffers(g, prim, false, aPos, aNrm, aUv, aIdx);
    std::string json = "{\"asset\":{\"version\":\"2.0\",\"generator\":\"Scratchbox photometric relief\"},\"scene\":0,\"scenes\":[{\"nodes\":[0]}],";
    json += "\"nodes\":[{\"name\":\"" + name + "\",\"mesh\":0}],\"meshes\":[{\"name\":\"" + name + "\",\"primitives\":[{\"attributes\":{\"POSITION\":" +
            std::to_string(aPos) + ",\"NORMAL\":" + std::to_string(aNrm) + "},\"indices\":" + std::to_string(aIdx) + ",\"material\":0,\"mode\":4}]}],";
    json += "\"materials\":[{\"name\":\"Mat_StudioGreyClay\",\"pbrMetallicRoughness\":{\"baseColorFactor\":[0.55,0.57,0.6,1],\"metallicFactor\":0,\"roughnessFactor\":0.85},\"doubleSided\":false}],";
    json += "\"accessors\":[" + detail::GlbBuilder::join(g.accessors) + "],\"bufferViews\":[" + detail::GlbBuilder::join(g.views) + "]";
    while (g.bin.size() % 4) g.bin.push_back(0);
    json += ",\"buffers\":[{\"byteLength\":" + std::to_string(g.bin.size()) + "}]}";
    return g.finish(json);
}

inline std::string PhotometricRelief::statsJson(const ReliefResult& r, const ReliefParams& p) {
    using detail::fmt;
    std::ostringstream s;
    auto v3 = [&](const P3& v) { return "[" + fmt(v.x) + "," + fmt(v.y) + "," + fmt(v.z) + "]"; };
    s << "{\n  \"ok\": " << (r.ok ? "true" : "false") << ",\n";
    if (!r.error.empty()) s << "  \"error\": \"" << r.error << "\",\n";
    s << "  \"params\": {\"maxDepth\": " << fmt(p.maxDepth) << ", \"minRegionArea\": " << fmt(p.minRegionArea) << ", \"wallMaxAbsNy\": " << fmt(p.wallMaxAbsNy)
      << ", \"planeAngleDeg\": " << fmt(p.planeAngleDeg) << ", \"planeOffset\": " << fmt(p.planeOffset) << ", \"pixel\": " << fmt(p.pixel)
      << ", \"minPitch\": " << fmt(p.minPitch) << ", \"maxPitch\": " << fmt(p.maxPitch) << ", \"recessMin\": " << fmt(p.recessMin) << ", \"recessMax\": " << fmt(p.recessMax)
      << ", \"contrastLo\": " << fmt(p.contrastLo) << ", \"contrastHi\": " << fmt(p.contrastHi) << ", \"shadowSlope\": " << fmt(p.shadowSlope)
      << ", \"maxBandHeight\": " << fmt(p.maxBandHeight) << ", \"jambWidth\": " << fmt(p.jambWidth) << "},\n";
    s << "  \"input\": {\"triangles\": " << r.inputTriangles << ", \"vertices\": " << r.inputVertices << ", \"weldedVertices\": " << r.weldedVertices << "},\n";
    s << "  \"output\": {\"triangles\": " << r.mesh.triangles.size() << ", \"positions\": " << r.mesh.positions.size() << ", \"insertedBorderVertices\": "
      << r.insertedBorderVertices << ", \"borderPolygonsPatched\": " << r.borderPolygonsPatched << "},\n";
    s << "  \"regions\": {\"candidateTriangles\": " << r.candidateTriangles << ", \"patches\": " << r.regionsFound << ", \"patchMerges\": " << r.patchesMerged
      << ", \"internalSeamEdges\": " << r.internalSeamEdges << ", \"analysed\": " << r.regionsAnalysed << ", \"treated\": " << r.regionsTreated << "},\n";
    s << "  \"relief\": {\"minHeight\": " << fmt(r.minHeight) << ", \"maxHeight\": " << fmt(r.maxHeight) << ", \"meanRecess\": " << fmt(r.meanRecess)
      << ", \"meanProud\": " << fmt(r.meanProud) << ", \"recessedVertices\": " << r.recessedVertices << ", \"proudVertices\": " << r.proudVertices
      << ", \"recessArea\": " << fmt(r.recessArea) << ", \"proudArea\": " << fmt(r.proudArea) << "},\n";
    s << "  \"timingsMs\": {";
    for (size_t i = 0; i < r.timingsMs.size(); ++i) s << (i ? ", " : "") << "\"" << r.timingsMs[i].first << "\": " << fmt(r.timingsMs[i].second);
    s << "},\n  \"facades\": [";
    bool first = true;
    for (const auto& f : r.facades) {
        const auto& a = f.analysis;
        s << (first ? "\n" : ",\n") << "    {\"id\": " << f.id << ", \"treated\": " << (f.treated ? "true" : "false");
        first = false;
        if (!f.skipReason.empty()) s << ", \"skipReason\": \"" << f.skipReason << "\"";
        s << ", \"area\": " << fmt(f.area) << ", \"inputTriangles\": " << f.inputTriangles << ", \"outputTriangles\": " << f.outputTriangles
          << ", \"centroid\": " << v3(f.centroid) << ", \"normal\": " << v3(f.normal) << ", \"axisS\": " << v3(f.axisS) << ", \"axisT\": " << v3(f.axisT)
          << ", \"sRange\": [" << fmt(f.sMin) << "," << fmt(f.sMax) << "], \"tRange\": [" << fmt(f.tMin) << "," << fmt(f.tMax) << "]"
          << ", \"texel\": " << fmt(f.texel) << ", \"pixel\": " << fmt(f.pixel) << ", \"ortho\": [" << f.orthoWidth << "," << f.orthoHeight << "]"
          << ", \"coverage\": " << fmt(f.coverage) << ", \"meanLuminance\": " << fmt(a.meanLuminance)
          << ", \"periodS\": {\"found\": " << (a.periodS.found ? "true" : "false") << ", \"pitch\": " << fmt(a.periodS.pitch) << ", \"periodicity\": " << fmt(a.periodS.periodicity) << ", \"harmonics\": " << a.periodS.harmonics << "}"
          << ", \"periodT\": {\"found\": " << (a.periodT.found ? "true" : "false") << ", \"pitch\": " << fmt(a.periodT.pitch) << ", \"periodicity\": " << fmt(a.periodT.periodicity) << ", \"harmonics\": " << a.periodT.harmonics << "}"
          << ", \"darkCell\": {\"foundS\": " << (a.cell.foundS ? "true" : "false") << ", \"foundT\": " << (a.cell.foundT ? "true" : "false")
          << ", \"s0\": " << fmt(a.cell.s0) << ", \"widthS\": " << fmt(a.cell.widthS) << ", \"t0\": " << fmt(a.cell.t0) << ", \"heightT\": " << fmt(a.cell.heightT)
          << ", \"phaseS\": " << fmt(a.cell.phaseS) << ", \"phaseT\": " << fmt(a.cell.phaseT) << ", \"contrastS\": " << fmt(a.cell.contrastS) << ", \"contrastT\": " << fmt(a.cell.contrastT);
        auto runs = [&](const std::vector<std::pair<double, double>>& rr) {
            std::string out = "[";
            for (size_t i = 0; i < rr.size(); ++i) out += (i ? ",[" : "[") + fmt(rr[i].first) + "," + fmt(rr[i].second) + "]";
            return out + "]";
        };
        s << ", \"runsS\": " << runs(a.cell.runsS) << ", \"runsT\": " << runs(a.cell.runsT) << "}"
          << ", \"pattern\": \"" << a.pattern << "\", \"cellsTested\": " << a.cellsTested << ", \"cellsAccepted\": " << a.cellsAccepted
          << ", \"stripsTested\": " << a.stripsTested << ", \"stripRuns\": " << a.stripRuns
          << ", \"sLines\": " << f.sLines << ", \"tLines\": " << f.tLines
          << ", \"minHeight\": " << fmt(f.minHeight) << ", \"maxHeight\": " << fmt(f.maxHeight) << ", \"recessArea\": " << fmt(f.recessArea) << ", \"proudArea\": " << fmt(f.proudArea);
        size_t nRecess = 0, nProud = 0;
        double dr0 = 0, dr1 = 0, dp0 = 0, dp1 = 0, drs = 0, dps = 0;
        for (const auto& ft : a.features) {
            double d = std::abs(ft.height);
            if (ft.height < 0) { dr0 = nRecess ? std::min(dr0, d) : d; dr1 = std::max(dr1, d); drs += d; ++nRecess; }
            else { dp0 = nProud ? std::min(dp0, d) : d; dp1 = std::max(dp1, d); dps += d; ++nProud; }
        }
        s << ", \"recessFeatures\": {\"count\": " << nRecess << ", \"minDepth\": " << fmt(dr0) << ", \"maxDepth\": " << fmt(dr1) << ", \"meanDepth\": " << fmt(nRecess ? drs / nRecess : 0) << "}";
        s << ", \"proudFeatures\": {\"count\": " << nProud << ", \"minDepth\": " << fmt(dp0) << ", \"maxDepth\": " << fmt(dp1) << ", \"meanDepth\": " << fmt(nProud ? dps / nProud : 0) << "}";
        s << ", \"lines\": [";
        for (size_t i = 0; i < a.lines.size(); ++i) {
            const auto& L = a.lines[i];
            s << (i ? "," : "") << "{\"axis\":\"" << L.axis << "\",\"coord\":" << fmt(L.coord) << ",\"step\":" << fmt(L.step) << ",\"consistency\":" << fmt(L.consistency)
              << ",\"from\":" << fmt(L.from) << ",\"to\":" << fmt(L.to) << ",\"shadowWidth\":" << fmt(L.shadowWidth) << ",\"proudDepth\":" << fmt(L.proudDepth)
              << ",\"relief\":" << (L.relief ? "true" : "false") << ",\"explainedByGrid\":" << (L.explainedByGrid ? "true" : "false") << "}";
        }
        s << "]}";
    }
    s << "\n  ]\n}\n";
    return s.str();
}

} // namespace photometric_relief
} // namespace scratchbox

#endif // SCRATCHBOX_PHOTOMETRIC_RELIEF_HPP
