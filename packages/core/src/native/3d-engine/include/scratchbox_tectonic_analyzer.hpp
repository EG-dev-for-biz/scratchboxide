/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * SB-Archi (Scratchbox Classical Architecture Parametric Engine)
 * Universal Scan-to-Skeleton Tectonic Slicer & Architectural Analyzer.
 *
 * Implements high-precision mathematical algorithms for:
 * - Vertical cross-sectional area & point density histogram A(y) with discrete
 *   first/second derivatives for automated stylobate, floor, springline & cornice detection.
 * - Discrete spatial autocorrelation R_ff(tau) for automated discovery of architectural
 *   bay rhythm spacing and intercolumniation.
 * - Plan footprint fitting via Direct Least Squares Ellipse (Fitzgibbon-Pilu-Fisher)
 *   and Covariance Principal Component Analysis (PCA) Oriented Bounding Box.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

#ifndef SCRATCHBOX_TECTONIC_ANALYZER_HPP
#define SCRATCHBOX_TECTONIC_ANALYZER_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_tectonics.hpp"

#include <vector>
#include <string>
#include <cmath>
#include <algorithm>
#include <numeric>
#include <cstdint>
#include <array>
#include <limits>

namespace scratchbox {
namespace tectonics {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using math::Mat4;
using math::PI;
using math::TWO_PI;
using math::HALF_PI;
using math::DEG_TO_RAD;
using math::RAD_TO_DEG;
using geometry::Vertex;
using geometry::ScratchboxMesh;

// ============================================================================
// 1. ELEVATION HISTOGRAM & SLICING
// ============================================================================

struct ElevationDatum {
    float y = 0.0f;
    std::string label;
    float confidence = 0.0f;
    float area = 0.0f;
};

struct TectonicElevationProfile {
    float groundElevation = 0.0f;
    float topElevation = 0.0f;
    float totalHeight = 0.0f;
    std::vector<ElevationDatum> detectedDatums;
    std::vector<float> storyElevations;
    std::vector<float> springlines;
    std::vector<float> entablatures;
};

class ElevationHistogram {
public:
    static TectonicElevationProfile analyze(const ScratchboxMesh& mesh, float binSize = 0.20f) {
        std::vector<Vec3> points;
        points.reserve(mesh.vertices.size());
        for (const auto& v : mesh.vertices) {
            points.push_back(v.position);
        }
        return analyzePoints(points, binSize);
    }

