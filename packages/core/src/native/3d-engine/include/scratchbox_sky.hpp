/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

#ifndef SCRATCHBOX_SKY_HPP
#define SCRATCHBOX_SKY_HPP

#include "scratchbox_math.hpp"
#include <algorithm>
#include <cmath>
#include <thread>
#include <vector>

namespace scratchbox {
namespace sky {

using math::Vec3;

/**
 * Physical atmosphere controls. Densities are multipliers on the sea-level reference profile,
 * so 1.0 is a clear standard atmosphere; raise dustDensity for haze or pollution.
 */
struct AtmosphereParams {
    float observerAltitudeMeters{0.0f};
    float airDensity{1.0f};
    float dustDensity{1.0f};
    float ozoneDensity{1.0f};
    float sunAngularDiameterDeg{0.545f};
    float sunIntensity{1.0f};
};

namespace detail {

constexpr double kPi = 3.14159265358979323846;
constexpr double kEarthRadius = 6360e3;
constexpr double kAtmosphereRadius = 6420e3;
constexpr double kRayleighScaleHeight = 8000.0;
constexpr double kMieScaleHeight = 1200.0;
constexpr double kOzoneCenter = 25000.0;
constexpr double kOzoneHalfWidth = 15000.0;
// Sea-level coefficients (1/m) for the linear sRGB primaries, sampled at 680, 550 and 440 nm.
constexpr double kRayleighScattering[3] = {5.802e-6, 13.558e-6, 33.1e-6};
constexpr double kMieScattering = 3.996e-6;
constexpr double kMieExtinction = 4.440e-6;
constexpr double kOzoneAbsorption[3] = {0.650e-6, 1.881e-6, 0.085e-6};
constexpr double kMieAnisotropy = 0.8;
constexpr double kLimbDarkening = 0.6;

struct Dvec3 {
    double x{0}, y{0}, z{0};
    Dvec3 operator+(const Dvec3& o) const { return {x + o.x, y + o.y, z + o.z}; }
    Dvec3 operator*(double s) const { return {x * s, y * s, z * s}; }
    double dot(const Dvec3& o) const { return x * o.x + y * o.y + z * o.z; }
    double length() const { return std::sqrt(dot(*this)); }
};

// Returns the far intersection distance of a ray starting inside a sphere, or -1 when it misses.
inline double sphereExit(const Dvec3& origin, const Dvec3& dir, double radius) {
    double b = origin.dot(dir);
    double c = origin.dot(origin) - radius * radius;
    double disc = b * b - c;
    if (disc < 0.0) return -1.0;
    return -b + std::sqrt(disc);
}

// Returns the near positive intersection distance with a sphere the ray starts outside of, or -1.
inline double sphereEntry(const Dvec3& origin, const Dvec3& dir, double radius) {
    double b = origin.dot(dir);
    double c = origin.dot(origin) - radius * radius;
    double disc = b * b - c;
    if (disc < 0.0) return -1.0;
    double t = -b - std::sqrt(disc);
    return t > 0.0 ? t : -1.0;
}

} // namespace detail

/**
 * Single-scattering clear sky over a spherical planet (Rayleigh + Mie + ozone absorption),
 * precomputed into an equirectangular lookup table relative to the sun azimuth. Radiance is
 * expressed relative to a top-of-atmosphere solar irradiance of `sunIntensity` per channel.
 * World frame: +Y up, +X east, +Z south.
 */
class PhysicalSky {
public:
    explicit PhysicalSky(const Vec3& sunDirection, const AtmosphereParams& params = {},
                         int azimuthResolution = 256, int elevationResolution = 128)
        : params_(params), azimuthRes_(std::max(azimuthResolution, 8)), elevationRes_(std::max(elevationResolution, 8)) {
        sunDir_ = sunDirection.normalized();
        if (sunDir_.lengthSquared() < 0.5f) sunDir_ = Vec3(0, 1, 0);
        float halfAngle = 0.5f * params_.sunAngularDiameterDeg * math::DEG_TO_RAD;
        sunCosHalfAngle_ = std::cos(halfAngle);
        sunSolidAngle_ = static_cast<float>(2.0 * detail::kPi * (1.0 - static_cast<double>(sunCosHalfAngle_)));
        buildSunBasis();

        detail::Dvec3 observer{0.0, detail::kEarthRadius + std::max(0.0f, params_.observerAltitudeMeters), 0.0};
        detail::Dvec3 sun{sunDir_.x, sunDir_.y, sunDir_.z};
        double depth[3];
        if (opticalDepthToSpace(observer, sun, 256, depth)) {
            sunTransmittance_ = Vec3(static_cast<float>(std::exp(-depth[0])),
                                     static_cast<float>(std::exp(-depth[1])),
                                     static_cast<float>(std::exp(-depth[2])));
        } else {
            sunTransmittance_ = Vec3(0, 0, 0);
        }

        double h = std::max(0.0, static_cast<double>(params_.observerAltitudeMeters));
        double densities[3];
        densityAt(h, densities);
        for (int c = 0; c < 3; ++c) {
            haze_[c] = static_cast<float>(detail::kRayleighScattering[c] * densities[0]
                                          + detail::kMieExtinction * densities[1]
                                          + detail::kOzoneAbsorption[c] * densities[2]);
        }

        buildLut();
        integrateHorizontalIrradiance();
    }

