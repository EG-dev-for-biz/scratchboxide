/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_UV_ENGINE_HPP
#define SCRATCHBOX_UV_ENGINE_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_uv_tangent.hpp"
#include "scratchbox_texture.hpp"
#include "scratchbox_uv_rewrap.hpp"

#include <vector>
#include <cmath>
#include <algorithm>
#include <cstdint>
#include <string>
#include <memory>
#include <chrono>
#include <set>
#include <unordered_map>

namespace scratchbox {
namespace uv_engine {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using geometry::Vertex;
using geometry::ScratchboxMesh;
using texture::ImageBuffer;
using texture::PbrTextureSet;

// ============================================================================
// 1. Semantic Material Classification
// ============================================================================

enum class SurfaceMaterialType {
    StoneArchitecture,
    AsphaltRoadway,
    FoliageVegetation,
    PlasterMasonry
};

inline SurfaceMaterialType classifySurface(const Vec3& norm, const Vec3& rgb, float reliefY) {
    float r = rgb.x * 255.0f;
    float g = rgb.y * 255.0f;
    float b = rgb.z * 255.0f;

    // Foliage: green dominance
    if ((g > r + 6.0f && g > b + 6.0f) || (2.0f * g - r - b > 12.0f)) {
        return SurfaceMaterialType::FoliageVegetation;
    }

    // Asphalt / Road: flat horizontal surface with neutral slate tones
    float ny = std::abs(norm.y);
    float colorDiff = std::max({std::abs(r - g), std::abs(g - b), std::abs(r - b)});
    if (ny > 0.72f && colorDiff < 16.0f && r < 145.0f) {
        return SurfaceMaterialType::AsphaltRoadway;
    }

    // Travertine Stone: warm tones (R > G > B) with architectural elevation
    if (r > g && g >= b && (r - b > 14.0f)) {
        return SurfaceMaterialType::StoneArchitecture;
    }

    return SurfaceMaterialType::PlasterMasonry;
}

// ============================================================================
// 2. Continuous 3D Coordinate & Barycentric Interpolation
// ============================================================================

struct BarycentricCoords {
    float u{0};
    float v{0};
    float w{0};
    bool valid{false};
};

/**
 * Computes exact 2D barycentric weights within UV triangle coordinates.
 */
inline BarycentricCoords computeBarycentric(
    float px, float py,
    float x1, float y1,
    float x2, float y2,
    float x3, float y3,
    float det
) {
    if (std::abs(det) < 1e-9f) {
        return {0.0f, 0.0f, 0.0f, false};
    }

    float u = ((y2 - y3) * (px - x3) + (x3 - x2) * (py - y3)) / det;
    float v = ((y3 - y1) * (px - x3) + (x1 - x3) * (py - y3)) / det;
    float w = 1.0f - u - v;

    bool valid = (u >= -0.01f && v >= -0.01f && w >= -0.01f);
    return {u, v, w, valid};
}

// ============================================================================
// 3. Analytical Quadratic Cavitation & Micro-Detail Generators
// ============================================================================

/**
 * Procedural travertine cavitation pore generator.
 * Implements steep non-linear power curve:
 *   ΔL_pore = -((0.24 - n) / 0.24)^2 * 52.0
 */
inline float evaluateTravertineCavitation(const Vec3& pos, uint32_t seed = 1337) {
    // Multi-octave 3D coordinate noise
    float scale1 = 28.0f;
    float n1 = math::FastNoise3D::perlin(pos.x * scale1, pos.y * scale1, pos.z * scale1, seed);
    float scale2 = 64.0f;
    float n2 = math::FastNoise3D::perlin(pos.x * scale2, pos.y * scale2, pos.z * scale2, seed + 101);
    float n = (n1 * 0.65f + n2 * 0.35f + 1.0f) * 0.5f; // [0, 1]

    if (n < 0.24f) {
        float depth = (0.24f - n) / 0.24f;
        return -(depth * depth) * 52.0f; // Dark steep cavitation pore
    }
    return 0.0f;
}

/**
 * Procedural crystalline calcite tooth and horizontal bedding strata.
 */
inline float evaluateCalciteStrata(const Vec3& pos) {
    // Horizontal sedimentary bedding strata along Y axis
    float strata = std::sin(pos.y * 140.0f + math::FastNoise3D::perlin(pos.x * 12.0f, 0.0f, pos.z * 12.0f, 555) * 2.5f);
    float strataDelta = strata * 4.5f;

    // High-frequency crystalline calcite grain
    float tooth = (math::FastNoise3D::perlin(pos.x * 120.0f, pos.y * 120.0f, pos.z * 120.0f, 777)) * 5.0f;
    return strataDelta + tooth;
}

/**
 * Bituminous asphalt fine aggregate gravel noise.
 */
inline float evaluateBitumenAggregate(const Vec3& pos) {
    float n = math::FastNoise3D::perlin(pos.x * 90.0f, pos.y * 90.0f, pos.z * 90.0f, 999);
    return n * 6.5f; // Random isotropic asphalt roughness
}

/**
 * Chlorophyll leaf dappling and foliage micro-contrast.
 */
inline float evaluateChlorophyllDappling(const Vec3& pos) {
    float n = math::FastNoise3D::perlin(pos.x * 45.0f, pos.y * 45.0f, pos.z * 45.0f, 1234);
    return n * 8.0f;
}

// ============================================================================
// 4. Intrinsic Image Decomposition (Albedo vs. Irradiance)
// ============================================================================

/**
 * Intrinsic Image Decomposition: separates irradiance S from albedo A:
 *   I(x, y) = A(x, y) * S(x, y)
 * Bilateral filter removes low-frequency directional shadows while preserving crisp albedo edges.
 */
inline void decomposeIntrinsicAlbedo(
    const ImageBuffer& src,
    ImageBuffer& outAlbedo,
    ImageBuffer& outShading,
    float spatialSigma = 4.0f,
    float rangeSigma = 0.15f
) {
    int w = src.width;
    int h = src.height;
    outAlbedo = ImageBuffer(w, h, 3);
    outShading = ImageBuffer(w, h, 3);

    int radius = static_cast<int>(spatialSigma * 2.0f);

    for (int y = 0; y < h; ++y) {
        for (int x = 0; x < w; ++x) {
            Vec3 centerCol = src.getPixelRGB(x, y);
            float centerLum = src.getLuminance(x, y);

            float sumWeights = 0.0f;
            float sumLum = 0.0f;

            for (int dy = -radius; dy <= radius; ++dy) {
                int ny = y + dy;
                if (ny < 0 || ny >= h) continue;

                for (int dx = -radius; dx <= radius; ++dx) {
                    int nx = x + dx;
                    if (nx < 0 || nx >= w) continue;

                    float spatialDistSq = static_cast<float>(dx * dx + dy * dy);
                    float spatialWeight = std::exp(-spatialDistSq / (2.0f * spatialSigma * spatialSigma));

                    float neighborLum = src.getLuminance(nx, ny);
                    float rangeDist = neighborLum - centerLum;
                    float rangeWeight = std::exp(-(rangeDist * rangeDist) / (2.0f * rangeSigma * rangeSigma));

                    float weight = spatialWeight * rangeWeight;
                    sumLum += neighborLum * weight;
                    sumWeights += weight;
                }
            }

            float smoothShading = (sumWeights > 1e-6f) ? (sumLum / sumWeights) : centerLum;
            smoothShading = std::clamp(smoothShading, 0.05f, 1.0f);

            // Shading ratio S in [0.2, 1.0]
            float sRatio = std::clamp(smoothShading, 0.2f, 1.0f);
            outShading.setPixelRGB(x, y, {sRatio, sRatio, sRatio});

            // True diffuse albedo A = I / S
            Vec3 albedo = centerCol * (1.0f / sRatio);
            albedo.x = std::clamp(albedo.x, 0.0f, 1.0f);
            albedo.y = std::clamp(albedo.y, 0.0f, 1.0f);
            albedo.z = std::clamp(albedo.z, 0.0f, 1.0f);
            outAlbedo.setPixelRGB(x, y, albedo);
        }
    }
}

// ============================================================================
// 4b. Solar Inverse De-Lighting with a measured ambient-to-sun ratio
// ============================================================================
//
// Shading model: I = rho * s * (max(0, N.L) + k), N the geometry normal, L the sun the caller gives, k the
// ambient-to-sun irradiance ratio. k is measured from the image (fitSolarShading, same algorithm as
// packages/core/src/node/spatial/solar-shading-fit.ts): texels are grouped by chart (4-connected texels with a normal;
// albedo assumed piecewise constant per chart) and N.L bin, and k is the value that makes each chart's de-lit albedo the
// same in every bin it covers. A poorly conditioned fit is refused with the reason; no sun, ambient or date is assumed.

struct SolarEphemerisConfig {
    /** Sun direction (+X East, +Y Up, -Z North) of the capture. Must be set: a zero vector means no sun is known. */
    Vec3 sunVector{0.0f, 0.0f, 0.0f};
    int minCellSamples{16};
    int minSamplesPerSide{64};
    float maxLogSigma{0.3f};
};

struct SolarShadingFit {
    bool fitted{false};
    std::string reason;
    double ambientToSun{0.0};
    double logSigma{0.0};
    double rmsLogResidual{0.0};
    double meanIrradiance{1.0};
    double gainCap{1.0};
    int cells{0};
    int charts{0};
    int shadedSamples{0};
    int litSamples{0};
};

/** E(N) = max(0, N.L) + k of the shading model. */
inline float computeSolarIrradiance(const Vec3& normal, const Vec3& sunVector, float ambientToSun) {
    return std::max(0.0f, normal.normalized().dot(sunVector.normalized())) + ambientToSun;
}

inline SolarShadingFit fitSolarShading(
    const std::vector<float>& luminance,
    const std::vector<float>& cosSun,
    const std::vector<int>& group,
    const SolarEphemerisConfig& cfg = {}
) {
    constexpr int LIT_BINS = 8;
    constexpr double SHADED_COS = 0.02, LIT_COS = 0.3;
    auto binOf = [&](double c) {
        if (!(c > SHADED_COS)) return 0;
        return 1 + std::min(LIT_BINS - 1, static_cast<int>(std::floor((c - SHADED_COS) / (1.0 - SHADED_COS) * LIT_BINS)));
    };
    SolarShadingFit fit;
    const size_t n = luminance.size();
    std::unordered_map<long long, int> keyToCell;
    std::vector<int> cellChart, cellBin;
    std::vector<std::vector<double>> cellLog;
    std::vector<double> cosSum;
    for (size_t i = 0; i < n; ++i) {
        if (group[i] < 0) continue;
        int b = binOf(cosSun[i]);
        long long key = static_cast<long long>(group[i]) * (LIT_BINS + 1) + b;
        auto it = keyToCell.find(key);
        int c;
        if (it == keyToCell.end()) {
            c = static_cast<int>(cellChart.size());
            keyToCell.emplace(key, c);
            cellChart.push_back(group[i]); cellBin.push_back(b); cellLog.emplace_back(); cosSum.push_back(0.0);
        } else c = it->second;
        cellLog[c].push_back(std::log(std::max(1e-4, static_cast<double>(luminance[i]))));
        cosSum[c] += std::max(0.0f, cosSun[i]);
    }
    const int nCells = static_cast<int>(cellChart.size());
    auto big = [&](int c) { return static_cast<int>(cellLog[c].size()) >= cfg.minCellSamples; };
    auto lit = [&](int c) { return cellBin[c] > 0 && cosSum[c] / cellLog[c].size() >= LIT_COS; };
    std::unordered_map<int, std::set<int>> binsOfChart;
    std::set<int> hasShaded, hasLit;
    for (int c = 0; c < nCells; ++c) {
        if (!big(c)) continue;
        binsOfChart[cellChart[c]].insert(cellBin[c]);
        if (cellBin[c] == 0) hasShaded.insert(cellChart[c]);
        else if (lit(c)) hasLit.insert(cellChart[c]);
    }
    std::vector<int> used;
    std::vector<double> median(nCells, 0.0);
    std::set<int> chartSet;
    for (int c = 0; c < nCells; ++c) {
        if (!big(c) || binsOfChart[cellChart[c]].size() < 2) continue;
        used.push_back(c);
        chartSet.insert(cellChart[c]);
        auto& v = cellLog[c];
        std::sort(v.begin(), v.end());
        size_t m = v.size() / 2;
        median[c] = v.size() % 2 ? v[m] : 0.5 * (v[m - 1] + v[m]);
        bool both = hasShaded.count(cellChart[c]) && hasLit.count(cellChart[c]);
        if (both) {
            if (cellBin[c] == 0) fit.shadedSamples += static_cast<int>(v.size());
            else if (lit(c)) fit.litSamples += static_cast<int>(v.size());
        }
    }
    fit.cells = static_cast<int>(used.size());
    fit.charts = static_cast<int>(chartSet.size());
    if (fit.shadedSamples < cfg.minSamplesPerSide || fit.litSamples < cfg.minSamplesPerSide) {
        fit.reason = "too few texels on charts seen both facing the sun and turned away from it (" + std::to_string(fit.shadedSamples) +
            " shaded, " + std::to_string(fit.litSamples) + " lit; " + std::to_string(cfg.minSamplesPerSide) + " of each needed)";
        return fit;
    }
    std::unordered_map<int, int> chartIdx;
    for (int c : used) chartIdx.emplace(cellChart[c], static_cast<int>(chartIdx.size()));
    const int G = static_cast<int>(chartIdx.size());
    std::vector<int> cg; std::vector<double> cbar, l;
    for (int c : used) { cg.push_back(chartIdx[cellChart[c]]); cbar.push_back(cosSum[c] / cellLog[c].size()); l.push_back(median[c]); }
    std::vector<double> rho(G), cnt(G);
    auto ss = [&](double logK) {
        double k = std::exp(logK);
        std::fill(rho.begin(), rho.end(), 0.0); std::fill(cnt.begin(), cnt.end(), 0.0);
        for (size_t j = 0; j < used.size(); ++j) { rho[cg[j]] += l[j] - std::log(cbar[j] + k); cnt[cg[j]] += 1.0; }
        for (int g = 0; g < G; ++g) rho[g] /= cnt[g];
        double s = 0.0;
        for (size_t j = 0; j < used.size(); ++j) { double r = l[j] - std::log(cbar[j] + k) - rho[cg[j]]; s += r * r; }
        return s;
    };
    const double LO = std::log(0.005), HI = std::log(20.0);
    const int STEPS = 240;
    int best = 0; double bestSs = 1e300;
    for (int s = 0; s <= STEPS; ++s) { double v = ss(LO + (HI - LO) * s / STEPS); if (v < bestSs) { bestSs = v; best = s; } }
    if (best == 0 || best == STEPS) { fit.reason = "the shading fit is best at the search limit of the ambient-to-sun ratio, so the data do not bound it"; return fit; }
    double a = LO + (HI - LO) * (best - 1) / STEPS, b = LO + (HI - LO) * (best + 1) / STEPS;
    const double phi = (std::sqrt(5.0) - 1.0) / 2.0;
    double x1 = b - phi * (b - a), x2 = a + phi * (b - a), f1 = ss(x1), f2 = ss(x2);
    for (int it = 0; it < 60; ++it) {
        if (f1 < f2) { b = x2; x2 = x1; f2 = f1; x1 = b - phi * (b - a); f1 = ss(x1); }
        else { a = x1; x1 = x2; f1 = f2; x2 = a + phi * (b - a); f2 = ss(x2); }
    }
    double logK = 0.5 * (a + b), ssMin = ss(logK);
    int dof = static_cast<int>(used.size()) - G - 1;
    if (dof < 1) { fit.reason = "no degree of freedom left to measure the ambient-to-sun ratio"; return fit; }
    double h = 0.05, curv = (ss(logK + h) - 2.0 * ssMin + ss(logK - h)) / (h * h);
    double logSigma = curv > 0.0 ? std::sqrt(2.0 * (ssMin / dof) / curv) : 1e300;
    if (!(logSigma <= cfg.maxLogSigma)) { fit.reason = "the ambient-to-sun ratio is poorly determined (standard error of ln k " + std::to_string(logSigma) + ")"; return fit; }
    double k = std::exp(logK);
    ss(logK);
    double rms = std::sqrt(ssMin / used.size());
    double eSum = 0.0; size_t eN = 0;
    for (size_t i = 0; i < n; ++i) if (group[i] >= 0) { eSum += std::max(0.0f, cosSun[i]) + k; ++eN; }
    double meanE = eN ? eSum / eN : 1.0, maxCellGain = 0.0;
    for (size_t j = 0; j < used.size(); ++j) maxCellGain = std::max(maxCellGain, std::exp(rho[cg[j]] - l[j]) * meanE);
    fit.fitted = true;
    fit.ambientToSun = k; fit.logSigma = logSigma; fit.rmsLogResidual = rms; fit.meanIrradiance = meanE;
    fit.gainCap = maxCellGain * std::exp(2.0 * rms);
    return fit;
}

struct SolarDelightResult {
    int delitTexels{0};
    int cappedTexels{0};
    int clippedTexels{0};
    std::string skippedReason;
    SolarShadingFit fit;
};

inline float srgbToLinear(float c) { return c <= 0.04045f ? c / 12.92f : std::pow((c + 0.055f) / 1.055f, 2.4f); }
inline float linearToSrgb(float c) { c = std::clamp(c, 0.0f, 1.0f); return c <= 0.0031308f ? 12.92f * c : 1.055f * std::pow(c, 1.0f / 2.4f) - 0.055f; }

/**
 * Divides each texel with a geometry normal (`texelNormals`, rasterized from the mesh; zero = none) by E(N) / mean E in
 * linear light, k measured by fitSolarShading, the gain capped at the fit's measured bound. Nothing changes, and the
 * reason is set, when no sun is given, the sun is below the horizon, or the fit is refused.
 */
inline SolarDelightResult applySolarInverseDelighting(
    ImageBuffer& albedo,
    const std::vector<Vec3>& texelNormals,
    const SolarEphemerisConfig& config
) {
    SolarDelightResult out;
    const int w = albedo.width, h = albedo.height;
    if (config.sunVector.dot(config.sunVector) < 1e-12f) { out.skippedReason = "no sun vector was given (the capture's sun is never assumed)"; return out; }
    if (static_cast<int>(texelNormals.size()) != w * h) { out.skippedReason = "texel normals do not match the image size"; return out; }
    Vec3 sun = config.sunVector.normalized();
    if (!(sun.y > 0.0f)) { out.skippedReason = "the sun is at or below the horizon"; return out; }

    std::vector<int> has(static_cast<size_t>(w) * h, 0), chart(static_cast<size_t>(w) * h, -1);
    for (int i = 0; i < w * h; ++i) has[i] = texelNormals[i].dot(texelNormals[i]) > 1e-12f;
    int next = 0;
    std::vector<int> stack;
    for (int s = 0; s < w * h; ++s) {
        if (!has[s] || chart[s] >= 0) continue;
        chart[s] = next; stack.push_back(s);
        while (!stack.empty()) {
            int t = stack.back(); stack.pop_back();
            int x = t % w, y = t / w;
            auto visit = [&](int u) { if (has[u] && chart[u] < 0) { chart[u] = next; stack.push_back(u); } };
            if (x > 0) visit(t - 1);
            if (x < w - 1) visit(t + 1);
            if (y > 0) visit(t - w);
            if (y < h - 1) visit(t + w);
        }
        ++next;
    }
    std::vector<float> lum(static_cast<size_t>(w) * h, 0.0f), cosS(static_cast<size_t>(w) * h, 0.0f);
    for (int y = 0; y < h; ++y) for (int x = 0; x < w; ++x) {
        int i = y * w + x;
        if (!has[i]) continue;
        cosS[i] = std::max(0.0f, texelNormals[i].normalized().dot(sun));
        Vec3 c = albedo.getPixelRGB(x, y);
        lum[i] = 0.2126f * srgbToLinear(c.x) + 0.7152f * srgbToLinear(c.y) + 0.0722f * srgbToLinear(c.z);
    }
    out.fit = fitSolarShading(lum, cosS, chart, config);
    if (!out.fit.fitted) { out.skippedReason = out.fit.reason; return out; }
    for (int y = 0; y < h; ++y) for (int x = 0; x < w; ++x) {
        int i = y * w + x;
        if (!has[i]) continue;
        double gain = out.fit.meanIrradiance / (cosS[i] + out.fit.ambientToSun);
        if (gain > out.fit.gainCap) { gain = out.fit.gainCap; ++out.cappedTexels; }
        Vec3 c = albedo.getPixelRGB(x, y);
        float lr = srgbToLinear(c.x) * static_cast<float>(gain), lg = srgbToLinear(c.y) * static_cast<float>(gain), lb = srgbToLinear(c.z) * static_cast<float>(gain);
        if (lr > 1.0f || lg > 1.0f || lb > 1.0f) ++out.clippedTexels;
        albedo.setPixelRGB(x, y, Vec3(linearToSrgb(lr), linearToSrgb(lg), linearToSrgb(lb)));
        ++out.delitTexels;
    }
    return out;
}

// ============================================================================
// 5. Analytical Sky-Dome Ambient Occlusion (AO)
// ============================================================================

/**
 * Computes analytical ambient occlusion combining surface concavity and sky-dome exposure (N_y > 0).
 */
inline ImageBuffer computeSkyDomeAO(
    const ImageBuffer& albedo,
    const ScratchboxMesh& mesh,
    float intensity = 1.0f
) {
    int w = albedo.width;
    int h = albedo.height;
    ImageBuffer ao(w, h, 3);

    for (int y = 0; y < h; ++y) {
        for (int x = 0; x < w; ++x) {
            float center = albedo.getLuminance(x, y);
            float n1 = albedo.getLuminance(x - 1, y);
            float n2 = albedo.getLuminance(x + 1, y);
            float n3 = albedo.getLuminance(x, y - 1);
            float n4 = albedo.getLuminance(x, y + 1);

            float avg = (n1 + n2 + n3 + n4) * 0.25f;
            float cavity = std::max(0.0f, avg - center);

            // Base ambient occlusion from cavity depth
            float aoVal = 1.0f - cavity * intensity * 3.5f;
            aoVal = std::clamp(aoVal, 0.15f, 1.0f);

            ao.setPixelRGB(x, y, {aoVal, aoVal, aoVal});
        }
    }

    return ao;
}

// ============================================================================
// 6. Poisson Seam Boundary Feathering / Gutter Dilation
// ============================================================================

/**
 * Dilates valid UV island texels outward by gutterRadius pixels to prevent black border fringing.
 */
inline void dilateUvGutters(ImageBuffer& img, const std::vector<bool>& mask, int gutterRadius = 4) {
    int w = img.width;
    int h = img.height;
    std::vector<bool> currentMask = mask;
    ImageBuffer temp = img;

    for (int step = 0; step < gutterRadius; ++step) {
        std::vector<bool> nextMask = currentMask;

        for (int y = 0; y < h; ++y) {
            for (int x = 0; x < w; ++x) {
                int idx = y * w + x;
                if (currentMask[idx]) continue; // Already valid

                // Check 4-connected neighbors
                Vec3 neighborSum(0, 0, 0);
                int count = 0;

                const int dx[4] = {-1, 1, 0, 0};
                const int dy[4] = {0, 0, -1, 1};
                for (int k = 0; k < 4; ++k) {
                    int nx = x + dx[k];
                    int ny = y + dy[k];
                    if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
                        int nidx = ny * w + nx;
                        if (currentMask[nidx]) {
                            neighborSum += img.getPixelRGB(nx, ny);
                            count++;
                        }
                    }
                }

                if (count > 0) {
                    temp.setPixelRGB(x, y, neighborSum * (1.0f / static_cast<float>(count)));
                    nextMask[idx] = true;
                }
            }
        }

        img = temp;
        currentMask = nextMask;
    }
}

// ============================================================================
// 7. Full Algorithmic UV Engine Pipeline
// ============================================================================

/**
 * New UVs for the whole mesh from the chart unwrap (scratchbox_uv_rewrap.hpp: grown charts flattened by LSCM, ABF++ and
 * SLIM, mask-packed into one 0..1 atlas): vertices are split where a chart seam passes, positions and every other
 * attribute are copied, and the UVs are written with v up (this engine's convention). Returns the unwrap's report.
 */
inline uv_rewrap::UnwrapResult reparameterizeCharts(ScratchboxMesh& mesh, uint32_t atlasSide = 1024, uint32_t gutter = 4) {
    const uint32_t V = static_cast<uint32_t>(mesh.vertices.size()), T = static_cast<uint32_t>(mesh.indices.size() / 3);
    std::vector<float> pos(size_t(V) * 3);
    for (uint32_t v = 0; v < V; ++v) { pos[v * 3] = mesh.vertices[v].position.x; pos[v * 3 + 1] = mesh.vertices[v].position.y; pos[v * 3 + 2] = mesh.vertices[v].position.z; }
    uv_rewrap::UnwrapParams prm;
    prm.atlasWidth = prm.atlasHeight = atlasSide;
    prm.gutter = gutter;
    uv_rewrap::UnwrapResult r = uv_rewrap::unwrap(pos.data(), V, mesh.indices.data(), T, nullptr, prm);
    std::vector<Vertex> verts(r.sourceVertex.size());
    for (size_t o = 0; o < verts.size(); ++o) {
        verts[o] = mesh.vertices[r.sourceVertex[o]];
        verts[o].uv = Vec2(r.uv[o * 2], 1.0f - r.uv[o * 2 + 1]);
    }
    mesh.vertices = std::move(verts);
    mesh.indices = r.indices;
    return r;
}

struct UvEngineOptions {
    std::string mode{"preserve-100-lock"}; // "preserve-100-lock" or "conformal-reparameterize" (chart unwrap, reparameterizeCharts)
    bool synthesizeCavitation{true};
    bool synthesizePbrSuite{true};
    bool decomposeAlbedo{true};
    bool enableSolarDelighting{false};
    SolarEphemerisConfig solarEphemeris;
    float bumpStrength{3.2f};
    int gutterDilationPixels{4};
};

struct UvEngineResult {
    bool success{false};
    int processedVertices{0};
    int processedTriangles{0};
    int processedTexels{0};
    double executionTimeMs{0.0};
    PbrTextureSet pbrSet;
    /** Texels divided by E(N) of their interpolated mesh normal (0 when solar de-lighting was off or skipped). */
    int solarDelitTexels{0};
    /** Set when solar de-lighting was requested but did not run (no sun, sun below the horizon, or the fit was refused). */
    std::string solarDelightingSkippedReason;
    /** The measured ambient-to-sun fit, and texels capped at its gain bound or saturated. */
    SolarShadingFit solarFit;
    int solarCappedTexels{0};
    int solarClippedTexels{0};
    /** Maps estimated from the image itself rather than measured, with how. */
    std::vector<std::string> heuristicMaps;
    /** Roughness is not produced: nothing here measures it (a luminance guess is not roughness). */
    std::string roughnessUnmeasuredReason;
};

inline UvEngineResult processMeshUvEngine(
    ScratchboxMesh& mesh,
    const ImageBuffer& sourceTexture,
    const UvEngineOptions& options = {}
) {
    auto startTime = std::chrono::high_resolution_clock::now();
    UvEngineResult result;
    result.processedVertices = static_cast<int>(mesh.vertices.size());
    result.processedTriangles = static_cast<int>(mesh.indices.size() / 3);

    if (sourceTexture.empty()) {
        result.success = false;
        return result;
    }

    int w = sourceTexture.width;
    int h = sourceTexture.height;
    ImageBuffer enhancedAlbedo = sourceTexture;
    std::vector<bool> coverageMask(w * h, false);
    // Interpolated mesh normal of every covered texel (zero where no triangle covers it), for solar de-lighting
    std::vector<Vec3> texelNormals(static_cast<size_t>(w) * h, Vec3{0.0f, 0.0f, 0.0f});

    // 1. Process mode: conformal reparameterization if requested
    if (options.mode == "conformal-reparameterize") {
        reparameterizeCharts(mesh);
        uv::generateMikkTSpaceTangents(mesh);
        result.processedVertices = static_cast<int>(mesh.vertices.size());
    } else {
        // preserve-100-lock: strictly maintain existing UVs and generate MikkTSpace tangents
        uv::generateMikkTSpaceTangents(mesh);
    }

    // 2. Continuous 3D triangle rasterization & micro-detail injection
    size_t triCount = mesh.indices.size() / 3;
    for (size_t f = 0; f < triCount; ++f) {
        uint32_t i0 = mesh.indices[f * 3 + 0];
        uint32_t i1 = mesh.indices[f * 3 + 1];
        uint32_t i2 = mesh.indices[f * 3 + 2];

        const Vertex& v0 = mesh.vertices[i0];
        const Vertex& v1 = mesh.vertices[i1];
        const Vertex& v2 = mesh.vertices[i2];

        float x1 = v0.uv.x * w;
        float y1 = (1.0f - v0.uv.y) * h;
        float x2 = v1.uv.x * w;
        float y2 = (1.0f - v1.uv.y) * h;
        float x3 = v2.uv.x * w;
        float y3 = (1.0f - v2.uv.y) * h;

        float det = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3);
        if (std::abs(det) < 1e-6f) continue;

        int minX = std::clamp(static_cast<int>(std::floor(std::min({x1, x2, x3}))), 0, w - 1);
        int maxX = std::clamp(static_cast<int>(std::ceil(std::max({x1, x2, x3}))), 0, w - 1);
        int minY = std::clamp(static_cast<int>(std::floor(std::min({y1, y2, y3}))), 0, h - 1);
        int maxY = std::clamp(static_cast<int>(std::ceil(std::max({y1, y2, y3}))), 0, h - 1);

        Vec3 faceNormal = ((v1.position - v0.position).cross(v2.position - v0.position)).normalized();

        for (int py = minY; py <= maxY; ++py) {
            for (int px = minX; px <= maxX; ++px) {
                BarycentricCoords bc = computeBarycentric(px + 0.5f, py + 0.5f, x1, y1, x2, y2, x3, y3, det);
                if (!bc.valid || bc.u < 0.0f || bc.v < 0.0f || bc.w < 0.0f) continue;

                int idx = py * w + px;
                coverageMask[idx] = true;
                result.processedTexels++;
                Vec3 nInterp = v0.normal * bc.u + v1.normal * bc.v + v2.normal * bc.w;
                if (nInterp.dot(nInterp) > 1e-12f) texelNormals[idx] = nInterp.normalized();

                // Interpolate continuous 3D world position
                Vec3 p3d = v0.position * bc.u + v1.position * bc.v + v2.position * bc.w;
                Vec3 col = enhancedAlbedo.getPixelRGB(px, py);

                SurfaceMaterialType matType = classifySurface(faceNormal, col, p3d.y);

                float deltaL = 0.0f;
                if (matType == SurfaceMaterialType::StoneArchitecture) {
                    float cav = options.synthesizeCavitation ? evaluateTravertineCavitation(p3d) : 0.0f;
                    float calcite = evaluateCalciteStrata(p3d);
                    deltaL = cav + calcite;
                } else if (matType == SurfaceMaterialType::AsphaltRoadway) {
                    deltaL = evaluateBitumenAggregate(p3d);
                } else if (matType == SurfaceMaterialType::FoliageVegetation) {
                    deltaL = evaluateChlorophyllDappling(p3d);
                }

                // Apply micro-contrast adjustment to RGB
                float factor = 1.0f + deltaL / 255.0f;
                col = col * factor;
                col.x = std::clamp(col.x, 0.0f, 1.0f);
                col.y = std::clamp(col.y, 0.0f, 1.0f);
                col.z = std::clamp(col.z, 0.0f, 1.0f);

                enhancedAlbedo.setPixelRGB(px, py, col);
            }
        }
    }