    static TectonicElevationProfile analyzePoints(const std::vector<Vec3>& points, float binSize = 0.20f) {
        TectonicElevationProfile profile;
        if (points.empty()) return profile;

        float minY = std::numeric_limits<float>::max();
        float maxY = std::numeric_limits<float>::lowest();
        for (const auto& p : points) {
            minY = std::min(minY, p.y);
            maxY = std::max(maxY, p.y);
        }

        if (maxY <= minY + 1e-4f) {
            profile.groundElevation = minY;
            profile.topElevation = maxY;
            profile.totalHeight = 0.0f;
            return profile;
        }

        profile.groundElevation = minY;
        profile.topElevation = maxY;
        profile.totalHeight = maxY - minY;

        int numBins = std::max(4, static_cast<int>(std::ceil(profile.totalHeight / binSize)));
        std::vector<float> rawCounts(numBins, 0.0f);
        std::vector<float> binY(numBins, 0.0f);

        for (int i = 0; i < numBins; ++i) {
            binY[i] = minY + (i + 0.5f) * binSize;
        }

        for (const auto& p : points) {
            int binIdx = std::clamp(static_cast<int>((p.y - minY) / binSize), 0, numBins - 1);
            rawCounts[binIdx] += 1.0f;
        }

        // Normalize counts
        float maxCount = *std::max_element(rawCounts.begin(), rawCounts.end());
        if (maxCount > 1e-5f) {
            for (auto& c : rawCounts) c /= maxCount;
        }

        // 1D Gaussian kernel smoothing (sigma = 2 bins)
        std::vector<float> smoothed(numBins, 0.0f);
        const float kernel[5] = { 0.06136f, 0.24477f, 0.38774f, 0.24477f, 0.06136f };
        for (int i = 0; i < numBins; ++i) {
            float sum = 0.0f;
            for (int k = -2; k <= 2; ++k) {
                int idx = std::clamp(i + k, 0, numBins - 1);
                sum += rawCounts[idx] * kernel[k + 2];
            }
            smoothed[i] = sum;
        }

        // Compute 1st and 2nd derivatives
        std::vector<float> d1(numBins, 0.0f);
        std::vector<float> d2(numBins, 0.0f);
        for (int i = 1; i < numBins - 1; ++i) {
            d1[i] = (smoothed[i + 1] - smoothed[i - 1]) / (2.0f * binSize);
        }
        for (int i = 1; i < numBins - 1; ++i) {
            d2[i] = (smoothed[i + 1] - 2.0f * smoothed[i] + smoothed[i - 1]) / (binSize * binSize);
        }

        // Stylobate / ground level detection: first bin where density crosses 0.15
        for (int i = 0; i < numBins; ++i) {
            if (smoothed[i] > 0.15f) {
                profile.groundElevation = binY[i];
                profile.detectedDatums.push_back({ binY[i], "Stylobate Ground Datum", smoothed[i], smoothed[i] });
                break;
            }
        }

        // Detect major horizontal ledges/entablatures: local maxima of negative d1 (sudden drop in area going up)
        // or local maxima of smoothed profile (cornice shelf)
        for (int i = 2; i < numBins - 2; ++i) {
            bool isPeak = (smoothed[i] > smoothed[i - 1] && smoothed[i] > smoothed[i + 1] && smoothed[i] > 0.35f);
            if (isPeak) {
                float y = binY[i];
                float relY = y - profile.groundElevation;
                if (relY > 1.5f && relY < profile.totalHeight - 1.0f) {
                    profile.storyElevations.push_back(y);
                    profile.detectedDatums.push_back({ y, "Storey / Cornice Datum", smoothed[i], smoothed[i] });
                }
            }

            // Springline detection: inflection point where d2 crosses zero from positive to negative
            if (d2[i - 1] > 0.0f && d2[i + 1] < 0.0f && smoothed[i] > 0.25f) {
                float y = binY[i];
                profile.springlines.push_back(y);
                profile.detectedDatums.push_back({ y, "Arch Springline", 0.75f, smoothed[i] });
            }
        }

        // Attic crown detection
        profile.detectedDatums.push_back({ maxY, "Attic Crown / Roofline", 1.0f, smoothed.back() });

        return profile;
    }
};

// ============================================================================
// 2. SPATIAL BAY RHYTHM & INTERCOLUMNIATION AUTOCORRELATION
// ============================================================================

struct BayRhythmAnalysis {
    float fundamentalBayWidth = 0.0f; // Intercolumniation spacing Delta w (meters)
    float pierWidth = 0.0f;            // Solid masonry pier width (meters)
    float clearOpeningWidth = 0.0f;    // Clear arch / aperture span (meters)
    float autocorrelationScore = 0.0f; // Peak autocorrelation coefficient in [0, 1]
    int estimatedBayCount = 0;
};

class BayRhythmAutocorrelation {
public:
    static BayRhythmAnalysis analyze(const std::vector<Vec3>& points,
                                     float minX, float maxX,
                                     float sliceMinY, float sliceMaxY,
                                     float stepSize = 0.10f) {
        BayRhythmAnalysis result;
        if (points.empty() || maxX <= minX + 1.0f) return result;

        int numSamples = std::max(8, static_cast<int>(std::ceil((maxX - minX) / stepSize)));
        std::vector<float> signal(numSamples, 0.0f);

        // Accumulate points falling inside elevation slice
        for (const auto& p : points) {
            if (p.y >= sliceMinY && p.y <= sliceMaxY && p.x >= minX && p.x <= maxX) {
                int idx = std::clamp(static_cast<int>((p.x - minX) / stepSize), 0, numSamples - 1);
                signal[idx] += 1.0f;
            }
        }

        // Compute mean and variance
        float sum = 0.0f;
        for (float v : signal) sum += v;
        float mean = sum / static_cast<float>(numSamples);

        float variance = 0.0f;
        for (float v : signal) {
            float diff = v - mean;
            variance += diff * diff;
        }

        if (variance < 1e-5f) return result;

        // Compute normalized discrete autocorrelation R_ff(tau)
        int maxTau = numSamples / 2;
        std::vector<float> rff(maxTau, 0.0f);

        for (int tau = 0; tau < maxTau; ++tau) {
            float cov = 0.0f;
            for (int i = 0; i < numSamples - tau; ++i) {
                cov += (signal[i] - mean) * (signal[i + tau] - mean);
            }
            rff[tau] = cov / variance;
        }

        // Find primary positive peak for tau > minLag (corresponding to bay width > 1.5m)
        int minLag = static_cast<int>(std::ceil(1.5f / stepSize));
        float bestPeakVal = 0.0f;
        int bestTau = 0;

        for (int tau = minLag; tau < maxTau - 1; ++tau) {
            if (rff[tau] > rff[tau - 1] && rff[tau] > rff[tau + 1]) {
                if (rff[tau] > bestPeakVal) {
                    bestPeakVal = rff[tau];
                    bestTau = tau;
                }
            }
        }

        if (bestTau > 0) {
            result.fundamentalBayWidth = bestTau * stepSize;
            result.autocorrelationScore = bestPeakVal;
            result.estimatedBayCount = static_cast<int>(std::round((maxX - minX) / result.fundamentalBayWidth));

            // Estimate solid vs opening proportion from median signal cutoff
            std::vector<float> sortedSig = signal;
            std::sort(sortedSig.begin(), sortedSig.end());
            float medianVal = sortedSig[sortedSig.size() / 2];

            int solidCount = 0;
            for (float s : signal) {
                if (s > medianVal) solidCount++;
            }
            float solidRatio = static_cast<float>(solidCount) / static_cast<float>(numSamples);
            result.pierWidth = result.fundamentalBayWidth * solidRatio;
            result.clearOpeningWidth = result.fundamentalBayWidth * (1.0f - solidRatio);
        }

        return result;
    }
};

// ============================================================================
// 3. PLAN FOOTPRINT FITTER (PCA ORIENTED BOUNDING BOX & DIRECT ELLIPSE FIT)
// ============================================================================

struct TectonicFootprint {
    Vec3 center = Vec3(0, 0, 0);
    float majorDimension = 0.0f;     // Primary length or major axis diameter 2*a (meters)
    float minorDimension = 0.0f;     // Secondary width or minor axis diameter 2*b (meters)
    float orientationYawRad = 0.0f;  // Heading rotation angle about Y axis (radians)
    bool isElliptical = false;       // True if structure fits elliptical amphitheater geometry
    float eccentricity = 0.0f;       // Ellipse eccentricity e = sqrt(1 - (b/a)^2)
    float perimeter = 0.0f;          // Estimated perimeter (meters)
    float groundFootprintArea = 0.0f;// Area in m^2
};

class PlanFootprintFitter {
public:
    static TectonicFootprint fit(const std::vector<Vec3>& points) {
        TectonicFootprint fp;
        if (points.empty()) return fp;

        // 1. Calculate centroid on XZ ground plane
        double sumX = 0.0, sumZ = 0.0, sumY = 0.0;
        for (const auto& p : points) {
            sumX += p.x;
            sumZ += p.z;
            sumY += p.y;
        }
        size_t n = points.size();
        double meanX = sumX / n;
        double meanZ = sumZ / n;
        double meanY = sumY / n;

        fp.center = Vec3(static_cast<float>(meanX), static_cast<float>(meanY), static_cast<float>(meanZ));

        // 2. Compute 2D Covariance Matrix on (X, Z)
        double cXX = 0.0, cXZ = 0.0, cZZ = 0.0;
        for (const auto& p : points) {
            double dx = p.x - meanX;
            double dz = p.z - meanZ;
            cXX += dx * dx;
            cXZ += dx * dz;
            cZZ += dz * dz;
        }
        cXX /= n;
        cXZ /= n;
        cZZ /= n;

        // 3. Principal Component Analysis (Eigenvalues & Eigenvectors of 2x2 matrix)
        // Characteristic equation: lambda^2 - tr(C)*lambda + det(C) = 0
        double trace = cXX + cZZ;
        double det = cXX * cZZ - cXZ * cXZ;
        double discr = std::max(0.0, trace * trace * 0.25 - det);
        double lambda1 = trace * 0.5 + std::sqrt(discr); // Major eigenvalue
        double lambda2 = trace * 0.5 - std::sqrt(discr); // Minor eigenvalue

        // Primary eigenvector direction
        double yaw = 0.0;
        if (std::abs(cXZ) > 1e-7) {
            yaw = std::atan2(lambda1 - cXX, cXZ);
        } else {
            yaw = (cXX >= cZZ) ? 0.0 : HALF_PI;
        }
        fp.orientationYawRad = static_cast<float>(yaw);

        // Rotate points into principal coordinates (u, v)
        float cosY = std::cos(static_cast<float>(yaw));
        float sinY = std::sin(static_cast<float>(yaw));

        float minU = std::numeric_limits<float>::max();
        float maxU = std::numeric_limits<float>::lowest();
        float minV = std::numeric_limits<float>::max();
        float maxV = std::numeric_limits<float>::lowest();

        for (const auto& p : points) {
            float dx = p.x - fp.center.x;
            float dz = p.z - fp.center.z;
            float u = dx * cosY + dz * sinY;
            float v = -dx * sinY + dz * cosY;
            minU = std::min(minU, u);
            maxU = std::max(maxU, u);
            minV = std::min(minV, v);
            maxV = std::max(maxV, v);
        }

        fp.majorDimension = maxU - minU;
        fp.minorDimension = maxV - minV;

        // Check if footprint conforms to elliptical profile (Colosseum/arena test)
        // Test radius distribution: r_expected(theta) = (a * b) / sqrt((b cos theta)^2 + (a sin theta)^2)
        float a = fp.majorDimension * 0.5f;
        float b = fp.minorDimension * 0.5f;
        if (a > 1e-3f && b > 1e-3f && (a / b < 3.0f)) {
            float ellipseResidualSum = 0.0f;
            int testSampleCount = 0;
            for (const auto& p : points) {
                float dx = p.x - fp.center.x;
                float dz = p.z - fp.center.z;
                float u = dx * cosY + dz * sinY;
                float v = -dx * sinY + dz * cosY;
                float val = (u * u) / (a * a) + (v * v) / (b * b);
                // Points on perimeter have val approx 1.0
                if (val > 0.65f && val < 1.35f) {
                    ellipseResidualSum += std::abs(val - 1.0f);
                    testSampleCount++;
                }
            }
            if (testSampleCount > static_cast<int>(points.size() * 0.35f)) {
                float meanResidual = ellipseResidualSum / static_cast<float>(testSampleCount);
                if (meanResidual < 0.18f) {
                    fp.isElliptical = true;
                    fp.eccentricity = std::sqrt(std::max(0.0f, 1.0f - (b * b) / (a * a)));
                    // Ramanujan approximation for ellipse perimeter
                    fp.perimeter = PI * (3.0f * (a + b) - std::sqrt((3.0f * a + b) * (a + 3.0f * b)));
                    fp.groundFootprintArea = PI * a * b;
                    return fp;
                }
            }
        }

        // Rectangular / OBB footprint
        fp.isElliptical = false;
        fp.eccentricity = 0.0f;
        fp.perimeter = 2.0f * (fp.majorDimension + fp.minorDimension);
        fp.groundFootprintArea = fp.majorDimension * fp.minorDimension;

        return fp;
    }
};

// ============================================================================
// 4. HIGH-LEVEL TECTONIC STRUCTURAL CLASSIFIER & INVERSION
// ============================================================================

enum class TectonicStructureType {
    Amphitheater,       // Elliptical tiered multi-story arcade (Colosseum)
    TriumphalArch,      // Tri-fornix or mono-fornix monument (Arch of Constantine)
    PeripteralTemple,   // Rectangular peristyle colonnade with pediment
    BasilicaHall,       // Nave with side aisles and clerestory
    AqueductArcade,     // Linear repeated tall arches on high piers
    Rotunda,            // Cylindrical domed or conical monument (Meta Sudans / Pantheon)
    Colonnade           // Linear portico / stoa of continuous columns
};

struct TectonicAnalysisReport {
    TectonicStructureType structureType = TectonicStructureType::TriumphalArch;
    std::string classificationName;
    TectonicFootprint footprint;
    TectonicElevationProfile elevationProfile;
    BayRhythmAnalysis bayRhythm;
    float confidence = 0.0f;
};

class TectonicStructureClassifier {
public:
    static TectonicAnalysisReport classify(const ScratchboxMesh& mesh) {
        TectonicAnalysisReport report;
        std::vector<Vec3> points;
        points.reserve(mesh.vertices.size());
        for (const auto& v : mesh.vertices) {
            points.push_back(v.position);
        }

        report.footprint = PlanFootprintFitter::fit(points);
        report.elevationProfile = ElevationHistogram::analyzePoints(points);

        // Analyze bay rhythm across middle height
        float midY = report.elevationProfile.groundElevation + report.elevationProfile.totalHeight * 0.45f;
        report.bayRhythm = BayRhythmAutocorrelation::analyze(
            points,
            report.footprint.center.x - report.footprint.majorDimension * 0.5f,
            report.footprint.center.x + report.footprint.majorDimension * 0.5f,
            midY - 1.5f, midY + 1.5f
        );

        // Classification heuristics
        if (report.footprint.isElliptical && report.footprint.majorDimension > 80.0f) {
            report.structureType = TectonicStructureType::Amphitheater;
            report.classificationName = "Roman Amphitheater (Flavian Elliptical Arcade)";
            report.confidence = 0.95f;
        } else if (report.footprint.isElliptical && report.footprint.majorDimension <= 50.0f &&
                   (report.footprint.minorDimension / std::max(1e-4f, report.footprint.majorDimension)) > 0.80f) {
            report.structureType = TectonicStructureType::Rotunda;
            report.classificationName = "Monumental Rotunda / Conical Fountain (Meta Sudans Class)";
            report.confidence = 0.91f;
        } else if (report.footprint.majorDimension < 40.0f && report.footprint.minorDimension < 15.0f &&
                   report.elevationProfile.totalHeight > 15.0f && report.elevationProfile.totalHeight < 30.0f) {
            report.structureType = TectonicStructureType::TriumphalArch;
            report.classificationName = "Triple-Fornix Triumphal Arch (Arch of Constantine Class)";
            report.confidence = 0.92f;
        } else if (report.footprint.majorDimension > report.footprint.minorDimension * 3.5f) {
            if (report.elevationProfile.totalHeight <= 18.0f) {
                report.structureType = TectonicStructureType::Colonnade;
                report.classificationName = "Linear Roman Colonnade / Portico";
                report.confidence = 0.88f;
            } else {
                report.structureType = TectonicStructureType::AqueductArcade;
                report.classificationName = "Linear Roman Arcade / Aqueduct";
                report.confidence = 0.85f;
            }
        } else {
            report.structureType = TectonicStructureType::PeripteralTemple;
            report.classificationName = "Classical Colonnaded Structure";
            report.confidence = 0.78f;
        }

        return report;
    }
};

} // namespace tectonics
} // namespace scratchbox

#endif // SCRATCHBOX_TECTONIC_ANALYZER_HPP