    /** Sky radiance excluding the solar disc (bilinear lookup). */
    Vec3 skyRadiance(const Vec3& direction) const {
        Vec3 d = direction.normalized();
        float elevation = std::asin(std::clamp(d.y, -1.0f, 1.0f));
        float rowF = std::sqrt(std::max(elevation, 0.0f) / static_cast<float>(detail::kPi * 0.5)) * elevationRes_ - 0.5f;
        float colF = relativeAzimuth(d) / static_cast<float>(detail::kPi) * azimuthRes_ - 0.5f;
        rowF = std::clamp(rowF, 0.0f, static_cast<float>(elevationRes_ - 1));
        colF = std::clamp(colF, 0.0f, static_cast<float>(azimuthRes_ - 1));
        int r0 = static_cast<int>(rowF), c0 = static_cast<int>(colF);
        int r1 = std::min(r0 + 1, elevationRes_ - 1), c1 = std::min(c0 + 1, azimuthRes_ - 1);
        float fr = rowF - r0, fc = colF - c0;
        auto at = [&](int r, int c) { return lut_[static_cast<size_t>(r) * azimuthRes_ + c]; };
        Vec3 top = at(r0, c0) * (1.0f - fc) + at(r0, c1) * fc;
        Vec3 bottom = at(r1, c0) * (1.0f - fc) + at(r1, c1) * fc;
        return top * (1.0f - fr) + bottom * fr;
    }

    /** Reference single-scattering integral for one direction (no lookup table). */
    Vec3 skyRadianceDirect(const Vec3& direction) const {
        Vec3 d = direction.normalized();
        d.y = std::max(d.y, 1e-4f);
        return integrate(d.normalized(), 48, 24);
    }

    /** Limb-darkened solar disc radiance; zero outside the disc. */
    Vec3 sunDiscRadiance(const Vec3& direction) const {
        Vec3 d = direction.normalized();
        float cosTheta = d.dot(sunDir_);
        if (cosTheta < sunCosHalfAngle_) return Vec3(0, 0, 0);
        float halfAngle = std::acos(sunCosHalfAngle_);
        float theta = std::acos(std::min(cosTheta, 1.0f));
        float r = halfAngle > 0.0f ? std::min(theta / halfAngle, 1.0f) : 0.0f;
        float mu = std::sqrt(std::max(0.0f, 1.0f - r * r));
        const float u = static_cast<float>(detail::kLimbDarkening);
        float profile = (1.0f - u * (1.0f - mu)) / (1.0f - u / 3.0f);
        return sunIrradiance() * (profile / sunSolidAngle_);
    }

    /** Uniformly samples a direction inside the solar cone (pdf = 1 / sunSolidAngle()). */
    Vec3 sampleSunDirection(float u1, float u2) const {
        float cosTheta = 1.0f - u1 * (1.0f - sunCosHalfAngle_);
        float sinTheta = std::sqrt(std::max(0.0f, 1.0f - cosTheta * cosTheta));
        float phi = static_cast<float>(2.0 * detail::kPi) * u2;
        return (sunDir_ * cosTheta + (sunTangent_ * std::cos(phi) + sunBitangent_ * std::sin(phi)) * sinTheta).normalized();
    }

    /** Direct solar irradiance at the observer on a surface facing the sun. */
    Vec3 sunIrradiance() const { return sunTransmittance_ * params_.sunIntensity; }
    Vec3 sunTransmittance() const { return sunTransmittance_; }
    /** Sky radiance at the horizon with the same azimuth as `direction`: the color distant haze converges to. */
    Vec3 horizonRadiance(const Vec3& direction) const {
        Vec3 flat(direction.x, 0.0f, direction.z);
        if (flat.lengthSquared() < 1e-8f) flat = Vec3(1, 0, 0);
        return skyRadiance(flat.normalized());
    }
    /** Extinction coefficient (1/m) of the air at the observer altitude. */
    Vec3 hazeExtinction() const { return Vec3(haze_[0], haze_[1], haze_[2]); }
    /** Irradiance on an upward-facing surface from the sky dome alone (solar disc excluded). */
    Vec3 skyIrradianceHorizontal() const { return skyIrradiance_; }