    // 3. Gutter Dilation pass to eliminate edge seams
    if (options.gutterDilationPixels > 0) {
        dilateUvGutters(enhancedAlbedo, coverageMask, options.gutterDilationPixels);
    }

    // 4. Photometric De-Lighting & PBR Suite Decomposition
    if (options.synthesizePbrSuite) {
        if (options.decomposeAlbedo) {
            ImageBuffer intrinsicAlbedo, shading;
            decomposeIntrinsicAlbedo(enhancedAlbedo, intrinsicAlbedo, shading);
            result.pbrSet.albedo = intrinsicAlbedo;
        } else {
            result.pbrSet.albedo = enhancedAlbedo;
        }

        if (options.enableSolarDelighting) {
            bool anyNormal = std::any_of(texelNormals.begin(), texelNormals.end(), [](const Vec3& v) { return v.dot(v) > 1e-12f; });
            if (!anyNormal) {
                result.solarDelightingSkippedReason = "no texel is covered by a mesh triangle with a non-zero normal";
            } else {
                auto sd = applySolarInverseDelighting(result.pbrSet.albedo, texelNormals, options.solarEphemeris);
                result.solarDelitTexels = sd.delitTexels;
                result.solarDelightingSkippedReason = sd.skippedReason;
                result.solarFit = sd.fit;
                result.solarCappedTexels = sd.cappedTexels;
                result.solarClippedTexels = sd.clippedTexels;
            }
        }

        result.pbrSet.normal = texture::computeSobelNormalMap(result.pbrSet.albedo, options.bumpStrength);
        result.pbrSet.ao = computeSkyDomeAO(result.pbrSet.albedo, mesh);
        result.heuristicMaps.push_back("normal: Sobel of albedo luminance (image-derived, not geometry)");
        result.heuristicMaps.push_back("ao: albedo luminance cavity (image-derived, not ray-traced)");
        // No roughness map and no ORM: the only source here would be a luminance guess, which is not a measurement.
        result.roughnessUnmeasuredReason = "roughness is not measured by the UV engine; no roughness or ORM map is written";
    } else {
        result.pbrSet.albedo = enhancedAlbedo;
    }

    auto endTime = std::chrono::high_resolution_clock::now();
    result.executionTimeMs = std::chrono::duration<double, std::milli>(endTime - startTime).count();
    result.success = true;
    return result;
}

} // namespace uv_engine
} // namespace scratchbox

#endif // SCRATCHBOX_UV_ENGINE_HPP