    const Vec3& sunDirection() const { return sunDir_; }
    float sunCosHalfAngle() const { return sunCosHalfAngle_; }
    float sunSolidAngle() const { return sunSolidAngle_; }
    const AtmosphereParams& params() const { return params_; }

private:
    void buildSunBasis() {
        Vec3 helper = std::abs(sunDir_.y) < 0.9f ? Vec3(0, 1, 0) : Vec3(1, 0, 0);
        sunTangent_ = helper.cross(sunDir_).normalized();
        sunBitangent_ = sunDir_.cross(sunTangent_);
    }

    void densityAt(double height, double out[3]) const {
        double h = std::max(0.0, height);
        out[0] = params_.airDensity * std::exp(-h / detail::kRayleighScaleHeight);
        out[1] = params_.dustDensity * std::exp(-h / detail::kMieScaleHeight);
        out[2] = params_.ozoneDensity * std::max(0.0, 1.0 - std::abs(h - detail::kOzoneCenter) / detail::kOzoneHalfWidth);
    }

    // Optical depth from `origin` to the top of the atmosphere; false when the planet blocks the ray.
    bool opticalDepthToSpace(const detail::Dvec3& origin, const detail::Dvec3& dir, int samples, double out[3]) const {
        out[0] = out[1] = out[2] = 0.0;
        if (detail::sphereEntry(origin, dir, detail::kEarthRadius) > 0.0) return false;
        double length = detail::sphereExit(origin, dir, detail::kAtmosphereRadius);
        if (length <= 0.0) return true;
        double sums[3] = {0, 0, 0};
        for (int i = 0; i < samples; ++i) {
            double u = (i + 0.5) / samples;
            double t = length * u * u;
            double dt = length * 2.0 * u / samples;
            double h = (origin + dir * t).length() - detail::kEarthRadius;
            double rho[3];
            densityAt(h, rho);
            sums[0] += rho[0] * dt;
            sums[1] += rho[1] * dt;
            sums[2] += rho[2] * dt;
        }
        for (int c = 0; c < 3; ++c) {
            out[c] = detail::kRayleighScattering[c] * sums[0] + detail::kMieExtinction * sums[1] + detail::kOzoneAbsorption[c] * sums[2];
        }
        return true;
    }

    Vec3 integrate(const Vec3& d, int viewSamples, int lightSamples) const {
        detail::Dvec3 observer{0.0, detail::kEarthRadius + std::max(0.0f, params_.observerAltitudeMeters), 0.0};
        detail::Dvec3 dir{d.x, d.y, d.z};
        detail::Dvec3 sun{sunDir_.x, sunDir_.y, sunDir_.z};
        double length = detail::sphereExit(observer, dir, detail::kAtmosphereRadius);
        double ground = detail::sphereEntry(observer, dir, detail::kEarthRadius);
        if (ground > 0.0) length = ground;
        if (length <= 0.0) return Vec3(0, 0, 0);

        double mu = dir.dot(sun);
        const double g = detail::kMieAnisotropy;
        double rayleighPhase = 3.0 / (16.0 * detail::kPi) * (1.0 + mu * mu);
        double miePhase = 3.0 / (8.0 * detail::kPi) * (1.0 - g * g) * (1.0 + mu * mu)
                        / ((2.0 + g * g) * std::pow(1.0 + g * g - 2.0 * g * mu, 1.5));

        double viewDepth[3] = {0, 0, 0};
        double radiance[3] = {0, 0, 0};
        for (int i = 0; i < viewSamples; ++i) {
            double u = (i + 0.5) / viewSamples;
            double t = length * u * u;
            double dt = length * 2.0 * u / viewSamples;
            detail::Dvec3 x = observer + dir * t;
            double h = x.length() - detail::kEarthRadius;
            double rho[3];
            densityAt(h, rho);
            double extinction[3];
            for (int c = 0; c < 3; ++c) {
                extinction[c] = detail::kRayleighScattering[c] * rho[0] + detail::kMieExtinction * rho[1] + detail::kOzoneAbsorption[c] * rho[2];
            }
            double sunDepth[3];
            if (opticalDepthToSpace(x, sun, lightSamples, sunDepth)) {
                for (int c = 0; c < 3; ++c) {
                    double transmittance = std::exp(-(viewDepth[c] + 0.5 * extinction[c] * dt + sunDepth[c]));
                    double scattering = detail::kRayleighScattering[c] * rho[0] * rayleighPhase + detail::kMieScattering * rho[1] * miePhase;
                    radiance[c] += transmittance * scattering * dt;
                }
            }
            for (int c = 0; c < 3; ++c) viewDepth[c] += extinction[c] * dt;
        }
        const double scale = params_.sunIntensity;
        return Vec3(static_cast<float>(radiance[0] * scale), static_cast<float>(radiance[1] * scale), static_cast<float>(radiance[2] * scale));
    }

    float relativeAzimuth(const Vec3& d) const {
        Vec3 sunFlat(sunDir_.x, 0.0f, sunDir_.z);
        Vec3 dirFlat(d.x, 0.0f, d.z);
        if (sunFlat.lengthSquared() < 1e-10f || dirFlat.lengthSquared() < 1e-10f) return 0.0f;
        float c = std::clamp(sunFlat.normalized().dot(dirFlat.normalized()), -1.0f, 1.0f);
        return std::acos(c);
    }

    Vec3 lutDirection(int row, int col) const {
        double elevation = detail::kPi * 0.5 * std::pow((row + 0.5) / elevationRes_, 2.0);
        double relAz = detail::kPi * (col + 0.5) / azimuthRes_;
        Vec3 sunFlat(sunDir_.x, 0.0f, sunDir_.z);
        if (sunFlat.lengthSquared() < 1e-10f) sunFlat = Vec3(0, 0, -1);
        sunFlat = sunFlat.normalized();
        Vec3 side = Vec3(0, 1, 0).cross(sunFlat).normalized();
        Vec3 flat = sunFlat * static_cast<float>(std::cos(relAz)) + side * static_cast<float>(std::sin(relAz));
        return (flat * static_cast<float>(std::cos(elevation)) + Vec3(0, static_cast<float>(std::sin(elevation)), 0)).normalized();
    }

    void buildLut() {
        lut_.assign(static_cast<size_t>(azimuthRes_) * elevationRes_, Vec3(0, 0, 0));
        unsigned workers = std::max(1u, std::min(std::thread::hardware_concurrency(), 32u));
        std::vector<std::thread> pool;
        for (unsigned w = 0; w < workers; ++w) {
            pool.emplace_back([this, w, workers]() {
                for (int row = static_cast<int>(w); row < elevationRes_; row += static_cast<int>(workers)) {
                    for (int col = 0; col < azimuthRes_; ++col) {
                        lut_[static_cast<size_t>(row) * azimuthRes_ + col] = integrate(lutDirection(row, col), 48, 24);
                    }
                }
            });
        }
        for (auto& t : pool) t.join();
    }

    void integrateHorizontalIrradiance() {
        const int elevationSteps = 64;
        const int azimuthSteps = 128;
        Vec3 sum(0, 0, 0);
        const double dElevation = detail::kPi * 0.5 / elevationSteps;
        const double dAzimuth = 2.0 * detail::kPi / azimuthSteps;
        for (int i = 0; i < elevationSteps; ++i) {
            double elevation = (i + 0.5) * dElevation;
            double weight = std::sin(elevation) * std::cos(elevation) * dElevation * dAzimuth;
            for (int j = 0; j < azimuthSteps; ++j) {
                double az = (j + 0.5) * dAzimuth;
                Vec3 d(static_cast<float>(std::cos(elevation) * std::sin(az)),
                       static_cast<float>(std::sin(elevation)),
                       static_cast<float>(-std::cos(elevation) * std::cos(az)));
                sum += skyRadiance(d) * static_cast<float>(weight);
            }
        }
        skyIrradiance_ = sum;
    }

    AtmosphereParams params_;
    int azimuthRes_;
    int elevationRes_;
    Vec3 sunDir_{0, 1, 0};
    Vec3 sunTangent_{1, 0, 0};
    Vec3 sunBitangent_{0, 0, 1};
    float sunCosHalfAngle_{1.0f};
    float sunSolidAngle_{0.0f};
    Vec3 sunTransmittance_{1, 1, 1};
    float haze_[3] = {0, 0, 0};
    Vec3 skyIrradiance_{0, 0, 0};
    std::vector<Vec3> lut_;
};

} // namespace sky
} // namespace scratchbox

#endif // SCRATCHBOX_SKY_HPP
